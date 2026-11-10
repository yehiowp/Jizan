"""Exercise offline mobile transfers against a real disposable ledger."""

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from uuid import uuid4

from ledger import Ledger
from transfer import MAX_BYTES, MAX_RECORDS, mobile_snapshot, preview_transfer, read_transfer, write_snapshot


def record(**changes):
    item = {"source": "apple_pay", "external_id": "wallet-transaction-stable-id", "amount": "120.00",
            "currency": "TWD", "merchant": "測試咖啡店", "occurred_at": "2026-11-10T09:00:00+08:00",
            "account": "日常消費", "kind": "expense", "time_precision": "minute"}
    return dict(item, **changes)


def envelope(*records, **changes):
    payload = {"format": "personal-ledger-transfer", "version": 1, "device_id": str(uuid4()),
               "export_id": str(uuid4()), "created_at": "2026-11-10T10:00:00+08:00", "records": list(records)}
    return dict(payload, **changes)


class FileTransferTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.ledger = Ledger(Path(self.directory.name) / "ledger.sqlite3")

    def tearDown(self):
        self.directory.cleanup()

    def test_preview_is_read_only_and_replay_keeps_one_entry(self):
        payload = envelope(record(provenance={"capture_method": "wallet_shortcut"}, date_precision="minute"))
        before = self.ledger.database.read_bytes()
        result = preview_transfer(json.dumps(payload), self.ledger)
        self.assertEqual(self.ledger.database.read_bytes(), before)
        self.assertEqual(self.ledger.snapshot()["sources"], [])
        self.assertEqual(result["records"][0]["provenance"]["capture_method"], "wallet_shortcut")
        self.assertEqual(result["records"][0]["provenance"]["transfer_device_id"], payload["device_id"])
        self.assertFalse(self.ledger.ingest(result["records"][0])["duplicate"])
        # A new export has different metadata but the same immutable transaction.
        repeated = preview_transfer(envelope(record()), self.ledger)
        self.assertTrue(repeated["rows"][0]["duplicate"])
        self.assertTrue(self.ledger.ingest(repeated["records"][0])["duplicate"])
        self.assertEqual(len(self.ledger.snapshot()["entries"]), 1)

    def test_changed_source_id_is_a_preview_error_and_never_overwrites(self):
        self.ledger.ingest(record())
        result = preview_transfer(envelope(record(amount="121.00"), record(external_id="another", amount="30")), self.ledger)
        self.assertEqual([item["index"] for item in result["errors"]], [1])
        self.assertIn("不能覆蓋", result["errors"][0]["error"])
        self.assertEqual(len(result["records"]), 1)
        self.assertEqual(self.ledger.snapshot()["entries"][0]["amount_minor"], 12000)

    def test_conflicting_rows_within_same_file_are_reported(self):
        result = preview_transfer(envelope(record(), record(amount="999"), record()), self.ledger)
        self.assertEqual(len(result["records"]), 2)
        self.assertEqual(result["errors"][0]["index"], 2)
        self.assertTrue(result["rows"][2]["duplicate"])
        self.assertEqual(self.ledger.snapshot()["entries"], [])

    def test_bad_rows_are_all_reported_and_valid_row_metadata_is_preserved(self):
        rows = [record(amount=120), record(amount="0"), record(occurred_at="2026-11-10"),
                record(source="gmail"), record(currency="BAD"), record(kind="deleted"),
                record(merchant=""), record(time_precision="year"), record(provenance=[]),
                record(external_id="ok-date", time_precision="day", source_timezone="Asia/Taipei")]
        result = preview_transfer(envelope(*rows), self.ledger)
        self.assertEqual(len(result["errors"]), 9)
        self.assertEqual(result["records"][0]["time_precision"], "day")
        self.assertEqual(result["records"][0]["source_timezone"], "Asia/Taipei")
        self.assertEqual(len(result["rows"]), 10)

    def test_envelope_validation_and_resource_limits(self):
        for changes in ({"version": True}, {"version": 2}, {"format": "other"}, {"device_id": "not-uuid"},
                        {"export_id": None}, {"created_at": "2026-11-10"}, {"records": {}},
                        {"records": [None] * (MAX_RECORDS + 1)}):
            with self.subTest(changes=list(changes)):
                with self.assertRaises(ValueError):
                    preview_transfer(envelope(**changes), self.ledger)
        with self.assertRaisesRegex(ValueError, "10 MiB"):
            preview_transfer(b" " * (MAX_BYTES + 1), self.ledger)
        with self.assertRaisesRegex(ValueError, "重複欄位"):
            preview_transfer('{"format":"personal-ledger-transfer","format":"other"}', self.ledger)

    def test_read_transfer_supports_utf8_bom_and_empty_export(self):
        path = Path(self.directory.name) / "mobile.json"
        path.write_text(json.dumps(envelope()), encoding="utf-8-sig")
        result = read_transfer(path, self.ledger)
        self.assertEqual(result["records"], [])
        self.assertEqual(result["errors"], [])

    def test_precision_and_amounts_are_exact(self):
        result = preview_transfer(envelope(record(amount="1000000000000000.00"),
                                           record(external_id="jpy", amount="10.1", currency="JPY")))
        self.assertEqual(result["records"][0]["amount"], "1000000000000000.00")
        self.assertEqual(result["errors"][0]["index"], 2)

    def test_client_supplied_ledger_ids_are_never_used(self):
        result = preview_transfer(envelope(record(entry_id="overwrite-target", account_id="foreign-account", id="source-id")), self.ledger)
        accepted = result["records"][0]
        self.assertNotIn("entry_id", accepted)
        self.assertNotIn("account_id", accepted)
        self.assertNotIn("id", accepted)
        inserted = self.ledger.ingest(accepted)
        self.assertNotEqual(inserted["entry_id"], "overwrite-target")

    def test_uncertain_wallet_time_can_only_request_review_with_a_boolean(self):
        result = preview_transfer(envelope(record(force_review=True),
                                           record(external_id="bad-review", force_review="false")), self.ledger)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue(result["records"][0]["force_review"])
        inserted = self.ledger.ingest(result["records"][0])
        self.assertEqual(inserted["status"], "pending")
        self.assertEqual(len(self.ledger.snapshot()["reviews"]), 1)

    def test_snapshot_includes_acknowledgments_and_sanitizes_nested_reviews(self):
        self.ledger.ingest(record())
        self.ledger.ingest(record(source="gmail", external_id="mail-opaque-id", amount="125"))
        with sqlite3.connect(self.ledger.database) as connection:
            connection.execute("UPDATE source_records SET payload_json=?", (json.dumps({"raw_email": "PRIVATE-MAIL-BODY"}),))
        result = mobile_snapshot(self.ledger)
        self.assertEqual(result["format"], "personal-ledger-snapshot")
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(len(result["reviews"]), 1)
        self.assertEqual(result["entries"][0]["amount"], "120.00")
        self.assertEqual(result["reviews"][0]["source"]["amount"], "125.00")
        self.assertEqual(len(result["accepted_sources"]), 2)
        serialized = json.dumps(result)
        self.assertNotIn("PRIVATE-MAIL-BODY", serialized)
        self.assertNotIn("payload_json", serialized)
        self.assertNotIn("fingerprint", serialized)
        self.assertNotIn("account_id", serialized)

    def test_unmatched_pending_source_is_also_acknowledged(self):
        self.ledger.ingest(record(source="statement", external_id="statement-row"))
        result = mobile_snapshot(self.ledger)
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["accepted_sources"][0]["entry_id"], None)
        self.assertEqual(len(result["reviews"]), 1)

    def test_snapshot_preserves_safe_statement_dates_without_exposing_provenance(self):
        statement = self.ledger.ingest(record(source="statement", external_id="dated-statement", time_precision="day",
            occurred_at="2026-11-10T00:00:00+08:00", provenance={"transaction_date":"2026-11-10",
                "posting_date":"2026-11-12", "statement_kind":"purchase", "description":"帳單說明",
                "raw_line":"PRIVATE-RAW-STATEMENT"}))
        pending = mobile_snapshot(self.ledger)
        source = pending["reviews"][0]["source"]
        self.assertEqual(source["transaction_date"], "2026-11-10")
        self.assertEqual(source["posting_date"], "2026-11-12")
        self.assertEqual(source["statement_kind"], "purchase")
        self.assertEqual(source["description"], "帳單說明")
        self.ledger.resolve_review(statement["review_id"], "use_source")
        accepted = mobile_snapshot(self.ledger)
        entry = accepted["entries"][0]
        self.assertEqual(entry["time_precision"], "day")
        self.assertEqual(entry["transaction_date"], "2026-11-10")
        self.assertEqual(entry["posting_date"], "2026-11-12")
        self.assertEqual(entry["statement_kind"], "purchase")
        self.assertEqual(entry["note"], "帳單說明")
        for snapshot in (pending, accepted):
            serialized = json.dumps(snapshot)
            self.assertNotIn("provenance", serialized)
            self.assertNotIn("PRIVATE-RAW-STATEMENT", serialized)

    def test_snapshot_file_round_trips_portfolio_and_exact_amounts(self):
        self.ledger.asset_event({"instrument_kind": "crypto", "symbol": "BTC", "market": "CRYPTO", "account": "錢包", "kind": "buy", "quantity": "0.1", "cash_amount": "5000", "fee": "10", "currency": "USD", "occurred_at": "2026-11-10T09:00:00+08:00"})
        self.ledger.set_quote({"instrument_kind": "crypto", "symbol": "BTC", "market": "CRYPTO", "price": "60000", "currency": "USD", "provider": "manual", "as_of": "2026-11-10T09:00:00+08:00"})
        path = Path(self.directory.name) / "snapshot.json"
        expected = write_snapshot(self.ledger, path)
        actual = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(actual, expected)
        self.assertEqual(actual["portfolio"][0]["value_decimal"], "6000.0")
        self.assertEqual(actual["portfolio"][0]["quote_type"], "manual")

    def test_snapshot_cannot_overwrite_the_active_database(self):
        self.ledger.ingest(record())
        with self.assertRaisesRegex(ValueError, "不能覆蓋"):
            write_snapshot(self.ledger, self.ledger.database)
        self.assertEqual(len(self.ledger.snapshot()["entries"]), 1)


if __name__ == "__main__":
    unittest.main()
