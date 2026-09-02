import type { AccountStatus, AccountType, NormalSide, TxType } from './types.js';

export type { AccountStatus, AccountType, NormalSide, PeriodStatus, TxType } from './types.js';

/**
 * Domain types mirroring the four entities of the design doc.
 * Balances/amounts are scaled bigints (see src/money.ts); anything crossing
 * the wire uses decimal strings.
 */

export interface LedgerAccount {
  tenantId: string;
  accountId: string;
  parentId: string | null;
  name: string;
  accountType: AccountType;
  normalSide: NormalSide;
  currency: string;
  status: AccountStatus;
  createdAt: Date;
}

export interface LedgerTransaction {
  transactionId: string;
  tenantId: string;
  idempotencyKey: string;
  payloadHash: string;
  transactionType: TxType;
  occurredAt: Date;
  postedAt: Date;
  ingestedAt: Date;
  periodKey: string;
  reversesTransactionId: string | null;
  description: string | null;
  metadata: unknown;
  correlationId: string | null;
}

/** One signed leg on one account. This is the append-only log. */
export interface LedgerEntry {
  entryId: string;
  transactionId: string;
  tenantId: string;
  accountId: string;
  amount: bigint; // scaled by 1e8, always signed, never zero
  currency: string;
  seq: bigint; // dense, per account
}

export interface AccountBalance {
  tenantId: string;
  accountId: string;
  seq: bigint; // log position this balance reflects
  amount: bigint;
  updatedAt: Date;
}

/** A line as supplied by a caller: amounts are decimal strings. */
export interface PostLine {
  accountId: string;
  amount: string;
}

export interface PostTransactionRequest {
  tenantId: string;
  idempotencyKey: string;
  transactionType: TxType;
  occurredAt: Date;
  currency: string;
  lines: PostLine[];
  description?: string;
  metadata?: unknown;
  correlationId?: string;
  reversesTransactionId?: string;
}

export interface PostTransactionResult {
  transaction: LedgerTransaction;
  /** true when the idempotency gate returned a previously stored tx (no new write). */
  duplicate: boolean;
  /** resulting per-account balances after this transaction. */
  balances: Array<{ accountId: string; seq: string; amount: string }>;
}

/** Error codes stable on the wire; mapped to HTTP status in src/http. */
export type LedgerErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNBALANCED_ENTRY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'CURRENCY_MISMATCH'
  | 'PERIOD_NOT_OPEN'
  | 'PERIOD_NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'TRANSACTION_NOT_FOUND'
  | 'ALREADY_REVERSED'
  | 'SEQUENCE_GAP';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly details: unknown;

  constructor(code: LedgerErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const isPeriodKey = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** '2025-08' from a business timestamp, in UTC. */
export function periodKeyFor(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
