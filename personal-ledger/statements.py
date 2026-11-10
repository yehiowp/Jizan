"""Offline statement preview. CSV rows reconcile; PDFs never auto-create expenses."""
from __future__ import annotations

import csv
from decimal import Decimal, InvalidOperation
import hashlib
import io
from pathlib import Path
import re

from integrations import _timestamp


ALIASES = {
    "date": ("occurred_at", "date", "交易時間", "交易日期", "消費日期"),
    "amount": ("amount", "金額", "交易金額", "消費金額"),
    "currency": ("currency", "幣別", "交易幣別"),
    "merchant": ("merchant", "商家", "商店", "交易商店", "交易說明", "摘要"),
    "kind": ("kind", "type", "交易類型", "收支類型", "收支"),
    "transaction_id": ("transaction_id", "external_id", "交易序號", "交易編號"),
    "account": ("account", "帳戶"),
}
KINDS = {"expense": "expense", "支出": "expense", "消費": "expense", "刷卡": "expense",
         "income": "income", "收入": "income", "refund": "income", "退款": "income", "退刷": "income",
         "transfer": "transfer", "轉帳": "transfer", "繳款": "transfer"}


def _decode_csv(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "cp950"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise ValueError("CSV 編碼無法辨識，請匯出為 UTF-8 或 Big5")


def read_statement_csv(path, mapping=None, account="日常消費", timezone_offset="+08:00") -> dict:
    """Preview CSV transactions without interpreting bank debit/credit conventions.

    Every accepted row has force_review=True. A statement date without a time is
    represented by local midnight with date_precision='day'; it must stay review
    only and must not auto-match transactions on the assumed midnight timestamp.
    Missing explicit kinds, negative/ambiguous amounts and totals stay pending.
    No values are silently corrected. A provided transaction_id is scoped to the
    account; otherwise the entire file hash plus record number gives replay safety.
    """
    path = Path(path)
    if path.suffix.lower() not in {".csv", ".tsv"}:
        raise ValueError("請選擇 CSV 或 TSV 帳單檔")
    raw = path.read_bytes()
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("帳單檔超過 20 MB，請分批匯出")
    text = _decode_csv(raw)
    reader = csv.DictReader(io.StringIO(text), delimiter="\t" if path.suffix.lower() == ".tsv" else ",")
    headers = reader.fieldnames or []
    if len(headers) != len(set(headers)) or None in headers:
        raise ValueError("帳單有重複／無效欄位名稱，請先修正")
    resolved = {}
    if mapping:
        if not isinstance(mapping, dict):
            raise ValueError("欄位對照須為 JSON 物件")
        unknown = set(mapping) - set(ALIASES)
        if unknown:
            raise ValueError("未知欄位對照鍵：" + ", ".join(sorted(unknown)))
        resolved = dict(mapping)
        if any(value not in headers for value in resolved.values()):
            raise ValueError("欄位對照指向不存在的 CSV 欄位")
    else:
        for field, aliases in ALIASES.items():
            matches = [header for header in headers if header.strip().lower() in aliases]
            if len(matches) > 1:
                raise ValueError(f"{field} 有多個候選欄位，請指定欄位對照")
            if matches:
                resolved[field] = matches[0]
    required = {"date", "amount", "currency", "merchant", "kind"}
    missing = required - set(resolved)
    if missing:
        raise ValueError("缺少帳單欄位：" + ", ".join(sorted(missing)) + "；可使用欄位對照 JSON")
    result = {"rows": [], "pending": [], "warnings": [], "mapping": resolved}
    digest = hashlib.sha256(raw).hexdigest()
    seen = set()
    for index, row in enumerate(reader, start=2):
        def cell(field):
            return str(row.get(resolved.get(field, "")) or "").strip()
        if not any(value for value in row.values()):
            continue
        try:
            if None in row:
                raise ValueError("欄位數量超出標題列，請檢查 CSV 引號")
            merchant = cell("merchant")
            if not merchant:
                raise ValueError("缺少交易商家／摘要")
            if re.search(r"(?:^|\s)(?:total|subtotal|balance)(?:$|\s)|合計|總計|總額|應繳|最低應繳|上期結餘|本期結餘", merchant, re.I):
                raise ValueError("彙總／餘額列不作為單筆交易")
            original_kind = cell("kind").lower()
            if original_kind not in KINDS:
                raise ValueError("交易類型需明確為 expense/income/refund/transfer 或 支出／收入／退款／轉帳")
            raw_amount = cell("amount")
            if not re.fullmatch(r"(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?", raw_amount):
                raise ValueError("金額需為正數；負號／括號的銀行慣例須人工確認")
            amount = Decimal(raw_amount.replace(",", ""))
            if not amount.is_finite() or amount <= 0:
                raise ValueError("金額必須大於零")
            currency = cell("currency").upper()
            if not re.fullmatch(r"[A-Z]{3}", currency):
                raise ValueError("幣別需使用 TWD/USD 等三碼代號")
            date = cell("date")
            date_precision = "minute"
            if re.fullmatch(r"\d{4}[-/]\d{1,2}[-/]\d{1,2}", date):
                date = date + " 00:00:00"
                date_precision = "day"
            occurred_at = _timestamp(date, timezone_offset)
            row_account = cell("account") or account
            transaction_id = cell("transaction_id")
            identity = "id:" + hashlib.sha256((row_account + "\x00" + transaction_id).encode()).hexdigest() if transaction_id else "csv:" + digest + ":" + str(index)
            if identity in seen:
                raise ValueError("同檔案有重複交易編號，需核對")
            seen.add(identity)
            transaction = {"source": "statement", "external_id": identity, "account": row_account,
                           "merchant": merchant, "amount": format(amount, "f"), "currency": currency,
                           "occurred_at": occurred_at, "kind": KINDS[original_kind], "force_review": True,
                           "date_precision": date_precision, "statement_kind": original_kind,
                           "description": "退款：需關聯原交易" if original_kind in {"refund", "退款", "退刷"} else "帳單對帳匯入",
                           "raw_text": "\n".join(f"{key}: {value}" for key, value in row.items())}
            result["rows"].append(transaction)
        except (ValueError, InvalidOperation) as exc:
            result["pending"].append({"line": index, "reason": str(exc), "row": row})
    if any(row["date_precision"] == "day" for row in result["rows"]):
        result["warnings"].append("部分帳單只有交易日期，00:00 僅是儲存佔位；需人工核對交易時間，不可直接視為午夜消費")
    if not result["rows"] and not result["pending"]:
        result["warnings"].append("帳單沒有交易資料列")
    return result


def extract_pdf_text(path, password=None) -> dict:
    """Extract text locally; never fetch URLs, use OCR, or post PDF numbers as expenses."""
    try:
        from pypdf import PdfReader
    except ImportError:
        raise RuntimeError("尚未安裝 PDF 文字擷取套件，請執行 python -m pip install -r requirements.txt；或先從銀行匯出 CSV") from None
    path = Path(path)
    if path.suffix.lower() != ".pdf":
        raise ValueError("請選擇 PDF 帳單")
    if path.stat().st_size > 30 * 1024 * 1024:
        raise ValueError("PDF 帳單超過 30 MB")
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and (not password or not reader.decrypt(password)):
            raise ValueError("此 PDF 已加密，請輸入正確密碼；密碼僅在記憶體使用")
        if len(reader.pages) > 100:
            raise ValueError("PDF 超過 100 頁，請分批匯入")
        pages = [(page.extract_text() or "") for page in reader.pages]
    except ValueError:
        raise
    except ImportError:
        raise RuntimeError("此加密 PDF 需要加密套件，請執行 python -m pip install -r requirements.txt") from None
    except Exception:
        raise ValueError("PDF 無法讀取；請確認檔案格式或改用 CSV") from None
    text = "\n\n".join(f"【第 {i} 頁】\n{page}" for i, page in enumerate(pages, 1))
    warnings = ["PDF 目前提供離線文字預覽，不自動入帳；先確認銀行欄位與交易分類後再匯入 CSV"]
    if not any(page.strip() for page in pages):
        warnings.append("此 PDF 可能是掃描影像，目前未提供 OCR，請匯出文字型 PDF 或 CSV")
    return {"text": text, "warnings": warnings, "page_count": len(pages)}
