# ledger-ts

> A double-entry ledger you can actually trust. Append-only log, invariants enforced **in the database** (not application folklore), idempotent writes, transactional outbox.

Money is a hard problem, and most "ledgers" get it wrong in ways that only show up under a crash, a retry, or a concurrent withdrawal. `ledger-ts` implements the design that survives all three: **the log is the truth, everything else is a rebuildable projection.**

This is a faithful, working implementation of a production ledger design — the kind of system behind payments, billing, and settlement.

[![CI](https://img.shields.io/badge/tests-40%20passing-brightgreen)](#testing)
![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

---

## Why this exists

A junior ledger stores a `balance` column and does `UPDATE balance = balance + x`. It looks right in the happy path and loses money the moment two requests race, a client retries a timed-out POST, or a process dies mid-write.

This project refuses all of those failure modes by construction:

| Threat | How `ledger-ts` defeats it |
|---|---|
| Unbalanced entry (`Σ ≠ 0`) | **Deferred constraint trigger** in Postgres refuses to commit — even if the app forgets |
| Client retries a timed-out write | **Idempotency gate**: same key+payload → returns stored tx (no-op); same key, different payload → hard `409` |
| Process dies mid-write | **One ACID transaction** writes tx + entries + balance + outbox together — no partial state |
| Two withdrawals race | **Row locks acquired in sorted account order** (deadlock-free) + guarded atomic upsert, never read-check-write |
| Balance projection drifts | **Reconciler sidecar** re-sums the log and diffs against the projection; replays must be byte-exact |
| Lost events on crash | **Transactional outbox** written in the same commit, relayed after — at-least-once, dedupe on `transaction_id` |
| Editing history | **Append-only log** — `UPDATE`/`DELETE` on entries are rejected by a DB trigger |

## Design at a glance

```
 UPSTREAM  payments · billing · bank statements
              │
              ▼
 LEDGER API   [authz+tenant] → [idempotency gate] → [validate Σ=0] → [policy: status, period]
              │
              │  ★ ONE ACID TRANSACTION ★
              ▼
 LEDGER CORE  LedgerAccount ─▶ LedgerTransaction ─▶ LedgerEntry  (the append-only log)
                 │                    │                   │
                 │                    │                   ├─▶ AccountBalance   (projection, seq-keyed)
                 │                    │                   └─▶ outbox ─▶ relay ─▶ Kafka/CDC
                 │                    ▼
              periods (OPEN/CLOSED/LOCKED) · idempotency_key UNIQUE · reverses_transaction_id
              │
              ▼
 DERIVED      statements · trial balance · P&L / balance sheet · snapshots — all rebuildable from LedgerEntry
 SIDEcars     reconciler (re-SUM vs balance, page on drift) · replay test (rebuild day, must match)
```

### The four entities

| Entity | Grain | Role |
|---|---|---|
| `LedgerAccount` | one account | chart-of-accounts node; `normal_side` decides what a sign means |
| `LedgerTransaction` | one business event | atomic *balanced* group; carries the idempotency key |
| `LedgerEntry` | one signed leg | **the log** — dense per-account `seq`, never UPDATE, never DELETE |
| `AccountBalance` | one account | derived rollup keyed to a log position (`seq`) |

The conservation invariant lives in the database, not in an `if`:

```sql
CREATE CONSTRAINT TRIGGER balanced
  AFTER INSERT ON ledger_entry
  DEFERRABLE INITIALLY DEFERRED   -- ← the load-bearing word
  FOR EACH ROW EXECUTE FUNCTION assert_balanced();
```

`DEFERRABLE INITIALLY DEFERRED` means you insert lines one at a time and the DB still refuses to commit a `LedgerTransaction` that doesn't sum to zero — **even if the application forgets to check.** There is a test that proves this by deliberately bypassing the engine.

## Quick start

```bash
git clone https://github.com/<you>/ledger-ts && cd ledger-ts
npm install
npm test                 # 40 tests against an embedded Postgres (PGlite) — no server needed
npm run dev              # REST API + demo console on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 and click **① Seed accounts + sample flow** to see the design-doc example post live: a user paying 100.00 with a 1.50 platform fee, split across three accounts that sum to exactly zero — then hit **Reverse** and watch the projection stay conserved.

> **Zero setup.** By default the app runs on [PGlite](https://pglite.dev) — real Postgres compiled to WASM — so the *same SQL, the same plpgsql triggers, and the same constraints* run with no database to install. Point `DATABASE_URL` at a real Postgres for production.

## Using it as a library

```ts
import { Ledger } from 'ledger-ts';

const ledger = await Ledger.create({ connectionString: process.env.DATABASE_URL });

await ledger.createAccount({ tenantId: 'acme', accountId: 'wallet:user:42',
  name: 'User wallet', accountType: 'asset', normalSide: 'DEBIT', currency: 'USD' });
await ledger.createAccount({ tenantId: 'acme', accountId: 'revenue:fees',
  name: 'Fee revenue', accountType: 'revenue', normalSide: 'CREDIT', currency: 'USD' });
// ... a funding source, then:

const result = await ledger.post({
  tenantId: 'acme',
  idempotencyKey: 'order-8842-payment',   // replay this request safely, forever
  transactionType: 'TRANSFER',
  occurredAt: new Date('2025-08-14T16:03:00Z'),
  currency: 'USD',
  lines: [
    { accountId: 'wallet:user:42', amount: '-100.00' },
    { accountId: 'settlement:acme', amount:  '98.50' },
    { accountId: 'revenue:fees',    amount:   '1.50' },
  ],
});

result.balances; // per-account balances + the log position each reflects
result.duplicate; // true if this exact request was already applied

// A reversal is a NEW, explicitly named transaction — never an erase:
await ledger.reverse({ tenantId: 'acme', transactionId: result.transaction.transactionId });

// Sidecars tell you the truth stayed true:
await ledger.reconcile('acme');           // { ok: true } unless projection drifted
await ledger.trialBalance('acme');        // { conserved: true, total: '0' }
```

**Amounts are decimal strings, never floats.** `parseAmount` rejects `100.0` as a JSON number and anything with more than 8 fraction digits; internally everything is a scaled `bigint`. `Float for money` is literally on the anti-patterns list.

## HTTP API

Money on the wire is a **decimal string**; JSON numbers are rejected with `422`. Tenant scope is a header (`X-Tenant-Id`). The idempotency key is required on every write.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/accounts` | create an account in the chart |
| `GET` | `/v1/accounts` · `/v1/accounts/:id` | list / read balance (a never-written account reads zero) |
| `POST` | `/v1/accounts/:id/status` | `ACTIVE → FROZEN → CLOSED` (status replaces DELETE) |
| `GET` | `/v1/accounts/:id/entries` | the statement; cursor-paginated over dense `seq` |
| `POST` | `/v1/transactions` · `/v1/transfers` | post a balanced transaction (idempotent) |
| `GET` | `/v1/transactions/:id` | one transaction with all its legs |
| `POST` | `/v1/transactions/:id/reversal` | reverse it, forward-only |
| `POST` | `/v1/periods/:key/status` | `OPEN / PRECLOSED / CLOSED / LOCKED` |
| `GET` | `/v1/trial-balance` | per-account net + `conserved` boolean |
| `GET` | `/v1/reconcile` | drift, seq-gaps, unbalanced txs, global sum |

```bash
# the §4 example, straight from the design doc
curl -s localhost:3000/v1/transfers \
  -H 'content-type: application/json' -H 'x-tenant-id: acme' \
  -d '{
    "idempotency_key": "order-8842-payment",
    "transaction_type": "TRANSFER",
    "currency": "USD",
    "occurred_at": "2025-08-14T16:03:00Z",
    "lines": [
      { "account_id": "wallet:user:42", "amount": "-100.00" },
      { "account_id": "settlement:acme", "amount": "98.50"  },
      { "account_id": "revenue:fees",    "amount": "1.50"   }
    ]
  }'
```

Re-run that exact command: the second call returns **`200` with `duplicate: true`** and the same `transaction_id` — no second set of entries, no double-charge.

## Testing

```bash
npm test
```

40 tests over 7 files, mapped to the invariants they protect:

- **`money`** — fixed-point parsing, float/scientific-notation rejection, exact round-trip.
- **`write path`** — the §4 example, and every rejection: unbalanced, zero-amount, unknown account, frozen account, cross-currency, overspend, dense-seq assignment, append-only (`UPDATE`/`DELETE` throw), and **the deferred trigger refusing an unbalanced batch even when the app bypasses the engine**.
- **`idempotency`** — replay is a no-op; cosmetic line reordering is the *same* payload; reused key + different payload is a loud `409`; **a 12-way concurrent retry storm produces exactly one entry set**.
- **`concurrency fuzz`** — 400 concurrent mixed transfers over a small account pool with a seeded PRNG → asserts money is conserved, no spendable account goes negative, and the reconciler reports zero drift; plus a chaos test (failure mid-batch leaves no partial transaction).
- **`periods & reversals`** — `occurred_at → period_key`; writes into `CLOSED`/`LOCKED` periods rejected; corrections go forward; reversals negate, link, dedupe, and refuse to reverse a reversal.
- **`sidecars`** — outbox written in-transaction and published only after commit; idempotent replay never double-publishes; rejected writes leave nothing in the outbox; replay-of-log equals stored projection; a tampered projection is caught as drift.
- **`api`** — the full request lifecycle through the real HTTP surface, including `X-Tenant-Id` enforcement and JSON-number rejection.

Runs on embedded PGlite (no database to install) or real Postgres via `DATABASE_URL`. CI does both.

## Architecture decisions

- **TypeScript, ESM, `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`** — strictness turned up, because the domain is correctness-critical.
- **Kysely + raw SQL for the hot path** — the write path is deliberately written as explicit SQL so the same statements (with `::text` casts, `FOR UPDATE`, `ON CONFLICT`, the deferred trigger) are auditable and identical on PGlite and Postgres.
- **One dialect, two runtimes** — a small `PgliteDialect` lets tests run real Postgres semantics in-process; production uses `pg`. No behavior fork between them.
- **PGlite is single-session**, so the dialect holds a per-*transaction* lock (not per-statement): concurrent Kysely transactions serialize instead of interleaving two `BEGIN`s on one connection. Correctness first; scale out by sharding accounts (see [docs/architecture.md](docs/architecture.md)).
- **Multi-tenancy by scoped key** — `(tenant_id, idempotency_key)` is unique; every query is tenant-scoped; no cross-tenant leaks in the tests.

## Anti-patterns this code refuses to commit

| Anti-pattern | Here |
|---|---|
| `UPDATE` on a `LedgerEntry` | rejected by DB trigger |
| `AccountBalance` as the authoritative column | reconciler treats it as a rebuildable projection |
| Float/`DOUBLE` for money | `NUMERIC(28,8)` + scaled `bigint`, decimal strings on the wire |
| read balance → check → write balance | guarded atomic upsert under a row lock |
| Publishing events from app code after commit | transactional outbox, relayed after commit |
| Auto-balancing plug lines | unbalanced → rejected |
| Retries without an idempotency key | required on every write; mismatch → `409` |

## Roadmap

- [ ] FX transactions with an explicit rate + realized-gain leg (multi-currency, one event)
- [ ] Materialized `AccountBalance` sharding + hot-account write buffer (design doc §6)
- [ ] CDC → ClickHouse/DuckDB read replica for reporting
- [ ] A real consumer demo (Kafka / NATS) behind the outbox relay
- [ ] Statement pagination with running balance at an as-of date

## License

MIT — © 2026 Tian Yang.

*The design is based on patterns proven in payment ledgers at scale. Review any accrual logic with a domain accountant before shipping it to money.*
