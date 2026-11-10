"""Conservative parser for the visually verified Taishin credit-card PDF layout.

Only transaction-table rows become review candidates. Header balances, payment
instructions, loyalty points, and advertised amounts never become transactions.
The parser does not write to a ledger or retain a PDF password.
"""
from __future__ import annotations

from collections import Counter
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
import unicodedata


class UnsupportedStatement(ValueError):
    """This is not the verified Taishin credit-card statement layout."""


class StatementFormatError(ValueError):
    """A recognized statement is missing mandatory dates/control values."""


_DATE = r"(?:\d{1,4}/)?\d{1,2}/\d{1,2}"
_MONEY = r"-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?"
_TABLE_MARKERS = ("消費日", "入帳起息日", "消費明細", "新臺幣金額", "外幣折算日", "消費地", "幣別", "外幣金額")
_CONTROLS = {
    "previous_due": "上期應繳總額", "paid_and_refunds": "已繳退款總額",
    "previous_balance": "前期餘額", "expected_new_charges": "本期新增款項",
    "amount_due": "本期累計應繳金額", "minimum_due": "本期最低應繳金額",
}


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).replace("−", "-").replace("﹣", "-")


def _compact(value: str) -> str:
    return re.sub(r"\s+", "", _normalize(value))


def _digest(value: str, length=24) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _money(value: str) -> Decimal:
    if not re.fullmatch(_MONEY, value):
        raise ValueError("金額格式不符合已驗證的台新帳單欄位")
    try:
        result = Decimal(value.replace(",", ""))
    except InvalidOperation:
        raise ValueError("帳單金額無法辨識") from None
    if not result.is_finite() or abs(result) > Decimal("1000000000000"):
        raise ValueError("帳單金額超出範圍")
    return result


def _amount(value: Decimal) -> str:
    return format(value, ".2f")


def _date(value: str, closing_date=None) -> tuple[date, bool]:
    parts = value.split("/")
    inferred = len(parts) == 2
    try:
        if inferred:
            if closing_date is None:
                raise ValueError()
            month, day = map(int, parts)
            year = closing_date.year - (month > closing_date.month)
        else:
            year, month, day = map(int, parts)
            if len(parts[0]) <= 3:
                year += 1911
        parsed = date(year, month, day)
        if not 1912 <= parsed.year <= 2200:
            raise ValueError()
        return parsed, inferred
    except (ValueError, TypeError):
        raise ValueError("帳單日期無效或無法判定年份") from None


def _page_lines(text: str) -> tuple[list[tuple[int, int, str]], list[str]]:
    pieces = re.split(r"【第\s*(\d+)\s*頁】", text)
    pages = [(1, text)] if len(pieces) == 1 else [(int(pieces[index]), pieces[index + 1]) for index in range(1, len(pieces), 2)]
    seen = set()
    lines, warnings = [], []
    for page_number, body in pages:
        key = _digest(_compact(body), 64)
        if key in seen:
            warnings.append(f"第 {page_number} 頁內容與前頁重複，已排除重複頁，請核對原件。")
            continue
        seen.add(key)
        for line_number, line in enumerate(body.splitlines(), 1):
            lines.append((page_number, line_number, _normalize(line).strip()))
    return lines, warnings


def _label_value(lines, label: str, *, is_date=False):
    pattern = re.compile(r"^[+=-]?\s*" + re.escape(label) + r"\s+(" + (_DATE if is_date else _MONEY) + r")\s*$")
    values = {match.group(1) for _, _, line in lines if (match := pattern.fullmatch(line))}
    if len(values) != 1:
        raise StatementFormatError(f"台新帳單缺少或有矛盾的「{label}」欄位，請保留文字預覽並人工核對。")
    return values.pop()


def _table_fields(value: str, closing_date: date) -> dict:
    """Consume the fixed table columns from right to left, preserving FX data.

    A numeric fee base in the description is never the settlement amount. Country
    codes do not imply a currency; a foreign merchant may still settle in TWD.
    """
    original_currency = original_amount = country = fx_date = None
    foreign = re.search(r"\s+([A-Z]{3})\s+(" + _MONEY + r")\s*$", value)
    if foreign:
        original_currency = foreign.group(1)
        original_amount = _amount(_money(foreign.group(2)))
        value = value[:foreign.start()].rstrip()
    country_match = re.search(r"\s+([A-Z]{2})\s*$", value)
    if country_match:
        country = country_match.group(1)
        value = value[:country_match.start()].rstrip()
    fx_match = re.search(r"\s+(" + _DATE + r")\s*$", value)
    if fx_match:
        fx_date = _date(fx_match.group(1), closing_date)[0].isoformat()
        value = value[:fx_match.start()].rstrip()
    settlement = re.search(r"\s+(" + _MONEY + r")\s*$", value)
    if not settlement:
        raise ValueError("找不到新臺幣金額，或外幣欄位排列與已驗證版型不同")
    merchant = value[:settlement.start()].strip()
    if not merchant or len(merchant) > 200:
        raise ValueError("消費明細空白或超過帳本長度限制")
    # A bare currency token or trailing malformed numeric column is ambiguous.
    if re.search(r"(?:^|\s)[A-Z]{3}$", merchant) and original_currency is None:
        raise ValueError("疑似缺少外幣金額或新臺幣金額，請人工核對")
    return dict(merchant=merchant, signed_amount=_money(settlement.group(1)),
                original_currency=original_currency, original_amount=original_amount,
                country=country, fx_date=fx_date)


def _classify(merchant: str, signed: Decimal) -> tuple[str, str, str, str]:
    if signed == 0:
        raise ValueError("零元帳單列不建立交易，請核對是否為說明列")
    payment = re.search(r"(?:網路銀行|自動扣繳|自動轉帳|ATM|超商|臨櫃|信用卡|轉帳).*繳款|^繳款$", merchant, re.I)
    if payment:
        if signed > 0:
            raise ValueError("繳款列卻為正金額，可能是繳款沖回，需人工確認方向")
        return "transfer", "payment", "信用卡繳款", "信用卡繳款，屬資金移動，不再計入支出"
    if signed < 0:
        return "income", "refund", "退款／折抵", "退款／折抵，請與原支出核對"
    if re.search(r"國外交易服務費|國際交易手續費|手續費|循環利息|違約金|信用卡年費|^年費", merchant):
        return "expense", "fee", "銀行費用", "帳單費用，請核對原交易與費用是否已分別記錄"
    return "expense", "purchase", "未分類", "帳單消費，待核對既有帳目"


def parse_taishin_text(text: str, account="台新信用卡") -> dict:
    """Parse locally extracted text into review-only rows and control totals."""
    if not isinstance(text, str) or len(text.encode("utf-8")) > 20 * 1024 * 1024:
        raise ValueError("帳單文字無效或超過 20 MB")
    if not isinstance(account, str) or not account.strip() or len(account) > 200 or any(ord(c) < 32 for c in account):
        raise ValueError("請填入有效帳戶名稱")
    account = account.strip()
    lines, warnings = _page_lines(text)
    joined = "\n".join(line for _, _, line in lines)
    compact = _compact(joined)
    title = re.search(r"(\d{2,4})年(\d{1,2})月信用卡電子帳單", compact)
    bank = "台新銀行" in compact or "www.taishinbank.com.tw" in compact.lower()
    has_header = any(all(marker in _compact(line) for marker in _TABLE_MARKERS) for _, _, line in lines)
    if not (bank and title and has_header):
        raise UnsupportedStatement("此 PDF 不符合已驗證的台新信用卡電子帳單版型；保留文字預覽，不自動建立交易。")
    title_year = int(title.group(1)) + (1911 if len(title.group(1)) <= 3 else 0)
    title_month = int(title.group(2))
    try:
        statement_month = date(title_year, title_month, 1).strftime("%Y-%m")
        closing_date = _date(_label_value(lines, "帳單結帳日", is_date=True))[0]
        due_date = _date(_label_value(lines, "繳款截止日", is_date=True))[0]
    except ValueError as error:
        raise StatementFormatError(str(error)) from None
    if statement_month != closing_date.strftime("%Y-%m") or due_date < closing_date:
        raise StatementFormatError("帳單年月、結帳日或繳款截止日互相矛盾，請人工核對。")
    control = {key: _money(_label_value(lines, label)) for key, label in _CONTROLS.items()}
    if any(control[key] < 0 for key in ("previous_due", "paid_and_refunds", "amount_due", "minimum_due")):
        raise StatementFormatError("帳單摘要為溢繳或特殊負餘額版型，尚需人工核對。")

    rows, pending = [], []
    section_id = "payments"
    section_ids = set()
    in_table = False
    current_page = None
    row_pattern = re.compile(r"^(" + _DATE + r")\s+(" + _DATE + r")\s+(.+)$")
    for page_number, line_number, line in lines:
        if current_page != page_number:
            in_table = False
            current_page = page_number
        if all(marker in _compact(line) for marker in _TABLE_MARKERS):
            in_table = True
            continue
        if not line:
            continue
        if not in_table:
            if row_pattern.fullmatch(line):
                pending.append({"page": page_number, "line": line_number,
                                "reason": "交易日期列出現在未驗證的表頭區段，未建立交易", "row": line})
            continue
        if re.search(r"卡號末四碼\s*[:：]\s*\d{4}", line):
            section_id = _digest(_compact(line), 16)
            section_ids.add(section_id)
            continue
        if line.startswith(("【", "本年度截至", "若台端起約", "台端起約", "本年度累計")):
            in_table = False
            continue
        match = row_pattern.fullmatch(line)
        if not match:
            pending.append({"page": page_number, "line": line_number, "reason": "交易表內有未辨識列，未建立交易", "row": line})
            continue
        try:
            occurred_date, transaction_inferred = _date(match.group(1), closing_date)
            posting_date, posting_inferred = _date(match.group(2), closing_date)
            if occurred_date > closing_date or posting_date > closing_date:
                raise ValueError("交易日或入帳日超過結帳日，請核對日期與年份")
            if posting_date < occurred_date:
                raise ValueError("入帳日早於消費日，請人工核對")
            fields = _table_fields(match.group(3), closing_date)
            kind, statement_kind, category, description = _classify(fields["merchant"], fields["signed_amount"])
            if section_id == "payments" and statement_kind != "payment":
                raise ValueError("尚未辨識信用卡區段，無法安全歸屬消費列")
            signed = _amount(fields["signed_amount"])
            provenance = {
                "bank": "taishin", "statement_date": closing_date.isoformat(), "due_date": due_date.isoformat(),
                "transaction_date": occurred_date.isoformat(), "posting_date": posting_date.isoformat(),
                "statement_kind": statement_kind, "signed_settlement_amount": signed,
                "original_currency": fields["original_currency"], "original_amount": fields["original_amount"],
                "description": description, "section_id": section_id, "line_index": line_number,
                "page": page_number, "country": fields["country"], "fx_date": fields["fx_date"],
                "date_year_inferred": transaction_inferred or posting_inferred,
            }
            if len(json.dumps(provenance, ensure_ascii=False).encode("utf-8")) > 4096:
                raise ValueError("帳單來源資訊超過大小限制")
            rows.append({
                "source": "statement", "account": account, "merchant": fields["merchant"],
                "amount": _amount(abs(fields["signed_amount"])), "currency": "TWD", "kind": kind,
                "category": category, "occurred_at": occurred_date.isoformat() + "T00:00:00+08:00",
                "date_precision": "day", "time_precision": "day", "force_review": True,
                "statement_kind": statement_kind, "posting_date": posting_date.isoformat(),
                "signed_settlement_amount": signed, "original_currency": fields["original_currency"],
                "original_amount": fields["original_amount"], "section_id": section_id,
                "description": description, "provenance": provenance,
            })
        except ValueError as error:
            pending.append({"page": page_number, "line": line_number, "reason": str(error), "row": line})

    identity = _digest("|".join(("taishin", statement_month, closing_date.isoformat(), account, *sorted(section_ids))), 32)
    occurrences = Counter()
    for row in rows:
        canonical = "|".join((row["section_id"], row["occurred_at"], row["posting_date"], _compact(row["merchant"]), row["signed_settlement_amount"], row["original_currency"] or "", row["original_amount"] or ""))
        key = _digest(canonical, 32)
        occurrences[key] += 1
        row["external_id"] = f"taishin:{identity}:{row['section_id']}:{key}:{occurrences[key]}"

    counts = Counter(row["statement_kind"] for row in rows)
    purchases = sum((Decimal(row["signed_settlement_amount"]) for row in rows if row["statement_kind"] == "purchase"), Decimal(0))
    fees = sum((Decimal(row["signed_settlement_amount"]) for row in rows if row["statement_kind"] == "fee"), Decimal(0))
    gross = purchases + fees
    refunds = -sum((Decimal(row["signed_settlement_amount"]) for row in rows if row["statement_kind"] == "refund"), Decimal(0))
    payments = -sum((Decimal(row["signed_settlement_amount"]) for row in rows if row["statement_kind"] == "payment"), Decimal(0))
    net_new = gross - refunds
    checks = {
        "previous_balance": control["previous_due"] - control["paid_and_refunds"] == control["previous_balance"],
        "closing_balance": control["previous_balance"] + control["expected_new_charges"] == control["amount_due"],
        "new_charges": net_new == control["expected_new_charges"],
        "payments": payments == control["paid_and_refunds"],
        "all_table_rows_parsed": not pending and bool(rows),
    }
    if not checks["previous_balance"] or not checks["closing_balance"]:
        warnings.append("帳務摘要的前期餘額／本期應繳計算不一致，請核對原件。")
    if not checks["new_charges"]:
        warnings.append(f"逐筆新增淨額 TWD {_amount(net_new)} 與帳單本期新增 TWD {_amount(control['expected_new_charges'])} 不一致，請先核對漏列、退款或費用。")
    if not checks["payments"]:
        warnings.append("逐筆繳款與摘要的已繳退款總額不一致，可能涉及其他調整，請人工核對。")
    if pending:
        warnings.append(f"有 {len(pending)} 列未能安全解析，尚不代表整份帳單已完整核對。")
    if not rows:
        warnings.append("未辨識到可核對的交易列。")
    warnings.extend([
        "帳單只有日期；00:00 為儲存佔位，不是實際交易時間。所有交易均需確認，尚未入帳。",
        "退款／折抵以正金額收入候選保存，另保留帳單負號；請與原支出核對，勿當一般收入。",
        "消費地不是原幣幣別；帳單未提供的外幣金額與幣別維持空白。",
    ])
    summary = {
        "bank": "taishin", "currency": "TWD", "statement_month": statement_month,
        "statement_date": closing_date.isoformat(), "closing_date": closing_date.isoformat(), "due_date": due_date.isoformat(),
        **{key: _amount(value) for key, value in control.items()},
        "row_count": len(rows), "pending_count": len(pending), "section_count": len(section_ids),
        **{kind + "_count": counts[kind] for kind in ("purchase", "fee", "refund", "payment")},
        "purchase_total": _amount(purchases), "fee_total": _amount(fees),
        "gross_charges": _amount(gross), "refunds": _amount(refunds), "payments": _amount(payments),
        "parsed_new_charges": _amount(net_new), "net_new_charges": _amount(net_new),
        "signed_all_rows_sum": _amount(net_new - payments),
        "controls": checks, "controls_ok": all(checks.values()), "ready_for_review": all(checks.values()),
        "statement_id": identity,
    }
    preview = "\n".join([
        f"台新信用卡帳單 {statement_month}｜結帳日 {closing_date.isoformat()}｜繳款截止 {due_date.isoformat()}",
        f"辨識 {len(rows)} 筆：消費 {counts['purchase']}、費用 {counts['fee']}、退款／折抵 {counts['refund']}、繳款 {counts['payment']}；未辨識 {len(pending)} 列。",
        f"消費及費用 TWD {_amount(gross)} − 退款／折抵 TWD {_amount(refunds)} = 本期新增淨額 TWD {_amount(net_new)}。",
        "摘要與逐筆控制金額一致。" if summary["controls_ok"] else "控制金額尚未全部一致，需先人工核對。",
        "尚未寫入帳本；匯入後全部列入待確認。",
    ])
    return {"rows": rows, "pending": pending, "warnings": warnings, "summary": summary, "preview": preview}


def parse_taishin_pdf(path, password=None, account="台新信用卡") -> dict:
    """Read a PDF locally; the optional password is supplied only by the GUI."""
    from statements import extract_pdf_text

    try:
        extracted = extract_pdf_text(Path(path), password=password)
    finally:
        password = None
    result = parse_taishin_text(extracted["text"], account=account)
    result["summary"]["page_count"] = extracted["page_count"]
    return result
