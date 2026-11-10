"""Real HTTP transport and retry tests with disposable local SQLite databases."""

import http.client
import json
import sqlite3
from pathlib import Path
import tempfile
import threading
import unittest

from sync_server import MAX_BODY, SyncServer, is_local_address, load_or_create_token


class SyncTransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name)
        self.token = load_or_create_token(self.path / "token.txt")
        self.server = SyncServer(("127.0.0.1", 0), self.path / "ledger.sqlite3", self.token)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()
        self.directory.cleanup()

    def request(self, value=None, headers=None, path="/v1/sync", method="POST", raw=None):
        body = raw if raw is not None else json.dumps(value or {"records": []}).encode()
        default = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}
        default.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, body=body, headers=default)
        response = connection.getresponse()
        status = response.status
        data = json.loads(response.read())
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))
        connection.close()
        return status, data

    @staticmethod
    def record(**changes):
        record = {"source": "apple_pay", "external_id": "wallet-1", "amount": "500.00",
                  "currency": "TWD", "merchant": "測試商店", "occurred_at": "2026-11-10T12:30:00+08:00",
                  "account": "信用卡", "kind": "expense"}
        record.update(changes)
        return record

    def test_actual_upload_replay_and_empty_refresh(self):
        status, first = self.request({"records": [self.record()]})
        self.assertEqual(status, 200)
        self.assertTrue(first["results"][0]["ok"])
        self.assertEqual(first["results"][0]["source"], "apple_pay")
        self.assertEqual(first["entries"][0]["amount_minor"], 50000)
        self.assertEqual(first["currency_digits"]["TWD"], 2)
        status, retry = self.request({"records": [self.record()]})
        self.assertTrue(retry["results"][0]["result"]["duplicate"])
        self.assertEqual(len(retry["entries"]), 1)
        status, refresh = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(refresh["results"], [])
        self.assertEqual(refresh["entries"][0]["id"], first["entries"][0]["id"])

    def test_partial_batch_and_changed_replay_are_explicit(self):
        status, result = self.request({"records": [self.record(), {"source": "manual", "external_id": "bad"}]})
        self.assertEqual(status, 200)
        self.assertEqual([r["ok"] for r in result["results"]], [True, False])
        status, collision = self.request({"records": [self.record(amount="501")]})
        self.assertFalse(collision["results"][0]["ok"])
        self.assertEqual(collision["entries"][0]["amount_minor"], 50000)

    def test_bank_mismatch_stays_one_expense_and_survives_retry(self):
        self.request({"records": [self.record()]})
        bank = self.record(source="gmail", external_id="gmail-1", amount="515")
        status, result = self.request({"records": [bank]})
        self.assertEqual(status, 200)
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["amount_minor"], 50000)
        self.assertEqual(result["reviews"][0]["source"]["amount_minor"], 51500)
        self.assertEqual(result["reviews"][0]["reason"], "amount_mismatch")
        status, replay = self.request({"records": [bank]})
        self.assertEqual(len(replay["reviews"]), 1)
        self.assertEqual(len(replay["entries"]), 1)

    def test_authentication_rejects_missing_wrong_and_non_ascii(self):
        for auth in ("", "Bearer incorrect", "Bearer \u00ff"):
            status, _ = self.request({"records": [self.record()]}, {"Authorization": auth})
            self.assertEqual(status, 401)
        self.assertEqual(self.server.ledger.snapshot()["entries"], [])

    def test_host_and_browser_origin_rejected(self):
        for headers in ({"Host": "attacker.example"}, {"Origin": "http://localhost"},
                        {"Host": "127.0.0.1:1"}, {"Host": "user@127.0.0.1"}):
            status, _ = self.request({"records": [self.record()]}, headers)
            self.assertEqual(status, 403)
        self.assertEqual(self.server.ledger.snapshot()["entries"], [])

    def test_repeated_early_rejections_deliver_complete_json(self):
        # Windows can issue WinError 10053 if the server closes without consuming
        # a POST body. Verify the actual response on every fresh connection.
        for index in range(20):
            for headers in ({"Host": "attacker.example"}, {"Origin": "http://localhost"}):
                with self.subTest(index=index, headers=headers):
                    status, response = self.request({"records": [self.record()]}, headers)
                    self.assertEqual(status, 403)
                    self.assertIn("error", response)
        self.assertEqual(self.server.ledger.snapshot()["entries"], [])

    def test_rejection_does_not_wait_for_false_declared_length(self):
        # The client sends two bytes but advertises a full valid-size body.
        # Rejection must finish within the request helper's 3-second timeout,
        # without waiting for the normal 10-second read timeout.
        status, _ = self.request(raw=b"{}", headers={"Host": "attacker.example", "Content-Length": str(MAX_BODY)})
        self.assertEqual(status, 403)
        self.assertEqual(self.request()[0], 200)

    def test_payload_limits_and_type_validation(self):
        self.assertEqual(self.request(raw=b"{not-json")[0], 400)
        self.assertEqual(self.request({"records": "not-an-array"})[0], 400)
        self.assertEqual(self.request({"records": [self.record()] * 501})[0], 400)
        self.assertEqual(self.request(raw=b"{}", headers={"Content-Length": str(MAX_BODY + 1)})[0], 413)
        self.assertEqual(self.request(raw=b"{}", headers={"Transfer-Encoding": "chunked"})[0], 411)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)

    def test_unknown_paths_and_health_are_minimal(self):
        status, health = self.request(path="/health", method="GET", headers={"Authorization": ""})
        self.assertEqual(status, 200)
        self.assertEqual(set(health), {"service", "version"})
        self.assertEqual(self.request(path="/v1/sync?token=anything")[0], 404)

    def test_unexpected_storage_failure_does_not_acknowledge(self):
        # Fail inside the shared storage step used by single and batched ingestion.
        for error in (RuntimeError("secret internal connection details"),
                      sqlite3.OperationalError("secret internal connection details")):
            def failed(*_, error=error):
                raise error
            self.server.ledger._ingest_prepared = failed
            status, response = self.request({"records": [self.record(), self.record(external_id="second")]})
            self.assertEqual(status, 500)
            self.assertNotIn("secret", json.dumps(response))
            self.assertNotIn("results", response)
        del self.server.ledger._ingest_prepared
        self.assertEqual(self.server.ledger.snapshot()["sources"], [])

    def test_batched_request_reports_each_record_and_keeps_valid_ones(self):
        records = [self.record(), "not an object", self.record(external_id="bad", amount="NaN"), self.record(external_id="second", merchant="書店")]
        status, response = self.request({"records": records})
        self.assertEqual(status, 200)
        self.assertEqual([item["ok"] for item in response["results"]], [True, False, False, True])
        self.assertEqual(response["results"][1]["error"], "Record must be an object")
        self.assertEqual(response["results"][3]["external_id"], "second")
        self.assertEqual(len(response["entries"]), 2)

    def test_token_persists_and_invalid_file_does_not_silently_rotate(self):
        self.assertEqual(load_or_create_token(self.path / "token.txt"), self.token)
        (self.path / "token.txt").write_text("too-short")
        with self.assertRaises(ValueError):
            load_or_create_token(self.path / "token.txt")

    def test_bind_and_address_scope(self):
        for value in ("127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.5.1"):
            self.assertTrue(is_local_address(value), value)
        for value in ("8.8.8.8", "169.254.1.1", "172.32.0.1", "224.0.0.1", "0.0.0.0", "example.com"):
            self.assertFalse(is_local_address(value), value)
        with self.assertRaises(ValueError):
            SyncServer(("8.8.8.8", 8765), self.path / "unused.sqlite3", self.token)


if __name__ == "__main__":
    unittest.main()
