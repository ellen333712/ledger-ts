import { sql } from 'kysely';
import type { LedgerDb } from '../db/open.js';
import {
  LedgerError,
  type AccountBalance,
  type LedgerEntry,
  type LedgerTransaction,
} from '../domain.js';
import { formatAmount, parseAmount } from '../money.js';
import { rowToBalance, rowToEntry, rowToTransaction } from './rows.js';
import type { LedgerEntryTable, AccountBalanceTable } from '../db/schema.js';

/** All derived reads: statements, trial balance, balances.
 *  Everything here is a projection — rebuildable from LedgerEntry. */

export async function getBalance(db: LedgerDb, tenantId: string, accountId: string): Promise<AccountBalance> {
  const row = await db
    .selectFrom('account_balance')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  if (!row) {
    // An account with no entries has a balance of zero at log position 0.
    return { tenantId, accountId, seq: 0n, amount: 0n, updatedAt: new Date(0) };
  }
  return rowToBalance(row);
}

export interface EntriesPage {
  entries: LedgerEntry[];
  nextAfterSeq: string | null;
}

/** Statement for one account, walking the dense per-account seq. */
export async function listEntries(
  db: LedgerDb,
  tenantId: string,
  accountId: string,
  opts: { afterSeq?: bigint; limit?: number; periodKey?: string } = {},
): Promise<EntriesPage> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  let q = db
    .selectFrom('ledger_entry')
    .selectAll()
    .where('ledger_entry.tenant_id', '=', tenantId)
    .where('ledger_entry.account_id', '=', accountId)
    .orderBy('seq', 'asc')
    .limit(limit + 1);
  if (opts.afterSeq !== undefined) q = q.where('seq', '>', opts.afterSeq.toString());
  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(rowToEntry);
  return {
    entries: page,
    nextAfterSeq: hasMore && page.length ? page[page.length - 1]!.seq.toString() : null,
  };
}

export async function getTransaction(
  db: LedgerDb,
  tenantId: string,
  transactionId: string,
): Promise<{ transaction: LedgerTransaction; entries: LedgerEntry[] }> {
  const tx = await db
    .selectFrom('ledger_transaction')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('transaction_id', '=', transactionId)
    .executeTakeFirst();
  if (!tx) throw new LedgerError('TRANSACTION_NOT_FOUND', `transaction ${transactionId} not found`);
  const entryRows = await db
    .selectFrom('ledger_entry')
    .selectAll()
    .where('transaction_id', '=', transactionId)
    .orderBy('account_id')
    .orderBy('seq')
    .execute();
  return { transaction: rowToTransaction(tx), entries: entryRows.map(rowToEntry) };
}

export interface TrialBalanceRow {
  accountId: string;
  accountType: string;
  normalSide: string;
  currency: string;
  /** net of all entries, optionally restricted to one period */
  net: string;
  entryCount: number;
}

/** The daily conservation smoke test: Σ over every row must be 0. */
export async function trialBalance(
  db: LedgerDb,
  tenantId: string,
  opts: { periodKey?: string } = {},
): Promise<{ rows: TrialBalanceRow[]; total: string; conserved: boolean }> {
  const result = await sql<{
    account_id: string;
    account_type: string;
    normal_side: string;
    currency: string;
    net: string;
    entry_count: string;
  }>`
    SELECT e.account_id,
           a.account_type,
           a.normal_side,
           e.currency,
           SUM(e.amount)::text AS net,
           COUNT(*)::text      AS entry_count
      FROM ledger_entry e
      JOIN ledger_account a ON a.tenant_id = e.tenant_id AND a.account_id = e.account_id
     WHERE e.tenant_id = ${tenantId}
       ${opts.periodKey ? sql`AND EXISTS (
              SELECT 1 FROM ledger_transaction t
               WHERE t.transaction_id = e.transaction_id AND t.period_key = ${opts.periodKey})` : sql``}
     GROUP BY e.account_id, a.account_type, a.normal_side, e.currency
     ORDER BY e.account_id
  `.execute(db);

  const rows: TrialBalanceRow[] = result.rows.map((r) => ({
    accountId: r.account_id,
    accountType: r.account_type,
    normalSide: r.normal_side,
    currency: r.currency.trim(),
    net: r.net,
    entryCount: Number(r.entry_count),
  }));
  const total = rows.reduce((acc, r) => acc + parseAmount(r.net), 0n);

  return { rows, total: formatAmount(total), conserved: total === 0n };
}
