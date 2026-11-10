import csv
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
import sqlite3
import tempfile
import unittest

from ledger import Ledger, from_minor, to_minor


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.database = Path(self.tmp.name) / 'ledger.sqlite3'
        self.ledger = Ledger(self.database)

    def record(self, **changes):
        payload = dict(source='apple_pay',external_id='wallet-1',amount='500',currency='TWD',
                       merchant='便利商店 A',account='信用卡 1234',kind='expense',
                       occurred_at='2026-11-10T12:00:00+08:00')
        payload.update(changes)
        return payload

    def asset(self, **changes):
        payload = dict(symbol='2330',market='TWSE',instrument_kind='stock',account='證券',
                       kind='buy',quantity='10',cash_amount='10000',fee='20',currency='TWD',
                       occurred_at='2026-11-10T12:00:00+08:00')
        payload.update(changes)
        return payload

    def test_repeat_ingest_is_idempotent(self):
        first = self.ledger.ingest(self.record())
        second = self.ledger.ingest(self.record())
        self.assertEqual(first['entry_id'],second['entry_id'])
        self.assertTrue(second['duplicate'])
        self.assertEqual(self.ledger.snapshot()['summary']['by_currency'][0]['expense_minor'],50000)

    def test_matching_window_edges_survive_indexed_range_lookup(self):
        # Same moment written in another offset, 3 days later for date-only statements.
        for day in range(1, 40):
            self.ledger.ingest(self.record(external_id=f'old-{day}',occurred_at=f'2026-10-{day % 28 + 1:02d}T12:00:00+08:00'))
        first = self.ledger.ingest(self.record(external_id='edge',occurred_at='2026-11-10T23:55:00+08:00'))
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-edge',occurred_at='2026-11-10T16:05:00Z'))
        self.assertEqual(first['entry_id'],bank['entry_id'])
        late = self.ledger.ingest(self.record(source='statement',external_id='statement-edge',time_precision='day',
                                              occurred_at='2026-11-13T23:55:00+08:00'))
        self.assertEqual(late['entry_id'],first['entry_id'])
        beyond = self.ledger.ingest(self.record(source='statement',external_id='statement-beyond',time_precision='day',
                                                occurred_at='2026-11-14T00:00:00+08:00'))
        self.assertIsNone(beyond['entry_id'])

    def test_far_history_is_not_a_candidate(self):
        old = self.ledger.ingest(self.record(external_id='old',occurred_at='2026-11-01T12:00:00+08:00'))
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-new'))
        self.assertNotEqual(old['entry_id'],bank.get('entry_id'))
        self.assertEqual(len(self.ledger.snapshot()['entries']),2)

    def test_lookup_indexes_exist(self):
        with sqlite3.connect(self.database) as connection:
            names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertTrue({'entry_match','source_entry','review_entry','review_source','asset_holding'} <= names)

    def test_changed_replay_rejected(self):
        self.ledger.ingest(self.record())
        with self.assertRaises(ValueError):
            self.ledger.ingest(self.record(amount='501'))
        self.assertEqual(len(self.ledger.snapshot()['sources']),1)

    def test_transfer_provenance_saved_without_changing_replay_identity(self):
        self.ledger.ingest(self.record(provenance={'transfer_export_id':'export-1'}))
        retry=self.ledger.ingest(self.record(provenance={'transfer_export_id':'export-2'}))
        self.assertTrue(retry['duplicate'])
        import json
        stored=json.loads(self.ledger.snapshot()['sources'][0]['payload_json'])
        self.assertEqual(stored['provenance']['transfer_export_id'],'export-1')

    def test_equal_bank_notice_links_without_double_count(self):
        first = self.ledger.ingest(self.record())
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-1',occurred_at='2026-11-10T04:01:00Z'))
        self.assertEqual(first['entry_id'],bank['entry_id'])
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),1)
        self.assertEqual(snapshot['entries'][0]['status'],'verified')
        self.assertFalse(snapshot['reviews'])

    def test_mismatched_amount_queued_and_preserves_original(self):
        self.ledger.ingest(self.record())
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-1',amount='515'))
        snapshot = self.ledger.snapshot()
        self.assertEqual(snapshot['entries'][0]['amount_minor'],50000)
        self.assertEqual(len(snapshot['entries']),1)
        self.assertEqual(snapshot['reviews'][0]['reason'],'amount_mismatch')
        self.assertEqual(snapshot['reviews'][0]['source']['amount_minor'],51500)
        self.ledger.resolve_review(bank['review_id'],'use_source')
        snapshot = self.ledger.snapshot()
        self.assertEqual(snapshot['entries'][0]['amount_minor'],51500)
        self.assertFalse(snapshot['reviews'])
        self.assertEqual(snapshot['entries'][0]['status'],'verified')

    def test_keep_original_and_replay_does_not_reopen(self):
        self.ledger.ingest(self.record())
        payload = self.record(source='gmail',external_id='mail',amount='515')
        result = self.ledger.ingest(payload)
        self.ledger.resolve_review(result['review_id'],'keep_entry')
        self.assertTrue(self.ledger.ingest(payload)['duplicate'])
        self.assertEqual(self.ledger.snapshot()['entries'][0]['amount_minor'],50000)
        self.assertFalse(self.ledger.snapshot()['reviews'])

    def test_ambiguous_same_merchant_needs_manual_link(self):
        a = self.ledger.ingest(self.record(source='manual'))
        self.ledger.ingest(self.record(source='manual',external_id='wallet-2',occurred_at='2026-11-10T12:02:00+08:00'))
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-1'))
        self.assertIsNone(bank['entry_id'])
        self.assertEqual(len(self.ledger.snapshot()['entries']),2)
        self.assertEqual(self.ledger.snapshot()['reviews'][0]['reason'],'ambiguous_match')
        self.ledger.resolve_review(bank['review_id'],'link',a['entry_id'])
        self.assertFalse(self.ledger.snapshot()['reviews'])
        self.assertEqual(len(self.ledger.snapshot()['entries']),2)

    def test_amount_alone_not_used_for_matching(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='gmail',external_id='mail-1',merchant='不同商店',occurred_at='2026-11-10T14:00:00+08:00'))
        self.assertEqual(len(self.ledger.snapshot()['entries']),2)

    def test_bank_merchant_variation_needs_review_instead_of_duplicate_expense(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='gmail',external_id='bank-merchant-variant',merchant='不同的銀行商家描述'))
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),1)
        self.assertEqual(snapshot['reviews'][0]['reason'],'merchant_mismatch')

    def test_same_source_resend_is_reviewed_without_double_spending(self):
        self.ledger.ingest(self.record(source='gmail',external_id='original'))
        self.ledger.ingest(self.record(source='gmail',external_id='resend'))
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),1)
        self.assertEqual(snapshot['reviews'][0]['reason'],'possible_duplicate')
        self.assertEqual(snapshot['summary']['by_currency'][0]['expense_minor'],50000)

    def test_force_review_cannot_be_bypassed_by_equal_amount(self):
        self.ledger.ingest(self.record())
        result = self.ledger.ingest(self.record(source='gmail',external_id='needs-review',force_review=True))
        self.assertIsNotNone(result['review_id'])
        self.assertEqual(result['status'],'pending')
        self.assertEqual(self.ledger.snapshot()['reviews'][0]['reason'],'manual_confirmation')

    def test_different_account_not_used_for_matching(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='gmail',external_id='mail-1',account='另一張卡'))
        self.assertEqual(len(self.ledger.snapshot()['entries']),2)

    def test_cross_currency_requires_confirmation_and_no_overwrite(self):
        self.ledger.ingest(self.record())
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail-1',currency='USD',amount='15'))
        self.assertEqual(self.ledger.snapshot()['reviews'][0]['reason'],'currency_mismatch')
        with self.assertRaises(ValueError):
            self.ledger.resolve_review(bank['review_id'],'use_source')
        self.assertEqual(self.ledger.snapshot()['entries'][0]['currency'],'TWD')

    def test_statement_missing_entry_waits_for_approval(self):
        result = self.ledger.ingest(self.record(source='statement',external_id='statement-1',time_precision='day'))
        self.assertEqual(self.ledger.snapshot()['entries'],[])
        self.assertEqual(self.ledger.snapshot()['reviews'][0]['reason'],'missing_entry')
        self.ledger.resolve_review(result['review_id'],'use_source')
        self.assertEqual(len(self.ledger.snapshot()['entries']),1)
        self.assertEqual(self.ledger.snapshot()['entries'][0]['status'],'verified')

    def test_date_only_statement_preserves_original_dates_note_and_category_in_csv(self):
        statement = self.record(source='statement', external_id='dated-statement', category='交通',
            occurred_at='2026-11-10T00:00:00+08:00', time_precision='day', force_review=True,
            provenance={'transaction_date':'2026-11-10','posting_date':'2026-11-12',
                        'statement_kind':'purchase','description':'電子票證\n加值',
                        'raw_line':'PRIVATE-STATEMENT-LINE'})
        result = self.ledger.ingest(statement)
        pending = self.ledger.snapshot()['reviews'][0]['source']
        self.assertEqual(pending['transaction_date'], '2026-11-10')
        self.assertEqual(pending['posting_date'], '2026-11-12')
        self.ledger.resolve_review(result['review_id'], 'use_source')
        entry = self.ledger.snapshot()['entries'][0]
        self.assertEqual(entry['time_precision'], 'day')
        self.assertEqual(entry['transaction_date'], '2026-11-10')
        self.assertEqual(entry['posting_date'], '2026-11-12')
        self.assertEqual(entry['statement_kind'], 'purchase')
        self.assertEqual(entry['category'], '交通')
        self.assertEqual(entry['note'], '電子票證 加值')
        # UTC storage is the preceding date, so original dates must not be
        # reconstructed from a viewer's local timezone.
        self.assertTrue(entry['occurred_at'].startswith('2026-11-09T16:00:00'))
        path = Path(self.tmp.name) / 'statement-export.csv'
        self.ledger.export_csv(path)
        with path.open(encoding='utf-8-sig', newline='') as handle:
            exported = list(csv.DictReader(handle))[0]
        self.assertEqual(exported['time_precision'], 'day')
        self.assertEqual(exported['transaction_date'], '2026-11-10')
        self.assertEqual(exported['posting_date'], '2026-11-12')
        self.assertEqual(exported['statement_kind'], 'purchase')
        self.assertEqual(exported['note'], '電子票證 加值')
        self.assertNotIn('PRIVATE-STATEMENT-LINE', path.read_text(encoding='utf-8-sig'))

    def test_statement_match_preserves_precise_original_entry_description_and_category(self):
        original = self.ledger.ingest(self.record(category='餐飲'))
        original_entry = self.ledger.snapshot()['entries'][0]
        self.ledger.update_entry(original['entry_id'], {'note':'我自己的註記'}, original_entry['revision'])
        statement = self.ledger.ingest(self.record(source='statement', external_id='matching-statement',
            merchant='銀行商家描述', category='銀行分類', amount='515',
            occurred_at='2026-11-10T00:00:00+08:00', time_precision='day', force_review=True,
            provenance={'transaction_date':'2026-11-10','posting_date':'2026-11-12',
                        'statement_kind':'purchase','description':'帳單原始說明'}))
        self.ledger.resolve_review(statement['review_id'], 'use_source')
        entries = self.ledger.snapshot()['entries']
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry['amount_minor'], 51500)
        self.assertEqual(entry['merchant'], original_entry['merchant'])
        self.assertEqual(entry['occurred_at'], original_entry['occurred_at'])
        self.assertEqual(entry['category'], '餐飲')
        self.assertEqual(entry['note'], '我自己的註記')
        self.assertEqual(entry['time_precision'], 'minute')
        self.assertNotIn('transaction_date', entry)
        self.assertEqual(entry['posting_date'], '2026-11-12')

    def test_ambiguous_or_invalid_source_dates_are_not_invented(self):
        initial = self.ledger.ingest(self.record(source='manual', time_precision='day',
                                               provenance={'transaction_date':'2026-11-10'}))
        self.ledger.ingest(self.record(source='statement', external_id='other-source-date', time_precision='day',
            provenance={'transaction_date':'2026-11-11','posting_date':'2026-02-30','statement_kind':'bad\nkind'}))
        entry = self.ledger.snapshot()['entries'][0]
        self.assertEqual(entry['id'], initial['entry_id'])
        self.assertEqual(entry['time_precision'], 'day')
        self.assertNotIn('transaction_date', entry)
        self.assertNotIn('posting_date', entry)
        self.assertNotIn('statement_kind', entry)

    def test_statement_description_is_bounded_and_not_copied_from_other_sources(self):
        statement = self.ledger.ingest(self.record(source='statement', external_id='long-description',
            provenance={'description':'描' * 1100}))
        self.ledger.resolve_review(statement['review_id'], 'separate')
        self.assertEqual(len(self.ledger.snapshot()['entries'][0]['note']), 1000)
        inserted = self.ledger.ingest(self.record(source='manual', external_id='manual-description',
                                                 provenance={'description':'不作為帳單備註'}))
        manual = next(entry for entry in self.ledger.snapshot()['entries'] if entry['id'] == inserted['entry_id'])
        self.assertEqual(manual['note'], '')

    def test_refund_cannot_be_merged_into_expense_and_lost(self):
        expense = self.ledger.ingest(self.record())
        refund = self.ledger.ingest(self.record(source='statement',external_id='refund',kind='income'))
        with self.assertRaises(ValueError):
            self.ledger.resolve_review(refund['review_id'],'link',expense['entry_id'])
        self.ledger.resolve_review(refund['review_id'],'separate')
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),2)
        self.assertEqual(snapshot['summary']['by_currency'][0]['balance_minor'],0)

    def test_statement_confirms_existing_without_spending_again(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='statement',external_id='statement-1',time_precision='minute'))
        self.assertEqual(len(self.ledger.snapshot()['entries']),1)
        self.assertEqual(self.ledger.snapshot()['entries'][0]['status'],'verified')

    def test_date_only_statement_suggests_but_does_not_auto_confirm(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='statement',external_id='statement-1',date_precision='day',occurred_at='2026-11-10T00:00:00+08:00'))
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),1)
        self.assertEqual(snapshot['reviews'][0]['reason'],'time_uncertain')

    def test_ignore_nonexpense_statement_row(self):
        result = self.ledger.ingest(self.record(source='statement',external_id='statement-1'))
        self.ledger.resolve_review(result['review_id'],'ignore')
        self.assertFalse(self.ledger.snapshot()['reviews'])
        self.assertFalse(self.ledger.snapshot()['entries'])

    def test_resolve_twice_rejected(self):
        result = self.ledger.ingest(self.record(source='statement',external_id='s'))
        self.ledger.resolve_review(result['review_id'],'separate')
        with self.assertRaises(ValueError):
            self.ledger.resolve_review(result['review_id'],'separate')

    def test_separate_moves_bank_source_to_new_entry(self):
        original = self.ledger.ingest(self.record())
        bank = self.ledger.ingest(self.record(source='gmail',external_id='mail',amount='515'))
        self.ledger.resolve_review(bank['review_id'],'separate')
        entries = {e['id']:e for e in self.ledger.snapshot()['entries']}
        self.assertEqual(len(entries),2)
        self.assertEqual(entries[original['entry_id']]['status'],'unverified')

    def test_invalid_amount_or_timestamp_cannot_leave_partial_records(self):
        for changes in ({'amount':'NaN'},{'amount':'-1'},{'amount':'0'}, {'amount':'0.001'},
                        {'occurred_at':'2026-11-10T12:00:00'}, {'amount':1.5}, {'kind':'refund'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.ledger.ingest(self.record(**changes))
        self.assertFalse(self.ledger.snapshot()['sources'])

    def test_currency_precision(self):
        self.assertEqual(to_minor('500','TWD'),50000)
        self.assertEqual(to_minor('1','JPY'),1)
        self.assertEqual(to_minor('1.234','BHD'),1234)
        self.assertEqual(from_minor(1234,'BHD'),'1.234')
        with self.assertRaises(ValueError):
            to_minor('1.01','JPY')

    def test_revision_conflict_preserves_entry(self):
        result = self.ledger.ingest(self.record())
        entry = self.ledger.snapshot()['entries'][0]
        self.ledger.update_entry(result['entry_id'],{'category':'餐飲'},entry['revision'])
        with self.assertRaises(ValueError):
            self.ledger.update_entry(result['entry_id'],{'category':'交通'},entry['revision'])
        self.assertEqual(self.ledger.snapshot()['entries'][0]['category'],'餐飲')

    def test_edited_merchant_does_not_hide_original_matching_identity(self):
        first = self.ledger.ingest(self.record())
        entry = self.ledger.snapshot()['entries'][0]
        self.ledger.update_entry(first['entry_id'],{'merchant':'自訂摘要'},entry['revision'])
        result = self.ledger.ingest(self.record(source='gmail',external_id='bank-original'))
        self.assertEqual(result['entry_id'],first['entry_id'])
        self.assertEqual(len(self.ledger.snapshot()['entries']),1)

    def test_portfolio_weighted_cost_fee_realized_and_quote(self):
        self.ledger.asset_event(self.asset())
        self.ledger.asset_event(self.asset(kind='sell',quantity='4',cash_amount='4800',fee='10',occurred_at='2026-11-11T12:00:00+08:00'))
        self.ledger.set_quote(dict(symbol='2330',market='TWSE',price='1200',currency='TWD',provider='test',as_of='2026-11-11T13:30:00+08:00'))
        position = self.ledger.snapshot()['portfolio'][0]
        self.assertEqual(Decimal(position['quantity_decimal']),6)
        self.assertEqual(Decimal(position['cost_decimal']),6012)
        self.assertEqual(Decimal(position['realized_decimal']),782)
        self.assertEqual(Decimal(position['value_decimal']),7200)
        self.assertEqual(Decimal(position['unrealized_decimal']),1188)

    def test_asset_oversell_and_backdated_oversell_roll_back(self):
        self.ledger.asset_event(self.asset())
        with self.assertRaises(ValueError):
            self.ledger.asset_event(self.asset(kind='sell',quantity='11'))
        with self.assertRaises(ValueError):
            self.ledger.asset_event(self.asset(kind='sell',quantity='1',occurred_at='2026-11-09T12:00:00+08:00'))
        self.assertEqual(len(self.ledger.snapshot()['asset_events']),1)

    def test_transfer_fee_not_silently_discarded(self):
        self.ledger.asset_event(self.asset())
        with self.assertRaises(ValueError):
            self.ledger.asset_event(self.asset(kind='transfer_out',quantity='1',fee='10'))
        self.assertEqual(len(self.ledger.snapshot()['asset_events']),1)

    def test_foreign_quote_does_not_report_wrong_profit(self):
        self.ledger.asset_event(self.asset())
        self.ledger.set_quote(dict(symbol='2330',market='TWSE',price='30',currency='USD',provider='test',as_of='2026-11-11T13:30:00+08:00'))
        p = self.ledger.snapshot()['portfolio'][0]
        self.assertEqual(p['quote_currency'],'USD')
        self.assertIsNone(p['unrealized_decimal'])

    def test_old_quote_cannot_overwrite_cache(self):
        self.ledger.asset_event(self.asset())
        quote = dict(symbol='2330',market='TWSE',price='1200',currency='TWD',provider='test',as_of='2026-11-11T13:30:00+08:00')
        self.ledger.set_quote(quote)
        result = self.ledger.set_quote(dict(quote,price='1100',as_of='2026-11-10T13:30:00+08:00'))
        self.assertFalse(result['updated'])
        self.assertEqual(self.ledger.snapshot()['quotes'][0]['price_decimal'],'1200')

    def test_export_formula_injection_protected(self):
        self.ledger.ingest(self.record(merchant='=1+2'))
        path = Path(self.tmp.name) / 'export.csv'
        self.ledger.export_csv(path)
        with path.open(encoding='utf-8-sig',newline='') as handle:
            row = next(csv.DictReader(handle))
        self.assertEqual(row['merchant'],"'=1+2")
        self.assertEqual(row['amount'],'500.00')

    def test_backup_reopens_and_matches_original(self):
        self.ledger.ingest(self.record())
        path = Path(self.tmp.name)/'backup.sqlite3'
        self.ledger.backup(path)
        self.assertEqual(len(Ledger(path).snapshot()['entries']),1)
        with self.assertRaises(ValueError):
            self.ledger.backup(path)

    def test_restore_validates_and_keeps_before_restore_backup(self):
        self.ledger.ingest(self.record())
        backup = Path(self.tmp.name)/'saved.sqlite3'
        self.ledger.backup(backup)
        self.ledger.ingest(self.record(external_id='new',merchant='另一家店'))
        result = self.ledger.restore_backup(backup)
        self.assertEqual(len(self.ledger.snapshot()['entries']),1)
        self.assertEqual(len(Ledger(result['previous_backup']).snapshot()['entries']),2)

    def test_invalid_restore_never_replaces_current_database(self):
        self.ledger.ingest(self.record())
        bad = Path(self.tmp.name)/'bad.sqlite3'
        bad.write_text('invalid database',encoding='utf-8')
        with self.assertRaises(ValueError):
            self.ledger.restore_backup(bad)
        self.assertEqual(len(self.ledger.snapshot()['entries']),1)

    def test_original_v1_schema_migrates_non_destructively(self):
        original = Path(self.tmp.name)/'old.sqlite3'
        with sqlite3.connect(original) as connection:
            connection.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf-8'))
            connection.execute("INSERT INTO accounts VALUES('a','銀行','cash','TWD')")
            connection.execute("INSERT INTO entries(id,account_id,kind,amount_minor,currency,merchant,occurred_at,status,updated_at) VALUES('e','a','expense',100,'TWD','原始帳目','2026-11-10T04:00:00+00:00','unverified','2026-11-10T04:00:00+00:00')")
        ledger = Ledger(original)
        self.assertEqual(ledger.snapshot()['entries'][0]['merchant'],'原始帳目')
        self.assertEqual(ledger.snapshot()['entries'][0]['category'],'未分類')

    def test_batch_ingest_matches_single_ingest_and_isolates_bad_records(self):
        records = [self.record(),
                   self.record(source='gmail',external_id='mail-1',occurred_at='2026-11-10T04:01:00Z'),
                   self.record(external_id='bad',amount='not-a-number'),
                   self.record(amount='501'),  # same identifier, different content
                   self.record(),  # exact replay inside the same batch
                   'not an object',
                   self.record(external_id='wallet-2',merchant='書店',occurred_at='2026-11-11T12:00:00+08:00')]
        outcomes = self.ledger.ingest_many(records, chunk_size=3)
        self.assertEqual([o['ok'] for o in outcomes],[True,True,False,False,True,False,True])
        self.assertEqual(outcomes[0]['result']['entry_id'],outcomes[1]['result']['entry_id'])
        self.assertTrue(outcomes[4]['result']['duplicate'])
        self.assertIn('內容不同',str(outcomes[3]['error']))
        self.assertTrue(all(isinstance(o['error'],ValueError) and not o.get('retryable') for o in outcomes if not o['ok']))
        snapshot = self.ledger.snapshot()
        self.assertEqual(len(snapshot['entries']),2)
        self.assertEqual(len(snapshot['sources']),3)
        self.assertEqual(snapshot['summary']['by_currency'][0]['expense_minor'],100000)
        self.assertEqual(self.ledger.ingest_many([]),[])

    def test_batch_storage_failure_rolls_back_only_the_unfinished_chunk(self):
        records = [self.record(external_id=f'wallet-{index}',occurred_at=f'2026-11-{index+1:02d}T12:00:00+08:00') for index in range(5)]
        original = self.ledger._ingest_prepared
        calls = []
        def failing(connection, prepared):
            calls.append(prepared['external_id'])
            if len(calls) == 4:
                raise sqlite3.OperationalError('disk I/O error')
            return original(connection, prepared)
        self.ledger._ingest_prepared = failing
        outcomes = self.ledger.ingest_many(records, chunk_size=2)
        self.assertEqual([o['ok'] for o in outcomes],[True,True,False,False,False])
        self.assertTrue(all(o.get('retryable') for o in outcomes[2:]))
        self.assertEqual(calls,['wallet-0','wallet-1','wallet-2','wallet-3'])
        # The first chunk is committed; the failed chunk left nothing behind.
        self.assertEqual({s['external_id'] for s in self.ledger.snapshot()['sources']},{'wallet-0','wallet-1'})
        self.ledger._ingest_prepared = original
        retried = self.ledger.ingest_many(records)
        self.assertEqual([o['result']['duplicate'] for o in retried],[True,True,False,False,False])
        self.assertEqual(len(self.ledger.snapshot()['entries']),5)

    def test_change_token_tracks_commits_but_not_reads(self):
        first = self.ledger.change_token()
        self.assertIsNotNone(first)
        self.ledger.snapshot()
        self.ledger.external_ids('apple_pay')
        self.assertEqual(self.ledger.change_token(),first)
        self.ledger.ingest(self.record())
        second = self.ledger.change_token()
        self.assertNotEqual(second,first)
        self.ledger.ingest(self.record())  # replay writes nothing
        self.assertEqual(self.ledger.change_token(),second)
        self.ledger.asset_event(self.asset())
        third = self.ledger.change_token()
        self.assertNotEqual(third,second)
        self.ledger.set_quote({'symbol':'2330','market':'TWSE','currency':'TWD','price':'1100','as_of':'2026-11-10T13:30:00+08:00'})
        self.assertNotEqual(self.ledger.change_token(),third)
        self.assertIsNone(Ledger(Path(self.tmp.name)/'other.sqlite3').__class__.change_token(type('Missing',(),{'database':Path(self.tmp.name)/'missing.sqlite3'})()))

    def test_lean_lookups_agree_with_the_full_snapshot(self):
        self.ledger.ingest(self.record())
        self.ledger.ingest(self.record(source='gmail',external_id='mail-1',occurred_at='2026-11-10T04:01:00Z'))
        self.ledger.ingest(self.record(source='manual',external_id='manual-1',merchant='早餐',account='現金'))
        self.ledger.asset_event(self.asset())
        self.ledger.set_quote({'symbol':'2330','market':'TWSE','currency':'TWD','price':'1100','as_of':'2026-11-10T13:30:00+08:00'})
        snapshot = self.ledger.snapshot()
        self.assertEqual(self.ledger.external_ids('gmail'),{'mail-1'})
        self.assertEqual(self.ledger.external_ids('statement'),set())
        self.assertEqual(self.ledger.portfolio(),snapshot['portfolio'])
        known = {(s['source'],s['external_id']):s for s in self.ledger.known_sources(('manual','apple_pay'))}
        self.assertEqual(set(known),{('apple_pay','wallet-1'),('manual','manual-1')})
        for source in snapshot['sources']:
            key = (source['source'],source['external_id'])
            if key in known:
                self.assertEqual(known[key],{field:source[field] for field in known[key]})
        self.assertEqual(self.ledger.known_sources(()),[])

    def test_portfolio_numbers_never_use_exponent_notation(self):
        self.ledger.asset_event(self.asset(symbol='BTC',market='BINANCE',instrument_kind='crypto',quantity='0.00000003',cash_amount='100',fee='0'))
        self.ledger.asset_event(self.asset(symbol='BTC',market='BINANCE',instrument_kind='crypto',kind='sell',quantity='0.00000001',cash_amount='40',fee='0',occurred_at='2026-11-11T12:00:00+08:00'))
        self.ledger.asset_event(self.asset(symbol='BTC',market='BINANCE',instrument_kind='crypto',kind='sell',quantity='0.00000002',cash_amount='80',fee='0',occurred_at='2026-11-12T12:00:00+08:00'))
        position = self.ledger.portfolio()[0]
        for field in ('quantity_decimal','cost_decimal','realized_decimal','dividend_decimal'):
            self.assertRegex(position[field],r'^-?\d+(\.\d+)?$')
        self.assertEqual(Decimal(position['quantity_decimal']),0)
        self.assertEqual(position['quantity_decimal'],'0.00000000')
        self.assertEqual(Decimal(position['realized_decimal']),Decimal('20'))


if __name__ == '__main__':
    unittest.main()
