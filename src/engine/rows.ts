import type { ColumnType, Generated } from 'kysely';
import type {
  AccountBalance,
  LedgerAccount,
  LedgerEntry,
  LedgerTransaction,
  AccountType,
  NormalSide,
} from '../domain.js';
import { parseAmount } from '../money.js';
import type {
  AccountBalanceTable,
  LedgerAccountTable,
  LedgerEntryTable,
  LedgerTransactionTable,
} from '../db/schema.js';

/** Row mappers: DB shapes → domain shapes.
 *  NUMERIC/BIGINT are decimal strings on the wire (we cast ::text in SQL);
 *  they become scaled bigints here and nowhere near a float. */

/** Resolve a Kysely table interface to its selected-row shape. */
type SelectOnly<T> = T extends ColumnType<infer S, unknown, unknown>
  ? S
  : T extends Generated<infer G>
    ? G
    : T;
type RowOf<R> = { [K in keyof R]: SelectOnly<R[K]> };

export type AccountRow = RowOf<LedgerAccountTable>;
export type TransactionRow = RowOf<LedgerTransactionTable>;
export type EntryRow = RowOf<LedgerEntryTable>;
export type BalanceRow = RowOf<AccountBalanceTable>;

export function rowToAccount(r: AccountRow): LedgerAccount {
  return {
    tenantId: r.tenant_id,
    accountId: r.account_id,
    parentId: r.parent_id,
    name: r.name,
    accountType: r.account_type as AccountType,
    normalSide: r.normal_side as NormalSide,
    currency: r.currency.trim(),
    status: r.status as LedgerAccount['status'],
    createdAt: r.created_at,
  };
}

export function rowToTransaction(r: TransactionRow): LedgerTransaction {
  return {
    transactionId: r.transaction_id,
    tenantId: r.tenant_id,
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    transactionType: r.transaction_type as LedgerTransaction['transactionType'],
    occurredAt: r.occurred_at,
    postedAt: r.posted_at,
    ingestedAt: r.ingested_at,
    periodKey: r.period_key,
    reversesTransactionId: r.reverses_transaction_id,
    description: r.description,
    metadata: parseJsonb(r.metadata),
    correlationId: r.correlation_id,
  };
}

export function rowToEntry(r: EntryRow): LedgerEntry {
  return {
    entryId: String(r.entry_id),
    transactionId: r.transaction_id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    amount: parseAmount(String(r.amount)),
    currency: r.currency.trim(),
    seq: BigInt(String(r.seq)),
  };
}

export function rowToBalance(r: BalanceRow): AccountBalance {
  return {
    tenantId: r.tenant_id,
    accountId: r.account_id,
    seq: BigInt(String(r.seq)),
    amount: parseAmount(String(r.amount)),
    updatedAt: r.updated_at,
  };
}

function parseJsonb(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
