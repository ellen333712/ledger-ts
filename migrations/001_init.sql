-- ledger-ts · 001_init.sql
-- Schema faithful to the ledger design doc: the log is the truth,
-- everything else is a projection.
--
--   LedgerAccount        chart-of-accounts node
--   LedgerTransaction    one business event, carries the idempotency gate
--   LedgerEntry          the append-only log (signed amounts, dense per-account seq)
--   AccountBalance       derived rollup keyed to a log position (seq)
--   LedgerPeriod         open/close discipline on business time
--   Outbox               same-transaction events, relayed after commit

-- ─────────────────────────────────────────────────────────────────────
-- ledger_account
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE ledger_account (
  account_id    TEXT        NOT NULL,
  tenant_id     TEXT        NOT NULL,
  parent_id     TEXT,
  name          TEXT        NOT NULL,
  account_type  TEXT        NOT NULL,                  -- asset|liability|equity|revenue|expense
  normal_side   TEXT        NOT NULL,                  -- DEBIT | CREDIT
  currency      CHAR(3)     NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|FROZEN|CLOSED
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id),
  CONSTRAINT account_type_check CHECK (account_type IN
    ('asset','liability','equity','revenue','expense')),
  CONSTRAINT normal_side_check CHECK (normal_side IN ('DEBIT','CREDIT')),
  CONSTRAINT status_check CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  -- a natural tree constraint: parent must precede child in id order is NOT
  -- required; instead forbid self-parenting:
  CONSTRAINT no_self_parent CHECK (parent_id IS NULL OR parent_id <> account_id),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES ledger_account (tenant_id, account_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- ledger_transaction
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE ledger_transaction (
  transaction_id   TEXT        PRIMARY KEY,
  tenant_id        TEXT        NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  payload_hash     TEXT        NOT NULL,               -- canonical-JSON sha256 of the request body
  transaction_type TEXT        NOT NULL,               -- TRANSFER|FEE|REFUND|REVERSAL|FX|ADJUST
  occurred_at      TIMESTAMPTZ NOT NULL,               -- business time → period_key
  posted_at        TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the ledger accepted it
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(), -- pipeline saw it; debugging only
  period_key       TEXT        NOT NULL,               -- '2025-08'
  reverses_transaction_id TEXT NULL REFERENCES ledger_transaction (transaction_id),
  description      TEXT,
  metadata         JSONB,
  correlation_id   TEXT,
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT tx_type_check CHECK (transaction_type IN
    ('TRANSFER','FEE','REFUND','REVERSAL','FX','ADJUST'))
);

CREATE INDEX tx_tenant_period_idx ON ledger_transaction (tenant_id, period_key);
CREATE INDEX tx_reverses_idx ON ledger_transaction (reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- ledger_entry · THE APPEND-ONLY LOG
-- ─────────────────────────────────────────────────────────────────────
CREATE SEQUENCE ledger_entry_seq;

CREATE TABLE ledger_entry (
  entry_id       BIGINT        PRIMARY KEY DEFAULT nextval('ledger_entry_seq'),
  transaction_id TEXT          NOT NULL REFERENCES ledger_transaction (transaction_id),
  tenant_id      TEXT          NOT NULL,
  account_id     TEXT          NOT NULL,
  amount         NUMERIC(28,8) NOT NULL CHECK (amount <> 0),  -- ALWAYS signed
  currency       CHAR(3)       NOT NULL,
  seq            BIGINT        NOT NULL,                       -- dense, per account
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_account (tenant_id, account_id),
  UNIQUE (account_id, seq)                                     -- ordering + gap detection
);

CREATE INDEX entry_tx_idx ON ledger_entry (transaction_id);
CREATE INDEX entry_account_seq_idx ON ledger_entry (account_id, seq DESC);

-- Append-only enforced as code, not folklore: in production you additionally
-- revoke UPDATE/DELETE from the app role; the trigger makes accidental ORM
-- misuse fail loudly in every environment.
CREATE FUNCTION assert_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_LOG: % on ledger_entry is forbidden', TG_OP;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER entry_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION assert_append_only();
CREATE TRIGGER entry_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION assert_append_only();

-- ─────────────────────────────────────────────────────────────────────
-- The conservation invariant, as a deferred constraint trigger.
-- SUM is checked after the whole batch of rows for the transaction has
-- landed: the database refuses to commit an unbalanced transaction even
-- if the application forgets to check.
-- ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION assert_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount), 0) FROM ledger_entry
        WHERE transaction_id = NEW.transaction_id) <> 0 THEN
    RAISE EXCEPTION 'UNBALANCED_ENTRY: transaction %', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER balanced
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_balanced();

-- ─────────────────────────────────────────────────────────────────────
-- account_balance · a projection, rebuildable from the log
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE account_balance (
  tenant_id    TEXT          NOT NULL,
  account_id   TEXT          NOT NULL PRIMARY KEY,
  seq          BIGINT        NOT NULL,               -- log position this balance reflects
  amount       NUMERIC(28,8) NOT NULL,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES ledger_account (tenant_id, account_id)
);

-- ─────────────────────────────────────────────────────────────────────
-- ledger_period
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE ledger_period (
  tenant_id   TEXT NOT NULL,
  period_key  TEXT NOT NULL,                          -- '2025-08'
  status      TEXT NOT NULL DEFAULT 'OPEN',           -- OPEN|PRECLOSED|CLOSED|LOCKED
  PRIMARY KEY (tenant_id, period_key),
  CONSTRAINT period_key_format CHECK (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT period_status_check CHECK (status IN ('OPEN','PRECLOSED','CLOSED','LOCKED'))
);

-- ─────────────────────────────────────────────────────────────────────
-- outbox · written in the same transaction as the entries; the relay
-- publishes strictly after commit → at-least-once, consumers dedupe on
-- transaction_id.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE outbox (
  event_id       BIGINT       PRIMARY KEY,
  tenant_id      TEXT         NOT NULL,
  transaction_id TEXT         NOT NULL,
  event_type     TEXT         NOT NULL,               -- 'ledger.transaction.posted'
  payload        JSONB        NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ  NULL
);

CREATE SEQUENCE outbox_event_seq;
ALTER TABLE outbox ALTER COLUMN event_id SET DEFAULT nextval('outbox_event_seq');

CREATE INDEX outbox_unpublished_idx ON outbox (event_id) WHERE published_at IS NULL;
