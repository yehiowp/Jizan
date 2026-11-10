"""Cross-language contract test: iPhone JS -> Windows -> iPhone snapshot."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from ledger import Ledger
from transfer import preview_transfer, mobile_snapshot


@unittest.skipUnless(shutil.which('node'), 'Node is only needed for the mobile contract test')
class MobileRoundtripTests(unittest.TestCase):
    def js(self, script, value):
        result = subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(value),text=True,
                                encoding='utf-8',capture_output=True,check=True,
                                cwd=Path(__file__).parent/'mobile')
        return json.loads(result.stdout)

    def test_mobile_export_windows_replay_and_safe_snapshot(self):
        row = dict(source='manual',external_id='mobile-contract',amount='125.50',currency='TWD',
                   merchant='合成午餐',account='日常消費',kind='expense',occurred_at='2026-11-10T12:30:00+08:00')
        payload = self.js("import{readFileSync}from'node:fs';import{normalize,makeTransfer}from'./dist/core.mjs';const r=normalize(JSON.parse(readFileSync(0,'utf8')));console.log(JSON.stringify(makeTransfer({device_id:crypto.randomUUID(),records:[r]},crypto.randomUUID(),new Date().toISOString())));",row)
        with tempfile.TemporaryDirectory() as directory:
            ledger = Ledger(Path(directory)/'ledger.sqlite3')
            records = preview_transfer(payload,ledger)['records']
            self.assertEqual(len(records),1)
            ledger.ingest(records[0])
            self.assertTrue(ledger.ingest(records[0])['duplicate'])
            snapshot = mobile_snapshot(ledger)
            checked = self.js("import{readFileSync}from'node:fs';import{validateSnapshot,pendingRecords,displayRows}from'./dist/core.mjs';const{snapshot,row}=JSON.parse(readFileSync(0,'utf8'));const s={snapshot:validateSnapshot(snapshot),records:[row]};console.log(JSON.stringify({pending:pendingRecords(s).length,rows:displayRows(s).length,amount:s.snapshot.entries[0].amount}));",dict(snapshot=snapshot,row=row))
            self.assertEqual(checked,dict(pending=0,rows=1,amount='125.50'))


if __name__=='__main__':
    unittest.main()
