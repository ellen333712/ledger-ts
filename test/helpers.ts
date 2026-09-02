import { Ledger } from '../src/index.js';

export const TENANT = 't1';
export const USD = 'USD';

export interface TestLedger {
  ledger: Ledger;
  /** seed the doc's §4 example chart: wallet, settlement, revenue, float, suspense */
  coa: Record<'wallet' | 'settlement' | 'revenue' | 'float' | 'suspense', string>;
  dispose: () => Promise<void>;
}

export async function setupLedger(): Promise<TestLedger> {
  // DATABASE_URL set (CI matrix) → real Postgres; otherwise embedded PGlite.
  const ledger = await Ledger.create(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, isolatedSchema: true }
      : {},
  );
  const coa = {
    wallet: 'wallet:user:42',
    settlement: 'settlement:acme',
    revenue: 'revenue:fees',
    float: 'float:bank',
    suspense: 'suspense:unmatched',
    capital: 'equity:contributed-capital',
  } as const;

  await ledger.createAccount({ tenantId: TENANT, accountId: coa.wallet, name: 'User 42 wallet', accountType: 'asset', normalSide: 'DEBIT', currency: USD });
  await ledger.createAccount({ tenantId: TENANT, accountId: coa.settlement, name: 'Acme payable', accountType: 'liability', normalSide: 'CREDIT', currency: USD });
  await ledger.createAccount({ tenantId: TENANT, accountId: coa.revenue, name: 'Fee revenue', accountType: 'revenue', normalSide: 'CREDIT', currency: USD });
  await ledger.createAccount({ tenantId: TENANT, accountId: coa.float, name: 'Bank float', accountType: 'asset', normalSide: 'DEBIT', currency: USD });
  await ledger.createAccount({ tenantId: TENANT, accountId: coa.suspense, name: 'Suspense', accountType: 'expense', normalSide: 'DEBIT', currency: USD });
  await ledger.createAccount({ tenantId: TENANT, accountId: coa.capital, name: 'Contributed capital', accountType: 'equity', normalSide: 'CREDIT', currency: USD });

  // Capital in: the bank float must exist before it can fund anything.
  // Balance-change convention (design doc §4): asset legs positive, the
  // source leg negative — Σ = 0, and only `asset` accounts carry the
  // non-negative guard.
  await ledger.post({
    tenantId: TENANT,
    idempotencyKey: 'seed:capital-in',
    transactionType: 'ADJUST',
    occurredAt: new Date(),
    currency: USD,
    lines: [
      { accountId: coa.capital, amount: '-1000000.00' },
      { accountId: coa.float, amount: '1000000.00' },
    ],
  });

  return { ledger, coa, dispose: () => ledger.close() };
}

let keyCounter = 0;
export function freshKey(prefix = 'key'): string {
  keyCounter += 1;
  return `${prefix}:${Date.now()}:${keyCounter}`;
}

export function transfer(opts: {
  idempotencyKey: string;
  lines: Array<[account: string, amount: string]>;
  occurredAt?: Date;
  type?: 'TRANSFER' | 'FEE' | 'REFUND' | 'REVERSAL' | 'FX' | 'ADJUST';
}) {
  return {
    tenantId: TENANT,
    idempotencyKey: opts.idempotencyKey,
    transactionType: opts.type ?? ('TRANSFER' as const),
    occurredAt: opts.occurredAt ?? new Date(),
    currency: USD,
    lines: opts.lines.map(([accountId, amount]) => ({ accountId, amount })),
  };
}

/** Fund the wallet in one step (float → wallet). */
export async function fund(t: TestLedger, amount: string, keyPrefix = 'fund') {
  return t.ledger.post(
    transfer({ idempotencyKey: freshKey(keyPrefix), lines: [[t.coa.float, `-${amount}`], [t.coa.wallet, amount]] }),
  );
}
