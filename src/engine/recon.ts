import type { LedgerDb } from '../db/open.js';
import { formatAmount, parseAmount } from '../money.js';
import { sql } from 'kysely';

/**
 * The sidecars from the design doc — things that run beside the write path
 * and make drift impossible to hide:
 *
 *   reconciler: re-SUM(LedgerEntry) → diff vs AccountBalance → alert on mismatch
 *   replay:     rebuild the projection from the log → must match byte-exact
 *   gaps:       dense per-account seq means a gap IS an incident
 */

export interface ReconcileReport {
  ok: boolean;
  /** accounts where Σ entries ≠ stored balance */
  balanceDrift: Array<{ accountId: string; logSum: string; stored: string }>;
  /** accounts with holes in the seq sequence (1..N must all exist) */
  seqGaps: Array<{ accountId: string; count: bigint; maxSeq: string }>;
  /** transactions whose Σ amount ≠ 0 (the trigger says impossible; trust, verify) */
  unbalancedTransactions: string[];
  /** global conservation: Σ over the whole log must be 0 */
  globalSum: string;
}

export async function reconcile(db: LedgerDb, tenantId: string): Promise<ReconcileReport> {
  const drift = await sql<{ account_id: string; log_sum: string; stored: string }>`
    WITH log AS (
      SELECT account_id, SUM(amount)::text AS log_sum, MAX(seq)::text AS log_seq
        FROM ledger_entry WHERE tenant_id = ${tenantId} GROUP BY account_id
    )
    SELECT l.account_id, l.log_sum, COALESCE(b.amount::text, '0') AS stored
      FROM log l
      LEFT JOIN account_balance b ON b.tenant_id = ${tenantId} AND b.account_id = l.account_id
     WHERE COALESCE(b.amount, 0) <> l.log_sum::numeric
        OR COALESCE(b.seq, 0) <> l.log_seq::bigint
  `.execute(db);

  const gaps = await sql<{ account_id: string; count: string; max_seq: string }>`
    SELECT account_id, COUNT(*)::text AS count, MAX(seq)::text AS max_seq
      FROM ledger_entry WHERE tenant_id = ${tenantId}
     GROUP BY account_id
    HAVING COUNT(*) <> MAX(seq)
  `.execute(db);

  const unbalanced = await sql<{ transaction_id: string }>`
    SELECT e.transaction_id
      FROM ledger_entry e
      JOIN ledger_transaction t ON t.transaction_id = e.transaction_id
     WHERE t.tenant_id = ${tenantId}
     GROUP BY e.transaction_id
    HAVING SUM(e.amount) <> 0
  `.execute(db);

  const global = await sql<{ sum: string | null }>`
    SELECT SUM(e.amount)::text AS sum
      FROM ledger_entry e
      JOIN ledger_transaction t ON t.transaction_id = e.transaction_id
     WHERE t.tenant_id = ${tenantId}
  `.execute(db);

  const globalSumRaw = global.rows[0]?.sum ?? '0';
  return {
    ok: drift.rows.length === 0 && gaps.rows.length === 0 && unbalanced.rows.length === 0,
    balanceDrift: drift.rows.map((r) => ({
      accountId: r.account_id,
      logSum: formatAmount(parseAmount(r.log_sum)),
      stored: formatAmount(parseAmount(r.stored)),
    })),
    seqGaps: gaps.rows.map((r) => ({
      accountId: r.account_id,
      count: BigInt(r.count),
      maxSeq: r.max_seq,
    })),
    unbalancedTransactions: unbalanced.rows.map((r) => r.transaction_id),
    globalSum: formatAmount(parseAmount(globalSumRaw)),
  };
}

/** Replay the projection from the log (the "byte-exact" guarantee, as a
 *  pure function you can run against a copy). */
export async function replayBalances(
  db: LedgerDb,
  tenantId: string,
): Promise<Array<{ accountId: string; seq: string; amount: string }>> {
  const result = await sql<{ account_id: string; seq: string; amount: string }>`
    SELECT account_id, MAX(seq)::text AS seq, SUM(amount)::text AS amount
      FROM ledger_entry WHERE tenant_id = ${tenantId}
     GROUP BY account_id ORDER BY account_id
  `.execute(db);
  return result.rows.map((r) => ({
    accountId: r.account_id,
    seq: r.seq,
    amount: formatAmount(parseAmount(r.amount)),
  }));
}
