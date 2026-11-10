"""Synthetic PDF fixtures only; no personal bank data or actual passwords."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

import prepare_statement as preparation


class PrepareStatementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.pdf = self.base / "synthetic.pdf"
        writer = PdfWriter()
        page = writer.add_blank_page(width=300, height=200)
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})})})
        stream = DecodedStreamObject()
        stream.set_data(b"BT /F1 12 Tf 20 100 Td (SYNTHETIC MERCHANT TWD 123 EXPENSE) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(stream)
        writer.encrypt("synthetic-password", algorithm="AES-256")
        with self.pdf.open("wb") as output:
            writer.write(output)

    def test_inspection_never_tries_a_password(self):
        with patch.object(PdfReader, "decrypt", side_effect=AssertionError("unexpected decrypt")):
            self.assertEqual(preparation.inspect_pdf(self.pdf), {"encrypted": True})

    def test_missing_or_incorrect_password_produces_no_review_copy(self):
        imports = self.base / "imports"
        directory = preparation.new_request(imports)
        with self.assertRaises(preparation.PasswordRequired):
            preparation.prepare_statement(self.pdf, directory=directory)
        with self.assertRaises(preparation.IncorrectPassword):
            preparation.prepare_statement(self.pdf, "wrong-fixture", directory=directory)
        self.assertEqual({path.name for path in directory.iterdir()}, {"status.json"})

    def test_private_copy_text_and_status_never_contain_password(self):
        original = self.pdf.read_bytes()
        directory = preparation.new_request(self.base / "imports")
        result = preparation.prepare_statement(self.pdf, "synthetic-password", directory=directory)
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["page_count"], 1)
        self.assertTrue(result["has_text"])
        self.assertFalse(result["ledger_imported"])
        self.assertEqual(self.pdf.read_bytes(), original)
        reader = PdfReader(result["pdf_path"])
        self.assertFalse(reader.is_encrypted)
        self.assertIn("SYNTHETIC MERCHANT", reader.pages[0].extract_text())
        self.assertIn("SYNTHETIC MERCHANT", Path(result["text_path"]).read_text(encoding="utf-8"))
        status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status, result)
        for path in directory.iterdir():
            self.assertNotIn(b"synthetic-password", path.read_bytes())
        self.assertEqual({path.suffix for path in directory.iterdir()}, {".json", ".pdf", ".txt"})

    def test_ready_request_cannot_be_overwritten(self):
        directory = preparation.new_request(self.base / "imports")
        preparation.prepare_statement(self.pdf, "synthetic-password", directory=directory)
        with self.assertRaisesRegex(ValueError, "已有輸出"):
            preparation.prepare_statement(self.pdf, "synthetic-password", directory=directory)

    def test_source_and_size_limits_are_checked_before_decryption(self):
        with self.assertRaises(ValueError):
            preparation.inspect_pdf(self.base / "missing.pdf")
        with patch.object(preparation, "MAX_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "30 MB"):
                preparation.inspect_pdf(self.pdf)

    def test_default_storage_uses_local_application_data(self):
        with patch.dict("os.environ", {"LOCALAPPDATA": str(self.base)}):
            request = preparation.new_request()
        self.assertEqual(request.parent, self.base / "PersonalLedger" / "imports")
        self.assertRegex(request.name, r"^[0-9a-f]{32}$")

    def test_cancelled_local_dialog_leaves_only_status(self):
        directory = preparation.new_request(self.base / "imports")
        with patch("tkinter.simpledialog.askstring", return_value=None), patch("tkinter.messagebox.showinfo"), patch("tkinter.messagebox.showerror"):
            self.assertEqual(preparation.run_dialog(self.pdf, directory=directory), 0)
        status = json.loads((directory / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status, {"state": "cancelled"})
        self.assertEqual({path.name for path in directory.iterdir()}, {"status.json"})

    def test_retry_only_uses_explicit_entries_in_masked_local_dialog(self):
        directory = preparation.new_request(self.base / "imports")
        with patch("tkinter.simpledialog.askstring", side_effect=["wrong-fixture", "synthetic-password"]) as prompt, patch("tkinter.messagebox.showinfo"), patch("tkinter.messagebox.showerror") as errors:
            self.assertEqual(preparation.run_dialog(self.pdf, directory=directory), 0)
        self.assertEqual(prompt.call_count, 2)
        self.assertTrue(all(call.kwargs["show"] == "*" for call in prompt.call_args_list))
        errors.assert_called_once()
        self.assertEqual(json.loads((directory / "status.json").read_text(encoding="utf-8"))["state"], "ready")
        for path in directory.iterdir():
            self.assertNotIn(b"synthetic-password", path.read_bytes())
            self.assertNotIn(b"wrong-fixture", path.read_bytes())


if __name__ == "__main__":
    unittest.main()
