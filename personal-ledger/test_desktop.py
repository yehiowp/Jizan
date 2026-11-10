"""Exercise user-facing offline import/review flows with a real temporary ledger."""

import json
from pathlib import Path
import tempfile
import tkinter as tk
import unittest
from unittest.mock import patch

from desktop import LedgerApp, format_record_time, seed_demo
from ledger import Ledger


class DesktopFlowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.directory.cleanup()
            self.skipTest(f"Tk display unavailable: {error}")
        self.root.withdraw()
        self.errors = patch("desktop.messagebox.showerror", side_effect=lambda *args, **kwargs: self.fail(str(args)))
        self.errors.start()
        self.app = LedgerApp(self.root, Path(self.directory.name) / "ledger.sqlite3")

    def tearDown(self):
        if hasattr(self, "app"):
            self.root.update_idletasks()
            self.app.close()
            self.errors.stop()
        self.directory.cleanup()

    def test_first_launch_is_empty_and_does_not_seed_examples(self):
        self.root.update_idletasks()
        self.assertEqual(len(self.app.notebook.tabs()), 5)
        self.assertEqual(self.app.cards["entries"].get(), "0")
        self.assertEqual(self.app.ledger.snapshot()["sources"], [])

    def test_json_preview_commits_once_and_reports_duplicate(self):
        transaction = {"source": "apple_pay", "external_id": "ui-apple-pay-1", "amount": "120", "currency": "TWD", "merchant": "咖啡店", "occurred_at": "2026-11-10T09:00:00+08:00", "account": "日常消費", "kind": "expense"}
        self.app.import_text.insert("1.0", json.dumps([transaction, transaction], ensure_ascii=False))
        self.app.preview_import()
        self.assertEqual(len(self.app.preview_records), 2)
        self.assertEqual(self.app.ledger.snapshot()["entries"], [])
        self.app.commit_import()
        self.assertEqual(len(self.app.entries_tree.get_children()), 1)
        self.assertEqual(self.app.cards["expense"].get(), "TWD 120.00")
        self.assertIn("未重複記帳", self.app.import_output.get("1.0", "end"))

    def test_mobile_file_preview_reports_bad_rows_and_requires_explicit_commit(self):
        from test_transfer import envelope, record
        path = Path(self.directory.name) / "phone-export.json"
        path.write_text(json.dumps(envelope(record(), record(external_id="bad-row", amount=125)), ensure_ascii=False), encoding="utf-8")
        with patch("desktop.filedialog.askopenfilename", return_value=str(path)):
            self.app.load_mobile_transfer()
        self.assertEqual(self.app.ledger.snapshot()["entries"], [])
        self.assertEqual(len(self.app.preview_records), 1)
        self.assertEqual(len(self.app.transfer_errors), 1)
        self.assertIn("第 2 筆不會匯入", self.app.import_output.get("1.0", "end"))
        self.app.commit_import()
        self.assertEqual(len(self.app.ledger.snapshot()["entries"]), 1)
        self.assertIn("原始第 2 筆未匯入", self.app.import_output.get("1.0", "end"))
        # Reopening the same phone file acknowledges the duplicate instead of
        # creating another expense. Invalid rows remain visible in the result.
        with patch("desktop.filedialog.askopenfilename", return_value=str(path)):
            self.app.load_mobile_transfer()
        self.app.commit_import()
        self.assertEqual(len(self.app.ledger.snapshot()["entries"]), 1)
        self.assertIn("未重複記帳", self.app.import_output.get("1.0", "end"))

    def test_mobile_envelope_can_also_be_pasted_and_snapshot_saved(self):
        from test_transfer import envelope, record
        self.app.import_text.insert("1.0", json.dumps(envelope(record()), ensure_ascii=False))
        self.app.preview_import()
        self.assertEqual(len(self.app.preview_records), 1)
        self.app.commit_import()
        path = Path(self.directory.name) / "phone-snapshot.json"
        with patch("desktop.filedialog.asksaveasfilename", return_value=str(path)):
            self.app.export_mobile_snapshot()
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(payload["format"], "personal-ledger-snapshot")
        self.assertEqual(len(payload["entries"]), 1)
        self.assertEqual(payload["accepted_sources"][0]["external_id"], "wallet-transaction-stable-id")

    def test_changed_mobile_record_cannot_be_confirmed(self):
        from test_transfer import envelope, record
        self.app.ledger.ingest(record())
        self.app.import_text.insert("1.0", json.dumps(envelope(record(amount="999")), ensure_ascii=False))
        self.app.preview_import()
        self.assertEqual(self.app.preview_records, [])
        self.assertEqual(str(self.app.import_button["state"]), "disabled")
        self.assertIn("不能覆蓋", self.app.import_output.get("1.0", "end"))
        self.assertEqual(self.app.ledger.snapshot()["entries"][0]["amount_minor"], 12000)

    def test_resolving_amount_difference_updates_original_row(self):
        seed_demo(self.app.ledger)
        self.app.refresh()
        reviews = self.app.review_tree.get_children()
        self.assertEqual(len(reviews), 1)
        self.app.review_tree.selection_set(reviews[0])
        self.app.resolve("use_source")
        self.assertEqual(self.app.cards["entries"].get(), "3")
        self.assertEqual(self.app.cards["pending"].get(), "0")
        self.assertEqual(self.app.cards["expense"].get(), "TWD 635.00")

    def test_statement_preview_requires_confirmation_and_unmatched_row_stays_review(self):
        statement = Path(self.directory.name) / "statement.csv"
        statement.write_text("date,amount,currency,merchant,kind,account\n2026-11-10,200,TWD,帳單商店,expense,日常消費\n", encoding="utf-8")
        with patch("desktop.filedialog.askopenfilename", return_value=str(statement)):
            self.app.load_statement()
        self.assertEqual(len(self.app.preview_records), 1)
        self.assertEqual(self.app.ledger.snapshot()["entries"], [])
        self.app.commit_import()
        self.assertEqual(self.app.cards["entries"].get(), "0")
        self.assertEqual(self.app.cards["pending"].get(), "1")

    def test_portfolio_displays_saved_quote_without_network(self):
        self.app.ledger.asset_event({"instrument_kind": "crypto", "symbol": "BTC", "market": "CRYPTO", "account": "錢包", "kind": "buy", "quantity": "0.1", "cash_amount": "5000", "fee": "10", "currency": "USD", "occurred_at": "2026-11-10T09:00:00+08:00"})
        self.app.ledger.set_quote({"instrument_kind": "crypto", "symbol": "BTC", "market": "CRYPTO", "price": "60000", "currency": "USD", "provider": "manual", "as_of": "2026-11-10T09:00:00+08:00"})
        self.app.refresh()
        values = self.app.portfolio_tree.item("0", "values")
        self.assertEqual(values[0], "BTC / CRYPTO")
        self.assertEqual(values[5], "USD 6,000.00")
        self.assertEqual(values[6], "USD 990.00")

    def test_closed_position_still_displays_realized_loss(self):
        base = {"instrument_kind": "crypto", "symbol": "BTC", "market": "CRYPTO", "account": "錢包", "currency": "USD", "fee": "0"}
        self.app.ledger.asset_event(dict(base, kind="buy", quantity="1", cash_amount="1000", occurred_at="2026-11-10T09:00:00+08:00"))
        self.app.ledger.asset_event(dict(base, kind="sell", quantity="1", cash_amount="900", occurred_at="2026-11-10T10:00:00+08:00"))
        self.app.refresh()
        values = self.app.portfolio_tree.item("0", "values")
        self.assertEqual(values[2], "0")
        self.assertEqual(values[9], "USD -100.00")

    def test_restore_updates_visible_ledger_and_preserves_previous_database(self):
        transaction = {"source": "manual", "external_id": "before-backup", "amount": "120", "currency": "TWD", "merchant": "備份內交易", "occurred_at": "2026-11-10T09:00:00+08:00", "account": "日常消費", "kind": "expense"}
        self.app.ledger.ingest(transaction)
        backup = Path(self.directory.name) / "selected-backup.sqlite3"
        self.app.ledger.backup(backup)
        self.app.ledger.ingest(dict(transaction, external_id="after-backup", amount="80", merchant="備份後交易"))
        self.app.refresh()
        self.assertEqual(self.app.cards["expense"].get(), "TWD 200.00")
        with patch("desktop.filedialog.askopenfilename", return_value=str(backup)), patch("desktop.messagebox.askyesno", return_value=True) as confirmation:
            self.app.restore()
        confirmation.assert_called_once()
        self.assertEqual(len(self.app.entries_tree.get_children()), 1)
        self.assertEqual(self.app.cards["expense"].get(), "TWD 120.00")
        row = self.app.entries_tree.item(self.app.entries_tree.get_children()[0], "values")
        self.assertEqual(row[1], "備份內交易")
        preserved = list(Path(self.directory.name).glob("before-restore-*.sqlite3"))
        self.assertEqual(len(preserved), 1)
        self.assertEqual(len(Ledger(preserved[0]).snapshot()["entries"]), 2)

    def test_automatic_gmail_without_credentials_never_uses_network_or_opens_authorization(self):
        with patch("integrations.gmail_status", return_value={"configured": False, "connected": False}), patch("integrations.sync_gmail") as sync, patch("integrations.connect_gmail") as authorize:
            self.app.sync_gmail(automatic=True)
            self.app._startup_gmail()
        sync.assert_not_called()
        authorize.assert_not_called()
        self.assertFalse(self.app.busy)

    def test_automatic_gmail_pending_preserves_editor_preview_and_current_tab(self):
        self.app.import_text.insert("1.0", "保留正在編輯的匯入內容")
        self.app.import_text.edit_modified(False)
        self.app.preview_records = [{"sentinel": "existing-preview"}]
        self.app._set_output("保留目前預覽")
        self.app.notebook.select(self.app.tabs["assets"])
        selected = self.app.notebook.select()
        result = {"imported": 0, "duplicates": 0, "skipped": 0, "pending": [{"transaction": {"merchant": "待確認交易"}, "warnings": ["時間需確認"]}], "errors": []}
        with patch("integrations.gmail_status", return_value={"configured": True, "connected": True}), patch("integrations.sync_gmail", return_value=result):
            self.app.sync_gmail(automatic=True)
            self.root.after(250, self.root.quit)
            self.root.mainloop()
        self.assertFalse(self.app.busy)
        self.assertEqual(self.app.import_text.get("1.0", "end-1c"), "保留正在編輯的匯入內容")
        self.assertEqual(self.app.import_output.get("1.0", "end-1c"), "保留目前預覽")
        self.assertEqual(self.app.preview_records, [{"sentinel": "existing-preview"}])
        self.assertEqual(self.app.notebook.select(), selected)
        self.assertIn("郵件待核對 1", self.app.notebook.tab(self.app.tabs["import"], "text"))

    def test_automatic_gmail_offline_failure_sets_status_without_modal(self):
        with patch("integrations.gmail_status", return_value={"configured": True, "connected": True}), patch("integrations.sync_gmail", side_effect=OSError("offline-fixture")):
            self.app.sync_gmail(automatic=True)
            self.root.after(250, self.root.quit)
            self.root.mainloop()
        self.assertFalse(self.app.busy)
        self.assertIn("offline-fixture", self.app.status.get())

    def test_pasted_notification_with_parser_warning_requires_manual_review(self):
        transaction = {"source": "apple_pay", "external_id": "wallet-uncertain", "amount": "120", "currency": "TWD", "merchant": "商店", "occurred_at": "2026-11-10T09:00:00+08:00", "account": "日常消費", "kind": "expense"}
        self.app.ledger.ingest(transaction)
        self.app.import_text.insert("1.0", "人工貼上的銀行通知")
        parsed = {"transaction": dict(transaction, source="gmail", external_id="gmail-uncertain"), "warnings": ["時間需人工確認"], "reason": None}
        with patch("integrations.parse_notification", return_value=parsed):
            self.app.preview_import()
        self.app.commit_import()
        self.assertEqual(self.app.cards["entries"].get(), "1")
        self.assertEqual(self.app.cards["pending"].get(), "1")

    def test_encrypted_pdf_prompt_is_masked_and_never_auto_posts(self):
        with patch("desktop.filedialog.askopenfilename", return_value="fixture.pdf"), \
             patch("statements.extract_pdf_text", side_effect=[ValueError("此 PDF 已加密"), {"text": "SYNTHETIC STATEMENT", "warnings": []}]) as extract, \
             patch("tkinter.simpledialog.askstring", return_value="fixture-secret") as prompt:
            self.app.load_statement()
        self.assertEqual(prompt.call_args.kwargs["show"], "*")
        self.assertEqual(extract.call_args.kwargs, {"password": "fixture-secret"})
        self.assertIn("SYNTHETIC STATEMENT", self.app.import_text.get("1.0", "end"))
        self.assertNotIn("fixture-secret", self.app.import_text.get("1.0", "end"))
        self.assertEqual(self.app.preview_records, [])
        self.assertEqual(self.app.ledger.snapshot()["sources"], [])
        self.assertEqual(str(self.app.import_button["state"]), "disabled")

    def test_taishin_pdf_previews_controls_then_stages_all_rows_for_review(self):
        from test_bank_statement import SYNTHETIC
        self.app.import_account.set("台新信用卡")
        with patch("statements.extract_pdf_text", return_value={"text": SYNTHETIC, "warnings": []}):
            self.app.load_statement(Path("synthetic.pdf"))
        self.assertEqual(len(self.app.preview_records), 5)
        self.assertEqual(self.app.ledger.snapshot()["sources"], [])
        self.assertIn("摘要與逐筆控制金額一致", self.app.import_output.get("1.0", "end"))
        self.assertIn("時間未提供", self.app.import_output.get("1.0", "end"))
        self.app.commit_import()
        data = self.app.ledger.snapshot()
        self.assertEqual(len(data["reviews"]), 5)
        self.assertEqual(data["entries"], [])
        self.app.review_tree.selection_set(self.app.review_tree.get_children()[0])
        self.app._show_review()
        self.assertIn("入帳日期", self.app.review_detail.get())
        self.assertNotIn("00:00", self.app.review_detail.get())

    def test_taishin_control_mismatch_cannot_be_committed(self):
        from test_bank_statement import SYNTHETIC
        text = SYNTHETIC.replace("本期新增款項 430", "本期新增款項 431")
        with patch("statements.extract_pdf_text", return_value={"text": text, "warnings": []}):
            self.app.load_statement(Path("synthetic.pdf"))
        self.assertEqual(self.app.preview_records, [])
        self.assertEqual(str(self.app.import_button["state"]), "disabled")
        self.assertIn("禁止匯入", self.app.import_output.get("1.0", "end"))
        self.assertEqual(self.app.ledger.snapshot()["sources"], [])

    def test_date_only_time_preserves_source_calendar_date(self):
        label = format_record_time({"occurred_at": "2026-10-06T00:00:00+08:00", "transaction_date": "2026-10-06", "time_precision": "day"})
        self.assertEqual(label, "2026/10/06（時間未提供）")
        self.assertNotIn("00:00", label)


if __name__ == "__main__":
    unittest.main()
