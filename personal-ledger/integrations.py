"""Local, conservative notification ingestion and public market data adapters.

Only Python's standard library is required. Email bodies are untrusted data;
neither links nor instructions in messages are executed.
"""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from email.utils import getaddresses
import hashlib
import html
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse, quote
from urllib.request import Request, urlopen
import webbrowser

GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
COINBASE_URL = "https://api.exchange.coinbase.com/products/{product}/ticker"
BINANCE_TRADES_URL = "https://data-api.binance.vision/api/v3/trades"
MAX_RESPONSE = 8 * 1024 * 1024


class ServiceHTTPError(RuntimeError):
    def __init__(self, status, reason=""):
        self.status, self.reason = status, reason
        super().__init__(f"服務回應 HTTP {status}；請稍後重試或重新授權")


def _data_dir() -> Path:
    from ledger import default_data_dir
    return default_data_dir()


def _config_path(path=None) -> Path:
    return Path(path) if path else _data_dir() / "gmail.json"


def gmail_config_template() -> dict:
    return {"oauth_client_file": "", "senders": [], "label": "", "account": "日常消費",
            "timezone_offset": "+08:00", "lookback_days": 30}


def _atomic_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def _offset(value: str) -> timezone:
    if not re.fullmatch(r"[+-](?:0\d|1[0-4]):[0-5]\d", value):
        raise ValueError("時區須使用 +08:00 格式")
    hours, minutes = map(int, value[1:].split(":"))
    if hours == 14 and minutes:
        raise ValueError("時區超出範圍")
    return timezone(timedelta(minutes=(hours * 60 + minutes) * (1 if value[0] == "+" else -1)))


def _timestamp(value: str, timezone_offset=None) -> str:
    value = str(value).strip().replace("Z", "+00:00")
    # Explicit full dates only: no inferred year and no mail reception time.
    value = re.sub(r"(\d{4})[年/](\d{1,2})[月/](\d{1,2})日?", r"\1-\2-\3", value)
    value = re.sub(r"(\d{4}-)(\d)(-)(\d)(?=[ T])", r"\g<1>0\2\g<3>0\4", value)
    match = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*([+-]\d{2}:?\d{2})?", value)
    if not match:
        raise ValueError("需要含完整年份、日期及時間的交易時間")
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    tz = _offset(zone if ":" in (zone or "") else zone[:3] + ":" + zone[3:]) if zone else (_offset(timezone_offset) if timezone_offset else None)
    if tz is None:
        raise ValueError("交易時間未提供時區；請設定來源時區")
    dt = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second or 0),
                  int(((fraction or ".")[1:] + "000000")[:6]), tzinfo=tz)
    return dt.isoformat()


_DATE = re.compile(r"(?<!\d)\d{4}(?:[-/]\d{1,2}[-/]\d{1,2}|年\d{1,2}月\d{1,2}日)\s*[T ]\s*\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?")
_MONEY = re.compile(r"(?<![A-Za-z])(?P<currency>NT\$|NTD|TWD|新臺幣|新台幣|台幣|USD|US\$|美元|EUR|歐元|JPY|日圓|HKD|港幣|CNY|RMB|人民幣)\s*(?P<amount>\d[\d,]*(?:\.\d+)?)", re.I)
_CURRENCIES = {"NT$": "TWD", "NTD": "TWD", "新臺幣": "TWD", "新台幣": "TWD", "台幣": "TWD", "US$": "USD", "美元": "USD", "歐元": "EUR", "日圓": "JPY", "港幣": "HKD", "RMB": "CNY", "人民幣": "CNY"}


def parse_notification(text: str, source="gmail", external_id=None, account="日常消費",
                       occurred_at=None, timezone_offset=None) -> dict:
    """Return a preview. Only a complete transaction with no warnings may auto-post.

    Generic support deliberately requires an explicit merchant label, currency,
    unambiguous amount, full transaction timestamp and purchase indication.
    Bank-specific templates can be added after a sanitized real sample exists.
    """
    if source not in {"gmail", "apple_pay", "manual", "statement"}:
        raise ValueError("不支援的來源")
    text = html.unescape(str(text)).replace("\r\n", "\n").strip()
    if not text or len(text) > 200_000:
        raise ValueError("通知內容為空或超過 200 KB")
    lead = text[:500]
    if re.search(r"(?:電子|信用卡|月結|本期)帳單|monthly statement|account statement", lead, re.I):
        return {"transaction": None, "warnings": [], "reason": "帳單應使用帳單對帳入口，不能當作單筆消費", "classification": "statement"}
    if re.search(r"(?:驗證碼|動態密碼|one.time password|\bOTP\b)", lead, re.I):
        return {"transaction": None, "warnings": [], "reason": "驗證訊息不入帳", "classification": "otp"}
    warnings = []
    refund = bool(re.search(r"退款|退貨|退刷|refund|reversal|取消交易", lead, re.I))
    transfer = bool(re.search(r"轉帳|轉入|轉出|繳款|繳費成功|payment received|\btransfer\b", lead, re.I))
    if refund:
        warnings.append("退款／取消交易需人工關聯原消費")
    if transfer:
        warnings.append("轉帳／繳款需人工確認帳戶與交易類型")
    if not re.search(r"消費|刷卡|交易|purchase|spent|paid|payment|退款|refund|轉帳|transfer", lead, re.I):
        warnings.append("尚未識別為交易通知")

    candidates = []
    for found in _MONEY.finditer(text):
        raw = found.group("amount")
        if found.end() < len(text) and text[found.end()] in ".,0123456789eE百千萬億":
            warnings.append("金額格式不明，不能擷取部分數字入帳")
            continue
        if "," in raw and not re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", raw):
            warnings.append("金額千分位格式不明")
            continue
        currency = found.group("currency").upper()
        currency = _CURRENCIES.get(currency, currency)
        amount = Decimal(raw.replace(",", ""))
        candidate = (currency, format(amount, "f"))
        if candidate not in candidates:
            candidates.append(candidate)
    # Also support labelled currency and amount fields, in either language.
    if not candidates:
        cm = re.search(r"(?:幣別|currency)\s*[:：]\s*([A-Z]{3})\b", text, re.I)
        am = re.search(r"(?:交易金額|消費金額|金額|amount)\s*[:：]\s*(\d[\d,]*(?:\.\d+)?)", text, re.I)
        if cm and am:
            raw = am.group(1)
            if am.end() < len(text) and text[am.end()] in ".,0123456789eE百千萬億":
                warnings.append("金額格式不明，不能擷取部分數字入帳")
            elif "," not in raw or re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", raw):
                candidates.append((cm.group(1).upper(), format(Decimal(raw.replace(",", "")), "f")))
    if len(candidates) != 1:
        warnings.append("缺少明確幣別及金額" if not candidates else "出現多個金額或幣別，需確認原幣、扣款與費用")

    merchant_match = re.search(r"(?:消費商店|交易商店|商店名稱|商家|商店|merchant)\s*[:：]\s*([^\n;；]+)", text, re.I)
    merchant = merchant_match.group(1).strip() if merchant_match else ""
    merchant = re.split(r"\s+(?:金額|交易金額|消費金額|幣別|時間|日期|amount|currency|date)\s*[:：]", merchant, maxsplit=1, flags=re.I)[0].strip()
    if not merchant or len(merchant) > 200:
        warnings.append("缺少明確商家欄位")

    timestamps = list(dict.fromkeys(m.group(0).strip() for m in _DATE.finditer(text)))
    transaction_time = None
    if not occurred_at and len(timestamps) != 1:
        warnings.append("缺少完整交易時間" if not timestamps else "出現多個時間，需確認交易時間")
    else:
        try:
            transaction_time = _timestamp(occurred_at or timestamps[0], timezone_offset)
        except ValueError as exc:
            warnings.append(str(exc))
    transaction = {"source": source, "external_id": str(external_id or hashlib.sha256(text.encode()).hexdigest()),
                   "account": account, "merchant": merchant, "occurred_at": transaction_time,
                   "kind": "transfer" if transfer else "income" if refund else "expense",
                   "description": "refund" if refund else "", "raw_text": text}
    if len(candidates) == 1:
        transaction.update(currency=candidates[0][0], amount=candidates[0][1])
        if Decimal(candidates[0][1]) <= 0:
            warnings.append("交易金額必須大於零")
    return {"transaction": transaction, "warnings": list(dict.fromkeys(warnings)), "reason": None,
            "classification": "refund" if refund else "transfer" if transfer else "transaction",
            "amount_candidates": [{"currency": c, "amount": a} for c, a in candidates]}


def _request_json(url, *, method="GET", data=None, headers=None, timeout=12, attempts=2):
    request_headers = {"Accept": "application/json", "User-Agent": "PersonalLedger/0.1"}
    request_headers.update(headers or {})
    payload = None
    if data is not None:
        payload = urlencode(data).encode("ascii")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    for attempt in range(attempts):
        try:
            with urlopen(Request(url, data=payload, headers=request_headers, method=method), timeout=timeout) as response:
                raw = response.read(MAX_RESPONSE + 1)
                if len(raw) > MAX_RESPONSE:
                    raise ValueError("服務回應超過大小限制")
                return json.loads(raw.decode("utf-8-sig"))
        except HTTPError as exc:
            if attempt + 1 < attempts and (exc.code == 429 or exc.code >= 500):
                time.sleep(min(2 ** attempt, 2))
                continue
            # Read only to classify an expired cursor; response content never
            # enters logs or exception messages, which might expose mail data.
            reason = ""
            if exc.code == 400:
                try:
                    error = json.loads(exc.read(64 * 1024)).get("error", {})
                    if re.search(r"page[ _-]*token", str(error.get("message", "")), re.I):
                        reason = "invalidPageToken"
                except (ValueError, AttributeError):
                    pass
            raise ServiceHTTPError(exc.code, reason) from None
        except (URLError, TimeoutError, socket.timeout) as exc:
            if attempt + 1 < attempts:
                time.sleep(0.5)
                continue
            detail = "憑證驗證失敗，請檢查 Windows 信任憑證" if "CERTIFICATE_VERIFY_FAILED" in str(exc) else "網路連線失敗或逾時"
            raise RuntimeError(detail) from None
    raise RuntimeError("無法取得服務回應")


def _load_config(path=None) -> tuple[Path, dict]:
    path = _config_path(path)
    if not path.exists():
        raise ValueError(f"請先建立 Gmail 設定：{path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError("Gmail 設定必須是 JSON 物件")
    senders = data.get("senders", [])
    if isinstance(senders, str) or not isinstance(senders, list):
        raise ValueError("senders 必須是寄件者清單")
    for sender in senders:
        if not isinstance(sender, str) or not re.fullmatch(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", sender):
            raise ValueError("寄件者須為完整電子郵件地址，不能使用搜尋語法")
    data["senders"] = [s.lower() for s in senders]
    if not senders and not str(data.get("label", "")).strip():
        raise ValueError("請設定銀行寄件者白名單或專用 Gmail 標籤；不讀取整個收件匣")
    if data.get("timezone_offset"):
        _offset(data["timezone_offset"])
    days = int(data.get("lookback_days", 30))
    if not 1 <= days <= 366:
        raise ValueError("lookback_days 須在 1 到 366 之間")
    data["lookback_days"] = days
    return path, data


def _client(config: dict, config_path: Path) -> dict:
    value = config.get("oauth_client_file")
    if not value:
        raise ValueError("請先選擇 Google Desktop app OAuth 用戶端 JSON 檔")
    path = Path(value)
    if not path.is_absolute():
        path = config_path.parent / path
    body = json.loads(path.read_text(encoding="utf-8-sig"))
    client = body.get("installed")
    if not isinstance(client, dict) or not str(client.get("client_id", "")).endswith(".apps.googleusercontent.com"):
        raise ValueError("必須使用 Desktop app 類型 OAuth JSON，不能使用 Web 或手機用戶端")
    return client


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(raw: bytes, decrypt=False) -> bytes:
    buffer = ctypes.create_string_buffer(raw)
    incoming = _Blob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = _Blob()
    crypt32 = ctypes.windll.crypt32
    action = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    action.argtypes = [ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    action.restype = wintypes.BOOL
    if not action(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise RuntimeError("Windows 無法保護／解開 Gmail 授權資料")
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(outgoing.pbData)


def _token_path(config_path: Path) -> Path:
    # Separate configurations get separate credentials; tokens never go to the project.
    suffix = hashlib.sha256(str(config_path.resolve()).encode()).hexdigest()[:16]
    return _data_dir() / ("gmail-token-" + suffix + ".json")


def _save_token(path: Path, token: dict) -> None:
    raw = json.dumps(token).encode()
    if os.name == "nt":
        _atomic_json(path, {"format": "windows-dpapi", "data": base64.b64encode(_dpapi(raw)).decode()})
    else:
        _atomic_json(path, {"format": "local-user-file", "data": base64.b64encode(raw).decode()})
        path.chmod(0o600)


def _read_token(path: Path) -> dict:
    body = json.loads(path.read_text(encoding="utf-8"))
    raw = base64.b64decode(body["data"])
    if body["format"] == "windows-dpapi":
        if os.name != "nt":
            raise RuntimeError("此授權檔只能由原 Windows 使用者解開")
        raw = _dpapi(raw, decrypt=True)
    elif body["format"] != "local-user-file" or os.name == "nt":
        raise RuntimeError("不接受未保護的 Windows 授權檔")
    return json.loads(raw)


def gmail_status(config_path=None) -> dict:
    try:
        path, config = _load_config(config_path)
        _client(config, path)
        connected = _token_path(path).exists()
        return {"configured": True, "connected": connected, "message": "已儲存授權，連線時驗證" if connected else "設定完成，尚未授權 Gmail"}
    except (OSError, ValueError, TypeError) as exc:
        return {"configured": False, "connected": False, "message": str(exc)}


def connect_gmail(config_path=None, open_browser=True, timeout=180) -> dict:
    path, config = _load_config(config_path)
    client = _client(config, path)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    result = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            query = parse_qs(parsed.query)
            valid = parsed.path == "/oauth2callback" and secrets.compare_digest(query.get("state", [""])[0], state)
            if valid:
                result.update({k: v[0] for k, v in query.items()})
            self.send_response(200 if valid else 400)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(("授權回應已收到，請關閉分頁並回到個人帳本。" if valid else "無效的授權回應。").encode())

        def log_message(self, *args):
            pass  # Authorization codes must never enter logs.

    with HTTPServer(("127.0.0.1", 0), Callback) as server:
        server.timeout = 1
        redirect = f"http://127.0.0.1:{server.server_port}/oauth2callback"
        auth_url = GOOGLE_AUTH + "?" + urlencode({"client_id": client["client_id"], "redirect_uri": redirect,
                "response_type": "code", "scope": GMAIL_SCOPE, "access_type": "offline", "prompt": "consent",
                "state": state, "code_challenge": challenge, "code_challenge_method": "S256"})
        if not open_browser:
            raise ValueError("請在可開啟瀏覽器的 Windows 桌面執行 Gmail 授權")
        if not webbrowser.open(auth_url, new=1):
            raise RuntimeError("無法開啟 Google 授權頁面；請檢查預設瀏覽器")
        deadline = time.monotonic() + max(10, min(int(timeout), 300))
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if "error" in result:
        raise RuntimeError("Google 授權未完成或遭拒絕")
    if not result.get("code"):
        raise RuntimeError("Gmail 授權逾時；尚未讀取郵件")
    fields = {"code": result["code"], "client_id": client["client_id"], "redirect_uri": redirect,
              "grant_type": "authorization_code", "code_verifier": verifier}
    if client.get("client_secret"):
        fields["client_secret"] = client["client_secret"]
    token = _request_json(GOOGLE_TOKEN, method="POST", data=fields, attempts=1)
    if token.get("scope", "") != GMAIL_SCOPE or not token.get("access_token"):
        raise RuntimeError("Google 未回傳預期的 Gmail 唯讀權限；授權未保存")
    token["expires_at"] = time.time() + int(token.get("expires_in", 3600))
    _save_token(_token_path(path), token)
    return {"connected": True, "message": "Gmail 唯讀授權完成；僅會讀取設定的交易郵件"}


def _access_token(path: Path, config: dict) -> str:
    token_path = _token_path(path)
    if not token_path.exists():
        raise ValueError("請先完成 Gmail 唯讀授權")
    token = _read_token(token_path)
    if token.get("scope") != GMAIL_SCOPE:
        raise ValueError("授權範圍不符合 Gmail 唯讀設定，請重新授權")
    if float(token.get("expires_at", 0)) < time.time() + 60:
        client = _client(config, path)
        if not token.get("refresh_token"):
            raise ValueError("授權已過期且無更新憑證，請重新授權 Gmail")
        fields = {"grant_type": "refresh_token", "client_id": client["client_id"], "refresh_token": token["refresh_token"]}
        if client.get("client_secret"):
            fields["client_secret"] = client["client_secret"]
        fresh = _request_json(GOOGLE_TOKEN, method="POST", data=fields, attempts=1)
        if "scope" in fresh and fresh["scope"] != GMAIL_SCOPE:
            raise ValueError("Gmail 更新授權範圍有異，請重新授權")
        token.update(fresh)
        token["expires_at"] = time.time() + int(fresh.get("expires_in", 3600))
        _save_token(token_path, token)
    if not token.get("access_token"):
        raise ValueError("授權資料不完整，請重新授權")
    return token["access_token"]


class _HTMLText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.hidden += 1
        if tag in {"br", "p", "div", "tr", "td", "li"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        if tag in {"p", "div", "tr", "td", "li"}:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def _body_text(part: dict) -> str:
    if part.get("filename"):
        return ""  # Do not download or parse attachments in notification sync.
    parts = part.get("parts", [])
    if parts:
        if part.get("mimeType") == "multipart/alternative":
            plain = next((p for p in parts if p.get("mimeType") == "text/plain"), None)
            if plain:
                return _body_text(plain)
        return "\n".join(_body_text(p) for p in parts)
    raw = part.get("body", {}).get("data", "")
    if not raw or part.get("mimeType") not in {"text/plain", "text/html"}:
        return ""
    decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", errors="replace")
    if part.get("mimeType") == "text/html":
        parser = _HTMLText()
        parser.feed(decoded)
        return "".join(parser.parts)
    return decoded


def _authenticated_sender(headers: list[dict], allowlist: list[str]) -> tuple[bool, str]:
    from_headers = [h["value"] for h in headers if h.get("name", "").lower() == "from"]
    addresses = getaddresses(from_headers)
    if len(addresses) != 1 or addresses[0][1].lower() not in allowlist:
        return False, "寄件者不在已設定白名單，需人工核對"
    domain = addresses[0][1].lower().rsplit("@", 1)[1]
    # The first mx.google.com result is the closest receiving Gmail result.
    auth = next((h.get("value", "") for h in headers if h.get("name", "").lower() == "authentication-results"
                 and re.match(r"\s*mx\.google\.com\s*;", h.get("value", ""), re.I)), "")
    clauses = auth.split(";")[1:]
    for clause in clauses:
        if re.search(r"\bdmarc=pass\b", clause, re.I) and re.search(r"\bheader\.from=" + re.escape(domain) + r"(?:\s|$)", clause, re.I):
            return True, ""
        if re.search(r"\bdkim=pass\b", clause, re.I):
            if re.search(r"\bheader\.(?:d|i)=@?" + re.escape(domain) + r"(?:\s|$)", clause, re.I):
                return True, ""
        if re.search(r"\bspf=pass\b", clause, re.I):
            if re.search(r"\bsmtp\.mailfrom=(?:[^\s@;]+@)?" + re.escape(domain) + r"(?:\s|$)", clause, re.I):
                return True, ""
    return False, "未取得 Gmail 對寄件者網域相符的驗證結果，需人工核對"


def sync_gmail(ledger, config_path=None, max_messages=50) -> dict:
    """Fetch only scoped mail. Uncertain previews persist locally for manual review."""
    path, config = _load_config(config_path)
    headers = {"Authorization": "Bearer " + _access_token(path, config)}
    label_id = None
    if config.get("label"):
        labels = _request_json(GMAIL_API + "/labels", headers=headers).get("labels", [])
        label_id = next((x["id"] for x in labels if x.get("name") == config["label"] and x.get("type") == "user"), None)
        if not label_id:
            raise ValueError("找不到指定 Gmail 自訂標籤；請先在 Gmail 建立專用交易標籤")
    query = f"newer_than:{config['lookback_days']}d -in:spam -in:trash"
    if config["senders"]:
        query += " {" + " ".join("from:" + s for s in config["senders"]) + "}"
    summary = {"imported": 0, "duplicates": 0, "skipped": 0, "pending": [], "errors": []}
    config_id = hashlib.sha256(str(path.resolve()).encode()).hexdigest()[:16]
    pending_path = _data_dir() / ("gmail-pending-" + config_id + ".json")
    cursor_path = _data_dir() / ("gmail-cursor-" + config_id + ".json")
    pending = json.loads(pending_path.read_text(encoding="utf-8")) if pending_path.exists() else {}
    if hasattr(ledger, "external_ids"):
        # Index-only lookup; a periodic sync must not rebuild the whole ledger snapshot.
        known_ids = {str(value) for value in ledger.external_ids("gmail")}
    else:
        known_ids = {str(row["external_id"]) for row in ledger.snapshot().get("sources", []) if row.get("source") == "gmail"}
    pending = {key: value for key, value in pending.items() if key not in known_ids}
    scope = hashlib.sha256(json.dumps({"query": query, "label_id": label_id, "account": config.get("account"),
                                       "timezone_offset": config.get("timezone_offset")}, sort_keys=True).encode()).hexdigest()
    cursor = json.loads(cursor_path.read_text(encoding="utf-8")) if cursor_path.exists() else {}
    next_page = cursor.get("page_token") if cursor.get("scope") == scope else None
    processed, cursor_reset = 0, False
    limit = max(1, min(int(max_messages), 500))
    while processed < limit:
        params = {"q": query, "maxResults": min(100, limit - processed)}
        if label_id:
            params["labelIds"] = label_id
        if next_page:
            params["pageToken"] = next_page
        try:
            result = _request_json(GMAIL_API + "/messages?" + urlencode(params), headers=headers)
        except ServiceHTTPError as exc:
            if next_page and not cursor_reset and exc.status == 400 and exc.reason == "invalidPageToken":
                # Gmail cursors can expire. Restart once; source IDs make replay
                # safe and prevent a reset from generating duplicate expenses.
                next_page, cursor_reset = None, True
                continue
            raise
        for stub in result.get("messages", [])[:limit - processed]:
            processed += 1
            external_id = stub["id"]
            if external_id in known_ids:
                summary["duplicates"] += 1
                pending.pop(external_id, None)
                continue
            try:
                message = _request_json(GMAIL_API + "/messages/" + quote(external_id, safe="") + "?format=full", headers=headers)
                payload = message.get("payload", {})
                mail_headers = payload.get("headers", [])
                subject = next((h["value"] for h in mail_headers if h.get("name", "").lower() == "subject"), "")
                text = subject + "\n" + _body_text(payload)
                preview = parse_notification(text, external_id=external_id, account=config.get("account", "日常消費"),
                                             timezone_offset=config.get("timezone_offset"))
                if not preview["transaction"]:
                    summary["skipped"] += 1
                    pending.pop(external_id, None)
                    continue
                verified, reason = _authenticated_sender(mail_headers, config["senders"])
                if not verified:
                    preview["warnings"].append(reason)
                if preview["warnings"]:
                    preview["external_id"] = external_id
                    pending[external_id] = preview
                else:
                    outcome = ledger.ingest(preview["transaction"])
                    duplicate = bool(outcome.get("duplicate")) or outcome.get("status") == "duplicate"
                    summary["duplicates" if duplicate else "imported"] += 1
                    pending.pop(external_id, None)
                    known_ids.add(external_id)
            except (ValueError, RuntimeError, OSError, KeyError) as exc:
                summary["errors"].append({"message_id": external_id, "error": str(exc)})
        next_page = result.get("nextPageToken")
        _atomic_json(pending_path, pending)
        _atomic_json(cursor_path, {"scope": scope, "page_token": next_page})
        if not next_page or not result.get("messages"):
            break
    _atomic_json(pending_path, pending)
    summary["pending"] = list(pending.values())
    summary["pending_file"] = str(pending_path)
    summary["has_more"] = bool(next_page)
    summary["message"] = "尚有更早郵件，下次同步繼續" if next_page else "已完成此篩選範圍的郵件同步"
    summary["cursor_reset"] = cursor_reset
    return summary


def _positive_price(raw) -> str:
    try:
        value = Decimal(str(raw).replace(",", ""))
    except InvalidOperation:
        raise ValueError("報價不是有效數字") from None
    if not value.is_finite() or value <= 0:
        raise ValueError("報價必須是有限正數")
    return format(value, "f")


def _twse_date(raw: str) -> str:
    raw = str(raw).replace("/", "").replace("-", "")
    if len(raw) == 7:  # Official ROC calendar date.
        raw = str(int(raw[:3]) + 1911) + raw[3:]
    if not re.fullmatch(r"\d{8}", raw):
        raise ValueError("證交所未提供有效交易日期")
    date = datetime.strptime(raw, "%Y%m%d")
    return date.strftime("%Y-%m-%d") + "T13:30:00+08:00"


def fetch_quote(asset: dict, *, twse_rows=None) -> dict:
    symbol = str(asset.get("symbol", "")).upper()
    kind = asset.get("instrument_kind", asset.get("asset_type", asset.get("kind", "")))
    market = str(asset.get("market", "")).upper()
    fetched_at = datetime.now(timezone.utc).isoformat()
    if kind == "crypto":
        currency = str(asset.get("quote_currency") or asset.get("currency") or "USD").upper()
        if market == "BINANCE":
            # USD/TWD acquisition costs do not identify a Binance quote asset.
            # Use the actual USDT product and keep its denomination explicit;
            # this performs no currency conversion and assumes no USD parity.
            if currency in {"TWD", "USD"}:
                currency = "USDT"
            if not re.fullmatch(r"[A-Z0-9]{1,20}", symbol) or not re.fullmatch(r"[A-Z0-9]{2,10}", currency):
                raise ValueError("無效的加密貨幣交易對")
            result = _request_json(BINANCE_TRADES_URL + "?" + urlencode({"symbol": symbol + currency, "limit": 1}))
            if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
                raise ValueError("Binance 未回傳單筆最近成交資料")
            trade = result[0]
            timestamp_ms = trade.get("time")
            if not isinstance(timestamp_ms, int) or isinstance(timestamp_ms, bool) or not 0 < timestamp_ms < 32_503_680_000_000:
                raise ValueError("Binance 未回傳有效成交時間")
            seconds, milliseconds = divmod(timestamp_ms, 1000)
            as_of = (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds, milliseconds=milliseconds)).isoformat()
            return {"symbol": symbol, "market": market, "instrument_kind": "crypto", "price": _positive_price(trade.get("price")),
                    "currency": currency, "provider": "Binance Spot", "as_of": as_of,
                    "fetched_at": fetched_at, "quote_type": "last_trade"}
        # A TWD acquisition cost is not a Coinbase product quote. Keep USD price
        # separate; the ledger never computes TWD profit from a USD market value.
        if currency == "TWD":
            currency = "USD"
        if not re.fullmatch(r"[A-Z0-9]{1,20}", symbol) or not re.fullmatch(r"[A-Z]{3,6}", currency):
            raise ValueError("無效的幣別代碼")
        result = _request_json(COINBASE_URL.format(product=symbol + "-" + currency))
        return {"symbol": symbol, "market": market, "instrument_kind": "crypto", "price": _positive_price(result.get("price")),
                "currency": currency, "provider": "Coinbase Exchange", "as_of": _timestamp(result.get("time", "")),
                "fetched_at": fetched_at, "quote_type": "last_trade"}
    if kind == "stock" and market == "TWSE":
        if not re.fullmatch(r"[A-Z0-9]{4,8}", symbol):
            raise ValueError("無效的台股上市代碼")
        rows = twse_rows if twse_rows is not None else _request_json(TWSE_URL)
        row = next((x for x in rows if x.get("Code") == symbol), None)
        if not row:
            raise ValueError("證交所資料中無此上市代碼；上櫃／美股請使用手動報價")
        return {"symbol": symbol, "market": market, "instrument_kind": "stock", "price": _positive_price(row.get("ClosingPrice")),
                "currency": "TWD", "provider": "TWSE OpenAPI", "as_of": _twse_date(row.get("Date", "")),
                "fetched_at": fetched_at, "quote_type": "closing"}
    raise ValueError("自動報價目前支援 TWSE 上市股票、BINANCE 與 Coinbase 交易對；其他市場可輸入手動報價")


def update_quotes(ledger, assets=None) -> dict:
    if assets is None:
        assets = ledger.portfolio() if hasattr(ledger, "portfolio") else ledger.snapshot().get("portfolio", [])
    summary = {"updated": 0, "errors": [], "quotes": []}
    seen, twse_rows, twse_error = set(), None, None
    for asset in assets:
        symbol, market = str(asset.get("symbol", "")).upper(), str(asset.get("market", "")).upper()
        key = (symbol, market, asset.get("quote_currency") or asset.get("currency"))
        if key in seen:
            continue
        seen.add(key)
        try:
            if market == "TWSE":
                if twse_error:
                    raise ValueError(twse_error)
                if twse_rows is None:
                    try:
                        twse_rows = _request_json(TWSE_URL)
                    except (RuntimeError, ValueError, OSError) as exc:
                        twse_error = str(exc)
                        raise
            value = fetch_quote(asset, twse_rows=twse_rows)
            ledger.set_quote(value)
            summary["quotes"].append(value)
            summary["updated"] += 1
        except (ValueError, RuntimeError, OSError, KeyError, TypeError) as exc:
            summary["errors"].append({"symbol": symbol, "market": market, "error": str(exc)})
    return summary


def main():
    parser = argparse.ArgumentParser(description="Gmail 唯讀通知與公開報價整合")
    parser.add_argument("action", choices=["gmail-template", "gmail-status", "gmail-connect", "gmail-sync", "quotes"])
    parser.add_argument("--config", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--max-messages", type=int, default=50)
    args = parser.parse_args()
    try:
        if args.action == "gmail-template":
            path = _config_path(args.config)
            if path.exists():
                raise ValueError("設定檔已存在，未覆蓋")
            _atomic_json(path, gmail_config_template())
            result = {"config": str(path), "message": "請選擇 OAuth 用戶端檔、設定寄件者或標籤後再連線"}
        elif args.action == "gmail-status":
            result = gmail_status(args.config)
        elif args.action == "gmail-connect":
            result = connect_gmail(args.config)
        else:
            from ledger import Ledger
            ledger = Ledger(args.database or _data_dir() / "ledger.sqlite3")
            result = sync_gmail(ledger, args.config, args.max_messages) if args.action == "gmail-sync" else update_quotes(ledger)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, RuntimeError) as exc:
        parser.exit(1, str(exc) + "\n")


if __name__ == "__main__":
    main()
