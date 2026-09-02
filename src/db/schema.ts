import type { ColumnType, Generated } from 'kysely';

/** Kysely table shapes. NUMERIC/BIGINT arrive as strings from both pg
 *  drivers (we cast `::text` in SQL to be sure); the engine converts via
 *  src/money.ts, so nothing float-shaped enters the domain. */

export interface LedgerAccountTable {
  account_id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  account_type: string;
  normal_side: string;
  currency: string;
  status: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface LedgerTransactionTable {
  transaction_id: string;
  tenant_id: string;
  idempotency_key: string;
  payload_hash: string;
  transaction_type: string;
  occurred_at: Date;
  posted_at: ColumnType<Date, Date | string | undefined, never>;
  ingested_at: ColumnType<Date, Date | string | undefined, never>;
  period_key: string;
  reverses_transaction_id: string | null;
  description: string | null;
  metadata: unknown;
  correlation_id: string | null;
}

export interface LedgerEntryTable {
  entry_id: Generated<string>;
  transaction_id: string;
  tenant_id: string;
  account_id: string;
  amount: string; // NUMERIC(28,8) as decimal string
  currency: string;
  seq: string; // BIGINT as string
}

export interface AccountBalanceTable {
  tenant_id: string;
  account_id: string;
  seq: string;
  amount: string;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface LedgerPeriodTable {
  tenant_id: string;
  period_key: string;
  status: string;
}

export interface OutboxTable {
  event_id: Generated<string>;
  tenant_id: string;
  transaction_id: string;
  event_type: string;
  payload: unknown;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  published_at: Date | null;
}

export interface Database {
  ledger_account: LedgerAccountTable;
  ledger_transaction: LedgerTransactionTable;
  ledger_entry: LedgerEntryTable;
  account_balance: AccountBalanceTable;
  ledger_period: LedgerPeriodTable;
  outbox: OutboxTable;
}
