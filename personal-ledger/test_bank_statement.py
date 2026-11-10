"""Synthetic, non-personal examples of the observed Taishin column layout."""
import unittest

from bank_statement import StatementFormatError, UnsupportedStatement, parse_taishin_text


SYNTHETIC = """【第 1 頁】
台新銀行網站 www.taishinbank.com.tw
115年 11月 信用卡電子帳單
帳單結帳日 115/11/08
繳款截止日 115/11/23
上期應繳總額 1,000
-已繳退款總額 1,000
=前期餘額 0
+本期新增款項 430
=本期累計應繳金額 430
本期最低應繳金額 100
信用額度(NT) 99,999
【第 2 頁】
消費日 入帳起息日 消費明細 新臺幣金額 外幣折算日 消費地 幣別 外幣金額
115/10/05 115/10/06 網路銀行繳款 -1,000
範例卡 (卡號末四碼:0000)
115/10/09 115/10/10 範例咖啡店Taipei 150 TW
115/10/10 115/10/11 範例書店 300 IE
115/10/10 115/10/11 國外交易服務費－300.00 5
115/10/12 115/10/13 範例退貨折讓 -25 TW
【範例卡本期消費回饋】點數 1234 本年費用 5678
【第 3 頁】
貼心提醒 自動扣款帳號:(00000*****000000)
"""


class TaishinStatementTests(unittest.TestCase):
    def test_rows_totals_types_and_provenance_are_review_only(self):
        result = parse_taishin_text(SYNTHETIC)
        summary = result["summary"]
        self.assertEqual(len(result["rows"]), 5)
        self.assertEqual(result["pending"], [])
        self.assertTrue(summary["controls_ok"])
        self.assertEqual(summary["gross_charges"], "455.00")
        self.assertEqual(summary["purchase_total"], "450.00")
        self.assertEqual(summary["fee_total"], "5.00")
        self.assertEqual(summary["refunds"], "25.00")
        self.assertEqual(summary["payments"], "1000.00")
        self.assertEqual(summary["net_new_charges"], "430.00")
        self.assertEqual(summary["statement_month"], "2026-11")
        self.assertEqual([row["statement_kind"] for row in result["rows"]], ["payment", "purchase", "purchase", "fee", "refund"])
        self.assertEqual([row["kind"] for row in result["rows"]], ["transfer", "expense", "expense", "expense", "income"])
        for row in result["rows"]:
            self.assertTrue(row["force_review"])
            self.assertEqual((row["time_precision"], row["date_precision"]), ("day", "day"))
            self.assertEqual(row["provenance"]["posting_date"], row["posting_date"])
            self.assertNotIn("0000", row["external_id"])
            self.assertNotIn("raw_text", row["provenance"])
        self.assertEqual(result["rows"][3]["amount"], "5.00")
        self.assertEqual(result["rows"][4]["signed_settlement_amount"], "-25.00")

    def test_country_does_not_imply_original_currency(self):
        row = parse_taishin_text(SYNTHETIC)["rows"][2]
        self.assertEqual(row["provenance"]["country"], "IE")
        self.assertEqual(row["currency"], "TWD")
        self.assertIsNone(row["original_currency"])
        self.assertIsNone(row["original_amount"])

    def test_foreign_columns_preserve_settlement_and_original_separately(self):
        fixture = SYNTHETIC.replace("+本期新增款項 430", "+本期新增款項 750").replace("=本期累計應繳金額 430", "=本期累計應繳金額 750")
        fixture = fixture.replace("【範例卡本期消費回饋】", "115/10/13 115/10/15 範例海外商店 320 10/15 US USD 10.00\n【範例卡本期消費回饋】")
        result = parse_taishin_text(fixture)
        self.assertTrue(result["summary"]["controls_ok"])
        row = result["rows"][-1]
        self.assertEqual((row["amount"], row["original_currency"], row["original_amount"]), ("320.00", "USD", "10.00"))
        self.assertEqual(row["provenance"]["fx_date"], "2026-10-15")

    def test_duplicate_import_and_whitespace_keep_stable_identity(self):
        first = parse_taishin_text(SYNTHETIC)["rows"]
        changed = SYNTHETIC.replace("範例咖啡店Taipei", "範例 咖啡店Taipei").replace("\n", "\n\n")
        second = parse_taishin_text(changed)["rows"]
        self.assertEqual([row["external_id"] for row in first], [row["external_id"] for row in second])
        self.assertNotEqual(first[0]["external_id"], parse_taishin_text(SYNTHETIC, account="另一張信用卡")["rows"][0]["external_id"])

    def test_identical_actual_rows_are_distinct_occurrences(self):
        fixture = SYNTHETIC.replace("+本期新增款項 430", "+本期新增款項 580").replace("=本期累計應繳金額 430", "=本期累計應繳金額 580")
        line = "115/10/09 115/10/10 範例咖啡店Taipei 150 TW"
        fixture = fixture.replace(line, line + "\n" + line)
        rows = parse_taishin_text(fixture)["rows"]
        self.assertEqual(len({row["external_id"] for row in rows}), 6)
        self.assertNotEqual(rows[1]["external_id"], rows[2]["external_id"])

    def test_duplicate_pages_and_rewards_do_not_create_extra_transactions(self):
        page = SYNTHETIC.split("【第 2 頁】")[1].split("【第 3 頁】")[0]
        fixture = SYNTHETIC + "【第 4 頁】" + page
        result = parse_taishin_text(fixture)
        self.assertEqual(len(result["rows"]), 5)
        self.assertTrue(result["summary"]["controls_ok"])
        self.assertTrue(any("重複頁" in warning for warning in result["warnings"]))

    def test_year_rollover_uses_closing_year_and_full_roc_dates(self):
        fixture = SYNTHETIC.replace("115年 11月", "116年 1月").replace("115/11/08", "116/01/08").replace("115/11/23", "116/01/23")
        fixture = fixture.replace("115/10/05 115/10/06", "12/05 12/06").replace("115/10/09 115/10/10", "115/12/09 115/12/10").replace("115/10/10 115/10/11", "12/10 12/11").replace("115/10/12 115/10/13", "01/02 01/03")
        result = parse_taishin_text(fixture)
        self.assertTrue(result["summary"]["controls_ok"])
        self.assertEqual(result["rows"][0]["occurred_at"], "2026-12-05T00:00:00+08:00")
        self.assertEqual(result["rows"][-1]["occurred_at"], "2027-01-02T00:00:00+08:00")

    def test_malformed_row_or_control_mismatch_stays_incomplete(self):
        result = parse_taishin_text(SYNTHETIC.replace("範例咖啡店Taipei 150 TW", "範例咖啡店Taipei 1,50 TW"))
        self.assertEqual(len(result["rows"]), 4)
        self.assertEqual(len(result["pending"]), 1)
        self.assertFalse(result["summary"]["controls_ok"])
        self.assertTrue(result["warnings"])
        result = parse_taishin_text(SYNTHETIC.replace("+本期新增款項 430", "+本期新增款項 431"))
        self.assertFalse(result["summary"]["controls_ok"])

    def test_offsetting_rows_outside_verified_headers_make_completeness_false(self):
        fixture = SYNTHETIC + "\n【第 4 頁】\n範例卡 (卡號末四碼:0000)\n115/10/14 115/10/15 遺漏消費 100 TW\n115/10/16 115/10/17 遺漏退款 -100 TW\n"
        result = parse_taishin_text(fixture)
        self.assertEqual(len(result["rows"]), 5)
        self.assertEqual(len(result["pending"]), 2)
        self.assertFalse(result["summary"]["controls_ok"])
        self.assertFalse(result["summary"]["ready_for_review"])
        self.assertFalse(result["summary"]["controls"]["all_table_rows_parsed"])

    def test_future_date_and_positive_payment_do_not_become_expenses(self):
        result = parse_taishin_text(SYNTHETIC.replace("115/10/05 115/10/06 網路銀行繳款 -1,000", "115/10/05 115/10/06 網路銀行繳款 1,000"))
        self.assertEqual(len(result["rows"]), 4)
        self.assertIn("繳款沖回", result["pending"][0]["reason"])
        result = parse_taishin_text(SYNTHETIC.replace("115/10/12 115/10/13", "115/11/12 115/11/13"))
        self.assertEqual(len(result["rows"]), 4)
        self.assertIn("超過結帳日", result["pending"][0]["reason"])

    def test_unrecognized_bank_and_missing_controls_fail_closed(self):
        with self.assertRaises(UnsupportedStatement):
            parse_taishin_text(SYNTHETIC.replace("台新銀行網站 www.taishinbank.com.tw", "其他銀行網站 bank.example"))
        with self.assertRaises(UnsupportedStatement):
            parse_taishin_text(SYNTHETIC.replace("新臺幣金額", "不明欄位"))
        with self.assertRaises(StatementFormatError):
            parse_taishin_text(SYNTHETIC.replace("上期應繳總額 1,000", ""))

    def test_two_card_sections_do_not_share_transaction_identity(self):
        fixture = SYNTHETIC.replace("+本期新增款項 430", "+本期新增款項 580").replace("=本期累計應繳金額 430", "=本期累計應繳金額 580")
        fixture = fixture.replace("【範例卡本期消費回饋】", "其他範例卡 (卡號末四碼:1111)\n115/10/09 115/10/10 範例咖啡店Taipei 150 TW\n【範例卡本期消費回饋】")
        result = parse_taishin_text(fixture)
        self.assertTrue(result["summary"]["controls_ok"])
        self.assertEqual(result["summary"]["section_count"], 2)
        self.assertNotEqual(result["rows"][1]["external_id"], result["rows"][-1]["external_id"])

    def test_statement_rows_enter_pending_and_replay_without_adding_expenses(self):
        from pathlib import Path
        import tempfile
        from ledger import Ledger

        rows = parse_taishin_text(SYNTHETIC)["rows"]
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory) / "synthetic.sqlite3")
            first = [ledger.ingest(row) for row in rows]
            second = [ledger.ingest(row) for row in rows]
            snapshot = ledger.snapshot()
            self.assertEqual(snapshot["entries"], [])
            self.assertEqual(len(snapshot["sources"]), 5)
            self.assertEqual(len(snapshot["reviews"]), 5)
            self.assertTrue(all(not item["duplicate"] for item in first))
            self.assertTrue(all(item["duplicate"] for item in second))


if __name__ == "__main__":
    unittest.main()
