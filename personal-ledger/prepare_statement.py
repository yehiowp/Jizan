"""Read an encrypted statement through a local, masked password prompt.

Passwords are accepted only in memory, never as command line arguments, environment
variables, logs, or output files. Decrypted material stays in the user's local app
data directory and is not imported into the ledger by this helper.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import uuid


MAX_BYTES = 30 * 1024 * 1024
MAX_PAGES = 100


class PasswordRequired(ValueError):
    """The user must supply a password through the local dialog."""


class IncorrectPassword(ValueError):
    """The password explicitly entered by the user did not decrypt the PDF."""


def imports_directory() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    return (Path(base) / "PersonalLedger" if base else Path.home() / ".personal-ledger") / "imports"


def _read_pdf(path):
    from pypdf import PdfReader

    path = Path(path)
    if path.suffix.lower() != ".pdf" or not path.is_file():
        raise ValueError("請選擇存在的 PDF 帳單。")
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("PDF 帳單超過 30 MB，請分批讀取。")
    try:
        return path, PdfReader(str(path))
    except Exception:
        raise ValueError("PDF 無法開啟，請確認檔案完整。") from None


def inspect_pdf(path) -> dict:
    """Inspect encryption only; do not try even an empty password."""
    _, reader = _read_pdf(path)
    return {"encrypted": reader.is_encrypted}


def _write_status(directory: Path, state: str, **fields) -> dict:
    status = dict(state=state, **fields)
    temporary = directory / "status.tmp"
    temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(directory / "status.json")
    return status


def new_request(imports_dir=None) -> Path:
    base = Path(imports_dir) if imports_dir is not None else imports_directory()
    base.mkdir(parents=True, exist_ok=True)
    directory = base / uuid.uuid4().hex
    directory.mkdir(mode=0o700)
    _write_status(directory, "created")
    return directory


def prepare_statement(path, password=None, *, directory=None) -> dict:
    """Create a private review copy and text; never modify the source or ledger.

    ``directory`` is a fresh request directory, normally created by ``new_request``.
    It allows an interactive caller to expose status without exposing PDF contents.
    The normal UI always chooses a directory outside the project/OneDrive folder.
    """
    from pypdf import PdfWriter

    path, reader = _read_pdf(path)
    try:
        if reader.is_encrypted:
            if not password:
                raise PasswordRequired("請在本機視窗輸入帳單密碼。")
            try:
                unlocked = reader.decrypt(password)
            except ImportError:
                raise RuntimeError("此加密 PDF 需要 pypdf 的加密套件。") from None
            except Exception:
                raise IncorrectPassword("密碼不正確，或此 PDF 無法解密。") from None
            if not unlocked:
                raise IncorrectPassword("密碼不正確，請再次確認。")
        if len(reader.pages) > MAX_PAGES:
            raise ValueError("PDF 超過 100 頁，請分批讀取。")
        try:
            pages = [(page.extract_text() or "") for page in reader.pages]
        except Exception:
            raise ValueError("無法擷取 PDF 文字，請改用銀行匯出的文字型 PDF 或 CSV。") from None
        directory = Path(directory) if directory is not None else new_request()
        # Refuse to overwrite an existing review copy, even on a repeated request.
        if any((directory / name).exists() for name in ("statement.pdf", "statement.txt")):
            raise ValueError("此讀取作業已有輸出，請建立新的讀取作業。")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        pdf_path = directory / "statement.pdf"
        text_path = directory / "statement.txt"
        try:
            with (directory / "statement.pdf.tmp").open("xb") as stream:
                writer.write(stream)
            text = "\n\n".join(f"【第 {index} 頁】\n{page}" for index, page in enumerate(pages, 1))
            (directory / "statement.txt.tmp").write_text(text, encoding="utf-8")
            (directory / "statement.pdf.tmp").replace(pdf_path)
            (directory / "statement.txt.tmp").replace(text_path)
            return _write_status(
                directory, "ready", page_count=len(pages),
                has_text=any(page.strip() for page in pages),
                source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                pdf_path=str(pdf_path), text_path=str(text_path),
                ledger_imported=False,
            )
        except Exception:
            # Only remove the fixed, newly created files belonging to this request.
            for name in ("statement.pdf.tmp", "statement.txt.tmp", "statement.pdf", "statement.txt"):
                (directory / name).unlink(missing_ok=True)
            raise
        finally:
            writer.close()
    finally:
        password = None


def run_dialog(path, *, directory=None) -> int:
    """The only user-facing password entry point; safe to launch with pythonw."""
    import tkinter as tk
    from tkinter import messagebox, simpledialog

    directory = Path(directory) if directory is not None else new_request()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    password = None
    try:
        encrypted = inspect_pdf(path)["encrypted"]
        while True:
            if encrypted:
                _write_status(directory, "awaiting_password")
                password = simpledialog.askstring(
                    "個人總帳本｜本機讀取帳單",
                    "這份 PDF 有密碼保護。\n\n"
                    "請只在此 Windows 視窗輸入帳單密碼，不用傳到聊天。\n"
                    "密碼不會保存；解密副本與文字僅存於本機應用程式資料夾。\n"
                    "此步驟只供核對預覽，尚不會寫入總帳。\n\n帳單密碼：",
                    show="*", parent=root,
                )
                if password is None:
                    _write_status(directory, "cancelled")
                    return 0
                if not password:
                    messagebox.showerror("帳單密碼", "請輸入帳單密碼，或按取消結束。", parent=root)
                    continue
            _write_status(directory, "preparing")
            try:
                result = prepare_statement(path, password=password, directory=directory)
                break
            except IncorrectPassword:
                _write_status(directory, "awaiting_password")
                messagebox.showerror("帳單密碼", "密碼不正確或無法解密，請重新輸入，或按取消。", parent=root)
            finally:
                password = None
        messagebox.showinfo(
            "已完成本機讀取",
            f"已讀取 {result['page_count']} 頁，尚未匯入總帳。\n"
            "接下來可核對交易欄位與帳單版型。\n\n"
            f"本機資料夾：\n{directory}", parent=root,
        )
        return 0
    except Exception:
        # Do not include exception text: libraries can embed user-entered secrets.
        _write_status(directory, "error", reason="PDF 無法讀取，請確認檔案或改用 CSV。")
        messagebox.showerror("讀取失敗", "PDF 無法讀取，請確認檔案或改用 CSV。密碼沒有保存。", parent=root)
        return 1
    finally:
        password = None
        root.destroy()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="本機密碼視窗讀取 PDF 帳單，僅作預覽，不匯入總帳。")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--request-id", help="僅接受本程式產生的 32 字元 request id，不接受密碼。")
    args = parser.parse_args(argv)
    directory = None
    if args.request_id:
        if len(args.request_id) != 32 or any(character not in "0123456789abcdef" for character in args.request_id):
            parser.error("request id 格式無效")
        directory = imports_directory() / args.request_id
        if not directory.is_dir() or not (directory / "status.json").is_file():
            parser.error("讀取作業不存在，請重新建立")
    return run_dialog(args.pdf, directory=directory)


if __name__ == "__main__":
    raise SystemExit(main())
