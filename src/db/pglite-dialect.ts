import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from 'kysely';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from './schema.js';

/**
 * Minimal Kysely dialect for PGlite (embedded WASM Postgres).
 *
 * PGlite is ONE session. Kysely happily interleaves concurrent
 * `db.transaction()` calls across connections — on a single session, a
 * second BEGIN collides with the first and a stray ROLLBACK destroys the
 * other transaction's work. So the lock is held per *transaction*, not per
 * statement: beginTransaction takes it, commit/rollback releases it; plain
 * statements acquire/release immediately and therefore never land inside
 * someone's open transaction. Result: fully serial execution — correct,
 * honest about being embedded, and the same SQL and triggers run
 * unserialized against real Postgres in CI.
 *
 * Numeric safety: PGlite may hand back NUMERIC/int8 as JS numbers; the
 * engine must never see a float, so every read column is cast `::text`
 * in SQL by the engine.
 */
export interface PgliteResultLike {
  rows: unknown[];
  affectedRows?: number;
}

type Queryable = {
  query(sql: string, params?: unknown[], options?: unknown): Promise<PgliteResultLike>;
};

/** Strict FIFO async lock. acquire() either takes ownership instantly or
 *  queues; release() hands off to the next waiter, keeping ownership warm. */
class SessionLock {
  private queue: Array<() => void> = [];
  private held = false;

  constructor(readonly pg: Queryable) {}

  async acquire(): Promise<void> {
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.held = false;
  }

  async withLock<T>(runExclusive: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await runExclusive();
    } finally {
      this.release();
    }
  }
}

class PgliteConnection implements DatabaseConnection {
  /** true between BEGIN and COMMIT/ROLLBACK for this connection */
  inTransaction = false;

  constructor(private readonly lock: SessionLock) {}

  async executeQuery<O>(sql: {
    sql: string;
    parameters: readonly unknown[];
  }): Promise<QueryResult<O>> {
    const run = async (): Promise<QueryResult<O>> => {
      const res = await this.lock.pg.query(sql.sql, sql.parameters as unknown[]);
      return {
        rows: res.rows as O[],
        numAffectedRows: BigInt(res.affectedRows ?? res.rows.length),
      };
    };
    return this.inTransaction ? run() : this.lock.withLock(run);
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('PgliteDialect does not support streaming');
  }
}

class PgliteDriver implements Driver {
  private lock?: SessionLock;

  constructor(private readonly pg: PGlite) {}

  async init(): Promise<void> {
    this.lock = new SessionLock(this.pg);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.lock) throw new Error('PgliteDriver not initialized');
    return new PgliteConnection(this.lock);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as PgliteConnection;
    await this.lock!.acquire();
    conn.inTransaction = true;
    await this.pg.query('BEGIN');
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as PgliteConnection;
    try {
      await this.pg.query('COMMIT');
    } finally {
      conn.inTransaction = false;
      this.lock!.release();
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const conn = connection as PgliteConnection;
    try {
      await this.pg.query('ROLLBACK');
    } finally {
      conn.inTransaction = false;
      this.lock!.release();
    }
  }

  async releaseConnection(): Promise<void> {
    /* single shared session */
  }

  async destroy(): Promise<void> {
    /* PGlite lifecycle owned by the caller */
  }
}

export class PgliteDialect implements Dialect {
  constructor(private readonly pg: PGlite) {}

  createAdapter(): PostgresAdapter {
    return new PostgresAdapter();
  }
  createDriver(): Driver {
    return new PgliteDriver(this.pg);
  }
  createQueryCompiler(): PostgresQueryCompiler {
    return new PostgresQueryCompiler();
  }
  createIntrospector(db: Kysely<unknown>): PostgresIntrospector {
    return new PostgresIntrospector(db);
  }
}
