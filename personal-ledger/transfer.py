"""Explicit, offline file transfer between the iPhone web app and Windows.

Reading and previewing never write to the ledger. Only the caller's deliberate
confirmation invokes Ledger.ingest, which remains the authority for replay and
reconciliation. Transfer files are ordinary private financial data, not backups.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
from uuid import UUID

from ledger import (CURRENCY_DIGITS, Ledger, currency_code, from_minor, now,
                    text_value, timestamp, to_minor, uid)


MAX_BYTES = 10 * 1024 * 1024
MAX_RECORDS = 5000
TRANSFER_FORMAT = "personal-ledger-transfer"
SNAPSHOT_FORMAT = "personal-ledger-snapshot"


def _uuid(value, label):
    try:
        if not isinstance(value, str):
            raise ValueError()
        return str(UUID(value))
    except (ValueError, AttributeError):
        raise ValueError(f"{label}必須是 UUID") from None


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"JSON 含重複欄位：{key}")
        result[key] = value
    return result


def _json(value):
    if isinstance(value, bytes):
        if len(value) > MAX_BYTES:
            raise ValueError("手機紀錄檔超過 10 MiB")
        try:
            value = value.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ValueError("手機紀錄檔必須使用 UTF-8") from None
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_BYTES:
            raise ValueError("手機紀錄檔超過 10 MiB")
        try:
            value = json.loads(value.lstrip("\ufeff"), object_pairs_hook=_no_duplicate_keys,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError("JSON 數值無效")))
        except (json.JSONDecodeError, RecursionError):
            raise ValueError("手機紀錄檔不是有效的 JSON") from None
    if not isinstance(value, dict):
        raise ValueError("手機紀錄檔必須是 JSON 物件")
    # Also bound in-memory inputs; callers must not bypass the file size limit.
    try:
        if len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_BYTES:
            raise ValueError("手機紀錄檔超過 10 MiB")
    except (TypeError, RecursionError):
        raise ValueError("手機紀錄檔內容無效") from None
    return value


def _record(value):
    if not isinstance(value, dict):
        raise ValueError("交易必須是 JSON 物件")
    source = value.get("source")
    if source not in {"manual", "apple_pay"}:
        raise ValueError("手機紀錄來源限 manual 或 apple_pay")
    external_id = text_value(value.get("external_id"), "來源識別碼", 500)
    amount = value.get("amount")
    if not isinstance(amount, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", amount):
        raise ValueError("金額必須為正數的十進位字串")
    currency = currency_code(value.get("currency"))
    minor = to_minor(amount, currency)
    if minor <= 0:
        raise ValueError("金額必須大於零")
    kind = value.get("kind")
    if kind not in {"expense", "income", "transfer", "investment"}:
        raise ValueError("交易類型無效")
    precision = value.get("time_precision", value.get("date_precision", "minute"))
    if precision not in {"minute", "second", "day"}:
        raise ValueError("時間精度無效")
    if "date_precision" in value and "time_precision" in value and value["date_precision"] != precision:
        raise ValueError("兩個時間精度欄位不一致")
    record = {"source": source, "external_id": external_id,
              "amount": from_minor(minor, currency), "currency": currency,
              "merchant": text_value(value.get("merchant"), "商家／摘要"),
              "occurred_at": timestamp(value.get("occurred_at")),
              "account": text_value(value.get("account"), "帳戶"), "kind": kind,
              "category": text_value(value.get("category", "未分類"), "分類"),
              "time_precision": precision}
    if "source_timezone" in value:
        record["source_timezone"] = text_value(value["source_timezone"], "來源時區", 100, optional=True)
    if "force_review" in value:
        if type(value["force_review"]) is not bool:
            raise ValueError("force_review 必須是布林值")
        record["force_review"] = value["force_review"]
    if "provenance" in value:
        provenance = value["provenance"]
        if not isinstance(provenance, dict) or len(json.dumps(provenance, ensure_ascii=False).encode("utf-8")) > 2000:
            raise ValueError("資料來源資訊必須是 2000 UTF-8 位元組內的物件")
        record["provenance"] = provenance
    return record


def _same_record(record, source):
    """Compare the immutable fields that Ledger.ingest fingerprints."""
    comparisons = {
        "source": record["source"], "external_id": record["external_id"],
        "amount_minor": to_minor(record["amount"], record["currency"]),
        "currency": record["currency"], "account": record["account"],
        "merchant": record["merchant"], "kind": record["kind"],
        "category": record["category"], "occurred_at": record["occurred_at"],
        "time_precision": record["time_precision"],
    }
    return all(source.get(key) == value for key, value in comparisons.items())


def preview_transfer(value, ledger: Ledger | None = None):
    """Validate all rows without mutations; report invalid rows individually.

    records contains only valid, immutable normalized payloads. errors and rows
    preserve the original one-based indexes so a partial import is explicit.
    """
    payload = _json(value)
    if payload.get("format") != TRANSFER_FORMAT or type(payload.get("version")) is not int or payload["version"] != 1:
        raise ValueError("不支援的手機紀錄格式或版本")
    device_id = _uuid(payload.get("device_id"), "裝置識別碼")
    export_id = _uuid(payload.get("export_id"), "匯出識別碼")
    created_at = timestamp(payload.get("created_at"))
    items = payload.get("records")
    if not isinstance(items, list) or len(items) > MAX_RECORDS:
        raise ValueError("手機紀錄必須是陣列，且每檔最多 5000 筆")
    # Only phone-originated sources can collide with a phone export; read just
    # their fingerprinted fields instead of building a whole ledger snapshot.
    existing = {(s["source"], s["external_id"]): s for s in ledger.known_sources(("manual", "apple_pay"))} if ledger else {}
    records, errors, rows = [], [], []
    for index, item in enumerate(items, 1):
        try:
            record = _record(item)
            # Provenance is metadata only; no client-supplied ledger entry IDs
            # or account IDs can influence reconciliation.
            provenance = dict(record.get("provenance", {}))
            provenance.update(transfer_device_id=device_id, transfer_export_id=export_id)
            record["provenance"] = provenance
            key = (record["source"], record["external_id"])
            previous = existing.get(key)
            if previous is not None and not _same_record(record, previous):
                raise ValueError("相同來源識別碼的內容不同，請另建更正交易，不能覆蓋原紀錄")
            duplicate = previous is not None
            records.append(record)
            rows.append({"index": index, "record": record, "duplicate": duplicate})
            if previous is None:
                existing[key] = dict(record, amount_minor=to_minor(record["amount"], record["currency"]))
        except (ValueError, TypeError) as error:
            problem = {"index": index, "error": str(error)}
            errors.append(problem)
            rows.append(problem)
    return {"device_id": device_id, "export_id": export_id, "created_at": created_at,
            "total": len(items), "records": records, "errors": errors, "rows": rows}


def read_transfer(path, ledger: Ledger | None = None):
    path = Path(path)
    # Read at most the limit plus one, including on concurrently growing files.
    with path.open("rb") as handle:
        content = handle.read(MAX_BYTES + 1)
    return preview_transfer(content, ledger)


_ENTRY_FIELDS = {"id", "account", "kind", "amount_minor", "currency", "merchant", "occurred_at",
                 "status", "revision", "updated_at", "category", "note", "time_precision",
                 "transaction_date", "posting_date", "statement_kind"}
_SOURCE_FIELDS = {"id", "source", "external_id", "entry_id", "amount_minor", "currency", "merchant",
                  "occurred_at", "account", "kind", "category", "time_precision", "source_timezone",
                  "transaction_date", "posting_date", "statement_kind", "description"}
_PORTFOLIO_FIELDS = {"symbol", "market", "instrument_kind", "account", "currency", "quantity_decimal",
                     "cost_decimal", "realized_decimal", "dividend_decimal", "price_decimal", "quote_currency",
                     "quote_as_of", "quote_provider", "quote_type", "value_decimal", "unrealized_decimal"}


def _financial_row(row, fields):
    clean = {key: value for key, value in row.items() if key in fields}
    if "amount_minor" in clean:
        clean["amount"] = from_minor(clean["amount_minor"], clean["currency"])
    return clean


def mobile_snapshot(ledger: Ledger):
    """Export only display/reconciliation fields, never raw mail or source JSON."""
    snapshot = ledger.snapshot()
    entries = [_financial_row(entry, _ENTRY_FIELDS) for entry in snapshot["entries"]]
    reviews = []
    for review in snapshot["reviews"]:
        reviews.append({"id": review["id"], "reason": review["reason"], "created_at": review["created_at"],
                        "entry": _financial_row(review["entry"], _ENTRY_FIELDS) if review.get("entry") else None,
                        "source": _financial_row(review["source"], _SOURCE_FIELDS),
                        "candidates": [_financial_row(candidate, _ENTRY_FIELDS) for candidate in review.get("candidates", [])]})
    return {"format": SNAPSHOT_FORMAT, "version": 1, "export_id": uid(), "created_at": now(),
            "entries": entries, "reviews": reviews,
            "portfolio": [{key: value for key, value in row.items() if key in _PORTFOLIO_FIELDS} for row in snapshot["portfolio"]],
            "currency_digits": dict(CURRENCY_DIGITS),
            "accepted_sources": [{"source": source["source"], "external_id": source["external_id"],
                                  "entry_id": source["entry_id"]} for source in snapshot["sources"]]}


def write_snapshot(ledger: Ledger, path):
    path = Path(path)
    if path.resolve() == ledger.database.resolve():
        raise ValueError("總帳匯出檔不能覆蓋目前的資料庫")
    payload = mobile_snapshot(ledger)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return payload
