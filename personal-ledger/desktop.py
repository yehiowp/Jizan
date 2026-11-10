"""Offline-first Windows ledger UI. Only Python's standard library is required."""

from __future__ import annotations

import argparse
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import queue
import threading
import webbrowser
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from typing import Any
from uuid import uuid4

from ledger import CURRENCY_DIGITS, Ledger, default_data_dir


APP_DIR = Path(__file__).resolve().parent
MOBILE_URL = 'https://personal-ledger-pocket-yeh.yeh2003121.chatgpt.site'
DEFAULT_DB = default_data_dir() / "ledger.sqlite3"
KINDS = {"支出": "expense", "收入": "income", "轉帳": "transfer"}
STATUS = {"unverified": "尚未核對", "verified": "已核對", "pending": "待確認"}
SOURCE = {"apple_pay": "Apple Pay", "gmail": "Gmail", "manual": "手動", "statement": "銀行帳單"}
REASONS = {
    "merchant_mismatch": "商家描述不同，需核對是否同筆交易",
    "amount_mismatch": "金額不同", "currency_mismatch": "幣別不同",
    "ambiguous_match": "多筆可能配對", "ambiguous": "多筆可能配對",
    "amount_difference": "金額不同", "currency_difference": "幣別不同",
    "sync_conflict": "兩端修改衝突", "missing_amount": "缺少金額",
    "missing_entry": "帳單有紀錄、帳本未找到", "time_uncertain": "僅有日期，需核對時間",
    "possible_duplicate": "同來源疑似重複交易", "manual_confirmation": "通知內容需人工核對",
}


def local_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def money(minor: Any, currency: str = "TWD") -> str:
    if minor is None:
        return "—"
    digits = CURRENCY_DIGITS.get(currency, 2)
    return f"{currency} {Decimal(str(minor)) / (10 ** digits):,.{digits}f}"


def decimal_text(value: Any, digits: int | None = None) -> str:
    if value is None or value == "":
        return "—"
    try:
        number = Decimal(str(value))
        return f"{number:,.{digits}f}" if digits is not None else format(number, ",f")
    except InvalidOperation:
        return str(value)


def format_time(value: Any) -> str:
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%Y/%m/%d %H:%M")
    except ValueError:
        return str(value)


def format_record_time(record: dict) -> str:
    if record.get("time_precision") == "day":
        value = record.get("transaction_date") or str(record.get("occurred_at") or "")[:10]
        try:
            day = datetime.strptime(value, "%Y-%m-%d")
            return day.strftime("%Y/%m/%d") + "（時間未提供）"
        except (ValueError, TypeError):
            return "日期待確認（時間未提供）"
    return format_time(record.get("occurred_at"))


def seed_demo(ledger: Ledger) -> None:
    """Deterministic examples are always written to a separate demo database."""
    examples = [
        {"source": "apple_pay", "external_id": "demo-wallet-coffee", "amount": "120", "currency": "TWD", "merchant": "示範咖啡店", "occurred_at": "2026-11-10T09:00:00+08:00", "account": "示範信用卡", "kind": "expense", "category": "餐飲"},
        {"source": "gmail", "external_id": "demo-bank-coffee", "amount": "120", "currency": "TWD", "merchant": "示範咖啡店", "occurred_at": "2026-11-10T09:01:00+08:00", "account": "示範信用卡", "kind": "expense"},
        {"source": "apple_pay", "external_id": "demo-wallet-shop", "amount": "500", "currency": "TWD", "merchant": "示範商店", "occurred_at": "2026-11-10T12:00:00+08:00", "account": "示範信用卡", "kind": "expense", "category": "購物"},
        {"source": "gmail", "external_id": "demo-bank-shop", "amount": "515", "currency": "TWD", "merchant": "示範商店", "occurred_at": "2026-11-10T12:01:00+08:00", "account": "示範信用卡", "kind": "expense"},
        {"source": "manual", "external_id": "demo-salary", "amount": "50000", "currency": "TWD", "merchant": "示範薪資", "occurred_at": "2026-11-05T10:00:00+08:00", "account": "示範銀行", "kind": "income", "category": "薪資"},
    ]
    for transaction in examples:
        ledger.ingest(transaction)


class LedgerApp(ttk.Frame):
    def __init__(self, root: tk.Tk | tk.Toplevel, database: Path, demo: bool = False):
        super().__init__(root, padding=0)
        self.root = root
        self.database = Path(database).resolve()
        self.ledger = Ledger(self.database)
        self.demo = demo
        self.data: dict[str, Any] = {}
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.worker_buttons: list[ttk.Button] = []
        self.preview_records: list[dict] = []
        self.transfer_errors: list[dict] = []
        self.review_map: dict[str, dict] = {}
        self.sync_server = None
        self.sync_thread = None
        self._closed = False
        self.settings_path = self.database.parent / "desktop-settings.json"
        self.gmail_config = self.database.parent / "gmail.json"
        self.settings = self._read_json(self.settings_path)
        self.status = tk.StringVar(value="資料保存在這台電腦，可離線操作。")
        self._style()
        self.pack(fill="both", expand=True)
        self._build()
        self.refresh()
        self._poll_id = self.root.after(100, self._poll_results)
        self._auto_id = self.root.after(60000, self._auto_refresh)
        self._startup_id = self.root.after(1200, self._startup_quotes)
        self._startup_gmail_id = self.root.after(1800, self._startup_gmail)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

    @staticmethod
    def _read_json(path: Path) -> dict:
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def _style(self) -> None:
        self.root.title("個人總帳本" + (" · 示範資料" if self.demo else ""))
        self.root.geometry("1220x820")
        self.root.minsize(1020, 690)
        self.root.configure(background="#f3f6fb")
        font = ("Microsoft JhengHei UI", 10)
        self.root.option_add("*Font", font)
        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure(".", font=font, background="#f3f6fb", foreground="#192b45")
        style.configure("TFrame", background="#f3f6fb")
        style.configure("Card.TFrame", background="white")
        style.configure("TLabel", background="#f3f6fb")
        style.configure("Muted.TLabel", foreground="#64758b")
        style.configure("Card.TLabel", background="white", foreground="#64758b")
        style.configure("Value.TLabel", background="white", foreground="#192b45", font=(font[0], 20, "bold"))
        style.configure("Title.TLabel", font=(font[0], 23, "bold"), foreground="#122540")
        style.configure("Heading.TLabel", font=(font[0], 13, "bold"))
        style.configure("TButton", padding=(12, 7), background="#e6edf7", borderwidth=0)
        style.map("TButton", background=[("active", "#d4e3f6"), ("disabled", "#eff2f7")])
        style.configure("Accent.TButton", foreground="white", background="#2265cb", padding=(15, 8))
        style.map("Accent.TButton", foreground=[("disabled", "#ccd5e2")], background=[("active", "#174fa6"), ("disabled", "#9bb4d9")])
        style.configure("TNotebook", borderwidth=0)
        style.configure("TNotebook.Tab", padding=(24, 12), background="#e8eef7")
        style.map("TNotebook.Tab", background=[("selected", "white")], foreground=[("selected", "#1b5bbd")])
        style.configure("Treeview", background="white", fieldbackground="white", rowheight=33, borderwidth=0)
        style.configure("Treeview.Heading", background="#eaf0f8", foreground="#435672", padding=(8, 9), font=(font[0], 10, "bold"))
        style.map("Treeview", background=[("selected", "#dceaff")], foreground=[("selected", "#123b72")])
        style.configure("TEntry", padding=6)
        style.configure("TCombobox", padding=5)
        style.configure("TLabelframe", padding=14)
        style.configure("TLabelframe.Label", font=(font[0], 11, "bold"))

    def _build(self) -> None:
        heading = ttk.Frame(self, padding=(26, 20, 26, 14))
        heading.pack(fill="x")
        left = ttk.Frame(heading)
        left.pack(side="left")
        ttk.Label(left, text="個人總帳本", style="Title.TLabel").pack(anchor="w")
        subtitle = "示範帳本 · 與正式帳本分開儲存" if self.demo else "離線記帳 · 交易核對 · 股票與加密貨幣"
        ttk.Label(left, text=subtitle, style="Muted.TLabel").pack(anchor="w", pady=(4, 0))
        ttk.Button(heading, text="重新整理", command=self.refresh).pack(side="right", padx=(8, 0))
        if not self.demo:
            ttk.Button(heading, text="開啟示範帳本", command=self.open_demo).pack(side="right")
        cards = ttk.Frame(self, padding=(26, 0, 26, 18))
        cards.pack(fill="x")
        self.cards: dict[str, tk.StringVar] = {}
        for index, (key, label) in enumerate([("expense", "總支出 · 不含轉帳"), ("income", "總收入 · 不含投資交易"), ("entries", "帳目筆數"), ("pending", "待確認事項")]):
            card = ttk.Frame(cards, padding=(18, 12), style="Card.TFrame")
            card.grid(row=0, column=index, sticky="nsew", padx=(0 if index == 0 else 10, 0))
            cards.columnconfigure(index, weight=1)
            ttk.Label(card, text=label, style="Card.TLabel").pack(anchor="w")
            value = tk.StringVar(value="—")
            ttk.Label(card, textvariable=value, style="Value.TLabel").pack(anchor="w", pady=(4, 0))
            self.cards[key] = value
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=26)
        self.tabs = {}
        for key, label in [("ledger", "帳本"), ("reviews", "待確認"), ("import", "匯入"), ("assets", "資產"), ("settings", "設定")]:
            frame = ttk.Frame(self.notebook, padding=16)
            self.notebook.add(frame, text=label)
            self.tabs[key] = frame
        self._ledger_tab()
        self._reviews_tab()
        self._import_tab()
        self._assets_tab()
        self._settings_tab()
        footer = ttk.Frame(self, padding=(26, 11))
        footer.pack(fill="x")
        ttk.Label(footer, textvariable=self.status, style="Muted.TLabel").pack(side="left", fill="x", expand=True)
        self.progress = ttk.Progressbar(footer, mode="indeterminate", length=90)
        self.progress.pack(side="right")

    def _tree(self, parent: ttk.Frame, columns: list[tuple[str, str, int]]) -> ttk.Treeview:
        wrap = ttk.Frame(parent)
        wrap.pack(fill="both", expand=True)
        tree = ttk.Treeview(wrap, columns=[key for key, _, _ in columns], show="headings", selectmode="browse")
        for key, title, width in columns:
            tree.heading(key, text=title)
            tree.column(key, width=width, minwidth=60, anchor="w", stretch=True)
        vertical = ttk.Scrollbar(wrap, orient="vertical", command=tree.yview)
        horizontal = ttk.Scrollbar(wrap, orient="horizontal", command=tree.xview)
        tree.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        tree.grid(row=0, column=0, sticky="nsew")
        vertical.grid(row=0, column=1, sticky="ns")
        horizontal.grid(row=1, column=0, sticky="ew")
        wrap.columnconfigure(0, weight=1)
        wrap.rowconfigure(0, weight=1)
        tree.tag_configure("odd", background="#f6f8fc")
        tree.tag_configure("pending", foreground="#9b610d")
        return tree

    @staticmethod
    def _fill(tree: ttk.Treeview, rows: list[tuple[str, tuple, str | None]]) -> None:
        tree.delete(*tree.get_children())
        for index, (iid, values, tag) in enumerate(rows):
            tree.insert("", "end", iid=iid, values=values, tags=tuple(t for t in ("odd" if index % 2 else "", tag) if t))

    def _ledger_tab(self) -> None:
        frame = self.tabs["ledger"]
        bar = ttk.Frame(frame)
        bar.pack(fill="x", pady=(0, 12))
        ttk.Label(bar, text="交易紀錄", style="Heading.TLabel").pack(side="left")
        ttk.Button(bar, text="新增帳目", command=self.manual_entry, style="Accent.TButton").pack(side="right")
        ttk.Button(bar, text="修改帳目", command=self.edit_entry).pack(side="right", padx=(8, 0))
        ttk.Button(bar, text="匯出 CSV", command=self.export_csv).pack(side="right", padx=8)
        self.search = tk.StringVar()
        search = ttk.Entry(bar, textvariable=self.search, width=24)
        search.pack(side="right", padx=12)
        ttk.Label(bar, text="搜尋商家／帳戶／分類", style="Muted.TLabel").pack(side="right")
        self.search.trace_add("write", lambda *_: self._render_entries())
        self.entries_tree = self._tree(frame, [("time", "交易時間", 150), ("merchant", "商家／摘要", 180), ("amount", "金額", 150), ("kind", "類型", 65), ("account", "帳戶", 110), ("category", "分類", 85), ("status", "核對狀態", 100)])
        self.entries_tree.bind("<<TreeviewSelect>>", self._show_entry)
        self.entry_detail = tk.StringVar(value="選取一筆帳目，可查看關聯通知與識別碼。")
        ttk.Label(frame, textvariable=self.entry_detail, style="Muted.TLabel", wraplength=1090, justify="left").pack(anchor="w", pady=(11, 0))
        self.empty_label = ttk.Label(frame, text="", style="Muted.TLabel")
        self.empty_label.pack(anchor="w", pady=(4, 0))

    def _reviews_tab(self) -> None:
        frame = self.tabs["reviews"]
        ttk.Label(frame, text="有差異的來源會保留在這裡，處理前不另外計為第二筆支出。", style="Muted.TLabel").pack(anchor="w", pady=(0, 10))
        self.review_tree = self._tree(frame, [("time", "通知時間", 145), ("reason", "待確認原因", 145), ("merchant", "商家", 170), ("entry", "原帳目金額", 150), ("source", "通知金額", 150), ("origin", "來源", 100)])
        self.review_tree.bind("<<TreeviewSelect>>", self._show_review)
        self.review_detail = tk.StringVar(value="選取待確認事項後，檢查兩個來源再選擇處理方式。")
        ttk.Label(frame, textvariable=self.review_detail, wraplength=1090, justify="left").pack(anchor="w", pady=13)
        actions = ttk.Frame(frame)
        actions.pack(fill="x")
        ttk.Button(actions, text="採用通知金額", command=lambda: self.resolve("use_source"), style="Accent.TButton").pack(side="left")
        ttk.Button(actions, text="保留原帳目金額", command=lambda: self.resolve("keep_entry")).pack(side="left", padx=8)
        ttk.Button(actions, text="另建一筆交易", command=lambda: self.resolve("separate")).pack(side="left")
        ttk.Button(actions, text="關聯其他帳目…", command=self.link_review).pack(side="left", padx=8)
        ttk.Button(actions, text="略過這則通知", command=lambda: self.resolve("ignore")).pack(side="left")

    def _import_tab(self) -> None:
        frame = self.tabs["import"]
        bar = ttk.Frame(frame)
        bar.pack(fill="x", pady=(0, 10))
        ttk.Label(bar, text="匯入通知與交易", style="Heading.TLabel").pack(side="left")
        self._job_button(bar, "同步 Gmail", self.sync_gmail).pack(side="right")
        ttk.Button(bar, text="讀取 JSON／文字檔", command=self.load_import).pack(side="right", padx=8)
        ttk.Button(bar, text="匯入銀行帳單", command=self.load_statement).pack(side="right")
        mobile_bar = ttk.Frame(frame)
        mobile_bar.pack(fill="x", pady=(0, 10))
        ttk.Label(mobile_bar, text="iPhone 檔案交換：手機匯出後在此預覽；總帳匯出後再由手機匯入。", style="Muted.TLabel").pack(side="left")
        ttk.Button(mobile_bar, text="匯出手機總帳", command=self.export_mobile_snapshot).pack(side="right")
        ttk.Button(mobile_bar, text="匯入手機紀錄", command=self.load_mobile_transfer).pack(side="right", padx=8)
        ttk.Label(frame, text="貼上交易 JSON、JSON 陣列或銀行通知文字。先預覽，再匯入；相同來源識別碼會自動去重。", style="Muted.TLabel", wraplength=1070).pack(anchor="w")
        options = ttk.Frame(frame)
        options.pack(fill="x", pady=(10, 8))
        ttk.Label(options, text="文字來源").pack(side="left")
        self.import_source = tk.StringVar(value="gmail")
        ttk.Combobox(options, textvariable=self.import_source, values=["gmail", "apple_pay", "manual"], state="readonly", width=13).pack(side="left", padx=8)
        ttk.Label(options, text="帳戶名稱").pack(side="left", padx=(12, 0))
        self.import_account = tk.StringVar(value="日常消費")
        ttk.Entry(options, textvariable=self.import_account, width=22).pack(side="left", padx=8)
        ttk.Button(options, text="預覽內容", command=self.preview_import).pack(side="right")
        self.import_text = tk.Text(frame, height=7, wrap="word", borderwidth=1, relief="solid", background="white", foreground="#25344b", padx=12, pady=10, font=("Consolas", 10))
        self.import_text.pack(fill="both", expand=True)
        self.import_output = tk.Text(frame, height=6, wrap="word", borderwidth=0, background="#eaf0f8", foreground="#435672", padx=12, pady=10, state="disabled")
        self.import_output.pack(fill="both", expand=True, pady=(10, 0))
        bottom = ttk.Frame(frame)
        bottom.pack(fill="x", pady=(10, 0))
        ttk.Label(bottom, text="Gmail 需在「設定」完成自己的 Google 唯讀授權。", style="Muted.TLabel").pack(side="left")
        self.import_button = ttk.Button(bottom, text="確認匯入預覽資料", command=self.commit_import, style="Accent.TButton", state="disabled")
        self.import_button.pack(side="right")
        self.import_text.bind("<<Modified>>", self._import_changed)

    def _assets_tab(self) -> None:
        frame = self.tabs["assets"]
        top = ttk.Frame(frame)
        top.pack(fill="x", pady=(0, 12))
        ttk.Label(top, text="股票與加密貨幣", style="Heading.TLabel").pack(side="left")
        self._job_button(top, "更新所有報價", self.update_quotes).pack(side="right")
        ttk.Button(top, text="手動報價", command=self.manual_quote).pack(side="right", padx=8)
        ttk.Button(top, text="新增投資交易", command=self.asset_entry, style="Accent.TButton").pack(side="right")
        self.portfolio_tree = self._tree(frame, [("symbol", "資產／市場", 125), ("account", "帳戶", 100), ("quantity", "持有數量", 110), ("cost", "成本", 125), ("price", "最後報價", 125), ("value", "市值", 125), ("profit", "未實現損益", 125), ("time", "報價時間", 150), ("provider", "來源／價格類型", 160), ("realized", "已實現損益", 125), ("dividend", "股息／收益淨額", 135)])
        ttk.Label(frame, text="TWSE 為收盤價；加密貨幣市場填 BINANCE 可取得 USDT 成交價。請依報價時間判斷；幣別不同時不直接計算損益。", style="Muted.TLabel", wraplength=1080).pack(anchor="w", pady=(12, 0))
        self.asset_status = tk.StringVar(value="尚未取得行情。可離線新增持倉及手動報價。")
        ttk.Label(frame, textvariable=self.asset_status, style="Muted.TLabel", wraplength=1080).pack(anchor="w", pady=(4, 0))

    def _settings_tab(self) -> None:
        holder = self.tabs["settings"]
        canvas = tk.Canvas(holder, borderwidth=0, highlightthickness=0, background="#f3f6fb")
        scrollbar = ttk.Scrollbar(holder, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        frame = ttk.Frame(canvas)
        content = canvas.create_window((0, 0), window=frame, anchor="nw")
        frame.bind("<Configure>", lambda _event: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>", lambda event: canvas.itemconfigure(content, width=event.width))
        data = ttk.LabelFrame(frame, text="本機資料與備份")
        data.pack(fill="x", pady=(0, 13))
        ttk.Label(data, text=str(self.database), wraplength=1000).pack(anchor="w")
        row = ttk.Frame(data)
        row.pack(fill="x", pady=(10, 0))
        ttk.Button(row, text="備份 SQLite 資料庫", command=self.backup).pack(side="left")
        ttk.Button(row, text="匯出帳本 CSV", command=self.export_csv).pack(side="left", padx=8)
        ttk.Button(row, text="從備份還原…", command=self.restore).pack(side="left")
        ttk.Label(row, text="備份包含帳務資料；請存到自己信任的位置。", style="Muted.TLabel").pack(side="left", padx=8)
        gmail = ttk.LabelFrame(frame, text="Gmail 唯讀整合")
        gmail.pack(fill="x", pady=(0, 13))
        self.gmail_status_text = tk.StringVar(value="尚未設定 Gmail。")
        ttk.Label(gmail, textvariable=self.gmail_status_text, wraplength=1000).pack(anchor="w")
        self.gmail_config_label = tk.StringVar(value=str(self.gmail_config))
        ttk.Label(gmail, textvariable=self.gmail_config_label, style="Muted.TLabel", wraplength=1000).pack(anchor="w", pady=5)
        buttons = ttk.Frame(gmail)
        buttons.pack(fill="x", pady=(5, 0))
        ttk.Button(buttons, text="建立 Gmail 設定…", command=self.configure_gmail).pack(side="left")
        self._job_button(buttons, "連結 Google 帳號", self.connect_gmail).pack(side="left", padx=8)
        self._job_button(buttons, "同步交易郵件", self.sync_gmail).pack(side="left")
        self._job_button(buttons, "檢視待確認郵件", self.sync_gmail).pack(side="left", padx=8)
        self.auto_gmail = tk.BooleanVar(value=bool(self.settings.get("auto_gmail", True)))
        ttk.Checkbutton(gmail, text="完成授權後，程式開啟期間每 5 分鐘同步交易通知", variable=self.auto_gmail, command=self.save_settings).pack(anchor="w", pady=(10, 0))
        refresh = ttk.LabelFrame(frame, text="報價更新")
        refresh.pack(fill="x", pady=(0, 13))
        self.auto_quotes = tk.BooleanVar(value=bool(self.settings.get("auto_quotes", True)))
        ttk.Checkbutton(refresh, text="程式開啟期間，每 15 分鐘嘗試更新行情", variable=self.auto_quotes, command=self.save_settings).pack(anchor="w")
        ttk.Label(refresh, text="需要網路；啟動時及每 15 分鐘嘗試更新，失敗時保留快取。自動更新預設開啟，可隨時關閉。", style="Muted.TLabel", wraplength=1000).pack(anchor="w", pady=(6, 0))
        phone = ttk.LabelFrame(frame, text="iPhone 手機版（不需 Mac）")
        phone.pack(fill="x")
        ttk.Label(phone, text="在 iPhone Safari 開啟私人手機網址，選「分享 → 加入主畫面」。首次完成載入後可離線記帳。", wraplength=990, justify="left").pack(anchor="w")
        ttk.Label(phone, text=MOBILE_URL, style="Muted.TLabel", wraplength=990).pack(anchor="w", pady=5)
        mobile_controls = ttk.Frame(phone)
        mobile_controls.pack(fill="x", pady=(3, 8))
        ttk.Button(mobile_controls, text="開啟手機版網址", command=lambda: webbrowser.open(MOBILE_URL)).pack(side="left")
        ttk.Button(mobile_controls, text="複製手機網址", command=self.copy_mobile_url).pack(side="left", padx=8)
        ttk.Button(mobile_controls, text="匯入手機紀錄", command=self.load_mobile_transfer).pack(side="left")
        ttk.Button(mobile_controls, text="匯出手機總帳", command=self.export_mobile_snapshot).pack(side="left", padx=8)
        ttk.Label(phone, text="用紀錄檔交換帳目；Apple Pay 可由捷徑存檔後匯入。手機網頁不使用下方原生開發版的區域網路配對。", style="Muted.TLabel", wraplength=990).pack(anchor="w", pady=(0, 8))
        advanced = ttk.Frame(phone)
        self.show_native = tk.BooleanVar(value=False)
        ttk.Checkbutton(phone, text="顯示原生 iPhone 開發版網路設定（需 Mac）", variable=self.show_native,
                        command=lambda: advanced.pack(fill="x", pady=10) if self.show_native.get() else advanced.pack_forget()).pack(anchor="w")
        self.lan_consent = tk.BooleanVar(value=False)
        ttk.Checkbutton(advanced, text="我正在可信任的私人網路，允許原生 App 透過區域網路同步（HTTP 未加密）", variable=self.lan_consent).pack(anchor="w", pady=7)
        self.sync_status = tk.StringVar(value="同步服務未啟動。手機與電腦可分別離線記帳。")
        ttk.Label(advanced, textvariable=self.sync_status, style="Muted.TLabel", wraplength=990).pack(anchor="w")
        controls = ttk.Frame(advanced)
        controls.pack(fill="x", pady=(9, 0))
        self.sync_button = ttk.Button(controls, text="啟動區域網路同步", command=self.toggle_sync)
        self.sync_button.pack(side="left")
        ttk.Button(controls, text="複製配對金鑰", command=self.copy_sync_token).pack(side="left", padx=8)
        def scroll(event):
            canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")
        def bind_scroll(widget):
            widget.bind("<MouseWheel>", scroll, add=True)
            for child in widget.winfo_children():
                bind_scroll(child)
        bind_scroll(frame)
        canvas.bind("<MouseWheel>", scroll)

    def copy_mobile_url(self) -> None:
        self.root.clipboard_clear()
        self.root.clipboard_append(MOBILE_URL)
        self.status.set('已複製手機網址，請在 iPhone Safari 開啟。')

    def toggle_sync(self) -> None:
        try:
            if self.sync_server is not None:
                self.sync_server.shutdown()
                self.sync_server.server_close()
                self.sync_server = None
                self.sync_button.configure(text="啟動區域網路同步")
                self.sync_status.set("同步服務已停止。帳本仍保留在本機。")
                return
            if not self.lan_consent.get():
                self.sync_status.set("請先確認正在可信任的私人網路，再啟動區域網路同步。")
                return
            from sync_server import SyncServer, load_or_create_token, local_addresses
            token = load_or_create_token(self.database.parent / "sync-token.txt")
            server = SyncServer(("0.0.0.0", 8765), self.database, token)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.sync_server = server
            self.sync_thread = thread
            addresses = sorted(ip for ip in local_addresses() if ip not in {"localhost", "127.0.0.1", "::1"})
            urls = "、".join("http://" + ip + ":8765" for ip in addresses)
            self.sync_status.set("同步已啟動。iPhone 伺服器位址：" + (urls or "未找到區域網路 IP，請確認電腦網路設定") + "。需在同一網路並允許 Windows 私人網路連線。")
            self.sync_button.configure(text="停止同步服務")
        except Exception as error:
            self.error(error)

    def copy_sync_token(self) -> None:
        if self.sync_server is None:
            self.sync_status.set("請先啟動同步服務，再複製配對金鑰。")
            return
        try:
            from sync_server import load_or_create_token
            token = load_or_create_token(self.database.parent / "sync-token.txt")
            self.root.clipboard_clear()
            self.root.clipboard_append(token)
            self.status.set("已將配對金鑰複製到剪貼簿，請貼到自己的 iPhone App 設定。")
        except Exception as error:
            self.error(error)

    def _job_button(self, parent, title: str, command) -> ttk.Button:
        button = ttk.Button(parent, text=title, command=command)
        self.worker_buttons.append(button)
        return button

    def refresh(self) -> None:
        try:
            self.data = self.ledger.snapshot()
            self._render_entries()
            self._render_reviews()
            self._render_portfolio()
            self.cards["entries"].set(str(len(self.data.get("entries", []))))
            self.cards["pending"].set(str(len(self.data.get("reviews", []))))
            summary = self.data.get("summary", {}).get("by_currency", [])
            twd = next((row for row in summary if row.get("currency") == "TWD"), summary[0] if summary else {})
            currency = twd.get("currency", "TWD")
            self.cards["expense"].set(money(twd.get("expense_minor", 0), currency))
            self.cards["income"].set(money(twd.get("income_minor", 0), currency))
            self.notebook.tab(self.tabs["reviews"], text=f"待確認 ({len(self.data.get('reviews', []))})")
            self._gmail_status()
        except Exception as error:
            self.error(error)

    def _render_entries(self) -> None:
        if not hasattr(self, "entries_tree"):
            return
        query = self.search.get().casefold().strip()
        entries = self.data.get("entries", [])
        filtered = [entry for entry in entries if not query or query in " ".join(str(entry.get(key, "")) for key in ("merchant", "account", "category", "currency")).casefold()]
        rows = []
        inverse_kind = {value: key for key, value in KINDS.items()}
        for entry in filtered:
            rows.append((str(entry["id"]), (format_record_time(entry), entry.get("merchant") or "—", money(entry.get("amount_minor"), entry.get("currency", "TWD")), inverse_kind.get(entry.get("kind"), "投資"), entry.get("account", "—"), entry.get("category") or "未分類", STATUS.get(entry.get("status"), entry.get("status", "—"))), "pending" if entry.get("status") == "pending" else None))
        self._fill(self.entries_tree, rows)
        self.empty_label.configure(text=f"顯示 {len(filtered)} / {len(entries)} 筆；各幣別分開統計，頁首優先顯示 TWD。" if entries else "帳本還沒有交易。可新增帳目、匯入通知，或開啟獨立示範帳本。")

    def _show_entry(self, _event=None) -> None:
        selection = self.entries_tree.selection()
        if not selection:
            return
        entry_id = selection[0]
        sources = [source for source in self.data.get("sources", []) if str(source.get("entry_id")) == entry_id]
        descriptions = [f"{SOURCE.get(s.get('source'), s.get('source'))} ({s.get('external_id')})" for s in sources]
        self.entry_detail.set(f"帳目 ID：{entry_id}\n關聯來源：{'；'.join(descriptions) if descriptions else '沒有關聯來源'}")

    def _render_reviews(self) -> None:
        rows = []
        self.review_map = {}
        for review in self.data.get("reviews", []):
            self.review_map[str(review["id"])] = review
            entry = review.get("entry") or {}
            source = review.get("source") or {}
            rows.append((str(review["id"]), (format_record_time(source), REASONS.get(review.get("reason"), review.get("reason", "需人工確認")), source.get("merchant", "—"), money(entry.get("amount_minor"), entry.get("currency", "TWD")), money(source.get("amount_minor"), source.get("currency", "TWD")), SOURCE.get(source.get("source"), source.get("source", "—"))), "pending"))
        self._fill(self.review_tree, rows)
        self.review_detail.set("選取待確認事項後，檢查兩個來源再選擇處理方式。" if rows else "目前沒有待確認事項。金額、幣別或配對有差異時會列在這裡。")

    def _selected_review(self) -> dict | None:
        selection = self.review_tree.selection()
        if not selection:
            self.status.set("請先選取一筆待確認事項。")
            return None
        return self.review_map.get(selection[0])

    def _show_review(self, _event=None) -> None:
        review = self._selected_review()
        if not review:
            return
        source, entry = review.get("source") or {}, review.get("entry") or {}
        details = [f"原帳目：{entry.get('merchant', '未配對')} · {entry.get('account', '—')} · {format_record_time(entry)} · {money(entry.get('amount_minor'), entry.get('currency', 'TWD'))}",
                   f"通知來源：{SOURCE.get(source.get('source'), source.get('source', '—'))} · {source.get('merchant', '—')} · {format_record_time(source)} · {money(source.get('amount_minor'), source.get('currency', 'TWD'))}"]
        statement_kind = {"purchase": "消費", "fee": "手續費", "refund": "退款／折抵", "payment": "信用卡繳款（轉帳）"}.get(source.get("statement_kind"))
        if statement_kind:
            details.append(f"帳單類型：{statement_kind} · 入帳日期：{source.get('posting_date') or '未提供'}")
        if source.get("description"):
            details.append(source["description"])
        details.append("採用或保留金額會把通知歸入同一筆帳目；另建一筆會增加帳目。")
        self.review_detail.set("\n".join(details))

    def resolve(self, action: str, entry_id: str | None = None) -> None:
        review = self._selected_review()
        if not review:
            return
        try:
            self.ledger.resolve_review(review["id"], action, entry_id=entry_id)
            self.refresh()
            self.status.set("已處理待確認事項，原始通知仍保留可回查。")
        except Exception as error:
            self.error(error)

    def link_review(self) -> None:
        if not self._selected_review():
            return
        dialog = tk.Toplevel(self.root)
        dialog.title("選擇要關聯的帳目")
        dialog.geometry("820x430")
        body = ttk.Frame(dialog, padding=16)
        body.pack(fill="both", expand=True)
        tree = self._tree(body, [("time", "時間", 145), ("merchant", "商家", 180), ("amount", "金額", 140), ("account", "帳戶", 120)])
        self._fill(tree, [(str(e["id"]), (format_record_time(e), e.get("merchant"), money(e.get("amount_minor"), e.get("currency", "TWD")), e.get("account", "—")), None) for e in self.data.get("entries", [])])
        def apply():
            selection = tree.selection()
            if selection:
                self.resolve("link", selection[0])
                dialog.destroy()
        ttk.Button(body, text="關聯選取帳目", command=apply, style="Accent.TButton").pack(anchor="e", pady=(12, 0))

    def _render_portfolio(self) -> None:
        rows = []
        for index, asset in enumerate(self.data.get("portfolio", [])):
            currency = asset.get("currency", "TWD")
            quote_currency = asset.get("quote_currency") or currency
            provider = asset.get("quote_provider") or "—"
            quote_type = {"closing": "收盤價", "last_trade": "成交價"}.get(asset.get("quote_type"), "手動" if provider == "manual" else "")
            if not quote_type:
                quote_type = "收盤價" if provider == "TWSE OpenAPI" else "成交價" if provider in {"Coinbase Exchange", "Binance Spot"} else ""
            provider_label = provider + (" · " + quote_type if quote_type else "")
            rows.append((str(index), (f"{asset.get('symbol', '')} / {asset.get('market', '')}", asset.get("account", "—"), decimal_text(asset.get("quantity_decimal")), f"{currency} {decimal_text(asset.get('cost_decimal'), 2)}", f"{quote_currency} {decimal_text(asset.get('price_decimal'))}" if asset.get("price_decimal") is not None else "尚無報價", f"{quote_currency} {decimal_text(asset.get('value_decimal'), 2)}" if asset.get("value_decimal") is not None else "—", f"{currency} {decimal_text(asset.get('unrealized_decimal'), 2)}" if asset.get("unrealized_decimal") is not None else "—", format_time(asset.get("quote_as_of")), provider_label, f"{currency} {decimal_text(asset.get('realized_decimal'), 2)}", f"{currency} {decimal_text(asset.get('dividend_decimal'), 2)}"), None))
        self._fill(self.portfolio_tree, rows)
        if not rows:
            self.asset_status.set("尚無持倉。按「新增投資交易」記錄買入、賣出或資產轉入。")
        else:
            self.asset_status.set("自動報價需連網；價格可能延遲。可在「設定」開啟每 15 分鐘更新。")

    def _form(self, title: str, fields: list[tuple], submit, button="儲存") -> None:
        dialog = tk.Toplevel(self.root)
        dialog.title(title)
        dialog.transient(self.root)
        dialog.resizable(False, False)
        body = ttk.Frame(dialog, padding=22)
        body.pack(fill="both", expand=True)
        values: dict[str, tk.StringVar] = {}
        for row, definition in enumerate(fields):
            key, label, default, *options = definition
            ttk.Label(body, text=label).grid(row=row, column=0, sticky="w", padx=(0, 18), pady=5)
            variable = tk.StringVar(value=default)
            values[key] = variable
            widget = ttk.Combobox(body, textvariable=variable, values=options[0], state="readonly", width=35) if options else ttk.Entry(body, textvariable=variable, width=38)
            widget.grid(row=row, column=1, sticky="ew", pady=5)
        feedback = tk.StringVar()
        ttk.Label(body, textvariable=feedback, foreground="#a33626", wraplength=450).grid(row=len(fields), column=0, columnspan=2, sticky="w", pady=(8, 0))
        def apply():
            try:
                submit({key: value.get().strip() for key, value in values.items()})
            except Exception as error:
                feedback.set(str(error))
                return
            dialog.destroy()
            self.refresh()
        ttk.Button(body, text=button, command=apply, style="Accent.TButton").grid(row=len(fields) + 1, column=1, sticky="e", pady=(12, 0))

    def manual_entry(self) -> None:
        def submit(values):
            values["kind"] = KINDS[values["kind"]]
            values.update(source="manual", external_id=str(uuid4()))
            self.ledger.ingest(values)
            self.status.set("已新增帳目並保存在本機。")
        self._form("新增帳目", [("kind", "類型", "支出", list(KINDS)), ("amount", "金額（正數）", ""), ("currency", "幣別", "TWD", ["TWD", "USD", "JPY", "EUR", "HKD", "CNY", "KRW"]), ("merchant", "商家／摘要", ""), ("account", "帳戶名稱", "日常消費"), ("category", "分類", "未分類"), ("occurred_at", "交易時間（含時區）", local_now())], submit)

    def edit_entry(self) -> None:
        selection = self.entries_tree.selection()
        if not selection:
            self.status.set("請先選取要修改的帳目。")
            return
        entry = next(item for item in self.data.get("entries", []) if str(item["id"]) == selection[0])
        fields = [("merchant", "商家／摘要", entry.get("merchant", "")), ("category", "分類", entry.get("category") or "未分類"), ("note", "備註", entry.get("note") or "")]
        linked = [source for source in self.data.get("sources", []) if source.get("entry_id") == entry["id"]]
        if len(linked) <= 1:
            amount = Decimal(entry["amount_minor"]) / (10 ** CURRENCY_DIGITS.get(entry["currency"], 2))
            fields.append(("amount", "金額（" + entry["currency"] + "）", str(amount)))
        def submit(values):
            self.ledger.update_entry(entry["id"], values, expected_revision=entry.get("revision"))
            self.status.set("已更新帳目；修改紀錄已保留。")
        self._form("修改帳目" + (" · 多來源金額請由待確認處理" if len(linked) > 1 else ""), fields, submit)

    def asset_entry(self) -> None:
        def submit(values):
            kinds = {"買入": "buy", "賣出": "sell", "股息／收益": "dividend", "資產轉入": "transfer_in", "資產轉出": "transfer_out"}
            values["kind"] = kinds[values["kind"]]
            values["instrument_kind"] = {"股票": "stock", "加密貨幣": "crypto"}[values["instrument_kind"]]
            self.ledger.asset_event(values)
            self.status.set("已新增投資交易。")
        self._form("新增投資交易", [("instrument_kind", "資產類型", "股票", ["股票", "加密貨幣"]), ("symbol", "代號（例 2330、BTC）", ""), ("market", "市場（股票 TWSE／幣 BINANCE）", "TWSE"), ("account", "證券／錢包帳戶", "投資帳戶"), ("kind", "交易類型", "買入", ["買入", "賣出", "股息／收益", "資產轉入", "資產轉出"]), ("quantity", "數量（股息可填 0）", ""), ("cash_amount", "成交總額／轉入成本（不含費用）", "0"), ("fee", "手續費", "0"), ("currency", "交易幣別", "TWD"), ("occurred_at", "交易時間（含時區）", local_now())], submit)

    def manual_quote(self) -> None:
        def submit(values):
            values["instrument_kind"] = {"股票": "stock", "加密貨幣": "crypto"}[values["instrument_kind"]]
            values["provider"] = "manual"
            self.ledger.set_quote(values)
            self.status.set("已保存手動報價。")
        self._form("新增／更新手動報價", [("instrument_kind", "資產類型", "股票", ["股票", "加密貨幣"]), ("symbol", "代號", ""), ("market", "市場", "TWSE"), ("price", "每單位價格", ""), ("currency", "報價幣別", "TWD"), ("as_of", "報價時間（含時區）", local_now())], submit)

    def _import_changed(self, _event=None) -> None:
        if self.import_text.edit_modified():
            self.preview_records = []
            self.transfer_errors = []
            self.import_button.configure(state="disabled")
            self.import_text.edit_modified(False)

    def load_import(self) -> None:
        path = filedialog.askopenfilename(parent=self.root, title="選擇交易資料", filetypes=[("交易 JSON／通知文字", "*.json *.txt"), ("所有檔案", "*.*")])
        if path:
            try:
                content = Path(path).read_text(encoding="utf-8-sig")
                self.import_text.delete("1.0", "end")
                self.import_text.insert("1.0", content)
                self.preview_import()
            except Exception as error:
                self.error(error)

    def load_mobile_transfer(self) -> None:
        path = filedialog.askopenfilename(parent=self.root, title="選擇 iPhone 匯出的紀錄檔", filetypes=[("手機紀錄 JSON", "*.json")])
        if not path:
            return
        self.preview_records = []
        self.transfer_errors = []
        self.import_button.configure(state="disabled")
        try:
            from transfer import MAX_BYTES
            with Path(path).open("rb") as handle:
                content = handle.read(MAX_BYTES + 1)
            if len(content) > MAX_BYTES:
                raise ValueError("手機紀錄檔超過 10 MiB")
            content = content.decode("utf-8-sig")
            self.import_text.delete("1.0", "end")
            self.import_text.insert("1.0", content)
            self.import_text.edit_modified(False)
            self._preview_mobile_transfer(content)
            self.notebook.select(self.tabs["import"])
        except Exception as error:
            self._set_output("手機紀錄未匯入：" + str(error))
            self.status.set("手機紀錄未匯入，原帳本沒有變動。")

    def _preview_mobile_transfer(self, content) -> None:
        from transfer import preview_transfer
        result = preview_transfer(content, self.ledger)
        self.preview_records = result["records"]
        self.transfer_errors = result["errors"]
        lines = [f"手機紀錄預覽：共 {result['total']} 筆；可匯入 {len(result['records'])} 筆，未通過 {len(result['errors'])} 筆。尚未寫入帳本。"]
        for row in result["rows"]:
            if "error" in row:
                lines.append(f"第 {row['index']} 筆不會匯入：{row['error']}")
            else:
                record = row["record"]
                state = "已接收，將去重" if row["duplicate"] else "待匯入"
                lines.append(f"第 {row['index']} 筆 [{state}]：{record['merchant']} | {record['currency']} {record['amount']} | {record['account']} | {record['occurred_at']}")
        if result["errors"]:
            lines.append("確認只會匯入通過檢查的紀錄；錯誤列仍保留在原始檔，請在手機另建更正交易後重新匯出。")
        self._set_output("\n".join(lines))
        self.import_button.configure(state="normal" if result["records"] else "disabled")
        self.status.set("手機紀錄已預覽，請檢查後按「確認匯入預覽資料」。")

    def export_mobile_snapshot(self) -> None:
        path = filedialog.asksaveasfilename(parent=self.root, title="匯出供 iPhone 匯入的總帳", defaultextension=".json",
                                          initialfile="personal-ledger-snapshot.json", filetypes=[("手機總帳 JSON", "*.json")])
        if not path:
            return
        try:
            from transfer import write_snapshot
            result = write_snapshot(self.ledger, path)
            self.status.set(f"已匯出手機總帳（{len(result['entries'])} 筆帳目）。請將檔案存入 iPhone「檔案」，再從手機記帳頁匯入。")
        except Exception as error:
            self.error(error)

    def load_statement(self, path: Path | str | None = None) -> None:
        if path is None:
            path = filedialog.askopenfilename(parent=self.root, title="選擇銀行帳單", filetypes=[("帳單 CSV／PDF", "*.csv *.pdf"), ("CSV", "*.csv"), ("PDF", "*.pdf")])
        if not path:
            return
        self.preview_records = []
        self.transfer_errors = []
        self.import_button.configure(state="disabled")
        try:
            from statements import extract_pdf_text, read_statement_csv
            if Path(path).suffix.lower() == ".pdf":
                try:
                    result = extract_pdf_text(Path(path))
                except ValueError as error:
                    if "PDF 已加密" not in str(error):
                        raise
                    from tkinter import simpledialog
                    password = simpledialog.askstring("帳單密碼", "此 PDF 已加密，請輸入銀行帳單密碼（不會保存）：", show="*", parent=self.root)
                    if password is None:
                        self.status.set("已取消 PDF 帳單讀取。")
                        return
                    try:
                        result = extract_pdf_text(Path(path), password=password)
                    finally:
                        password = None
                from bank_statement import UnsupportedStatement, parse_taishin_text
                try:
                    parsed = parse_taishin_text(result.get("text", ""), account=self.import_account.get() or "台新信用卡")
                except UnsupportedStatement:
                    self.import_text.delete("1.0", "end")
                    self.import_text.insert("1.0", result.get("text", ""))
                    self.import_text.edit_modified(False)
                    self._set_output("已擷取 PDF 文字，尚未入帳。尚未支援此銀行版型，請檢查文字並整理成交易 CSV 或 JSON 再預覽。\n" + "\n".join(result.get("warnings", [])))
                else:
                    self._preview_statement_rows(parsed, bank_pdf=True)
            else:
                result = read_statement_csv(Path(path), account=self.import_account.get() or "日常消費")
                self._preview_statement_rows(result)
            self.notebook.select(self.tabs["import"])
            self.status.set("已讀取帳單，請先檢查預覽。")
        except Exception as error:
            self._set_output("帳單讀取失敗：" + str(error))
            self.status.set("帳單未匯入。")

    def _preview_statement_rows(self, result: dict, bank_pdf: bool = False) -> None:
        records = result.get("rows", [])
        ready = not bank_pdf or result.get("summary", {}).get("ready_for_review") is True
        self.import_text.delete("1.0", "end")
        self.import_text.insert("1.0", json.dumps(records, ensure_ascii=False, indent=2, default=str))
        self.import_text.edit_modified(False)
        self.preview_records = records if ready else []
        self.import_button.configure(state="normal" if self.preview_records else "disabled")
        lines = [result.get("preview") or f"帳單預覽：{len(records)} 筆交易；匯入後列入待確認。"]
        if not ready:
            lines.append("金額控制或明細完整性未通過，本次禁止匯入；請核對原帳單。")
        for index, record in enumerate(records, 1):
            metadata = record.get("provenance") or {}
            dated = dict(record, transaction_date=metadata.get("transaction_date"))
            label = {"purchase": "消費", "fee": "手續費", "refund": "退款／折抵", "payment": "繳款（轉帳）"}.get(metadata.get("statement_kind"), record.get("kind", ""))
            lines.append(f"{index}. {record.get('merchant') or '未提供商家'} | {record.get('currency')} {record.get('amount')} | {format_record_time(dated)} | {label} | 入帳 {metadata.get('posting_date') or '未提供'}")
        lines.extend(str(warning) for warning in result.get("warnings", []))
        if result.get("pending"):
            lines.append("\n以下列未匯入，需補充欄位：\n" + json.dumps(result["pending"], ensure_ascii=False, indent=2, default=str))
        self._set_output("\n".join(lines))

    def _set_output(self, text: str) -> None:
        self.import_output.configure(state="normal")
        self.import_output.delete("1.0", "end")
        self.import_output.insert("1.0", text)
        self.import_output.configure(state="disabled")

    def preview_import(self) -> None:
        self.import_text.edit_modified(False)
        self.preview_records = []
        self.transfer_errors = []
        self.import_button.configure(state="disabled")
        content = self.import_text.get("1.0", "end").strip()
        if not content:
            self._set_output("請先貼上通知或交易 JSON。")
            return
        try:
            warnings = []
            if content.startswith(("{", "[")):
                payload = json.loads(content)
                if isinstance(payload, dict) and payload.get("format") == "personal-ledger-transfer":
                    self._preview_mobile_transfer(content)
                    return
                records = payload if isinstance(payload, list) else [payload]
                if not records or any(not isinstance(item, dict) for item in records):
                    raise ValueError("JSON 必須是交易物件或非空的交易物件陣列。")
                for item in records:
                    missing = [key for key in ("amount", "currency", "occurred_at") if not item.get(key)]
                    if missing:
                        raise ValueError("缺少欄位：" + "、".join(missing))
                    item.setdefault("source", self.import_source.get())
                    item.setdefault("account", self.import_account.get() or "日常消費")
                    item.setdefault("kind", "expense")
                self.preview_records = records
            else:
                from integrations import parse_notification
                result = parse_notification(content, source=self.import_source.get(), account=self.import_account.get() or "日常消費")
                warnings = result.get("warnings", [])
                if not result.get("transaction"):
                    self._set_output("無法建立交易：" + str(result.get("reason") or "通知欄位不足") + "\n" + "\n".join(warnings))
                    return
                self.preview_records = [dict(result["transaction"], force_review=True) if warnings else result["transaction"]]
            lines = [f"預覽 {len(self.preview_records)} 筆交易："]
            for index, item in enumerate(self.preview_records, 1):
                lines.append(f"{index}. {item.get('merchant') or '未提供商家'} | {item.get('currency')} {item.get('amount')} | {item.get('account')} | {item.get('occurred_at')} | {SOURCE.get(item.get('source'), item.get('source'))}")
            if warnings:
                lines.append("\n解析提醒（請核對再匯入）：\n" + "\n".join(warnings))
            self._set_output("\n".join(lines))
            self.import_button.configure(state="normal")
        except Exception as error:
            self._set_output(f"預覽失敗：{error}")

    def commit_import(self) -> None:
        if not self.preview_records:
            return
        results, errors = [], []
        preview_errors = [f"原始第 {error['index']} 筆未匯入：{error['error']}" for error in self.transfer_errors]
        for index, record in enumerate(self.preview_records, 1):
            try:
                result = self.ledger.ingest(record)
                description = "相同來源已匯入，未重複記帳" if result.get("duplicate") else {"pending": "已列為待確認", "verified": "已完成核對", "unverified": "已入帳，尚未核對"}.get(result.get("status"), "已處理")
                results.append(f"第 {index} 筆：{description}")
            except Exception as error:
                errors.append(f"第 {index} 筆失敗：{error}")
        self.preview_records = []
        self.transfer_errors = []
        self.import_button.configure(state="disabled")
        self._set_output("\n".join(results + errors + preview_errors))
        self.refresh()
        self.status.set(f"匯入完成：{len(results)} 筆已處理，{len(errors) + len(preview_errors)} 筆未匯入。重複交易不會再次入帳。")

    def _run_job(self, label: str, worker, done=None, quiet: bool = False) -> None:
        if self.busy:
            self.status.set("已有工作執行中，請等候完成。")
            return
        self.busy = True
        self.status.set(label)
        self.progress.start(12)
        for button in self.worker_buttons:
            button.configure(state="disabled")
        def run():
            try:
                self.results.put((True, worker(), done, quiet))
            except Exception as error:
                self.results.put((False, str(error), None, quiet))
        threading.Thread(target=run, daemon=True).start()

    def _poll_results(self) -> None:
        if self._closed:
            return
        try:
            success, result, done, quiet = self.results.get_nowait()
        except queue.Empty:
            pass
        else:
            self.busy = False
            self.progress.stop()
            for button in self.worker_buttons:
                button.configure(state="normal")
            self.refresh()
            if success:
                if done:
                    done(result)
                else:
                    self.status.set(str(result))
            else:
                self.status.set("工作未完成：" + str(result))
                if not quiet:
                    messagebox.showerror("工作未完成", str(result), parent=self.root)
        self._poll_id = self.root.after(100, self._poll_results)

    def _gmail_status(self) -> None:
        try:
            from integrations import gmail_status
            status = gmail_status(self.gmail_config)
            self.gmail_status_text.set(status.get("message", "尚未設定 Gmail。"))
        except ImportError:
            self.gmail_status_text.set("Gmail 模組尚未安裝。可先使用手動匯入。")
        except Exception as error:
            self.gmail_status_text.set("Gmail 設定無法讀取：" + str(error))

    def connect_gmail(self) -> None:
        from integrations import connect_gmail
        self._run_job("正在開啟 Google 唯讀授權，請在瀏覽器完成登入…", lambda: connect_gmail(self.gmail_config), lambda result: self.status.set(result.get("message", "Gmail 授權工作已結束。")))

    def sync_gmail(self, automatic: bool = False) -> None:
        if automatic and (self.demo or self.busy or not self.auto_gmail.get()):
            return
        from integrations import gmail_status, sync_gmail
        if automatic:
            status = gmail_status(self.gmail_config)
            if not status.get("configured") or not status.get("connected"):
                return
        def done(result):
            progress_message = result.get("message") or ("尚有更早郵件，下次同步繼續。" if result.get("has_more") else "")
            pending = result.get("pending", [])
            self.notebook.tab(self.tabs["import"], text=f"匯入 · 郵件待核對 {len(pending)}" if pending else "匯入")
            self.status.set(f"Gmail：匯入 {result.get('imported', 0)} 筆，重複 {result.get('duplicates', 0)} 筆，略過 {result.get('skipped', 0)} 筆，郵件待核對 {len(pending)} 封。" + progress_message)
            if automatic:
                if result.get("errors"):
                    self.status.set(self.status.get() + "部分郵件讀取失敗，可手動同步查看。")
                return
            lines = []
            records = []
            for index, preview in enumerate(pending, 1):
                if preview.get("transaction"):
                    records.append(dict(preview["transaction"], force_review=True))
                lines.append(f"待核對郵件 {index}：" + "；".join(str(w) for w in preview.get("warnings", [])))
            if records:
                self.import_text.delete("1.0", "end")
                self.import_text.insert("1.0", json.dumps(records, ensure_ascii=False, indent=2, default=str))
                self.import_text.edit_modified(False)
                self.preview_records = []
                self.import_button.configure(state="disabled")
                lines.insert(0, "未自動入帳的郵件候選資料已放入上方。請確認欄位、按「預覽內容」，再決定是否匯入待確認。")
            lines.extend(str(error) for error in result.get("errors", []))
            if progress_message:
                lines.append(progress_message)
            self._set_output("\n".join(lines) or "Gmail 同步完成，沒有需要人工處理的郵件。")
            if result.get("pending") or result.get("errors"):
                self.notebook.select(self.tabs["import"])
        self._run_job("正在讀取符合篩選條件的 Gmail 通知…", lambda: sync_gmail(self.ledger, self.gmail_config), done, quiet=automatic)

    def configure_gmail(self) -> None:
        existing = self._read_json(self.gmail_config)
        selected = filedialog.askopenfilename(parent=self.root, title="選擇 Google Cloud OAuth 桌面應用程式 JSON", filetypes=[("OAuth JSON", "*.json")])
        if not selected:
            return
        def submit(values):
            client_path = Path(values["oauth_client_file"]).expanduser()
            if not client_path.is_file():
                raise ValueError("請填入從 Google Cloud 下載的 OAuth 桌面應用程式 JSON 檔案路徑。")
            senders = [sender.strip() for sender in values["senders"].split(",") if sender.strip()]
            if not senders and not values["label"]:
                raise ValueError("請填入可信任的銀行寄件者，或 Gmail 標籤。只有標籤時僅下載預覽。")
            days = int(values["lookback_days"])
            if not 1 <= days <= 366:
                raise ValueError("回查天數必須介於 1 與 366。")
            config = dict(existing)
            config.update(oauth_client_file=str(client_path.resolve()), senders=senders, label=values["label"], lookback_days=days, account=values["account"], timezone_offset=values["timezone_offset"])
            self.gmail_config.parent.mkdir(parents=True, exist_ok=True)
            self.gmail_config.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
            self.status.set("已儲存 Gmail 設定。請按「連結 Google 帳號」完成唯讀授權。")
        self._form("Gmail 設定", [("oauth_client_file", "OAuth JSON 完整路徑", selected), ("senders", "銀行寄件者（逗號分隔）", ", ".join(existing.get("senders", []))), ("label", "Gmail 標籤（選填）", existing.get("label", "")), ("lookback_days", "回查天數", str(existing.get("lookback_days", 30))), ("account", "通知對應帳戶", existing.get("account", "日常消費")), ("timezone_offset", "通知時區", existing.get("timezone_offset", "+08:00"))], submit)

    def update_quotes(self, automatic: bool = False) -> None:
        if automatic and (self.busy or not self.data.get("portfolio")):
            return
        from integrations import update_quotes
        def done(result):
            errors = result.get("errors", [])
            text = f"行情更新完成：{result.get('updated', 0)} 筆。"
            if errors:
                text += " " + "；".join(str(error) for error in errors)
            self.asset_status.set(text)
            self.status.set(text)
        self._run_job("正在更新行情；離線時會保留最後報價…", lambda: update_quotes(self.ledger), done, quiet=automatic)

    def save_settings(self) -> None:
        self.settings["auto_quotes"] = self.auto_quotes.get()
        self.settings["auto_gmail"] = self.auto_gmail.get()
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        self.settings_path.write_text(json.dumps(self.settings, ensure_ascii=False, indent=2), encoding="utf-8")
        self.status.set("已儲存 Gmail 與行情更新設定。")

    def _auto_refresh(self) -> None:
        if self._closed:
            return
        self.refresh()
        ticks = getattr(self, "_minute_ticks", 0) + 1
        self._minute_ticks = ticks
        if ticks % 15 == 0 and self.auto_quotes.get():
            self.update_quotes(automatic=True)
        if ticks % 5 == 0:
            self.sync_gmail(automatic=True)
        self._auto_id = self.root.after(60000, self._auto_refresh)

    def _startup_quotes(self) -> None:
        if not self._closed and not self.demo and self.auto_quotes.get() and self.data.get("portfolio"):
            self.update_quotes(automatic=True)

    def _startup_gmail(self) -> None:
        if self._closed or self.demo or not self.auto_gmail.get():
            return
        if self.busy:
            self._startup_gmail_id = self.root.after(1000, self._startup_gmail)
            return
        self.sync_gmail(automatic=True)

    def export_csv(self) -> None:
        path = filedialog.asksaveasfilename(parent=self.root, title="匯出帳本 CSV", defaultextension=".csv", initialfile="個人帳本.csv", filetypes=[("CSV", "*.csv")])
        if path:
            try:
                self.ledger.export_csv(Path(path))
                self.status.set("已匯出帳本：" + path)
            except Exception as error:
                self.error(error)

    def backup(self) -> None:
        path = filedialog.asksaveasfilename(parent=self.root, title="備份資料庫", defaultextension=".sqlite3", initialfile="ledger-backup-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".sqlite3", filetypes=[("SQLite", "*.sqlite3")])
        if path:
            try:
                self.ledger.backup(Path(path))
                self.status.set("已建立資料庫備份：" + path)
            except Exception as error:
                self.error(error)

    def restore(self) -> None:
        if self.busy:
            self.status.set("請等候目前工作完成，再還原備份。")
            return
        if self.sync_server is not None:
            self.status.set("請先在「設定」停止 iPhone 同步服務，再還原備份。")
            return
        path = filedialog.askopenfilename(parent=self.root, title="選擇要還原的帳本備份", filetypes=[("SQLite 備份", "*.sqlite3 *.db"), ("所有檔案", "*.*")])
        if not path:
            return
        approved = messagebox.askyesno("還原帳本備份", "要用這份備份取代目前帳本嗎？\n\n" + path + "\n\n程式會先驗證備份，並自動備份目前帳本，再進行還原。還原後的帳本可能不包含備份時間之後的交易。", parent=self.root, default="no", icon="warning")
        if not approved:
            return
        try:
            self.ledger.restore_backup(Path(path))
            self.preview_records = []
            self.import_button.configure(state="disabled")
            self.refresh()
            self.status.set("已驗證並還原帳本；還原前的帳本已另存備份。")
        except Exception as error:
            self.error(error)

    def open_demo(self) -> None:
        path = self.database.parent / "demo.sqlite3"
        try:
            seed_demo(Ledger(path))
            window = tk.Toplevel(self.root)
            app = LedgerApp(window, path, demo=True)
            window._ledger_app = app
        except Exception as error:
            self.error(error)

    def error(self, error: Exception) -> None:
        self.status.set("未完成：" + str(error))
        messagebox.showerror("未完成", str(error), parent=self.root)

    def close(self) -> None:
        self._closed = True
        for callback in (self._poll_id, self._auto_id, self._startup_id, self._startup_gmail_id):
            self.root.after_cancel(callback)
        if self.sync_server is not None:
            self.sync_server.shutdown()
            self.sync_server.server_close()
            self.sync_server = None
        self.root.destroy()


def main() -> None:
    parser = argparse.ArgumentParser(description="個人總帳本 Windows 離線桌面程式")
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--statement", type=Path, help="開啟本機帳單預覽，不自動匯入")
    parser.add_argument("--statement-account", default="台新信用卡", help="帳單所屬帳戶，須與 Apple Pay 紀錄一致")
    parser.add_argument("--smoke-test", action="store_true", help="建立介面後立即結束，不修改帳目")
    args = parser.parse_args()
    root = tk.Tk()
    app = LedgerApp(root, args.database)
    if args.smoke_test:
        root.withdraw()
        root.update_idletasks()
        app.close()
        print("Windows ledger UI smoke test passed.")
        return
    if args.statement:
        app.import_account.set(args.statement_account)
        root.after(100, lambda: app.load_statement(args.statement))
    root.mainloop()


if __name__ == "__main__":
    main()
