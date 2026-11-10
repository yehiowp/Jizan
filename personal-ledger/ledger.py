"""Offline ledger and conservative reconciliation. All mutations are atomic."""

import argparse
from collections import defaultdict
from contextlib import closing, contextmanager
import csv
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import unicodedata
import uuid

CURRENCY_DIGITS = {c: 2 for c in ('TWD','USD','HKD','EUR','GBP','CNY','SGD','AUD','CAD','CHF')}
CURRENCY_DIGITS.update(JPY=0, KRW=0, BHD=3, KWD=3, USDT=6, USDC=6)
SCHEMA_VERSION = 2


def default_data_dir() -> Path:
    base = os.environ.get('LOCALAPPDATA')
    return Path(base) / 'PersonalLedger' if base else Path.home() / '.personal-ledger'


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def uid() -> str:
    return str(uuid.uuid4())


def decimal_value(value, label='數值') -> Decimal:
    if isinstance(value, (float, bool)):
        raise ValueError(f'{label}請使用十進位字串')
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f'{label}格式無效') from None
    if not result.is_finite() or abs(result) > Decimal('1000000000000000'):
        raise ValueError(f'{label}超出範圍')
    return result


def currency_code(value) -> str:
    code = str(value).strip().upper()
    if code not in CURRENCY_DIGITS:
        raise ValueError(f'不支援的幣別：{code}')
    return code


def to_minor(value, currency) -> int:
    number = decimal_value(value, '金額')
    scaled = number * (10 ** CURRENCY_DIGITS[currency_code(currency)])
    if scaled != scaled.to_integral_value() or abs(scaled) > 9_000_000_000_000_000_000:
        raise ValueError('金額的小數位數超過此幣別精度')
    return int(scaled)


def from_minor(value, currency) -> str:
    places = CURRENCY_DIGITS[currency_code(currency)]
    return f'{Decimal(value) / (10 ** places):.{places}f}'


def timestamp(value) -> str:
    try:
        date = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if date.tzinfo is None or date.utcoffset() is None:
            raise ValueError()
        return date.astimezone(timezone.utc).isoformat(timespec='microseconds')
    except (ValueError, TypeError, OverflowError):
        raise ValueError('交易時間需為含時區的 ISO 8601，例如 2026-11-10T14:30:00+08:00') from None


def text_value(value, label, maximum=200, optional=False) -> str:
    if value is None and optional:
        return ''
    if not isinstance(value, str) or (not value.strip() and not optional) or len(value) > maximum:
        raise ValueError(f'{label}未填或過長')
    if any(ord(c) < 32 for c in value):
        raise ValueError(f'{label}含無效控制字元')
    return value.strip()


def merchant_key(value) -> str:
    value = unicodedata.normalize('NFKC', value or '').casefold()
    return ''.join(c for c in value if c.isalnum())


def _original_date(value):
    """Accept a canonical source date without guessing a timezone or time."""
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value)
        return value if parsed.isoformat() == value else None
    except ValueError:
        return None


def _source_metadata(source):
    """Expose only validated display metadata from retained source provenance."""
    try:
        payload = json.loads(source.get('payload_json') or '{}')
        provenance = payload.get('provenance', {}) if isinstance(payload, dict) else {}
    except (ValueError, TypeError):
        provenance = {}
    if not isinstance(provenance, dict):
        provenance = {}
    metadata = {}
    if source.get('time_precision') == 'day':
        original_date = _original_date(provenance.get('transaction_date'))
        if original_date:
            metadata['transaction_date'] = original_date
    if source.get('source') == 'statement':
        posting_date = _original_date(provenance.get('posting_date'))
        if posting_date:
            metadata['posting_date'] = posting_date
        try:
            kind = text_value(provenance.get('statement_kind'), '帳單交易類型', 80, optional=True)
            if kind:
                metadata['statement_kind'] = kind
        except ValueError:
            pass
        description = provenance.get('description')
        if isinstance(description, str):
            # The original remains in provenance; the note is a compact, safe
            # display copy, including for statements containing wrapped lines.
            description = ''.join(' ' if ord(character) < 32 else character for character in description).strip()[:1000]
            if description:
                metadata['description'] = description
    return metadata


def initialize(database: Path) -> None:
    database = Path(database)
    database.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database, timeout=15)) as connection:
        version = connection.execute('PRAGMA user_version').fetchone()[0]
        if version > SCHEMA_VERSION:
            raise RuntimeError('此資料庫來自較新版本，請先更新程式')
        if version == 0:
            connection.executescript(Path(__file__).with_name('schema.sql').read_text(encoding='utf-8'))
        connection.execute('BEGIN IMMEDIATE')
        additions = {
            'entries': {'category': "TEXT NOT NULL DEFAULT '未分類'", 'note': "TEXT NOT NULL DEFAULT ''"},
            'source_records': {
                'account_id': 'TEXT REFERENCES accounts(id)', 'kind': "TEXT NOT NULL DEFAULT 'expense'",
                'category': "TEXT NOT NULL DEFAULT '未分類'", 'payload_json': "TEXT NOT NULL DEFAULT '{}'",
                'fingerprint': 'TEXT', 'time_precision': "TEXT NOT NULL DEFAULT 'minute'"},
            'review_items': {'candidate_ids_json': "TEXT NOT NULL DEFAULT '[]'"},
            'asset_events': {'external_id': 'TEXT', 'created_at': 'TEXT'},
            'quotes': {'quote_type': "TEXT NOT NULL DEFAULT 'manual'", 'fetched_at': 'TEXT'},
        }
        for table, columns in additions.items():
            existing = {row[1] for row in connection.execute(f'PRAGMA table_info({table})')}
            for name, kind in columns.items():
                if name not in existing:
                    connection.execute(f'ALTER TABLE {table} ADD COLUMN {name} {kind}')
        connection.execute('CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT, after_json TEXT, created_at TEXT NOT NULL)')
        connection.execute('CREATE INDEX IF NOT EXISTS entry_match ON entries(account_id, kind, occurred_at)')
        connection.execute('CREATE UNIQUE INDEX IF NOT EXISTS asset_external ON asset_events(external_id) WHERE external_id IS NOT NULL')
        # Lookup indexes for reconciliation, review status and holdings; safe to add to existing ledgers.
        connection.execute('CREATE INDEX IF NOT EXISTS source_entry ON source_records(entry_id)')
        connection.execute('CREATE INDEX IF NOT EXISTS review_entry ON review_items(entry_id, resolved_at)')
        connection.execute('CREATE INDEX IF NOT EXISTS review_source ON review_items(source_record_id, resolved_at)')
        connection.execute('CREATE INDEX IF NOT EXISTS asset_holding ON asset_events(instrument_id, account_id, occurred_at)')
        connection.execute(f'PRAGMA user_version = {SCHEMA_VERSION}')
        connection.commit()
        if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('資料庫完整性檢查失敗')


class Ledger:
    def __init__(self, database=None):
        self.database = Path(database) if database else default_data_dir() / 'ledger.sqlite3'
        initialize(self.database)

    @contextmanager
    def _connection(self, write=False):
        connection = sqlite3.connect(self.database, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys = ON')
        try:
            connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _audit(connection, action, entity_id, before, after):
        connection.execute('INSERT INTO audit_log VALUES(?,?,?,?,?,?)',
                           (uid(), action, entity_id, json.dumps(before, ensure_ascii=False),
                            json.dumps(after, ensure_ascii=False), now()))

    @staticmethod
    def _account(connection, name, currency, kind='cash'):
        account_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f'personal-ledger/account/{name}/{currency}'))
        connection.execute('INSERT OR IGNORE INTO accounts(id,name,kind,currency) VALUES(?,?,?,?)',
                           (account_id, name, kind, currency))
        return account_id

    @staticmethod
    def _entry(connection, entry_id):
        row = connection.execute('SELECT e.*,a.name AS account FROM entries e LEFT JOIN accounts a ON a.id=e.account_id WHERE e.id=?', (entry_id,)).fetchone()
        return dict(row) if row else None

    @staticmethod
    def _create_entry(connection, source, amount=None, currency=None):
        entry_id = uid()
        note = _source_metadata(source).get('description', '')
        connection.execute('INSERT INTO entries(id,account_id,kind,amount_minor,currency,merchant,occurred_at,status,updated_at,category,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
            (entry_id, source['account_id'], source['kind'], source['amount_minor'] if amount is None else amount,
             currency or source['currency'], source['merchant'], source['occurred_at'],
             'verified' if source['source'] == 'manual' else 'unverified', now(), source['category'], note))
        connection.execute('UPDATE source_records SET entry_id=? WHERE id=?', (entry_id, source['id']))
        return entry_id

    @staticmethod
    def _refresh_status(connection, entry_id):
        if not entry_id:
            return
        pending = connection.execute('SELECT COUNT(*) FROM review_items WHERE entry_id=? AND resolved_at IS NULL', (entry_id,)).fetchone()[0]
        sources = {r[0] for r in connection.execute('SELECT source FROM source_records WHERE entry_id=?', (entry_id,))}
        confirmed = any(json.loads(r[0] or '{}').get('action') in {'use_source','keep_entry','separate','link'}
                        for r in connection.execute('SELECT resolution FROM review_items WHERE entry_id=? AND resolved_at IS NOT NULL', (entry_id,)))
        status = 'pending' if pending else ('verified' if confirmed or len(sources) > 1 or 'manual' in sources else 'unverified')
        connection.execute('UPDATE entries SET status=?,revision=revision+1,updated_at=? WHERE id=?', (status, now(), entry_id))

    def ingest(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('交易必須是 JSON 物件')
        source = text_value(payload.get('source'), '來源')
        if source not in {'manual','apple_pay','gmail','bank','statement'}:
            raise ValueError('不支援的交易來源')
        external_id = text_value(payload.get('external_id'), '來源識別碼', 500)
        currency = currency_code(payload.get('currency', 'TWD'))
        amount = to_minor(payload.get('amount'), currency)
        if amount <= 0:
            raise ValueError('請輸入大於零的金額，以交易類型區分收入／支出')
        account = text_value(payload.get('account', '日常消費'), '帳戶')
        merchant = text_value(payload.get('merchant'), '商家／摘要')
        kind = payload.get('kind', 'expense')
        if kind not in {'expense','income','transfer','investment'}:
            raise ValueError('交易類型無效')
        category = text_value(payload.get('category', '未分類'), '分類')
        occurred_at = timestamp(payload.get('occurred_at'))
        precision = payload.get('time_precision', payload.get('date_precision', 'minute'))
        if precision not in {'minute','second','day'}:
            raise ValueError('時間精度無效')
        force_review = bool(payload.get('force_review', False))
        normalized = {'source':source, 'external_id':external_id, 'currency':currency,
                      'amount_minor':amount, 'account':account, 'merchant':merchant,
                      'kind':kind, 'category':category, 'occurred_at':occurred_at,
                      'time_precision':precision}
        provenance = payload.get('provenance')
        if provenance is not None and (not isinstance(provenance,dict) or len(json.dumps(provenance,ensure_ascii=False).encode('utf-8')) > 4096):
            raise ValueError('來源資訊必須是 4096 bytes 以內的 JSON 物件')
        stored_payload = dict(normalized)
        if provenance is not None:
            stored_payload['provenance'] = provenance
        fingerprint = hashlib.sha256(json.dumps(normalized, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        with self._connection(write=True) as connection:
            existing = connection.execute('SELECT * FROM source_records WHERE source=? AND external_id=?', (source, external_id)).fetchone()
            if existing:
                if existing['fingerprint'] and existing['fingerprint'] != fingerprint:
                    raise ValueError('相同來源識別碼的內容不同，請先人工確認，不能覆蓋原紀錄')
                review = connection.execute('SELECT id FROM review_items WHERE source_record_id=? AND resolved_at IS NULL', (existing['id'],)).fetchone()
                entry = self._entry(connection, existing['entry_id'])
                return {'source_record_id':existing['id'], 'entry_id':existing['entry_id'], 'duplicate':True,
                        'review_id': review['id'] if review else None, 'status':entry['status'] if entry else 'pending'}
            account_id = self._account(connection, account, currency)
            source_id = uid()
            connection.execute('INSERT INTO source_records(id,source,external_id,amount_minor,currency,merchant,occurred_at,received_at,source_timezone,account_id,kind,category,payload_json,fingerprint,time_precision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (source_id,source,external_id,amount,currency,merchant,occurred_at,now(),str(payload.get('source_timezone',''))[:100],
                 account_id,kind,category,json.dumps(stored_payload, ensure_ascii=False),fingerprint,precision))
            record = dict(connection.execute('SELECT * FROM source_records WHERE id=?', (source_id,)).fetchone())
            candidates = []
            uncertain_candidates = []
            # Account identity must agree; currency changes are surfaced for manual review.
            if source != 'manual':
                window = 3*86400 if source == 'statement' or precision == 'day' else 10*60
                # Coarse SQL range (padded by one day) uses the entry_match index instead of
                # scanning the account's whole history; the exact window is checked below.
                center = datetime.fromisoformat(occurred_at)
                padding = timedelta(seconds=window, days=1)
                rows = connection.execute('SELECT e.*,a.name AS account FROM entries e JOIN accounts a ON a.id=e.account_id WHERE a.name=? AND e.kind=? AND e.deleted_at IS NULL AND e.occurred_at BETWEEN ? AND ?',
                                          (account,kind,(center-padding).isoformat(timespec='microseconds'),(center+padding).isoformat(timespec='microseconds'))).fetchall()
                links = defaultdict(list)
                if rows:
                    ids = [row['id'] for row in rows]
                    for link in connection.execute(f'SELECT entry_id,source,merchant FROM source_records WHERE entry_id IN ({",".join("?"*len(ids))})', ids):
                        links[link['entry_id']].append(link)
                for row in rows:
                    linked = links[row['id']]
                    known_merchants = {merchant_key(row['merchant'])} | {merchant_key(s['merchant']) for s in linked}
                    delta = abs((datetime.fromisoformat(row['occurred_at'])-datetime.fromisoformat(occurred_at)).total_seconds())
                    linked_sources = {s['source'] for s in linked}
                    if delta <= window:
                        candidate = dict(row)
                        candidate['_same_source'] = source in linked_sources
                        if merchant_key(merchant) in known_merchants:
                            candidates.append(candidate)
                        elif source in {'gmail','bank','statement'} and linked_sources & {'apple_pay','manual'}:
                            # Bank merchant descriptors often differ. Suggest a
                            # nearby transaction, never silently count it twice
                            # or automatically merge on amount alone.
                            candidate['_merchant_uncertain'] = True
                            uncertain_candidates.append(candidate)
            if not candidates:
                candidates = uncertain_candidates
            entry_id = None
            reason = None
            if len(candidates) == 1:
                candidate = candidates[0]
                entry_id = candidate['id']
                connection.execute('UPDATE source_records SET entry_id=? WHERE id=?', (entry_id, source_id))
                if candidate['_same_source']:
                    reason = 'possible_duplicate'
                elif candidate.get('_merchant_uncertain'):
                    reason = 'merchant_mismatch'
                elif candidate['currency'] != currency:
                    reason = 'currency_mismatch'
                elif candidate['amount_minor'] != amount:
                    reason = 'amount_mismatch'
                elif precision == 'day':
                    reason = 'time_uncertain'
                elif force_review:
                    reason = 'manual_confirmation'
            elif len(candidates) > 1:
                reason = 'ambiguous_match'
            elif force_review or source == 'statement':
                reason = 'missing_entry' if source == 'statement' else 'manual_confirmation'
            else:
                entry_id = self._create_entry(connection, record)
            review_id = None
            if reason:
                review_id = uid()
                connection.execute('INSERT INTO review_items(id,entry_id,source_record_id,reason,created_at,candidate_ids_json) VALUES(?,?,?,?,?,?)',
                                   (review_id,entry_id,source_id,reason,now(),json.dumps([c['id'] for c in candidates])))
            if entry_id:
                self._refresh_status(connection, entry_id)
            result = {'source_record_id':source_id, 'entry_id':entry_id, 'review_id':review_id, 'duplicate':False,
                      'status': 'pending' if reason else self._entry(connection, entry_id)['status']}
            self._audit(connection,'ingest',source_id,None,result)
            return result

    def resolve_review(self, review_id, action, entry_id=None):
        if action not in {'use_source','keep_entry','separate','link','ignore'}:
            raise ValueError('不支援的確認方式')
        with self._connection(write=True) as connection:
            review = connection.execute('SELECT * FROM review_items WHERE id=?', (review_id,)).fetchone()
            if not review or review['resolved_at']:
                raise ValueError('待確認項目不存在或已處理')
            source = dict(connection.execute('SELECT * FROM source_records WHERE id=?', (review['source_record_id'],)).fetchone())
            old_entry_id = review['entry_id']
            target_id = entry_id or old_entry_id
            target = self._entry(connection, target_id) if target_id else None
            if action in {'use_source','keep_entry','link'} and target_id and (not target or target['deleted_at']):
                raise ValueError('指定帳目不存在')
            if action in {'use_source','keep_entry','link'} and target and target['kind'] != source['kind']:
                raise ValueError('交易收支方向不同，請分開建立帳目；退款應新增收入紀錄')
            before = dict(target) if target else None
            if action == 'ignore':
                # Keep a record of a statement line that is not a spending transaction.
                connection.execute('UPDATE source_records SET entry_id=NULL WHERE id=?', (source['id'],))
            elif action == 'separate' or (action == 'use_source' and not target):
                target_id = self._create_entry(connection, source)
            elif action == 'use_source':
                if target['currency'] != source['currency']:
                    raise ValueError('跨幣別交易請先分開建立帳目，不能直接覆蓋幣別')
                connection.execute('UPDATE entries SET amount_minor=?,revision=revision+1,updated_at=? WHERE id=?', (source['amount_minor'],now(),target_id))
                connection.execute('UPDATE source_records SET entry_id=? WHERE id=?', (target_id,source['id']))
            elif action in {'keep_entry','link'}:
                if not target:
                    raise ValueError('請選擇要關聯的帳目')
                # Explicit human confirmation permits a differing settlement amount.
                connection.execute('UPDATE source_records SET entry_id=? WHERE id=?', (target_id,source['id']))
            connection.execute('UPDATE review_items SET resolved_at=?,resolution=?,entry_id=? WHERE id=?', (now(),json.dumps({'action':action,'entry_id':target_id}),target_id,review_id))
            if old_entry_id:
                self._refresh_status(connection, old_entry_id)
            if target_id and action != 'ignore':
                self._refresh_status(connection, target_id)
            self._audit(connection,'resolve_review',review_id,before,{'action':action,'entry_id':target_id})
            return {'review_id':review_id,'entry_id':target_id,'action':action}

    def update_entry(self, entry_id, changes, expected_revision):
        with self._connection(write=True) as connection:
            entry = self._entry(connection, entry_id)
            if not entry or entry['deleted_at']:
                raise ValueError('帳目不存在')
            if entry['revision'] != expected_revision:
                raise ValueError('此帳目已被修改，請重新整理後再試')
            values = {k:text_value(v,k,1000 if k == 'note' else 200, optional=k == 'note') for k,v in changes.items() if k in {'category','note','merchant'}}
            if 'amount' in changes:
                values['amount_minor'] = to_minor(changes['amount'],entry['currency'])
                if values['amount_minor'] <= 0:
                    raise ValueError('金額需大於零')
                if connection.execute('SELECT COUNT(*) FROM source_records WHERE entry_id=?', (entry_id,)).fetchone()[0] > 1:
                    raise ValueError('已核對帳目的金額請透過待確認流程調整')
            if values:
                connection.execute('UPDATE entries SET '+','.join(f'{k}=?' for k in values)+',revision=revision+1,updated_at=? WHERE id=?',(*values.values(),now(),entry_id))
                self._audit(connection,'update_entry',entry_id,entry,self._entry(connection,entry_id))
            return self._entry(connection, entry_id)

    def asset_event(self, payload):
        symbol = text_value(payload.get('symbol'),'代號',50).upper()
        market = text_value(payload.get('market'),'市場',80).upper()
        instrument_kind = payload.get('instrument_kind','stock')
        if instrument_kind not in {'stock','crypto'}:
            raise ValueError('資產類型必須是 stock 或 crypto')
        kind = payload.get('kind','buy')
        if kind not in {'buy','sell','dividend','transfer_in','transfer_out'}:
            raise ValueError('資產交易類型無效')
        quantity = decimal_value(payload.get('quantity','0'),'數量')
        cash = decimal_value(payload.get('cash_amount','0'),'總金額')
        fee = decimal_value(payload.get('fee','0'),'手續費')
        if quantity < 0 or cash < 0 or fee < 0 or (quantity == 0 and kind != 'dividend'):
            raise ValueError('數量及金額不得為負；買賣與轉帳的數量需大於零')
        if kind == 'transfer_out' and fee:
            raise ValueError('此版本的轉出不自動計算費用；請將手續費另記為支出，轉出費用填 0')
        currency = currency_code(payload.get('currency','TWD'))
        account = text_value(payload.get('account','投資帳戶'),'帳戶')
        at = timestamp(payload.get('occurred_at'))
        external_id = payload.get('external_id')
        if external_id:
            external_id = text_value(external_id,'資產交易識別碼',500)
        with self._connection(write=True) as connection:
            if external_id and connection.execute('SELECT id FROM asset_events WHERE external_id=?',(external_id,)).fetchone():
                raise ValueError('此資產交易識別碼已存在')
            instrument_id = str(uuid.uuid5(uuid.NAMESPACE_URL,f'personal-ledger/instrument/{symbol}/{market}'))
            connection.execute('INSERT OR IGNORE INTO instruments VALUES(?,?,?,?)', (instrument_id,symbol,market,instrument_kind))
            existing_kind = connection.execute('SELECT kind FROM instruments WHERE id=?',(instrument_id,)).fetchone()[0]
            if existing_kind != instrument_kind:
                raise ValueError('相同代號與市場已有不同資產類型')
            account_id = self._account(connection,account,currency,'investment')
            event_id = uid()
            connection.execute('INSERT INTO asset_events(id,instrument_id,account_id,kind,quantity_decimal,cash_amount_decimal,fee_decimal,currency,occurred_at,external_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (event_id,instrument_id,account_id,kind,str(quantity),str(cash),str(fee),currency,at,external_id,now()))
            # Validate full chronological position, including backdated events.
            holding = Decimal('0')
            for event in connection.execute('SELECT kind,quantity_decimal FROM asset_events WHERE instrument_id=? AND account_id=? ORDER BY occurred_at,created_at,id',(instrument_id,account_id)):
                if event['kind'] in {'buy','transfer_in'}:
                    holding += Decimal(event['quantity_decimal'])
                elif event['kind'] in {'sell','transfer_out'}:
                    holding -= Decimal(event['quantity_decimal'])
                if holding < 0:
                    raise ValueError('賣出／轉出數量超過當時持倉；此版本不支援放空')
            self._audit(connection,'asset_event',event_id,None,payload)
            return {'id':event_id,'instrument_id':instrument_id}

    def set_quote(self, payload):
        symbol = text_value(payload.get('symbol'),'代號',50).upper()
        market = text_value(payload.get('market'),'市場',80).upper()
        currency = currency_code(payload.get('currency'))
        price = decimal_value(payload.get('price'),'價格')
        if price <= 0:
            raise ValueError('價格需大於零')
        provider = text_value(payload.get('provider','manual'),'報價來源',100)
        at = timestamp(payload.get('as_of'))
        fetched_at = timestamp(payload.get('fetched_at') or now())
        quote_type = text_value(payload.get('quote_type','manual'),'報價類型',50)
        with self._connection(write=True) as connection:
            instrument = connection.execute('SELECT * FROM instruments WHERE symbol=? AND market=?',(symbol,market)).fetchone()
            if not instrument:
                raise ValueError('請先建立此資產的持倉紀錄')
            previous = connection.execute('SELECT as_of FROM quotes WHERE instrument_id=? AND provider=? AND currency=?',(instrument['id'],provider,currency)).fetchone()
            if previous and previous['as_of'] > at:
                return {'updated':False,'reason':'older_quote'}
            connection.execute('INSERT INTO quotes(instrument_id,provider,currency,price_decimal,as_of,quote_type,fetched_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(instrument_id,provider,currency) DO UPDATE SET price_decimal=excluded.price_decimal,as_of=excluded.as_of,quote_type=excluded.quote_type,fetched_at=excluded.fetched_at',
                (instrument['id'],provider,currency,str(price),at,quote_type,fetched_at))
            return {'updated':True,'symbol':symbol,'as_of':at}

    @staticmethod
    def _portfolio(events, quotes):
        positions = {}
        for event in events:
            key = (event['instrument_id'],event['account_id'],event['currency'])
            p = positions.setdefault(key, {'symbol':event['symbol'],'market':event['market'],'instrument_kind':event['instrument_kind'],
                'instrument_id':event['instrument_id'],'account':event['account'],'currency':event['currency'],
                '_quantity':Decimal('0'),'_cost':Decimal('0'),'_realized':Decimal('0'),'_dividend':Decimal('0')})
            quantity = Decimal(event['quantity_decimal'])
            cash = Decimal(event['cash_amount_decimal'] or '0')
            fee = Decimal(event['fee_decimal'] or '0')
            if event['kind'] in {'buy','transfer_in'}:
                p['_quantity'] += quantity
                p['_cost'] += cash + fee
            elif event['kind'] in {'sell','transfer_out'}:
                removed_cost = p['_cost'] * quantity / p['_quantity'] if p['_quantity'] else Decimal('0')
                p['_quantity'] -= quantity
                p['_cost'] -= removed_cost
                if event['kind'] == 'sell':
                    p['_realized'] += cash - fee - removed_cost
            elif event['kind'] == 'dividend':
                p['_dividend'] += cash - fee
        result = []
        for p in positions.values():
            # Prefer quote in position currency, otherwise expose value in quoted currency only.
            available = [q for q in quotes if q['instrument_id'] == p['instrument_id']]
            local = [q for q in available if q['currency'] == p['currency']]
            quote = max(local or available,key=lambda q:q['as_of']) if available else None
            q = p.pop('_quantity'); cost = p.pop('_cost')
            realized = p.pop('_realized'); dividend = p.pop('_dividend')
            value = q * Decimal(quote['price_decimal']) if quote else None
            p.update(quantity_decimal=str(q),cost_decimal=str(cost),realized_decimal=str(realized),dividend_decimal=str(dividend),
                price_decimal=quote['price_decimal'] if quote else None, quote_currency=quote['currency'] if quote else None,
                quote_as_of=quote['as_of'] if quote else None, quote_provider=quote['provider'] if quote else None,
                quote_type=quote['quote_type'] if quote else None,value_decimal=str(value) if value is not None else None,
                unrealized_decimal=str(value-cost) if value is not None and quote['currency'] == p['currency'] else None)
            result.append(p)
        return result

    def snapshot(self):
        with self._connection() as connection:
            entries = [dict(r) for r in connection.execute('SELECT e.*,a.name AS account FROM entries e LEFT JOIN accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL ORDER BY occurred_at DESC,id')]
            sources = [dict(r) for r in connection.execute('SELECT s.*,a.name AS account FROM source_records s LEFT JOIN accounts a ON a.id=s.account_id ORDER BY received_at DESC')]
            linked_sources = defaultdict(list)
            for source in sources:
                source.update(_source_metadata(source))
                if source['entry_id']:
                    linked_sources[source['entry_id']].append(source)
            for entry in entries:
                linked = linked_sources[entry['id']]
                date_only = bool(linked) and all(source['time_precision'] == 'day' for source in linked)
                entry['time_precision'] = 'day' if date_only else 'minute'
                metadata_fields = ['posting_date', 'statement_kind'] + (['transaction_date'] if date_only else [])
                for field in metadata_fields:
                    values = {source[field] for source in linked if source.get(field)}
                    if len(values) == 1:
                        entry[field] = values.pop()
            by_entry = {e['id']:e for e in entries}; by_source = {s['id']:s for s in sources}
            reviews = []
            for row in connection.execute('SELECT * FROM review_items WHERE resolved_at IS NULL ORDER BY created_at DESC'):
                item = dict(row)
                item.update(entry=by_entry.get(item['entry_id']),source=by_source[item['source_record_id']],
                            candidates=[by_entry[c] for c in json.loads(item['candidate_ids_json']) if c in by_entry])
                reviews.append(item)
            events = [dict(r) for r in connection.execute('SELECT e.*,i.symbol,i.market,i.kind AS instrument_kind,a.name AS account FROM asset_events e JOIN instruments i ON i.id=e.instrument_id JOIN accounts a ON a.id=e.account_id ORDER BY e.occurred_at,e.created_at,e.id')]
            quotes = [dict(r) for r in connection.execute('SELECT q.*,i.symbol,i.market,i.kind AS instrument_kind FROM quotes q JOIN instruments i ON i.id=q.instrument_id')]
            totals = defaultdict(lambda:{'expense_minor':0,'income_minor':0,'balance_minor':0})
            for entry in entries:
                group = totals[entry['currency']]
                if entry['kind'] == 'expense':
                    group['expense_minor'] += entry['amount_minor']
                    group['balance_minor'] -= entry['amount_minor']
                elif entry['kind'] == 'income':
                    group['income_minor'] += entry['amount_minor']
                    group['balance_minor'] += entry['amount_minor']
            return {'entries':entries,'sources':sources,'reviews':reviews,
                'accounts':[dict(r) for r in connection.execute('SELECT * FROM accounts ORDER BY name,currency')],
                'instruments':[dict(r) for r in connection.execute('SELECT * FROM instruments ORDER BY symbol,market')],
                'asset_events':events,'portfolio':self._portfolio(events,quotes),'quotes':quotes,'currency_digits':CURRENCY_DIGITS,
                'summary':{'by_currency':[dict(currency=c,**v) for c,v in sorted(totals.items())],
                    'pending_count':len(reviews),'entry_count':len(entries)},'server_time':now()}

    def export_csv(self, path):
        path = Path(path)
        snapshot = self.snapshot()
        fields = ['id','account','kind','amount','currency','merchant','occurred_at','status','category','note',
                  'time_precision','transaction_date','posting_date','statement_kind']
        def safe(value):
            value = '' if value is None else str(value)
            return "'"+value if value.lstrip().startswith(('=','+','-','@','\t','\r')) else value
        with path.open('w',encoding='utf-8-sig',newline='') as handle:
            writer = csv.DictWriter(handle,fieldnames=fields)
            writer.writeheader()
            for entry in snapshot['entries']:
                row = {f:entry.get(f,'') for f in fields}
                row['amount'] = from_minor(entry['amount_minor'],entry['currency'])
                writer.writerow({k:safe(v) for k,v in row.items()})
        return str(path)

    def backup(self, path):
        path = Path(path)
        if path.resolve() == self.database.resolve():
            raise ValueError('備份位置不能與目前資料庫相同')
        if path.exists():
            raise ValueError('備份檔已存在，請使用新的檔名')
        path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.database,timeout=15)) as source, closing(sqlite3.connect(path)) as target:
            source.backup(target)
            if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('備份完整性檢查失敗')
        return str(path)

    def restore_backup(self, path):
        """Validate first, keep current DB as a backup, then replace atomically.

        Callers must stop sync before restoring. Credentials are separate and
        never restored from an accounting database.
        """
        path = Path(path).resolve()
        if path == self.database.resolve() or not path.is_file():
            raise ValueError('請選擇另一個有效的帳本備份檔')
        temporary = self.database.with_name('.restore-'+uid()+'.sqlite3')
        try:
            with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True)) as source:
                if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('備份檔完整性檢查失敗')
                tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {'entries','accounts','source_records','review_items','asset_events','instruments','quotes'} <= tables:
                    raise ValueError('這不是個人帳本的資料庫備份')
                version = source.execute('PRAGMA user_version').fetchone()[0]
                if version not in {1,2}:
                    raise ValueError('不支援此備份的資料庫版本')
                with closing(sqlite3.connect(temporary)) as target:
                    source.backup(target)
            restored = Ledger(temporary)
            restored.snapshot()
            with restored._connection() as connection:
                if connection.execute('PRAGMA foreign_key_check').fetchone():
                    raise ValueError('備份中的關聯資料不完整')
            previous = self.database.with_name('before-restore-'+datetime.now().strftime('%Y%m%d-%H%M%S')+'-'+uid()[:8]+'.sqlite3')
            self.backup(previous)
            os.replace(temporary,self.database)
            return {'restored_from':str(path),'previous_backup':str(previous)}
        except sqlite3.DatabaseError:
            raise ValueError('檔案不是可讀取的帳本備份') from None
        finally:
            if temporary.exists():
                temporary.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='初始化個人帳本資料庫')
    parser.add_argument('--database',type=Path,default=default_data_dir()/'ledger.sqlite3')
    args = parser.parse_args()
    initialize(args.database)
    print(f'Ledger initialized: {args.database.resolve()}')
