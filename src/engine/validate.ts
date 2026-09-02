import { z } from 'zod';
import { LedgerError, type PostTransactionRequest } from '../domain.js';
import { parseAmount, sumAmount } from '../money.js';

/**
 * Shape validation — the first gate, before any database is touched.
 * The design doc's order: authz+tenant scope → idempotency gate →
 * validate (Σ = 0, currency, no zeros) → policy (status, period).
 */

export const moneyAmountSchema = z
  .string()
  .regex(/^-?\d{1,20}(\.\d{1,8})?$/, 'amount must be a decimal string with <= 8 fraction digits, never a JSON number')
  .refine(
    (s) => {
      try {
        return parseAmount(s) !== 0n;
      } catch {
        return false;
      }
    },
    'amount must be non-zero',
  );

export const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO-4217 style 3-letter code');

export const txTypeSchema = z.enum(['TRANSFER', 'FEE', 'REFUND', 'REVERSAL', 'FX', 'ADJUST']);

export const accountIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_:.\-]+$/, 'accountId may contain letters, digits, _ : . -');

export const idempotencyKeySchema = z.string().min(8).max(200);

export const postLineSchema = z.object({
  account_id: accountIdSchema,
  amount: moneyAmountSchema,
});

export const postTransactionSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  transaction_type: txTypeSchema,
  currency: currencySchema,
  occurred_at: z.string().datetime({ offset: true }).or(z.string().endsWith('Z')),
  lines: z.array(postLineSchema).min(2, 'a transaction needs at least two lines'),
  description: z.string().max(2000).optional(),
  metadata: z.unknown().optional(),
  correlation_id: z.string().max(200).optional(),
});

export type PostTransactionBody = z.infer<typeof postTransactionSchema>;

/**
 * Pure pre-DB checks on an assembled request:
 *  - every amount parses and is non-zero (schema already enforced, re-asserted)
 *  - Σ amount = 0  (conservation — rejected here, enforced again by the
 *    deferred DB trigger so a buggy caller can never commit)
 *  - one currency per transaction
 *
 * Note: duplicate lines for the same account are legal (multiple legs on
 * one account in one event); each still gets its own dense seq.
 */
export function assertRequestValid(req: PostTransactionRequest): void {
  if (req.lines.length < 2) {
    throw new LedgerError('VALIDATION_FAILED', 'a transaction needs at least two lines');
  }
  const amounts: bigint[] = [];
  const accounts = new Set<string>();
  for (const line of req.lines) {
    let scaled: bigint;
    try {
      scaled = parseAmount(line.amount);
    } catch (e) {
      throw new LedgerError('VALIDATION_FAILED', (e as Error).message, { account_id: line.accountId });
    }
    if (scaled === 0n) {
      throw new LedgerError('VALIDATION_FAILED', 'zero-amount line rejected; a plug line is never auto-inserted', {
        account_id: line.accountId,
      });
    }
    amounts.push(scaled);
    accounts.add(line.accountId);
  }
  if (sumAmount(amounts) !== 0n) {
    throw new LedgerError('UNBALANCED_ENTRY', 'Σ(amount) must equal 0', {
      sum: sumAmount(amounts).toString(),
    });
  }
  if (accounts.size < 2) {
    throw new LedgerError('VALIDATION_FAILED', 'a transaction must touch at least two distinct accounts');
  }
}

/** Map raw PG/PGlite errors onto stable domain errors. */
export function wrapDbError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('UNBALANCED_ENTRY')) {
    return new LedgerError('UNBALANCED_ENTRY', 'database refused an unbalanced transaction (deferred trigger)');
  }
  if (msg.includes('NON_NEGATIVE_BALANCE') || msg.includes('negative balance')) {
    return new LedgerError('INSUFFICIENT_FUNDS', msg.split('\n')[0] ?? 'negative balance');
  }
  if (msg.includes('duplicate key value') && msg.includes('idempotency_key')) {
    return new LedgerError('IDEMPOTENCY_CONFLICT', 'idempotency key already used with a different payload');
  }
  return err;
}
