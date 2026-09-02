import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/server.js';
import { setupLedger, type TestLedger } from './helpers.js';

let t: TestLedger;
let app: FastifyInstance;

beforeEach(async () => {
  t = await setupLedger();
  app = await buildApp({ ledger: t.ledger });
});
afterEach(async () => {
  await app.close();
  await t.dispose();
});

const H = { 'content-type': 'application/json', 'x-tenant-id': 't1' };

async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method: method as 'GET', url, headers: H, ...(body ? { payload: body } : {}) });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe('HTTP API', () => {
  it('X-Tenant-Id is mandatory', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/accounts' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('full flow: create account → post → duplicate 200 → conflict 409 → overspend 422', async () => {
    // §4 example straight from the design doc
    const body = {
      idempotency_key: 'http:pay:0001',
      transaction_type: 'TRANSFER',
      currency: 'USD',
      occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'wallet:user:42', amount: '-100.00' },
        { account_id: 'settlement:acme', amount: '98.50' },
        { account_id: 'revenue:fees', amount: '1.50' },
      ],
    };
    // wallet is empty → insufficient; fund first
    const unaffordable = await call('POST', '/v1/transfers', body);
    expect(unaffordable.status).toBe(422);
    expect(unaffordable.json.error).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    const funded = await call('POST', '/v1/transfers', {
      idempotency_key: 'http:fund:00001',
      transaction_type: 'TRANSFER',
      currency: 'USD',
      occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'float:bank', amount: '-100.00' },
        { account_id: 'wallet:user:42', amount: '100.00' },
      ],
    });
    expect(funded.status).toBe(201);
    expect(funded.json.duplicate).toBe(false);

    const paid = await call('POST', '/v1/transactions', body);
    expect(paid.status).toBe(201);
    expect((paid.json.balances as Array<{ accountId: string; amount: string }>).find((b) => b.accountId === 'revenue:fees')!.amount).toBe('1.5');

    // replay → 200, same transaction_id
    const replay = await call('POST', '/v1/transactions', body);
    expect(replay.status).toBe(200);
    expect(replay.json.transaction_id).toBe(paid.json.transaction_id);

    // same key, different payload → 409, loud
    const conflictBody = { ...body, lines: [
      { account_id: 'wallet:user:42', amount: '-99.00' },
      { account_id: 'settlement:acme', amount: '97.50' },
      { account_id: 'revenue:fees', amount: '1.50' },
    ] };
    const conflict = await call('POST', '/v1/transactions', conflictBody);
    expect(conflict.status).toBe(409);
    expect(conflict.json.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects JSON numbers for money with 400 (amount must be a string)', async () => {
    const res = await call('POST', '/v1/transactions', {
      idempotency_key: 'http:num:00001',
      transaction_type: 'TRANSFER',
      currency: 'USD',
      occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'wallet:user:42', amount: -1 },
        { account_id: 'settlement:acme', amount: 1 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects an unbalanced batch with 422 UNBALANCED_ENTRY', async () => {
    const res = await call('POST', '/v1/transactions', {
      idempotency_key: 'http:bad:000001',
      transaction_type: 'TRANSFER',
      currency: 'USD',
      occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'wallet:user:42', amount: '-10' },
        { account_id: 'settlement:acme', amount: '9' },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.json.error).toMatchObject({ code: 'UNBALANCED_ENTRY' });
  });

  it('reads: account balance, entries paging, transaction detail, trial balance, reconcile', async () => {
    await call('POST', '/v1/transfers', {
      idempotency_key: 'http:seed:00001',
      transaction_type: 'TRANSFER', currency: 'USD', occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'float:bank', amount: '-30' },
        { account_id: 'wallet:user:42', amount: '30' },
      ],
    });
    const acct = await call('GET', '/v1/accounts/wallet%3Auser%3A42');
    expect(acct.json).toMatchObject({ account_id: 'wallet:user:42', balance: { amount: '30' } });

    const entries = await call('GET', '/v1/accounts/wallet%3Auser%3A42/entries');
    const list = entries.json.entries as Array<{ seq: string; amount: string }>;
    expect(list[0]).toMatchObject({ seq: expect.any(String), amount: '30' });

    const tb = await call('GET', '/v1/trial-balance');
    expect(tb.json).toMatchObject({ conserved: true, total: '0' });

    const rec = await call('GET', '/v1/reconcile');
    expect(rec.json).toMatchObject({ ok: true });
  });

  it('reversal endpoint negates the transaction', async () => {
    const funded = await call('POST', '/v1/transfers', {
      idempotency_key: 'http:rv:fund:01',
      transaction_type: 'TRANSFER', currency: 'USD', occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'float:bank', amount: '-10' },
        { account_id: 'wallet:user:42', amount: '10' },
      ],
    });
    void funded;
    const paid = await call('POST', '/v1/transfers', {
      idempotency_key: 'http:rv:pay:0001',
      transaction_type: 'TRANSFER', currency: 'USD', occurred_at: new Date().toISOString(),
      lines: [
        { account_id: 'wallet:user:42', amount: '-10' },
        { account_id: 'settlement:acme', amount: '10' },
      ],
    });
    const txId = paid.json.transaction_id as string;
    const rev = await call('POST', `/v1/transactions/${txId}/reversal`, { reason: 'http demo' });
    expect(rev.status).toBe(201);
    expect(rev.json).toMatchObject({ transaction_type: 'REVERSAL', reverses_transaction_id: txId });
    const acct = await call('GET', '/v1/accounts/wallet%3Auser%3A42');
    expect(acct.json).toMatchObject({ balance: { amount: '10' } });
  });
});
