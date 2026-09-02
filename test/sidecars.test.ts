import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fund, setupLedger, transfer, freshKey, type TestLedger } from './helpers.js';
import { parseAmount, formatAmount } from '../src/money.js';

let t: TestLedger;
beforeEach(async () => { t = await setupLedger(); });
afterEach(async () => { await t.dispose(); });

describe('outbox relay (design doc §3 failure rules)', () => {
  it('events are written in the same transaction and only published after commit', async () => {
    const published: string[] = [];
    const relay = t.ledger.relay({ publish: (e) => { published.push(e.transactionId); } });
    await relay.drain(); // flush the seed capital-in event
    published.length = 0;

    const res = await fund(t, '42.00');
    const txId = res.transaction.transactionId;

    // committed but NOT yet published: the row is safe in the outbox
    expect(await relay.pendingCount()).toBe(1);
    expect(published).toEqual([]);

    const drained = await relay.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]!.transactionId).toBe(txId);
    expect(published).toEqual([txId]);
    expect(await relay.pendingCount()).toBe(0);

    // payload carries the lines — consumers never have to touch the log
    const payload = drained[0]!.payload as { lines: Array<{ account_id: string; amount: string }>; tenant_id: string };
    expect(payload.tenant_id).toBe('t1');
    expect(payload.lines).toHaveLength(2);
  });

  it('idempotent replay does not double-publish', async () => {
    const published: string[] = [];
    const relay = t.ledger.relay({ publish: (e) => { published.push(e.transactionId); } });
    await relay.drain(); // baseline
    published.length = 0;
    const req = transfer({ idempotencyKey: freshKey('ob'), lines: [[t.coa.float, '-5'], [t.coa.wallet, '5']] });
    await t.ledger.post(req);
    await t.ledger.post(req); // duplicate → no outbox row
    expect(await relay.pendingCount()).toBe(1);
    await relay.drain();
    expect(published).toHaveLength(1);
  });

  it('a rejected write leaves NOTHING in the outbox (same ACID unit)', async () => {
    const relay = t.ledger.relay();
    await fund(t, '10.00');
    const before = await t.ledger.db.selectFrom('outbox').selectAll().execute();
    await t.ledger
      .post(transfer({ idempotencyKey: freshKey('no'), lines: [[t.coa.wallet, '-10.01'], [t.coa.float, '10.01']] }))
      .catch(() => undefined);
    const after = await t.ledger.db.selectFrom('outbox').selectAll().execute();
    expect(after.length).toBe(before.length);
  });
});

describe('reconciler & replay (design doc §8 sidecars)', () => {
  it('replay of the log equals the stored projection, exactly', async () => {
    await fund(t, '30.00');
    await t.ledger.post(
      transfer({
        idempotencyKey: freshKey('recon1'),
        lines: [
          [t.coa.wallet, '-12.34567890'],
          [t.coa.settlement, '12.00000000'],
          [t.coa.revenue, '0.34567890'],
        ],
      }),
    );
    const report = await t.ledger.reconcile('t1');
    expect(report.ok).toBe(true);
    expect(report.globalSum).toBe('0');

    const replayed = await t.ledger.replayBalances('t1');
    for (const r of replayed) {
      const stored = await t.ledger.getBalance('t1', r.accountId);
      expect(r.seq).toBe(stored.seq.toString());
      expect(formatAmount(stored.amount)).toBe(formatAmount(parseAmount(r.amount)));
    }
  });

  it('tampering with the projection (not the log) is detected as drift', async () => {
    await fund(t, '50.00');
    // account_balance is a projection → UPDATE is legal there; simulate drift
    await t.ledger.db
      .updateTable('account_balance')
      .set({ amount: '1.00000000' })
      .where('account_id', '=', t.coa.wallet)
      .execute();
    const report = await t.ledger.reconcile('t1');
    expect(report.ok).toBe(false);
    expect(report.balanceDrift.map((d) => d.accountId)).toContain(t.coa.wallet);
    expect(report.balanceDrift[0]!.logSum).toBe('50');
    expect(report.balanceDrift[0]!.stored).toBe('1');
  });
});
