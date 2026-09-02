import type { LedgerDb } from '../db/open.js';
import { LedgerError, type AccountStatus, type AccountType, type LedgerAccount, type NormalSide } from '../domain.js';
import { rowToAccount } from './rows.js';
import { wrapDbError } from './validate.js';

/** Chart of accounts: a tree per tenant; `status` replaces DELETE. */

export interface CreateAccountInput {
  tenantId: string;
  accountId: string;
  name: string;
  accountType: AccountType;
  normalSide: NormalSide;
  currency: string;
  parentId?: string;
}

export async function createAccount(db: LedgerDb, input: CreateAccountInput): Promise<LedgerAccount> {
  try {
    if (input.parentId) {
      const parent = await db
        .selectFrom('ledger_account')
        .select(['account_id', 'tenant_id'])
        .where('tenant_id', '=', input.tenantId)
        .where('account_id', '=', input.parentId)
        .executeTakeFirst();
      if (!parent) {
        throw new LedgerError('ACCOUNT_NOT_FOUND', `parent account ${input.parentId} not found`);
      }
    }
    const inserted = await db
      .insertInto('ledger_account')
      .values({
        tenant_id: input.tenantId,
        account_id: input.accountId,
        parent_id: input.parentId ?? null,
        name: input.name,
        account_type: input.accountType,
        normal_side: input.normalSide,
        currency: input.currency,
        status: 'ACTIVE',
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'account_id']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return rowToAccount(inserted);

    // CREATE IF NOT EXISTS keeps re-seeding scripts and tests boring.
    const existing = await getAccount(db, input.tenantId, input.accountId);
    return existing;
  } catch (err) {
    throw wrapDbError(err);
  }
}

export async function getAccount(db: LedgerDb, tenantId: string, accountId: string): Promise<LedgerAccount> {
  const row = await db
    .selectFrom('ledger_account')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  if (!row) throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${accountId} not found`);
  return rowToAccount(row);
}

/** ACTIVE → FROZEN → CLOSED. Frozen accounts reject new legs but keep the
 *  full history readable — you never delete an account that holds truth. */
export async function setAccountStatus(
  db: LedgerDb,
  tenantId: string,
  accountId: string,
  status: AccountStatus,
): Promise<LedgerAccount> {
  const updated = await db
    .updateTable('ledger_account')
    .set({ status })
    .where('tenant_id', '=', tenantId)
    .where('account_id', '=', accountId)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${accountId} not found`);
  return rowToAccount(updated);
}

export interface ListAccountsOptions {
  parentOnly?: boolean;
  status?: AccountStatus;
  limit?: number;
}

export async function listAccounts(
  db: LedgerDb,
  tenantId: string,
  opts: ListAccountsOptions = {},
): Promise<LedgerAccount[]> {
  let q = db.selectFrom('ledger_account').selectAll().where('tenant_id', '=', tenantId);
  if (opts.parentOnly) q = q.where('parent_id', 'is', null);
  if (opts.status) q = q.where('status', '=', opts.status);
  q = q.orderBy('account_id').limit(opts.limit ?? 500);
  return (await q.execute()).map(rowToAccount);
}
