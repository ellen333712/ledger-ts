import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { Ledger } from '../engine/ledger.js';
import { LedgerError, type LedgerErrorCode } from '../domain.js';
import { formatAmount } from '../money.js';
import { accountIdSchema, currencySchema, postTransactionSchema } from '../engine/validate.js';
import { createAccountSchema } from './schemas.js';
import { DEMO_HTML } from './demo-page.js';

/** Error code → HTTP status. The wire contract is the domain error codes. */
export const STATUS_BY_CODE: Record<LedgerErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNBALANCED_ENTRY: 422,
  IDEMPOTENCY_CONFLICT: 409,
  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_NOT_ACTIVE: 422,
  CURRENCY_MISMATCH: 422,
  PERIOD_NOT_OPEN: 409,
  PERIOD_NOT_FOUND: 409,
  INSUFFICIENT_FUNDS: 422,
  TRANSACTION_NOT_FOUND: 404,
  ALREADY_REVERSED: 409,
  SEQUENCE_GAP: 500,
};

const tenantHeaderSchema = z.string().min(1).max(100);

const serializeAccount = (a: Awaited<ReturnType<Ledger['getAccount']>>) => ({
  tenant_id: a.tenantId,
  account_id: a.accountId,
  parent_id: a.parentId,
  name: a.name,
  account_type: a.accountType,
  normal_side: a.normalSide,
  currency: a.currency,
  status: a.status,
  created_at: a.createdAt.toISOString(),
});

const serializeTx = (t: Awaited<ReturnType<Ledger['getTransaction']>>['transaction']) => ({
  transaction_id: t.transactionId,
  tenant_id: t.tenantId,
  idempotency_key: t.idempotencyKey,
  transaction_type: t.transactionType,
  occurred_at: t.occurredAt.toISOString(),
  posted_at: t.postedAt.toISOString(),
  period_key: t.periodKey,
  reverses_transaction_id: t.reversesTransactionId,
  description: t.description,
  metadata: t.metadata,
  correlation_id: t.correlationId,
});

const serializeEntry = (e: { entryId: string; transactionId: string; accountId: string; amount: bigint; currency: string; seq: bigint }) => ({
  entry_id: e.entryId,
  transaction_id: e.transactionId,
  account_id: e.accountId,
  amount: formatAmount(e.amount),
  currency: e.currency,
  seq: e.seq.toString(),
});

export interface BuildAppOptions {
  ledger: Ledger;
  /** in-process bus sink for the demo: relayed events land here. */
  onEvent?: (event: { transaction_id: string; tenant_id: string }) => void;
}

export async function buildApp({ ledger, onEvent }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof LedgerError) {
      return reply.status(STATUS_BY_CODE[err.code]).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    if (err instanceof z.ZodError || (err as { validationError?: boolean }).validationError) {
      const first = err instanceof z.ZodError ? err.issues[0] : undefined;
      return reply
        .status(400)
        .send({
          error: {
            code: 'VALIDATION_FAILED',
            message: first ? `${first.path.join('.')}: ${first.message}` : 'request validation failed',
          },
        });
    }
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'unexpected error' } });
  });

  const requireTenant = (req: { headers: Record<string, unknown> }): string => {
    const raw = req.headers['x-tenant-id'];
    const parsed = tenantHeaderSchema.safeParse(typeof raw === 'string' ? raw : undefined);
    if (!parsed.success) {
      throw new LedgerError('VALIDATION_FAILED', 'X-Tenant-Id header is required');
    }
    return parsed.data;
  };

  app.get('/healthz', async () => ({ ok: true }));

  // ── accounts ──────────────────────────────────────────────────────
  app.post('/v1/accounts', async (req, reply) => {
    const tenantId = requireTenant(req);
    const body = createAccountSchema.parse(req.body);
    const account = await ledger.createAccount({
      tenantId,
      accountId: body.account_id,
      name: body.name,
      accountType: body.account_type,
      normalSide: body.normal_side,
      currency: body.currency,
      ...(body.parent_id !== undefined && { parentId: body.parent_id }),
    });
    return reply.status(201).send(serializeAccount(account));
  });

  app.get('/v1/accounts', async (req) => {
    const tenantId = requireTenant(req);
    const list = await ledger.listAccounts(tenantId);
    return { accounts: list.map(serializeAccount) };
  });

  app.get<{ Params: { accountId: string } }>('/v1/accounts/:accountId', async (req) => {
    const tenantId = requireTenant(req);
    const account = await ledger.getAccount(tenantId, accountIdSchema.parse(req.params.accountId));
    const balance = await ledger.getBalance(tenantId, account.accountId);
    return { ...serializeAccount(account), balance: { seq: balance.seq.toString(), amount: formatAmount(balance.amount) } };
  });

  app.post<{ Params: { accountId: string }; Body: { status: string } }>('/v1/accounts/:accountId/status', async (req) => {
    const tenantId = requireTenant(req);
    const status = z.enum(['ACTIVE', 'FROZEN', 'CLOSED']).parse(req.body.status);
    const account = await ledger.setAccountStatus(tenantId, accountIdSchema.parse(req.params.accountId), status);
    return serializeAccount(account);
  });

  app.get<{ Params: { accountId: string }; Querystring: { after_seq?: string; limit?: string; period_key?: string } }>(
    '/v1/accounts/:accountId/entries',
    async (req) => {
      const tenantId = requireTenant(req);
      const page = await ledger.listEntries(tenantId, accountIdSchema.parse(req.params.accountId), {
        ...(req.query.after_seq !== undefined && { afterSeq: BigInt(req.query.after_seq) }),
        ...(req.query.limit !== undefined && { limit: Number(req.query.limit) }),
      });
      return { entries: page.entries.map(serializeEntry), next_after_seq: page.nextAfterSeq };
    },
  );

  // ── transactions ──────────────────────────────────────────────────
  const postTx = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const tenantId = requireTenant(req);
    const body = postTransactionSchema.parse(req.body);
    const result = await ledger.post({
      tenantId,
      idempotencyKey: body.idempotency_key,
      transactionType: body.transaction_type,
      currency: body.currency,
      occurredAt: new Date(body.occurred_at),
      lines: body.lines.map((l) => ({ accountId: l.account_id, amount: l.amount })),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.metadata !== undefined && { metadata: body.metadata }),
      ...(body.correlation_id !== undefined && { correlationId: body.correlation_id }),
    });
    reply.status(result.duplicate ? 200 : 201);
    return {
      ...serializeTx(result.transaction),
      duplicate: result.duplicate,
      balances: result.balances,
    };
  };

  app.post('/v1/transactions', postTx);
  app.post('/v1/transfers', postTx); // alias from the design doc; engine stays type-agnostic

  app.get<{ Params: { transactionId: string } }>('/v1/transactions/:transactionId', async (req) => {
    const tenantId = requireTenant(req);
    const { transaction, entries } = await ledger.getTransaction(tenantId, req.params.transactionId);
    return { ...serializeTx(transaction), entries: entries.map(serializeEntry) };
  });

  app.post<{ Params: { transactionId: string }; Body: { idempotency_key?: string; reason?: string; occurred_at?: string } }>(
    '/v1/transactions/:transactionId/reversal',
    async (req, reply) => {
      const tenantId = requireTenant(req);
      const body = z
        .object({
          idempotency_key: z.string().min(8).max(200).optional(),
          reason: z.string().max(500).optional(),
          occurred_at: z.string().optional(),
        })
        .parse(req.body ?? {});
      const result = await ledger.reverse({
        tenantId,
        transactionId: req.params.transactionId,
        ...(body.idempotency_key !== undefined && { idempotencyKey: body.idempotency_key }),
        ...(body.reason !== undefined && { reason: body.reason }),
        ...(body.occurred_at !== undefined && { occurredAt: new Date(body.occurred_at) }),
      });
      reply.status(result.duplicate ? 200 : 201);
      return { ...serializeTx(result.transaction), duplicate: result.duplicate, balances: result.balances };
    },
  );

  // ── projections & sidecars ────────────────────────────────────────
  app.get<{ Querystring: { period_key?: string } }>('/v1/trial-balance', async (req) => {
    const tenantId = requireTenant(req);
    return ledger.trialBalance(tenantId, {
      ...(req.query.period_key !== undefined && { periodKey: req.query.period_key }),
    });
  });

  app.get('/v1/reconcile', async (req) => {
    const tenantId = requireTenant(req);
    return ledger.reconcile(tenantId);
  });

  app.post<{ Params: { periodKey: string }; Body: { status: string } }>(
    '/v1/periods/:periodKey/status',
    async (req) => {
      const tenantId = requireTenant(req);
      const status = z.enum(['OPEN', 'PRECLOSED', 'CLOSED', 'LOCKED']).parse(req.body.status);
      await ledger.setPeriodStatus(tenantId, req.params.periodKey, status);
      return { period_key: req.params.periodKey, status };
    },
  );

  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(DEMO_HTML);
  });

  return app;
}

/** Convenience: build + listen + drain the outbox to an in-memory sink. */
export async function startServer(port = 3000, host = '127.0.0.1') {
  const ledger = await Ledger.create({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
  });
  const seen: string[] = [];
  const relay = ledger.relay({
    publish: async (e) => {
      seen.push(e.transactionId);
      const sink = (globalThis as { __events?: (event: { transaction_id: string; tenant_id: string }) => void }).__events;
      sink?.({ transaction_id: e.transactionId, tenant_id: e.tenantId });
    },
  });
  relay.start(250);
  const app = await buildApp({ ledger });
  await app.listen({ port, host });
  console.log(`ledger-ts listening on http://${host}:${port} (embedded=${ledger.embedded})`);
  return { app, ledger, relay, seen };
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
const isDirectRun = entry !== undefined && (import.meta.url === entry || import.meta.url.startsWith(entry + '?'));
if (isDirectRun) {
  startServer(Number(process.env.PORT ?? 3000)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
