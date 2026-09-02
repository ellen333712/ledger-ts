import { sql, type Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { LedgerDb } from '../db/open.js';
import type { Database } from '../db/schema.js';
import {
  LedgerError,
  periodKeyFor,
  type LedgerTransaction,
  type PostTransactionRequest,
  type PostTransactionResult,
} from '../domain.js';
import { formatAmount, parseAmount } from '../money.js';
import { payloadHash } from '../canonical.js';
import { assertRequestValid, wrapDbError } from './validate.js';
import { rowToTransaction } from './rows.js';

/**
 * The write path — what the ACID boundary actually covers (design doc §3):
 *
 *   BEGIN
 *     INSERT ledger_transaction  ON CONFLICT (tenant, idempotency_key)
 *       conflict → hash match? return stored tx : hard 409
 *     LOCK ledger_account rows sorted by account_id   (deterministic, deadlock-free)
 *     CHECK period FOR UPDATE — writes into non-OPEN periods are rejected here,
 *       in the transaction, not in app folklore
 *     assign dense per-account seq, INSERT ledger_entry × N   ← the log
 *     UPSERT account_balance (guarded for spendable accounts)
 *     INSERT outbox row (same tx → no lost/phantom events)
 *   COMMIT  ← deferred constraint trigger asserts Σ amount = 0 per tx
 *
 * Failure rules honored below:
 *  - before commit → transaction absent entirely; retry with the same key
 *  - reused key, different payload → IDEMPOTENCY_CONFLICT (make it loud)
 *  - unbalanced batch → the DB itself refuses to commit (UNBALANCED_ENTRY)
 */

export interface PostPolicy {
  /** auto-create the current month's period row as OPEN when absent. */
  autoCreatePeriod: boolean;
}

export const DEFAULT_POLICY: PostPolicy = { autoCreatePeriod: true };

/** Hash only the semantics of the request: a retry must produce the same
 *  hash; a *different* body under the same key must collide loudly. Lines
 *  are sorted so cosmetic reordering is still "the same request". */
export function semanticPayloadHash(req: PostTransactionRequest): string {
  return payloadHash({
    transaction_type: req.transactionType,
    currency: req.currency,
    occurred_at: req.occurredAt.toISOString(),
    description: req.description ?? null,
    metadata: req.metadata ?? null,
    reverses: req.reversesTransactionId ?? null,
    lines: [...req.lines]
      .map((l) => ({ account_id: l.accountId, amount: normalizeAmount(l.amount) }))
      .sort((a, b) => a.account_id.localeCompare(b.account_id) || a.amount.localeCompare(b.amount)),
  });
}

function normalizeAmount(input: string): string {
  return parseAmount(input).toString();
}

export async function postTransaction(
  db: LedgerDb,
  req: PostTransactionRequest,
  policy: PostPolicy = DEFAULT_POLICY,
): Promise<PostTransactionResult> {
  // Gate 1: shape validation, before any database is touched.
  assertRequestValid(req);

  const hash = semanticPayloadHash(req);
  const periodKey = periodKeyFor(req.occurredAt);
  const transactionId = randomUUID();

  try {
    return await db.transaction().execute(async (trx) => {
      // Gate 2: idempotency gate — key + payload hash → dedupe | conflict-reject.
      const inserted = await trx
        .insertInto('ledger_transaction')
        .values({
          transaction_id: transactionId,
          tenant_id: req.tenantId,
          idempotency_key: req.idempotencyKey,
          payload_hash: hash,
          transaction_type: req.transactionType,
          occurred_at: req.occurredAt,
          period_key: periodKey,
          reverses_transaction_id: req.reversesTransactionId ?? null,
          description: req.description ?? null,
          metadata: req.metadata === undefined ? null : JSON.stringify(req.metadata),
          correlation_id: req.correlationId ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'idempotency_key']).doNothing(),
        )
        .returning('transaction_id')
        .execute();

      if (inserted.length === 0) {
        return await resolveDuplicate(trx, req.tenantId, req.idempotencyKey, hash);
      }

      // Gate 3: period discipline — checked inside the write transaction.
      if (policy.autoCreatePeriod) {
        await trx
          .insertInto('ledger_period')
          .values({ tenant_id: req.tenantId, period_key: periodKey, status: 'OPEN' })
          .onConflict((oc) => oc.columns(['tenant_id', 'period_key']).doNothing())
          .execute();
      }
      const period = await sql<{ status: string }>`
        SELECT status FROM ledger_period
         WHERE tenant_id = ${req.tenantId} AND period_key = ${periodKey}
        FOR UPDATE
      `.execute(trx);
      const status = period.rows[0]?.status;
      if (status === undefined) {
        throw new LedgerError('PERIOD_NOT_FOUND', `period ${periodKey} does not exist and auto-creation is disabled`);
      }
      if (status !== 'OPEN') {
        throw new LedgerError(
          'PERIOD_NOT_OPEN',
          `period ${periodKey} is ${status}; corrections go forward, not backward`,
        );
      }

      // Gate 4: lock accounts sorted by id (deterministic order, no deadlock),
      // then validate existence / status / currency.
      const accountIds = [...new Set(req.lines.map((l) => l.accountId))].sort();
      const accounts = new Map<string, { status: string; currency: string; account_type: string }>();
      for (const accountId of accountIds) {
        const locked = await sql<{ status: string; currency: string; account_type: string }>`
          SELECT status, currency, account_type FROM ledger_account
           WHERE tenant_id = ${req.tenantId} AND account_id = ${accountId}
          FOR UPDATE
        `.execute(trx);
        const row = locked.rows[0];
        if (!row) {
          throw new LedgerError('ACCOUNT_NOT_FOUND', `account ${accountId} not found`, { account_id: accountId });
        }
        if (row.status !== 'ACTIVE') {
          throw new LedgerError('ACCOUNT_NOT_ACTIVE', `account ${accountId} is ${row.status}`, {
            account_id: accountId,
            status: row.status,
          });
        }
        if (row.currency !== req.currency) {
          throw new LedgerError('CURRENCY_MISMATCH', `account ${accountId} holds ${row.currency}, tx is ${req.currency}`, {
            account_id: accountId,
          });
        }
        accounts.set(accountId, row);
      }

      // Assign dense per-account seq and append the log. Never UPDATE, never
      // DELETE; one LedgerEntry row per line, signed amounts only.
      const netByAccount = new Map<string, bigint>();
      for (const line of req.lines) {
        const amount = parseAmount(line.amount);
        netByAccount.set(line.accountId, (netByAccount.get(line.accountId) ?? 0n) + amount);
      }

      for (const accountId of accountIds) {
        const maxSeq = await sql<{ seq: string }>`
          SELECT COALESCE(MAX(seq), 0)::text AS seq FROM ledger_entry WHERE account_id = ${accountId}
        `.execute(trx);
        let seq = BigInt(maxSeq.rows[0]!.seq);
        for (const line of req.lines) {
          if (line.accountId !== accountId) continue;
          seq += 1n;
          await sql`
            INSERT INTO ledger_entry (entry_id, transaction_id, tenant_id, account_id, amount, currency, seq)
            VALUES (nextval('ledger_entry_seq'), ${transactionId}, ${req.tenantId}, ${accountId},
                    ${line.amount}::numeric, ${req.currency}, ${seq.toString()}::bigint)
          `.execute(trx);
        }
      }

      // UPSERT the balance projection. The guard for spendable accounts is a
      // single atomic statement under the account row lock — never
      // read-balance → check → write-balance.
      const balances: PostTransactionResult['balances'] = [];
      for (const accountId of accountIds) {
        const delta = netByAccount.get(accountId)!;
        if (delta === 0n) continue; // two legs on one account in the same event

        const current = await sql<{ seq: string }>`
          SELECT COALESCE(MAX(seq), 0)::text AS seq FROM ledger_entry WHERE account_id = ${accountId}
        `.execute(trx);
        const upserted = await sql<{ seq: string; amount: string }>`
          INSERT INTO account_balance (tenant_id, account_id, seq, amount, updated_at)
          VALUES (${req.tenantId}, ${accountId}, ${current.rows[0]!.seq}, ${formatAmount(delta)}::numeric, now())
          ON CONFLICT (account_id) DO UPDATE
            SET amount = account_balance.amount + EXCLUDED.amount,
                seq    = EXCLUDED.seq,
                updated_at = now()
          RETURNING seq::text AS seq, amount::text AS amount
        `.execute(trx);

        const row = upserted.rows[0]!;
        const newAmount = parseAmount(row.amount);
        if (accounts.get(accountId)!.account_type === 'asset' && newAmount < 0n) {
          // Rolls the whole transaction back; the deferred trigger is the
          // belt to this pair of suspenders.
          throw new LedgerError(
            'INSUFFICIENT_FUNDS',
            `spendable account ${accountId} would go negative (${row.amount})`,
            { account_id: accountId },
          );
        }
        balances.push({ accountId, seq: row.seq, amount: formatAmount(newAmount) });
      }

      // Transactional outbox: same ACID unit as the log, so a crash after
      // commit cannot lose the event — the relay retries until published.
      await sql`
        INSERT INTO outbox (event_id, tenant_id, transaction_id, event_type, payload)
        VALUES (nextval('outbox_event_seq'), ${req.tenantId}, ${transactionId},
                'ledger.transaction.posted',
                ${JSON.stringify({
                  event_type: 'ledger.transaction.posted',
                  transaction_id: transactionId,
                  tenant_id: req.tenantId,
                  transaction_type: req.transactionType,
                  period_key: periodKey,
                  occurred_at: req.occurredAt.toISOString(),
                  currency: req.currency,
                  lines: req.lines.map((l) => ({ account_id: l.accountId, amount: normalizeAmount(l.amount) })),
                  correlation_id: req.correlationId ?? null,
                })}::jsonb)
      `.execute(trx);

      const txRow = await trx
        .selectFrom('ledger_transaction')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .executeTakeFirstOrThrow();

      return {
        transaction: rowToTransaction(txRow),
        duplicate: false,
        balances,
      };
    });
  } catch (err) {
    throw wrapDbError(err);
  }
}

/** The key already exists: same payload → return the stored transaction
 *  (200, no-op); different payload → 409, that is a client bug. */
async function resolveDuplicate(
  trx: Transaction<Database>,
  tenantId: string,
  idempotencyKey: string,
  hash: string,
): Promise<PostTransactionResult> {
  const existing = await trx
    .selectFrom('ledger_transaction')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();

  if (!existing) {
    // Vanished between ON CONFLICT DO NOTHING and SELECT — a concurrent
    // ROLLBACK. Treat as "retry me": surface a conflict the caller can retry.
    throw new LedgerError('IDEMPOTENCY_CONFLICT', 'idempotency race detected; retry the request');
  }
  if (existing.payload_hash !== hash) {
    throw new LedgerError(
      'IDEMPOTENCY_CONFLICT',
      'idempotency key was already used with a different payload',
      { transaction_id: existing.transaction_id },
    );
  }

  const entryAccounts = await trx
    .selectFrom('ledger_entry')
    .select('account_id')
    .distinct()
    .where('transaction_id', '=', existing.transaction_id)
    .execute();

  const balances: PostTransactionResult['balances'] = [];
  for (const { account_id } of entryAccounts) {
    const b = await trx
      .selectFrom('account_balance')
      .select(['seq', 'amount'])
      .where('account_id', '=', account_id)
      .executeTakeFirst();
    if (b) balances.push({ accountId: account_id, seq: String(b.seq), amount: String(b.amount) });
  }

  return { transaction: rowToTransaction(existing), duplicate: true, balances };
}

export type { LedgerTransaction };
