import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupLedger, transfer, freshKey, type TestLedger } from './helpers.js';
import { parseAmount, formatAmount } from '../src/money.js';

let t: TestLedger;
beforeEach(async () => { t = await setupLedger(); });
afterEach(async () => { await t.dispose(); });

/** Seeded deterministic PRNG so a failure is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Design doc §8: "random transfers over a small account pool → assert
 *  money is conserved and no spendable account goes negative." */
describe('concurrency fuzz', () => {
  it('400 concurrent mixed transfers: conserved, non-negative, one ACID unit each', async () => {
    const rand = mulberry32(42);
    const wallets = ['w:1', 'w:2', 'w:3', 'w:4'].map((id) => `wallet:${id}`);
    const fee = 'revenue:fees';
    const float = t.coa.float;

    for (const w of wallets) {
      await t.ledger.createAccount({ tenantId: 't1', accountId: w, name: w, accountType: 'asset', normalSide: 'DEBIT', currency: 'USD' });
    }
    // seed each wallet with 100.00 from float
    for (const w of wallets) {
      await t.ledger.post(
        transfer({ idempotencyKey: `fuzzseed:${w}`, lines: [[float, '-100.00'], [w, '100.00']] }),
      );
    }

    const ops: Array<Promise<unknown>> = [];
    for (let i = 0; i < 400; i++) {
      const from = wallets[Math.floor(rand() * wallets.length)]!;
      let to = wallets[Math.floor(rand() * wallets.length)]!;
      if (to === from) to = wallets.find((w) => w !== from)!;
      const cents = Math.floor(rand() * 2000) + 1; // 1 .. 2000 cents
      const feeCents = Math.floor(cents / 10);
      // integer scaled arithmetic keeps Σ exactly zero: from = to + fee
      const fromScaled = BigInt(cents) * 10n ** 6n; // 1 cent = 10^6 units
      const feeScaled = BigInt(feeCents) * 10n ** 6n;
      const toStr = formatAmount(fromScaled - feeScaled);
      const fromStr = `-${formatAmount(fromScaled)}`;
      const lines: Array<[string, string]> =
        feeScaled === 0n
          ? [[from, fromStr], [to, formatAmount(fromScaled)]]
          : [[from, fromStr], [to, toStr], [fee, formatAmount(feeScaled)]];
      ops.push(
        t.ledger
          .post(
            transfer({
              idempotencyKey: `fuzz:${i}`,
              lines,
            }),
          )
          .catch((err: unknown) => {
            const code = (err as { code?: string }).code;
            if (code === 'INSUFFICIENT_FUNDS') return 'rejected';
            throw err;
          }),
      );
    }

    const results = await Promise.all(ops);
    const accepted = results.filter((r) => r !== 'rejected').length;
    expect(accepted).toBeGreaterThan(100); // most transfers succeeded

    // conservation: Σ across every account is exactly 0
    const tb = await t.ledger.trialBalance('t1');
    expect(tb.conserved).toBe(true);

    // no spendable account negative, and the stored projection agrees with the log
    for (const acct of [...wallets, float]) {
      const b = await t.ledger.getBalance('t1', acct);
      expect(b.amount >= 0n, `${acct} went negative`).toBe(true);
    }

    // reconciler agrees: projection == log replay
    const report = await t.ledger.reconcile('t1');
    expect(report.ok).toBe(true);
    expect(report.balanceDrift).toEqual([]);
    expect(report.seqGaps).toEqual([]);

    // the money that left wallets landed in fees: fee revenue > 0
    const feeBal = await t.ledger.getBalance('t1', fee);
    expect(feeBal.amount > 0n).toBe(true);
  });

  it('chaos: a failing write mid-batch leaves no partial transaction', async () => {
    // x is funded 100 and tries to send 150: both legs land in the log, the
    // spendable guard then fails — the whole ACID unit must vanish
    await t.ledger.createAccount({ tenantId: 't1', accountId: 'wallet:x', name: 'x', accountType: 'asset', normalSide: 'DEBIT', currency: 'USD' });
    await t.ledger.createAccount({ tenantId: 't1', accountId: 'wallet:y', name: 'y', accountType: 'asset', normalSide: 'DEBIT', currency: 'USD' });
    await t.ledger.post(transfer({ idempotencyKey: 'chaos:seed', lines: [[t.coa.float, '-100'], ['wallet:x', '100']] }));

    await expect(
      t.ledger.post(transfer({ idempotencyKey: 'chaos:1', lines: [['wallet:x', '-150'], ['wallet:y', '150']] })),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    // wallet:x still holds the full 100 — its leg did not half-post
    const x = await t.ledger.getBalance('t1', 'wallet:x');
    expect(x.amount).toBe(parseAmount('100'));
    // and no transaction row for the chaos key exists
    const rows = await t.ledger.db
      .selectFrom('ledger_transaction')
      .select('transaction_id')
      .where('idempotency_key', '=', 'chaos:1')
      .execute();
    expect(rows).toHaveLength(0);
  });
});
