/**
 * npm run demo — the whole design doc, executed as a story.
 *
 * Seeds the §4 example (user pays 100.00, platform keeps 1.50), then proves
 * the interesting properties live, not in a test runner: idempotent replay,
 * overspend rejection, forward-only reversal, and a clean reconciler report.
 * Runs on embedded PGlite — no database, no network.
 */
import { Ledger } from '../src/index.js';
import { formatAmount, parseAmount } from '../src/money.js';
import type { TxType } from '../src/types.js';

const TENANT = 'demo';
const USD = 'USD';

const line = (s = '─') => console.log(s.repeat(64));
let n = 0;
const key = (p: string) => `${p}:${(n += 1)}`;

async function main(): Promise<void> {
  const ledger = await Ledger.create(); // in-memory PGlite, auto-migrated
  console.log('ledger-ts demo · embedded Postgres (PGlite) · no setup\n');
  line();

  // 1. chart of accounts -------------------------------------------------
  const coa = [
    { accountId: 'float:bank', name: 'Bank float', accountType: 'asset' as const, normalSide: 'DEBIT' as const },
    { accountId: 'wallet:user:42', name: 'User 42 wallet', accountType: 'asset' as const, normalSide: 'DEBIT' as const },
    { accountId: 'settlement:acme', name: 'Acme payable', accountType: 'liability' as const, normalSide: 'CREDIT' as const },
    { accountId: 'revenue:fees', name: 'Fee revenue', accountType: 'revenue' as const, normalSide: 'CREDIT' as const },
    { accountId: 'equity:capital', name: 'Contributed capital', accountType: 'equity' as const, normalSide: 'CREDIT' as const },
  ];
  for (const a of coa) {
    await ledger.createAccount({ tenantId: TENANT, currency: USD, ...a });
  }
  console.log(`✓ created ${coa.length} accounts (chart of accounts, one tenant="${TENANT}")`);

  // helper to post a balanced transaction
  const post = (idempotencyKey: string, lines: Array<[string, string]>, type: TxType = 'TRANSFER') =>
    ledger.post({
      tenantId: TENANT,
      idempotencyKey,
      transactionType: type,
      occurredAt: new Date(),
      currency: USD,
      lines: lines.map(([accountId, amount]) => ({ accountId, amount })),
    });

  // 2. capital in, then fund the wallet ---------------------------------
  await post(key('cap'), [['equity:capital', '-1000.00'], ['float:bank', '1000.00']], 'ADJUST');
  await post(key('fund'), [['float:bank', '-100.00'], ['wallet:user:42', '100.00']]);
  console.log('✓ funded: capital → bank float → user wallet (100.00)');

  // 3. the §4 example: pay 100.00, 1.50 fee ------------------------------
  // NOTE: the request body is built ONCE — a correct idempotent client
  // resends the *same* body (including occurred_at) on every retry;
  // stamping a fresh timestamp would make it a different request, and the
  // engine would (rightly) treat key reuse as a conflict.
  const payReq = {
    tenantId: TENANT,
    idempotencyKey: 'order-8842-payment',
    transactionType: 'TRANSFER' as const,
    occurredAt: new Date(),
    currency: USD,
    lines: [
      { accountId: 'wallet:user:42', amount: '-100.00' },
      { accountId: 'settlement:acme', amount: '98.50' },
      { accountId: 'revenue:fees', amount: '1.50' },
    ],
  };
  const first = await ledger.post(payReq);
  console.log(`✓ posted §4 example  ${first.transaction.transactionId.slice(0, 8)}  (3 legs, Σ=0)`);

  // 4. idempotent replay → no-op, same tx, duplicate:true ----------------
  const replay = await ledger.post(payReq);
  console.log(`✓ replayed same key → duplicate=${replay.duplicate}  same_tx=${replay.transaction.transactionId === first.transaction.transactionId}`);

  // 5. overspend is rejected, and changes nothing ------------------------
  try {
    await post(key('over'), [['wallet:user:42', '-5000.00'], ['settlement:acme', '5000.00']]);
    console.log('✗ overspend unexpectedly allowed');
  } catch (e) {
    const code = (e as { code?: string }).code;
    console.log(`✓ overspend rejected with ${code} (wallet untouched)`);
  }

  // 6. balances + conservation ------------------------------------------
  line();
  console.log('projection (AccountBalance) after the dust settles:');
  for (const a of coa) {
    const b = await ledger.getBalance(TENANT, a.accountId);
    const sign = b.amount < 0n ? '' : '+';
    console.log(`   ${a.accountId.padEnd(18)} ${sign}${formatAmount(b.amount).padStart(9)}  (${a.accountType})`);
  }
  const tb = await ledger.trialBalance(TENANT);
  const wallet = await ledger.getBalance(TENANT, 'wallet:user:42');
  console.log(`\n✓ trial balance: Σ=${tb.total}  conserved=${tb.conserved}`);
  console.log(`   wallet net change = ${formatAmount(wallet.amount)} (funded 100, spent 100 → 0)`);

  // 7. reversal: corrections go forward, never erase ---------------------
  const rev = await ledger.reverse({ tenantId: TENANT, transactionId: first.transaction.transactionId, reason: 'demo' });
  const walletAfter = await ledger.getBalance(TENANT, 'wallet:user:42');
  console.log(`\n✓ reversed ${first.transaction.transactionId.slice(0, 8)} → ${rev.transaction.transactionId.slice(0, 8)}  wallet=${formatAmount(walletAfter.amount)} (+100 refunded)`);

  // 8. reconciler agrees the projection still equals the log -------------
  const report = await ledger.reconcile(TENANT);
  console.log(`✓ reconciler: ok=${report.ok}  drift=${report.balanceDrift.length}  gaps=${report.seqGaps.length}  globalΣ=${report.globalSum}`);
  line();

  // a tiny self-check so CI fails loudly if the story breaks
  const conserved = parseAmount(tb.total) === 0n && tb.conserved;
  const walletRefunded = walletAfter.amount === parseAmount('100.00');
  console.log(conserved && report.ok && walletRefunded ? '\nDEMO OK — every invariant held.' : '\nDEMO FAILED');

  await ledger.close();
  if (!(conserved && report.ok && walletRefunded)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
