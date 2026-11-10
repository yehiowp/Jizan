"""Opt-in, authenticated private-LAN transport for the offline ledger.

No discovery, cloud relay, port forwarding, cookies, CORS, or arbitrary commands.
The core Ledger owns validation and idempotency. Run without --lan for loopback.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import time
from urllib.parse import urlsplit

from ledger import Ledger, default_data_dir

MAX_BODY = 1024 * 1024
MAX_RECORDS = 500
MAX_RESPONSE = 8 * 1024 * 1024
REJECT_DRAIN_SECONDS = 0.25


def load_or_create_token(path: Path) -> str:
    """Token is local configuration, never part of ledger backups or HTTP logs."""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        token = path.read_text(encoding="utf-8").strip()
    else:
        token = secrets.token_urlsafe(32)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(token + "\n")
    if len(token) < 32 or len(token) > 256 or not all(c.isalnum() or c in "-_" for c in token):
        raise ValueError("Invalid pairing token file; restore it or remove it to pair again")
    return token


def is_local_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
        return address.is_loopback or any(
            address in network for network in (
                ipaddress.ip_network("10.0.0.0/8"),
                ipaddress.ip_network("172.16.0.0/12"),
                ipaddress.ip_network("192.168.0.0/16"),
            ) if address.version == network.version
        )
    except ValueError:
        return False


def local_addresses() -> set[str]:
    addresses = {"127.0.0.1", "localhost"}
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            value = item[4][0]
            if is_local_address(value):
                addresses.add(value)
    except OSError:
        pass
    return addresses


class SyncServer(HTTPServer):
    allow_reuse_address = True

    def __init__(self, address, database: Path, token: str, allowed_hosts=None):
        if not (address[0] == "0.0.0.0" or is_local_address(address[0])):
            raise ValueError("Sync binds only to loopback or private LAN addresses")
        self.ledger = Ledger(database)
        self.token = token
        self.allowed_hosts = set(allowed_hosts or local_addresses())
        if address[0] != "0.0.0.0":
            self.allowed_hosts.add(address[0])
        super().__init__(address, SyncHandler)


class SyncHandler(BaseHTTPRequestHandler):
    server_version = "LocalLedger/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)
        self._request_body_read = False

    def log_message(self, format, *args):
        # Avoid logging source records, URLs, account identifiers, or pairing codes.
        pass

    def _discard_rejected_body(self):
        """Avoid resetting Windows TCP before the client receives a rejection.

        Closing a socket with unread POST bytes can discard the response. Drain
        small, already-sent bodies without parsing them. Both the byte count and
        total elapsed time are bounded, even for missing/misleading framing or a
        client that continuously drips bytes. Successful requests read normally.
        """
        if self._request_body_read:
            return
        lengths = self.headers.get_all("Content-Length", [])
        if not lengths and self.headers.get("Transfer-Encoding") is None:
            return
        try:
            declared = int(lengths[0]) if len(lengths) == 1 else -1
        except ValueError:
            declared = -1
        remaining = declared if 0 <= declared <= MAX_BODY else MAX_BODY
        original_timeout = self.connection.gettimeout()
        deadline = time.monotonic() + REJECT_DRAIN_SECONDS
        try:
            while remaining:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    break
                self.connection.settimeout(timeout)
                # read1 performs at most one underlying read, so the absolute
                # deadline is checked between chunks rather than reset forever.
                chunk = self.rfile.read1(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
        except (OSError, ValueError):
            pass
        finally:
            self.connection.settimeout(original_timeout)
            self._request_body_read = True

    def _send(self, status: int, value: dict):
        self._discard_rejected_body()
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) > MAX_RESPONSE:
            status = 413
            body = b'{"error":"Ledger snapshot exceeds this prototype transport limit"}'
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.wfile.write(body)

    def _valid_host(self) -> bool:
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            return False
        try:
            parsed = urlsplit("//" + hosts[0])
            return (
                parsed.hostname in self.server.allowed_hosts
                and parsed.port in (None, self.server.server_port)
                and not parsed.username and not parsed.password
                and not parsed.path and not parsed.query and not parsed.fragment
            )
        except ValueError:
            return False

    def _authorized(self) -> bool:
        if not is_local_address(self.client_address[0]) or not self._valid_host():
            self._send(403, {"error": "Private LAN and local Host required"})
            return False
        # Origin-bearing requests are browser requests. No browser integration is exposed.
        if self.headers.get("Origin") is not None:
            self._send(403, {"error": "Browser origins are not supported"})
            return False
        auth = self.headers.get_all("Authorization", [])
        if len(auth) != 1 or not hmac.compare_digest(auth[0].encode("utf-8"), ("Bearer " + self.server.token).encode("utf-8")):
            self._send(401, {"error": "Pairing token required"})
            return False
        return True

    def do_GET(self):
        if self.path != "/health":
            self._send(404, {"error": "Not found"})
        elif not is_local_address(self.client_address[0]) or not self._valid_host():
            self._send(403, {"error": "Private LAN and local Host required"})
        else:
            self._send(200, {"service": "personal-ledger", "version": 1})

    def do_POST(self):
        if self.path != "/v1/sync":
            self._send(404, {"error": "Not found"})
            return
        if not self._authorized():
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1:
            self._send(411, {"error": "One Content-Length required"})
            return
        try:
            length = int(lengths[0])
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            self._send(413, {"error": "Request must be between 1 byte and 1 MiB"})
            return
        if self.headers.get_content_type() != "application/json":
            self._send(415, {"error": "application/json required"})
            return
        try:
            raw = self.rfile.read(length)
            self._request_body_read = True
            if len(raw) != length:
                raise ValueError("Incomplete request")
            payload = json.loads(raw)
            records = payload.get("records") if isinstance(payload, dict) else None
            if not isinstance(records, list) or len(records) > MAX_RECORDS:
                raise ValueError("records must be an array with at most 500 records")
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": "Invalid JSON or records array"})
            return
        try:
            # Records commit together in chunks; each one is still validated and
            # isolated individually, so a rejected record does not affect the rest.
            outcomes = self.server.ledger.ingest_many(records)
        except Exception:
            outcomes = None
        if outcomes is None or any(outcome.get("retryable") for outcome in outcomes):
            # Earlier records may have committed. Retrying is safe through Ledger idempotency.
            self._send(500, {"error": "Storage failed; keep pending records and retry"})
            return
        results = []
        for record, outcome in zip(records, outcomes):
            external_id = record.get("external_id") if isinstance(record, dict) else None
            source = record.get("source") if isinstance(record, dict) else None
            if outcome["ok"]:
                results.append({"source": source, "external_id": external_id, "ok": True, "result": outcome["result"]})
            else:
                message = str(outcome["error"]) if isinstance(record, dict) else "Record must be an object"
                results.append({"source": source, "external_id": external_id, "ok": False, "error": message[:300]})
        try:
            snapshot = self.server.ledger.snapshot()
            self._send(200, {
                **snapshot,
                "results": results,
                "server_time": datetime.now(timezone.utc).isoformat(),
            })
        except Exception:
            self._send(500, {"error": "Snapshot failed; keep pending records and retry"})


def main():
    base = default_data_dir()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=base / "ledger.sqlite3")
    parser.add_argument("--token-file", type=Path, default=base / "sync-token.txt")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--lan", action="store_true", help="Opt in to trusted private LAN access")
    parser.add_argument("--show-pairing", action="store_true", help="Display pairing token locally")
    parser.add_argument("--tls-cert", type=Path)
    parser.add_argument("--tls-key", type=Path)
    args = parser.parse_args()
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("--tls-cert and --tls-key must be supplied together")
    token = load_or_create_token(args.token_file)
    bind = "0.0.0.0" if args.lan else "127.0.0.1"
    server = SyncServer((bind, args.port), args.database, token)
    scheme = "http"
    if args.tls_cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.tls_cert, args.tls_key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
        scheme = "https"
    print(f"Sync listening at {scheme}://{bind}:{server.server_port}")
    if args.lan and not args.tls_cert:
        print("LAN HTTP is not encrypted. Use only a trusted private Wi-Fi network; do not expose this port to the internet.")
    print(f"Pairing token file: {args.token_file.resolve()}")
    if args.show_pairing:
        print(f"Pairing token: {token}")
    print("Allowed local IPs: " + ", ".join(sorted(server.allowed_hosts)))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
