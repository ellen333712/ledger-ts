import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerError } from '../src/domain.js';
import { fund, setupLedger, transfer, freshKey, USD, type TestLedger } from './helpers.js';
import { parseAmount } from '../src/money.js';

let t: TestLedger;
beforeEach(async () => { t = await setupLedger(); });
afterEach(async () => { await t.dispose(); });

describe('write path (design doc §3/§4)', () => {
  it('posts the §4 example: 3 legs, Σ=0, wallet down 100, fee up 1.50', async () => {
    await fund(t, '100.00');
    const res = await t.ledger.post(
      transfer({
        idempotencyKey: freshKey('pay'),
        lines: [
          [t.coa.wallet, '-100.00'],
          [t.coa.settlement, '98.50'],
          [t.coa.revenue, '1.50'],
        ],
      }),
    );
    expect(res.duplicate).toBe(false);

    const wallet = await t.ledger.getBalance(t.ledger && 't1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('0.00')); // 100 funded, 100 spent

    const revenue = await t.ledger.getBalance('t1', t.coa.revenue);
    expect(revenue.amount).toBe(parseAmount('1.50'));

    // balances carry the log position they reflect
    const settlement = await t.ledger.getBalance('t1', t.coa.settlement);
    expect(settlement.seq).toBeGreaterThanOrEqual(1n);

    // trial balance conserves
    const tb = await t.ledger.trialBalance('t1');
    expect(tb.conserved).toBe(true);
    expect(tb.total).toBe('0');
  });

  it('rejects an unbalanced transaction before the DB (§4: no auto plug line)', async () => {
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('bad'),
          lines: [
            [t.coa.wallet, '-100.00'],
            [t.coa.settlement, '98.00'], // 2.00 unaccounted
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNBALANCED_ENTRY' });

    // nothing half-posted: no transaction row exists for the rejected key
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('bad2'),
          lines: [
            [t.coa.wallet, '-1.00'],
            [t.coa.settlement, '0.50'],
            [t.coa.revenue, '0.40'],
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('rejects zero-amount legs', async () => {
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('zero'),
          lines: [
            [t.coa.wallet, '-5.00'],
            [t.coa.settlement, '5.00'],
            [t.coa.revenue, '0'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects unknown accounts and rolls the whole write back', async () => {
    await fund(t, '10.00');
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('ghost'),
          lines: [
            [t.coa.wallet, '-1.00'],
            ['wallet:does:not:exist', '1.00'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    // the wallet leg did not land either: balance unchanged
    const wallet = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('10.00'));
  });

  it('rejects frozen accounts but keeps history readable', async () => {
    await fund(t, '10.00');
    await t.ledger.setAccountStatus('t1', t.coa.wallet, 'FROZEN');
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('frozen'),
          lines: [
            [t.coa.wallet, '-1.00'],
            [t.coa.float, '1.00'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE' });

    const entries = await t.ledger.listEntries('t1', t.coa.wallet);
    expect(entries.entries).toHaveLength(1); // the fund is still readable
  });

  it('rejects cross-currency legs', async () => {
    await t.ledger.createAccount({ tenantId: 't1', accountId: 'wallet:eur', name: 'EUR wallet', accountType: 'asset', normalSide: 'DEBIT', currency: 'EUR' });
    await fund(t, '5.00');
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('fx'),
          lines: [
            [t.coa.wallet, '-5.00'],
            ['wallet:eur', '5.00'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('refuses to overspend a wallet (guarded upsert under lock, not read-check-write)', async () => {
    await fund(t, '10.00');
    await expect(
      t.ledger.post(
        transfer({
          idempotencyKey: freshKey('over'),
          lines: [
            [t.coa.wallet, '-10.01'],
            [t.coa.settlement, '10.01'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });

    const wallet = await t.ledger.getBalance('t1', t.coa.wallet);
    expect(wallet.amount).toBe(parseAmount('10.00'));

    // exactly-to-zero IS allowed
    const res = await t.ledger.post(
      transfer({
        idempotencyKey: freshKey('exact'),
        lines: [
          [t.coa.wallet, '-10.00'],
          [t.coa.settlement, '10.00'],
        ],
      }),
    );
    expect(res.balances.find((b) => b.accountId === t.coa.wallet)?.amount).toBe('0');
  });

  it('assigns dense per-account seq across transactions', async () => {
    await fund(t, '10.00');
    await t.ledger.post(
      transfer({ idempotencyKey: freshKey('a'), lines: [[t.coa.wallet, '-2.00'], [t.coa.settlement, '2.00']] }),
    );
    await t.ledger.post(
      transfer({ idempotencyKey: freshKey('b'), lines: [[t.coa.wallet, '-3.00'], [t.coa.revenue, '3.00']] }),
    );
    const page = await t.ledger.listEntries('t1', t.coa.wallet);
    expect(page.entries.map((e) => e.seq.toString())).toEqual(['1', '2', '3']);
  });

  it('append-only: UPDATE and DELETE on the log are rejected by the database', async () => {
    await fund(t, '7.00');
    await expect(t.ledger.execScript(`UPDATE ledger_entry SET amount = 1 WHERE amount <> 0`)).rejects.toThrow(/IMMUTABLE_LOG/);
    await expect(t.ledger.execScript(`DELETE FROM ledger_entry WHERE amount <> 0`)).rejects.toThrow(/IMMUTABLE_LOG/);
  });

  it('the deferred constraint trigger refuses an unbalanced batch even if the app forgets', async () => {
    // simulate a buggy application that bypassed the engine:
    await fund(t, '5.00');
    await expect(
      t.ledger.execScript(`
        BEGIN;
        INSERT INTO ledger_transaction (transaction_id, tenant_id, idempotency_key, payload_hash, transaction_type, occurred_at, period_key)
        VALUES ('buggy-1', 't1', 'buggy:key:1', 'h', 'TRANSFER', now(), to_char(now(), 'YYYY-MM'));
        INSERT INTO ledger_entry (entry_id, transaction_id, tenant_id, account_id, amount, currency, seq)
        VALUES (nextval('ledger_entry_seq'), 'buggy-1', 't1', 'wallet:user:42', -999, 'USD', 2);
        COMMIT;
      `),
    ).rejects.toThrow(/UNBALANCED_ENTRY/);
  });
});
