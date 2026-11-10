PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    currency TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    account_id TEXT REFERENCES accounts(id),
    kind TEXT NOT NULL CHECK(kind IN ('expense','income','transfer','investment')),
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    merchant TEXT,
    occurred_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('unverified','verified','pending')),
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS source_records (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    entry_id TEXT REFERENCES entries(id),
    amount_minor INTEGER,
    currency TEXT,
    merchant TEXT,
    occurred_at TEXT,
    source_timezone TEXT,
    received_at TEXT NOT NULL,
    UNIQUE(source, external_id)
);

CREATE TABLE IF NOT EXISTS review_items (
    id TEXT PRIMARY KEY,
    entry_id TEXT REFERENCES entries(id),
    source_record_id TEXT NOT NULL REFERENCES source_records(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
);

CREATE TABLE IF NOT EXISTS instruments (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    market TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('stock','crypto')),
    UNIQUE(symbol, market)
);

CREATE TABLE IF NOT EXISTS asset_events (
    id TEXT PRIMARY KEY,
    instrument_id TEXT NOT NULL REFERENCES instruments(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind TEXT NOT NULL,
    quantity_decimal TEXT NOT NULL,
    cash_amount_decimal TEXT,
    fee_decimal TEXT,
    currency TEXT,
    occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
    instrument_id TEXT NOT NULL REFERENCES instruments(id),
    provider TEXT NOT NULL,
    currency TEXT NOT NULL,
    price_decimal TEXT NOT NULL,
    as_of TEXT NOT NULL,
    PRIMARY KEY(instrument_id, provider, currency)
);

PRAGMA user_version = 1;
