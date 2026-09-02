import type { LedgerDb } from '../db/open.js';
import { LedgerError, isPeriodKey, type PeriodStatus } from '../domain.js';

/**
 * Time discipline (design doc §5): occurred_at → period_key.
 * CLOSED/LOCKED periods reject writes inside the write transaction
 * (see post.ts); corrections go forward, never backward.
 */

export async function openPeriod(db: LedgerDb, tenantId: string, periodKey: string): Promise<void> {
  assertKey(periodKey);
  await db
    .insertInto('ledger_period')
    .values({ tenant_id: tenantId, period_key: periodKey, status: 'OPEN' })
    .onConflict((oc) => oc.columns(['tenant_id', 'period_key']).doUpdateSet({ status: 'OPEN' }))
    .execute();
}

export async function setPeriodStatus(
  db: LedgerDb,
  tenantId: string,
  periodKey: string,
  status: PeriodStatus,
): Promise<PeriodStatus> {
  assertKey(periodKey);
  const updated = await db
    .updateTable('ledger_period')
    .set({ status })
    .where('tenant_id', '=', tenantId)
    .where('period_key', '=', periodKey)
    .returning('status')
    .executeTakeFirst();
  if (!updated) throw new LedgerError('PERIOD_NOT_FOUND', `period ${periodKey} not found`);
  return updated.status as PeriodStatus;
}

/** Reopen a period that was closed but never written to again — the only
 *  safe direction, and it is loud by design: audit needs a reason. */
export async function listPeriods(db: LedgerDb, tenantId: string) {
  return db
    .selectFrom('ledger_period')
    .select(['period_key', 'status'])
    .where('tenant_id', '=', tenantId)
    .orderBy('period_key')
    .execute();
}

function assertKey(periodKey: string): void {
  if (!isPeriodKey(periodKey)) {
    throw new LedgerError('VALIDATION_FAILED', `period_key must look like '2025-08', got ${periodKey}`);
  }
}
