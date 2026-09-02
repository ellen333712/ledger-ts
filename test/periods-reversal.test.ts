import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fund, setupLedger, transfer, freshKey, type TestLedger } from './helpers.js';
import { periodKeyFor } from '../src/domain.js';
import { parseAmount } from '../src/money.js';

let t: TestLedger;
beforeEach(async () => { t = await setupLedger(); });
afterEach(async () => { await t.dispose(); });

describe('periods (design doc §5)', () => {
  it('derives period_key from occurred_at, in UTC', async () => {
    const occurred = new Date('2025-03-31T23:30:00Z'); // still March in UTC
    const res = await t.ledger.post(
      transfer({ idempotencyKey: freshKey('p1'), occurredAt: occurred, lines: [[t.coa.float, '-10'], [t.coa.wallet, '10']] }),
    );
    expect(res.transaction.periodKey).toBe('2025-03');
    expect(periodKeyFor(new Date('2025-12-01T00:00:01Z'))).toBe('2025-12');
  });

  it('rejects writes into a CLOSED period; the same event can be booked forward', async () => {
    const lastMonth = new Date(Date.UTC(2025, 6, 15)); // July 2025
    const key = periodKeyFor(lastMonth);
    await t.ledger.post(
      transfer({ idempotencyKey: 'july:ok', occurredAt: lastMonth, lines: [[t.coa.float, '-10'], [t.coa.wallet, '10']] }),
    );
    await t.ledger.setPeriodStatus('t1', key, 'CLOSED');

    await expect(
      t.ledger.post(
        transfer({ idempotencyKey: 'july:late', occurredAt: new Date(Date.UTC(2025, 6, 20)), lines: [[t.coa.float, '-5'], [t.coa.wallet, '5']] }),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_OPEN' });

    // corrections go forward: today is an OPEN (auto-created) period
    const fwd = await t.ledger.post(
      transfer({ idempotencyKey: 'forward:ok', lines: [[t.coa.float, '-5'], [t.coa.wallet, '5']] }),
    );
    expect(fwd.duplicate).toBe(false);
  });

  it('LOCKED behaves the same and the period list shows the ladder', async () => {
    const k = '2030-01';
    await t.ledger.openPeriod('t1', k);
    await t.ledger.setPeriodStatus('t1', k, 'LOCKED');
    const list = await t.ledger.listPeriods('t1');
    expect(list.find((p) => p.period_key === k)?.status).toBe('LOCKED');
    await expect(
      t.ledger.post(
        transfer({ idempotencyKey: 'locked:nope', occurredAt: new Date(Date.UTC(2030, 0, 5)), lines: [[t.coa.float, '-1'], [t.coa.wallet, '1']] }),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_NOT_OPEN' });
  });
});

describe('reversals (POST /transactions/{id}/reversal)', () => {
  it('posts a new negated transaction linked to the original', async () => {
    await fund(t, '80.00');
    const original = await t.ledger.post(
      transfer({
        idempotencyKey: freshKey('orig'),
        lines: [
          [t.coa.wallet, '-80.00'],
          [t.coa.settlement, '78.00'],
          [t.coa.revenue, '2.00'],
        ],
      }),
    );
    const before = await t.ledger.getBalance('t1', t.coa.wallet);

    const rev = await t.ledger.reverse({ tenantId: 't1', transactionId: original.transaction.transactionId, reason: 'mischarge' });
    expect(rev.transaction.transactionType).toBe('REVERSAL');
    expect(rev.transaction.reversesTransactionId).toBe(original.transaction.transactionId);
    expect(rev.transaction.description).toContain('mischarge');

    // wallet is whole again
    const after = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(after.amount).toBe(parseAmount('80.00'));

    // the original still exists untouched; conservation holds; recon is clean
    const origAgain = await t.ledger.getTransaction('t1', original.transaction.transactionId);
    expect(origAgain.entries).toHaveLength(3);
    expect((await t.ledger.trialBalance('t1')).conserved).toBe(true);
    expect((await t.ledger.reconcile('t1')).ok).toBe(true);
  });

  it('reversing twice with the same derived key dedupes; a second reversal with a new key is rejected', async () => {
    await fund(t, '20.00');
    const original = await t.ledger.post(
      transfer({ idempotencyKey: freshKey('r2'), lines: [[t.coa.wallet, '-20'], [t.coa.settlement, '20']] }),
    );
    const id = original.transaction.transactionId;

    const first = await t.ledger.reverse({ tenantId: 't1', transactionId: id });
    const replay = await t.ledger.reverse({ tenantId: 't1', transactionId: id });
    expect(replay.duplicate).toBe(true);
    expect(replay.transaction.transactionId).toBe(first.transaction.transactionId);

    await expect(
      t.ledger.reverse({ tenantId: 't1', transactionId: id, idempotencyKey: freshKey('rev2') }),
    ).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
  });

  it('refuses to reverse a reversal', async () => {
    await fund(t, '15.00');
    const original = await t.ledger.post(
      transfer({ idempotencyKey: freshKey('r3'), lines: [[t.coa.wallet, '-15'], [t.coa.settlement, '15']] }),
    );
    const rev = await t.ledger.reverse({ tenantId: 't1', transactionId: original.transaction.transactionId });
    await expect(
      t.ledger.reverse({ tenantId: 't1', transactionId: rev.transaction.transactionId, idempotencyKey: freshKey('rev-of-rev') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
