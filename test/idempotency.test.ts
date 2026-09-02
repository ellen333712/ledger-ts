import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fund, setupLedger, transfer, freshKey, type TestLedger } from './helpers.js';
import { parseAmount } from '../src/money.js';

let t: TestLedger;
beforeEach(async () => { t = await setupLedger(); });
afterEach(async () => { await t.dispose(); });

/** Design doc §8: "every write replayed twice under random retries →
 *  exactly one entry set". */
describe('idempotency gate', () => {
  it('replays the same key+payload as a no-op returning the stored tx', async () => {
    const req = transfer({
      idempotencyKey: freshKey('idem'),
      lines: [[t.coa.float, '-50.00'], [t.coa.wallet, '50.00']],
    });
    const first = await t.ledger.post(req);
    const second = await t.ledger.post(req);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.transaction.transactionId).toBe(first.transaction.transactionId);

    // exactly one entry set: wallet balance is 50, not 100
    const wallet = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('50.00'));

    const tb = await t.ledger.trialBalance('t1');
    expect(tb.conserved).toBe(true);
  });

  it('treats cosmetic differences (line order, trailing zeros) as the same payload', async () => {
    const key = freshKey('cosmetic');
    const a = transfer({ idempotencyKey: key, lines: [[t.coa.float, '-50'], [t.coa.wallet, '50.00000000']] });
    const b = transfer({ idempotencyKey: key, lines: [[t.coa.wallet, '50.0'], [t.coa.float, '-50.00']] });
    const first = await t.ledger.post(a);
    const second = await t.ledger.post(b);
    expect(second.duplicate).toBe(true);
    expect(second.transaction.transactionId).toBe(first.transaction.transactionId);
  });

  it('hard-rejects a reused key with a DIFFERENT payload (client bug → loud 409)', async () => {
    const key = freshKey('conflict');
    await t.ledger.post(transfer({ idempotencyKey: key, lines: [[t.coa.float, '-50'], [t.coa.wallet, '50']] }));
    await expect(
      t.ledger.post(transfer({ idempotencyKey: key, lines: [[t.coa.float, '-51'], [t.coa.wallet, '51']] })),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // the conflicting write changed nothing
    const wallet = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('50'));
  });

  it('survives a storm of concurrent retries with the same key (exactly one entry set)', async () => {
    const req = transfer({
      idempotencyKey: freshKey('storm'),
      lines: [[t.coa.float, '-25.00'], [t.coa.wallet, '25.00']],
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => t.ledger.post(req)));
    const txIds = new Set(results.map((r) => r.transaction.transactionId));
    expect(txIds.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1); // the write happened once

    const wallet = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('25.00'));
  });

  it('a write that rolled back leaves no key behind — retry with the same key succeeds', async () => {
    const key = freshKey('afterfail');
    // fail fast: unbalanced, rejected before the DB is even touched
    await t.ledger
      .post(transfer({ idempotencyKey: key, lines: [[t.coa.wallet, '-9'], [t.coa.float, '8']] }))
      .catch(() => undefined);
    const retry = await t.ledger.post(
      transfer({ idempotencyKey: key, lines: [[t.coa.float, '-9.00'], [t.coa.wallet, '9.00']] }),
    );
    expect(retry.duplicate).toBe(false);
  });

  it('even a rollback AFTER the idempotency INSERT frees the key (one ACID unit)', async () => {
    const key = freshKey('rolledback');
    // wallet empty: this fails deep inside the transaction, after
    // ledger_transaction was already inserted — then the whole thing rolls back
    await t.ledger
      .post(transfer({ idempotencyKey: key, lines: [[t.coa.wallet, '-500'], [t.coa.float, '500']] }))
      .catch(() => undefined);
    const retry = await t.ledger.post(
      transfer({ idempotencyKey: key, lines: [[t.coa.float, '-7.00'], [t.coa.wallet, '7.00']] }),
    );
    expect(retry.duplicate).toBe(false);
  });
});
