import base64
from datetime import datetime
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen

import integrations as api
from statements import extract_pdf_text, read_statement_csv


NOTICE = "信用卡消費通知\n商店：全聯福利中心\n交易金額：NT$500\n交易時間：2026/11/10 12:34:00+08:00"


class FakeLedger:
    def __init__(self):
        self.seen, self.ingested, self.quotes = set(), [], []

    def ingest(self, transaction):
        key = transaction["source"], transaction["external_id"]
        if key in self.seen:
            return {"duplicate": True}
        self.seen.add(key)
        self.ingested.append(transaction)
        return {"duplicate": False}

    def set_quote(self, quote):
        self.quotes.append(quote)

    def snapshot(self):
        return {"portfolio": [], "sources": [{"source": source, "external_id": external_id} for source, external_id in self.seen]}


class ParserTests(unittest.TestCase):
    def test_complete_notification(self):
        preview = api.parse_notification(NOTICE, external_id="message-1")
        self.assertEqual(preview["warnings"], [])
        tx = preview["transaction"]
        self.assertEqual((tx["amount"], tx["currency"], tx["merchant"]), ("500", "TWD", "全聯福利中心"))
        self.assertEqual(tx["occurred_at"], "2026-11-10T12:34:00+08:00")
        self.assertEqual(tx["external_id"], "message-1")

    def test_no_year_or_email_timestamp_guess(self):
        preview = api.parse_notification(NOTICE.replace("2026/11/10", "11/10"))
        self.assertIsNone(preview["transaction"]["occurred_at"])
        self.assertTrue(preview["warnings"])

    def test_explicit_source_timezone(self):
        notice = NOTICE.replace("+08:00", "")
        self.assertTrue(api.parse_notification(notice)["warnings"])
        self.assertEqual(api.parse_notification(notice, timezone_offset="+08:00")["warnings"], [])

    def test_multiple_amounts_and_currency_need_confirmation(self):
        preview = api.parse_notification(NOTICE + "\n扣款 USD 15.50")
        self.assertEqual(len(preview["amount_candidates"]), 2)
        self.assertNotIn("amount", preview["transaction"])
        self.assertTrue(preview["warnings"])

    def test_unsafe_and_nonexpense_types(self):
        for text in ("電子帳單 本期應繳 NT$500", "OTP 驗證碼 123456"):
            self.assertIsNone(api.parse_notification(text)["transaction"])
        for text in (NOTICE.replace("消費通知", "退款通知"), NOTICE.replace("消費通知", "轉帳通知")):
            self.assertTrue(api.parse_notification(text)["warnings"])

    def test_bad_amount_and_bad_date_do_not_auto_post(self):
        for invalid in ("NT$1,23", "NT$1e5", "NT$12.34.56", "NT$5萬"):
            self.assertTrue(api.parse_notification(NOTICE.replace("NT$500", invalid))["warnings"])
        self.assertTrue(api.parse_notification(NOTICE.replace("2026/11/10", "2026/02/31"))["warnings"])

    def test_external_id_is_replay_stable(self):
        first = api.parse_notification(NOTICE)["transaction"]
        self.assertEqual(first["external_id"], api.parse_notification(NOTICE)["transaction"]["external_id"])
        self.assertNotEqual(first["external_id"], api.parse_notification(NOTICE.replace("12:34", "13:34"))["transaction"]["external_id"])


class GmailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.config_path = self.path / "gmail.json"
        self.config = api.gmail_config_template()
        self.config["senders"] = ["notify@bank.example"]
        self.config["oauth_client_file"] = str(self.path / "client.json")
        (self.path / "client.json").write_text(json.dumps({"installed": {"client_id": "fixture.apps.googleusercontent.com", "client_secret": "fixture"}}))
        self.config_path.write_text(json.dumps(self.config))
        self.patcher = patch.object(api, "_data_dir", return_value=self.path)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def message(self, body=NOTICE, auth=True):
        headers = [{"name": "From", "value": "Bank <notify@bank.example>"}, {"name": "Subject", "value": "信用卡消費通知"}]
        if auth:
            headers.append({"name": "Authentication-Results", "value": "mx.google.com; dkim=pass header.i=@bank.example; spf=pass smtp.mailfrom=notify@bank.example; dmarc=pass header.from=bank.example"})
        return {"payload": {"mimeType": "text/plain", "headers": headers,
                            "body": {"data": base64.urlsafe_b64encode(body.encode()).rstrip(b"=").decode()}}}

    def request(self, url, **kwargs):
        if "/messages?" in url:
            query = parse_qs(urlparse(url).query)
            self.assertIn("from:notify@bank.example", query["q"][0])
            return {"messages": [{"id": "mail1"}]}
        return self.message()

    def test_unscoped_mailbox_is_rejected_before_network(self):
        self.config["senders"] = []
        self.config_path.write_text(json.dumps(self.config))
        with patch.object(api, "_request_json") as request:
            with self.assertRaises(ValueError):
                api.sync_gmail(FakeLedger(), self.config_path)
            request.assert_not_called()

    def test_sender_search_syntax_cannot_broaden_mailbox(self):
        self.config["senders"] = ["{anything}@bank.example"]
        self.config_path.write_text(json.dumps(self.config))
        with self.assertRaises(ValueError):
            api._load_config(self.config_path)

    def test_authenticated_scoped_sync_and_replay(self):
        ledger = FakeLedger()
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=self.request):
            self.assertEqual(api.sync_gmail(ledger, self.config_path)["imported"], 1)
            self.assertEqual(api.sync_gmail(ledger, self.config_path)["duplicates"], 1)
        self.assertEqual(len(ledger.ingested), 1)

    def test_real_ledger_sync_and_quotes_do_not_rebuild_the_whole_snapshot(self):
        from ledger import Ledger
        ledger = Ledger(self.path / "ledger.sqlite3")
        ledger.asset_event({"symbol": "2330", "market": "TWSE", "instrument_kind": "stock", "account": "證券", "kind": "buy",
                            "quantity": "10", "cash_amount": "10000", "currency": "TWD", "occurred_at": "2026-11-10T12:00:00+08:00"})
        def request(url, **kwargs):
            if url == api.TWSE_URL:
                return [{"Code": "2330", "ClosingPrice": "1,234.50", "Date": "1151109"}]
            return self.request(url, **kwargs)
        with patch.object(Ledger, "snapshot", side_effect=AssertionError("periodic jobs must use lean lookups")), \
                patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=request):
            self.assertEqual(api.sync_gmail(ledger, self.config_path)["imported"], 1)
            self.assertEqual(api.sync_gmail(ledger, self.config_path)["duplicates"], 1)
            self.assertEqual(api.update_quotes(ledger)["updated"], 1)
        snapshot = ledger.snapshot()
        self.assertEqual(len(snapshot["entries"]), 1)
        self.assertEqual(snapshot["portfolio"][0]["price_decimal"], "1234.50")

    def test_authentication_missing_stays_pending(self):
        def request(url, **kwargs):
            return {"messages": [{"id": "mail1"}]} if "/messages?" in url else self.message(auth=False)
        ledger = FakeLedger()
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=request):
            result = api.sync_gmail(ledger, self.config_path)
        self.assertEqual(result["imported"], 0)
        self.assertEqual(len(result["pending"]), 1)
        self.assertTrue(Path(result["pending_file"]).exists())
        self.assertFalse(ledger.ingested)

    def test_next_run_resumes_older_page_then_returns_to_newest(self):
        listed = []
        def request(url, **kwargs):
            if "/messages?" in url:
                token = parse_qs(urlparse(url).query).get("pageToken", [None])[0]
                listed.append(token)
                return {"messages": [{"id": "mail1"}], "nextPageToken": "page-two"} if token is None else {"messages": [{"id": "mail2"}]}
            return self.message()
        ledger = FakeLedger()
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=request):
            self.assertTrue(api.sync_gmail(ledger, self.config_path, max_messages=1)["has_more"])
            self.assertFalse(api.sync_gmail(ledger, self.config_path, max_messages=1)["has_more"])
            api.sync_gmail(ledger, self.config_path, max_messages=1)
        self.assertEqual(listed, [None, "page-two", None])
        self.assertEqual(len(ledger.ingested), 2)

    def test_expired_cursor_restarts_once_without_duplicate_expense(self):
        ledger = FakeLedger()
        def first(url, **kwargs):
            return {"messages": [{"id": "mail1"}], "nextPageToken": "expired"} if "/messages?" in url else self.message()
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=first):
            api.sync_gmail(ledger, self.config_path, max_messages=1)
        calls = []
        def second(url, **kwargs):
            token = parse_qs(urlparse(url).query).get("pageToken", [None])[0]
            calls.append(token)
            if token:
                raise api.ServiceHTTPError(400, "invalidPageToken")
            return {"messages": [{"id": "mail1"}]}
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=second):
            result = api.sync_gmail(ledger, self.config_path, max_messages=1)
        self.assertEqual(calls, ["expired", None])
        self.assertTrue(result["cursor_reset"])
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(len(ledger.ingested), 1)

    def test_old_pending_returns_on_later_pages_and_manual_import_clears(self):
        ledger = FakeLedger()
        def first(url, **kwargs):
            return {"messages": [{"id": "pending1"}], "nextPageToken": "page-two"} if "/messages?" in url else self.message(auth=False)
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", side_effect=first):
            result = api.sync_gmail(ledger, self.config_path, max_messages=1)
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", return_value={"messages": []}):
            later = api.sync_gmail(ledger, self.config_path)
        self.assertEqual(later["pending"][0]["external_id"], "pending1")
        ledger.ingest(dict(result["pending"][0]["transaction"], force_review=True))
        with patch.object(api, "_access_token", return_value="mock"), patch.object(api, "_request_json", return_value={"messages": []}):
            cleared = api.sync_gmail(ledger, self.config_path)
        self.assertEqual(cleared["pending"], [])
        self.assertEqual(json.loads(Path(cleared["pending_file"]).read_text()), {})

    def test_mismatched_authenticated_domain_does_not_pass(self):
        headers = self.message()["payload"]["headers"]
        headers[-1]["value"] = "mx.google.com; dkim=pass header.i=@attacker.example; dmarc=pass header.from=attacker.example"
        self.assertFalse(api._authenticated_sender(headers, self.config["senders"])[0])

    def test_html_does_not_execute_or_duplicate_alternatives(self):
        payload = {"mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": base64.urlsafe_b64encode(b"plain").decode()}},
            {"mimeType": "text/html", "body": {"data": base64.urlsafe_b64encode(b"<script>evil()</script><p>html</p>").decode()}}]}
        self.assertEqual(api._body_text(payload), "plain")
        self.assertNotIn("evil", api._body_text(payload["parts"][1]))

    def test_windows_token_protected_and_roundtrips(self):
        token = {"access_token": "test-not-a-real-token", "scope": api.GMAIL_SCOPE}
        path = self.path / "token.json"
        api._save_token(path, token)
        self.assertEqual(api._read_token(path), token)
        self.assertNotIn("test-not-a-real-token", path.read_text())

    def test_oauth_pkce_scope_and_loopback_state(self):
        captured = {}
        threads = []
        def browser(auth_url, **kwargs):
            params = parse_qs(urlparse(auth_url).query)
            captured.update(params)
            def callback():
                redirect = params["redirect_uri"][0]
                invalid = redirect + "?" + urlencode({"code": "bad", "state": "bad-state"})
                try:
                    urlopen(invalid, timeout=3)
                except Exception:
                    pass
                with urlopen(redirect + "?" + urlencode({"code": "good", "state": params["state"][0]}), timeout=3) as response:
                    response.read()
            thread = threading.Thread(target=callback)
            thread.start()
            threads.append(thread)
            return True
        def exchange(url, **kwargs):
            self.assertEqual(url, api.GOOGLE_TOKEN)
            self.assertEqual(kwargs["data"]["code"], "good")
            verifier = kwargs["data"]["code_verifier"]
            challenge = base64.urlsafe_b64encode(api.hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
            self.assertEqual(challenge, captured["code_challenge"][0])
            return {"access_token": "fixture", "refresh_token": "fixture-refresh", "expires_in": 3600, "scope": api.GMAIL_SCOPE}
        with patch.object(api.webbrowser, "open", side_effect=browser), patch.object(api, "_request_json", side_effect=exchange):
            self.assertTrue(api.connect_gmail(self.config_path)["connected"])
        for thread in threads:
            thread.join(3)
        self.assertEqual(captured["scope"], [api.GMAIL_SCOPE])
        self.assertTrue(captured["redirect_uri"][0].startswith("http://127.0.0.1:"))


class QuoteTests(unittest.TestCase):
    def test_crypto_preserves_actual_trade_time(self):
        with patch.object(api, "_request_json", return_value={"price": "12345.6789", "time": "2026-11-09T23:59:01.123Z"}):
            quote = api.fetch_quote({"symbol": "BTC", "instrument_kind": "crypto", "market": "COINBASE", "currency": "USD"})
        self.assertEqual(quote["price"], "12345.6789")
        self.assertEqual(quote["as_of"], "2026-11-09T23:59:01.123000+00:00")
        self.assertEqual(quote["quote_type"], "last_trade")
        self.assertNotEqual(quote["as_of"], quote["fetched_at"])

    def test_twse_roc_date_and_close(self):
        quote = api.fetch_quote({"symbol": "2330", "instrument_kind": "stock", "market": "TWSE"},
                                twse_rows=[{"Code": "2330", "ClosingPrice": "1,234.50", "Date": "1151109"}])
        self.assertEqual((quote["price"], quote["currency"]), ("1234.50", "TWD"))
        self.assertEqual(quote["as_of"], "2026-11-09T13:30:00+08:00")
        self.assertEqual(quote["quote_type"], "closing")

    def test_twd_crypto_cost_uses_explicit_usd_quote(self):
        with patch.object(api, "_request_json", return_value={"price": "12345", "time": "2026-11-09T23:59:01Z"}) as request:
            quote = api.fetch_quote({"symbol": "BTC", "instrument_kind": "crypto", "market": "COINBASE", "currency": "TWD"})
        self.assertEqual(quote["currency"], "USD")
        self.assertIn("BTC-USD/ticker", request.call_args.args[0])

    def test_binance_explicit_market_uses_real_usdt_and_exact_trade_time(self):
        for cost_currency in ("TWD", "USD"):
            with patch.object(api, "_request_json", return_value=[{"price": "74854.76000000", "time": 1700000000123}]) as request:
                quote = api.fetch_quote({"symbol": "BTC", "market": "BINANCE", "instrument_kind": "crypto", "currency": cost_currency})
            self.assertEqual(quote["currency"], "USDT")
            self.assertEqual(quote["provider"], "Binance Spot")
            self.assertEqual(quote["price"], "74854.76000000")
            self.assertEqual(quote["as_of"], "2023-11-14T22:13:20.123000+00:00")
            self.assertEqual(quote["market"], "BINANCE")
            self.assertEqual(quote["quote_type"], "last_trade")
            self.assertEqual(parse_qs(urlparse(request.call_args.args[0]).query), {"symbol": ["BTCUSDT"], "limit": ["1"]})

    def test_binance_failure_preserves_cache_without_silent_provider_change(self):
        ledger = FakeLedger()
        ledger.quotes = [{"symbol": "BTC", "price": "1", "currency": "USDT", "provider": "Binance Spot"}]
        with patch.object(api, "_request_json", side_effect=RuntimeError("offline")) as request:
            result = api.update_quotes(ledger, [{"symbol": "BTC", "market": "BINANCE", "instrument_kind": "crypto", "currency": "TWD"}])
        self.assertEqual(result["updated"], 0)
        self.assertEqual(ledger.quotes[0]["price"], "1")
        self.assertEqual(len(result["errors"]), 1)
        self.assertEqual(request.call_count, 1)
        self.assertIn("data-api.binance.vision", request.call_args.args[0])

    def test_failure_keeps_cached_quote(self):
        ledger = FakeLedger()
        ledger.quotes = [{"symbol": "BTC", "price": "1"}]
        with patch.object(api, "_request_json", side_effect=RuntimeError("offline")):
            result = api.update_quotes(ledger, [{"symbol": "BTC", "instrument_kind": "crypto", "currency": "USD"}])
        self.assertEqual(result["updated"], 0)
        self.assertEqual(len(ledger.quotes), 1)
        self.assertEqual(len(result["errors"]), 1)

    def test_unknown_market_never_guessed(self):
        with patch.object(api, "_request_json") as request:
            with self.assertRaises(ValueError):
                api.fetch_quote({"symbol": "AAPL", "instrument_kind": "stock", "market": "NASDAQ"})
            request.assert_not_called()

    def test_invalid_price_rejected(self):
        for price in ("NaN", "Infinity", "-1", "0", "--"):
            with self.assertRaises(ValueError):
                api._positive_price(price)


class StatementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "statement.csv"

    def csv(self, content):
        self.path.write_text(content, encoding="utf-8-sig")
        return read_statement_csv(self.path)

    def test_expense_refund_transfer_and_date_precision(self):
        result = self.csv("date,amount,currency,merchant,kind,transaction_id\n2026/11/10,500,TWD,全聯,expense,a\n2026/11/10 12:00,100,TWD,全聯,refund,b\n2026/11/10,1000,TWD,信用卡繳款,transfer,c\n")
        self.assertEqual(len(result["rows"]), 3)
        self.assertEqual([row["kind"] for row in result["rows"]], ["expense", "income", "transfer"])
        self.assertTrue(all(row["force_review"] for row in result["rows"]))
        self.assertEqual(result["rows"][0]["date_precision"], "day")
        self.assertEqual(result["rows"][1]["date_precision"], "minute")
        self.assertTrue(result["warnings"])

    def test_missing_kind_does_not_guess(self):
        with self.assertRaises(ValueError):
            self.csv("date,amount,currency,merchant\n2026/11/10,500,TWD,全聯\n")

    def test_totals_negatives_duplicate_ids_and_invalid_dates_pending(self):
        result = self.csv("date,amount,currency,merchant,kind,transaction_id\n2026/11/10,500,TWD,全聯,expense,a\n2026/11/10,500,TWD,全聯,expense,a\n2026/11/10,500,TWD,本期總計,expense,total\n2026/11/10,-50,TWD,退款,refund,b\n2026/02/31,100,TWD,全聯,expense,c\n")
        self.assertEqual(len(result["rows"]), 1)
        self.assertEqual(len(result["pending"]), 4)

    def test_file_replay_identity_is_stable(self):
        result = self.csv("date,amount,currency,merchant,kind\n2026/11/10,500,TWD,全聯,expense\n")
        self.assertEqual(result["rows"][0]["external_id"], read_statement_csv(self.path)["rows"][0]["external_id"])

    def test_chinese_header_and_explicit_mapping(self):
        result = self.csv("交易日期,金額,幣別,商家,收支\n2026/11/10,500,TWD,全聯,支出\n")
        self.assertEqual(result["rows"][0]["amount"], "500")
        self.path.write_text("when,money,fx,shop,what\n2026/11/10,5,USD,shop,expense\n")
        result = read_statement_csv(self.path, mapping={"date": "when", "amount": "money", "currency": "fx", "merchant": "shop", "kind": "what"})
        self.assertEqual(result["rows"][0]["currency"], "USD")

    @unittest.skipUnless(importlib.util.find_spec("pypdf"), "PDF dependency optional")
    def test_encrypted_pdf_password_stays_in_memory(self):
        from pypdf import PdfWriter
        from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
        path = self.path.with_suffix(".pdf")
        writer = PdfWriter()
        page = writer.add_blank_page(width=500, height=200)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 20 100 Td (2026-11-10 MERCHANT SAMPLE TWD 500 EXPENSE) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        algorithm = "AES-256" if importlib.util.find_spec("cryptography") else "RC4-128"
        writer.encrypt("fixture-password", algorithm=algorithm)
        with path.open("wb") as stream:
            writer.write(stream)
        with self.assertRaises(ValueError):
            extract_pdf_text(path)
        with self.assertRaises(ValueError):
            extract_pdf_text(path, password="wrong")
        result = extract_pdf_text(path, password="fixture-password")
        self.assertEqual(result["page_count"], 1)
        self.assertIn("2026-11-10 MERCHANT SAMPLE TWD 500 EXPENSE", result["text"])
        self.assertNotIn("fixture-password", json.dumps(result))
        self.assertTrue(result["warnings"])


if __name__ == "__main__":
    unittest.main()
