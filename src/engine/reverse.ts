import { randomUUID } from 'node:crypto';
import type { LedgerDb } from '../db/open.js';
import {
  LedgerError,
  type PostTransactionRequest,
  type PostTransactionResult,
} from '../domain.js';
import { formatAmount, negateAmount, parseAmount } from '../money.js';
import { getTransaction } from './query.js';
import { postTransaction, DEFAULT_POLICY, type PostPolicy } from './post.js';
import { rowToTransaction } from './rows.js';

/**
 * Reversals (design doc §3/§5): a reversal is a NEW, explicitly named
 * transaction with negated lines, `reverses_transaction_id` pointing at the
 * original, and its own idempotency key. Corrections go forward — you never
 * erase a posted fact, and the original period is untouched.
 */

export interface ReverseInput {
  tenantId: string;
  transactionId: string;
  /** Caller's key for the reversal itself; defaults to a derived stable key
   *  `reversal:{transactionId}` so retried reversals dedupe automatically. */
  idempotencyKey?: string;
  occurredAt?: Date;
  reason?: string;
}

export async function reverseTransaction(
  db: LedgerDb,
  input: ReverseInput,
  policy: PostPolicy = DEFAULT_POLICY,
): Promise<PostTransactionResult> {
  const { transaction, entries } = await getTransaction(db, input.tenantId, input.transactionId);

  // A retried reversal of the SAME key is a dedupe, not a second reversal:
  // consult the idempotency gate before the double-reversal check.
  const derivedKey = input.idempotencyKey ?? `reversal:${transaction.transactionId}`;
  const prior = await db
    .selectFrom('ledger_transaction')
    .selectAll()
    .where('tenant_id', '=', input.tenantId)
    .where('idempotency_key', '=', derivedKey)
    .executeTakeFirst();
  if (prior && prior.reverses_transaction_id === transaction.transactionId) {
    return {
      transaction: rowToTransaction(prior),
      duplicate: true,
      balances: [],
    };
  }

  const already = await db
    .selectFrom('ledger_transaction')
    .select('transaction_id')
    .where('reverses_transaction_id', '=', transaction.transactionId)
    .executeTakeFirst();
  if (already) {
    throw new LedgerError(
      'ALREADY_REVERSED',
      `transaction ${transaction.transactionId} is already reversed by ${already.transaction_id}`,
    );
  }
  if (transaction.transactionType === 'REVERSAL') {
    throw new LedgerError('VALIDATION_FAILED', 'refusing to reverse a reversal; post a fresh transaction instead');
  }

  const req: PostTransactionRequest = {
    tenantId: input.tenantId,
    idempotencyKey: derivedKey,
    transactionType: 'REVERSAL',
    occurredAt: input.occurredAt ?? new Date(),
    currency: entries[0]!.currency,
    lines: entries.map((e) => ({
      accountId: e.accountId,
      amount: formatAmount(negateAmount(e.amount)),
    })),
    description: input.reason
      ? `reversal of ${transaction.transactionId}: ${input.reason}`
      : `reversal of ${transaction.transactionId}`,
    reversesTransactionId: transaction.transactionId,
    ...(transaction.correlationId !== null && { correlationId: transaction.correlationId }),
  };

  return postTransaction(db, req, policy);
}

export function _zeroAmountForTest(amount: string): boolean {
  return parseAmount(amount) === 0n;
}
