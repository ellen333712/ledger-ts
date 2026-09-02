import type { OpenedDb } from '../db/open.js';
import { openDb, migrate } from '../db/open.js';
import type { LedgerDb } from '../db/open.js';
import type {
  AccountStatus,
  LedgerAccount,
  PeriodStatus,
  PostTransactionRequest,
  PostTransactionResult,
} from '../domain.js';
import * as accounts from './accounts.js';
import * as query from './query.js';
import * as periods from './periods.js';
import * as recon from './recon.js';
import * as reverse from './reverse.js';
import { postTransaction, type PostPolicy } from './post.js';
import { OutboxRelay, type RelayOptions } from './outbox.js';

/**
 * The facade that ties engine modules to one connection.
 *
 *   const ledger = await Ledger.create();          // embedded PGlite, migrated
 *   await ledger.createAccount({ ... });
 *   const result = await ledger.post(request);     // the §3 write path
 */
export class Ledger {
  private constructor(
    readonly db: LedgerDb,
    private readonly opened: OpenedDb,
  ) {}

  static async create(
    opts: { connectionString?: string; pgliteDir?: string; migrate?: boolean; isolatedSchema?: boolean } = {},
  ): Promise<Ledger> {
    const opened = await openDb({
      ...(opts.connectionString !== undefined && { connectionString: opts.connectionString }),
      ...(opts.pgliteDir !== undefined && { pgliteDir: opts.pgliteDir }),
      ...(opts.isolatedSchema !== undefined && { isolatedSchema: opts.isolatedSchema }),
    });
    if (opts.migrate !== false) await migrate(opened);
    return new Ledger(opened.db, opened);
  }

  get embedded(): boolean {
    return this.opened.embedded;
  }

  async close(): Promise<void> {
    await this.opened.close();
  }

  // ── write path ────────────────────────────────────────────────────
  post(req: PostTransactionRequest, policy?: PostPolicy): Promise<PostTransactionResult> {
    return postTransaction(this.db, req, policy);
  }

  reverse(input: reverse.ReverseInput, policy?: PostPolicy): Promise<PostTransactionResult> {
    return reverse.reverseTransaction(this.db, input, policy);
  }

  // ── chart of accounts ─────────────────────────────────────────────
  createAccount(input: accounts.CreateAccountInput): Promise<LedgerAccount> {
    return accounts.createAccount(this.db, input);
  }
  getAccount(tenantId: string, accountId: string): Promise<LedgerAccount> {
    return accounts.getAccount(this.db, tenantId, accountId);
  }
  setAccountStatus(tenantId: string, accountId: string, status: AccountStatus): Promise<LedgerAccount> {
    return accounts.setAccountStatus(this.db, tenantId, accountId, status);
  }
  listAccounts(tenantId: string, opts?: accounts.ListAccountsOptions): Promise<LedgerAccount[]> {
    return accounts.listAccounts(this.db, tenantId, opts);
  }

  // ── derived reads (projections) ───────────────────────────────────
  getBalance(tenantId: string, accountId: string) {
    return query.getBalance(this.db, tenantId, accountId);
  }
  listEntries(
    tenantId: string,
    accountId: string,
    opts?: { afterSeq?: bigint; limit?: number; periodKey?: string },
  ) {
    return query.listEntries(this.db, tenantId, accountId, opts);
  }
  getTransaction(tenantId: string, transactionId: string) {
    return query.getTransaction(this.db, tenantId, transactionId);
  }
  trialBalance(tenantId: string, opts?: { periodKey?: string }) {
    return query.trialBalance(this.db, tenantId, opts);
  }

  // ── periods ───────────────────────────────────────────────────────
  openPeriod(tenantId: string, periodKey: string) {
    return periods.openPeriod(this.db, tenantId, periodKey);
  }
  setPeriodStatus(tenantId: string, periodKey: string, status: PeriodStatus) {
    return periods.setPeriodStatus(this.db, tenantId, periodKey, status);
  }
  listPeriods(tenantId: string) {
    return periods.listPeriods(this.db, tenantId);
  }

  // ── sidecars ──────────────────────────────────────────────────────
  reconcile(tenantId: string) {
    return recon.reconcile(this.db, tenantId);
  }
  replayBalances(tenantId: string) {
    return recon.replayBalances(this.db, tenantId);
  }
  relay(opts?: RelayOptions): OutboxRelay {
    return new OutboxRelay(this.db, opts);
  }

  /** escape hatch for tests/benchmarks */
  execScript(text: string): Promise<void> {
    return this.opened.execScript(text);
  }
}
