# Architecture

*A companion to the top-level README. The original design notes that
specified this system are mirrored here with permission of their author
(Tian Yang) — this file is the "why" behind every table, lock, and trigger.*

## 1. The one idea everything else follows from

**The log is the truth; everything else is a projection.**

```
LedgerEntry (append-only, signed amounts, dense per-account seq)
    │
    ├── AccountBalance   rollup @ seq          ← rebuildable
    ├── statements       entry walk per account ← rebuildable
    ├── trial balance    GROUP BY sum          ← rebuildable
    ├── P&L / balance sheet from account_type  ← rebuildable
    └── outbox events    same commit          ← replayable
```

A derived table that drifts is an *incident with a fix* (rebuild it). A log
that drifts is an *incident with a lawyer*. So the log gets all the
mechanical protection, and everything downstream of it is disposable.

## 2. Write path — one ACID unit

```
BEGIN
  INSERT ledger_transaction ON CONFLICT (tenant, idempotency_key)
      ─ conflict → hash matches? return stored tx (dedupe)
                  → hash differs? 409 IDEMPOTENCY_CONFLICT (client bug)
  INSERT ... ON CONFLICT ledger_period; SELECT ... FOR UPDATE
      ─ status must be OPEN; closed periods reject writes *here*, inside
        the transaction — not in application code that someone will rewrite
  SELECT ledger_account ... ORDER BY account_id FOR UPDATE   (per account)
      ─ locks acquired in deterministic order → no deadlocks between
        transactions whose account sets overlap
      ─ existence, ACTIVE, currency checked under the lock
  INSERT ledger_entry × N
      ─ per account: seq = COALESCE(MAX(seq),0) + 1..k  (dense, ordered)
      ─ the deferred `balanced` constraint trigger will vet Σ=0 at COMMIT
  UPSERT account_balance (guarded, atomic — see §4)
  INSERT outbox row (JSON payload of the posted event)
COMMIT
  ── deferred triggers run here: UNBALANCED_ENTRY / NON_NEGATIVE_BALANCE
     refuse the commit; nothing is half-posted ever
```

Failure rules (each covered by a test):

| Crash point | Result |
|---|---|
| Before COMMIT | the transaction simply does not exist; the idempotency key is **free**; retry is safe |
| After COMMIT, before publish | the outbox row is still unpublished; the relay retries; consumers dedupe on `transaction_id` |
| Retry, same payload | `200` + `duplicate: true` + the *stored* transaction — zero new rows |
| Retry, different payload | `409` loudly — this is a client bug and must page someone |

## 3. Where each invariant is enforced

| Invariant | Enforced by | Detects drift via |
|---|---|---|
| Conservation (Σ = 0 per tx) | API validation **+ deferred constraint trigger** | trial balance job |
| Append-only | `BEFORE UPDATE/DELETE` trigger raising `IMMUTABLE_LOG` (+ no-grant posture in prod) | audit of DDL/roles |
| Idempotence | `UNIQUE (tenant_id, idempotency_key)` + payload-hash compare | replay-under-retry test |
| Determinism | dense `seq`, immutable `period_key` | nightly rebuild-and-diff |
| Per-account order | account row locks, then `seq` assignment | `UNIQUE (account_id, seq)` gaps |
| Non-negative spendables | guarded UPSERT + deferred trigger per account type | reconciler |
| All-or-nothing events | one transaction + outbox | chaos tests |

The recurring principle: **invariants belong as close to the data as
possible.** A `CHECK` or trigger cannot be "forgotten" by a future code
path; an application check can.

## 4. The spendable-account race, and why the fix is one statement

The anti-pattern: `SELECT balance → if ok → UPDATE balance + x`. Under
concurrency, two withdrawals both pass the check and the account goes
negative.

The fix has two layers:

1. **A single atomic statement** that computes, guards, and writes in one
   go. We hold the account's row lock (`FOR UPDATE`) for the whole
   transaction anyway, so the guarded upsert + in-memory check is race
   free *by lock construction*; the deferred `NON_NEGATIVE_BALANCE`
   trigger is a second, independent net for any code path that forgets
   the lock.
2. The **trigger** (`002_spendable_guard.sql`) joins to `ledger_account`
   and refuses to commit `account_type = 'asset'` with a negative
   balance — the policy lives with the data.

## 5. Time: three clocks, one business answer

```
occurred_at  — when the real world happened → period_key ('2025-08')
posted_at    — when the ledger accepted it  → replay order, seq, audit
ingested_at  — when the pipeline saw it     → debugging only; NEVER a
                                                business number
```

`period_key` is derived once from `occurred_at` at write time and stored —
immutable. Month-end becomes a status flip (`OPEN → CLOSED`) that the
write transaction itself obeys.

## 6. Reversals, not deletions

`POST /v1/transactions/:id/reversal` creates a **new** transaction: negated
legs, `transaction_type = 'REVERSAL'`, `reverses_transaction_id` pointing
at the original, and its own idempotency key (default:
`reversal:{transactionId}`, so a retried reversal dedupes automatically).
Corrections go forward: the original period is untouched, and anyone
reading the log sees both facts — never just the "corrected" world.

## 7. Outbox over "publish after commit"

Publishing from application code after commit has a failure mode that no
amount of retries fixes: the process dies between the COMMIT and the
publish, and the event never exists. Writing the event inside the same
transaction makes the database the consistency boundary; the relay
(`FOR UPDATE SKIP LOCKED`, safe across multiple relay instances) drains it
afterwards → **at-least-once**, and consumers dedupe on
`transaction_id`. Exactly-once delivery is a myth; exactly-once
*processing* is a design.

## 8. Scaling out (only when one Postgres stops being enough)

Not implemented here — implemented *deliberately not needed* here — but
the design is: hash-shard `ledger_account` (and therefore its entry set)
across leaf shards; each shard is still fully ACID; hot aggregate accounts
(fee/settlement sinks) get a write buffer (`acct % 64` pending rows,
batched flush) so leaf balances stay exact and aggregates lag one batch.
Reporting moves to a CDC feed (outbox → ClickHouse/DuckDB) so finance's
month-end scan never competes with the payment path.

## 9. The sidecars that keep us honest

- **reconciler**: `re-SUM(LedgerEntry) → diff vs AccountBalance → page on
  mismatch`. Exposed as `GET /v1/reconcile`; a test proves it *detects*
  deliberate tampering with the projection.
- **replay test**: rebuild the projection from the log; the result must
  match stored balances byte-exact (`replayBalances` in the API).

A ledger without reconciliation is a ledger that is quietly wrong.

## 10. Testing strategy — "tests that pay for themselves"

1. **Unit** the fixed-point money parser (floats cannot enter).
2. **Invariant tests** that attack the system as a liar would: replay
   storms, mid-batch chaos, tampered projections, and a *deliberately
   buggy caller* that bypasses the engine and tries to commit an
   unbalanced batch directly through SQL — the database, not the API,
   must say no.
3. **A 400-operation fuzz** over an account pool asserting conservation
   and non-negativity after the dust settles.
4. The same suite runs against **embedded PGlite** (fast, hermetic) and
   **real Postgres** (CI matrix) — one SQL dialect, two runtimes, zero
   behavior fork.
