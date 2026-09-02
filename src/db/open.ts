import { PGlite } from '@electric-sql/pglite';
import { Kysely, PostgresDialect, sql, type ColumnType, type Dialect } from 'kysely';
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { PgliteDialect } from './pglite-dialect.js';
import type { Database } from './schema.js';

export type LedgerDb = Kysely<Database>;

export interface DbOptions {
  /** Real Postgres. When omitted, an embedded PGlite instance is used —
   *  same SQL, same plpgsql triggers, zero setup. */
  connectionString?: string;
  /** Persist the PGlite data dir (omit for in-memory). */
  pgliteDir?: string;
  /** Postgres mode: run in a private random schema (created + dropped with
   *  the instance), so parallel test suites can share one database. */
  isolatedSchema?: boolean;
}

export interface OpenedDb {
  db: LedgerDb;
  /** true when running on embedded PGlite (single connection). */
  embedded: boolean;
  /** Run a multi-statement SQL script (migrations), bypassing the
   *  parameterized-query path which is single-statement only. */
  execScript: (text: string) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * One code path so tests (PGlite), local dev (PGlite file), and production
 * (Postgres via DATABASE_URL) run the exact same queries against the exact
 * same triggers and constraints.
 */
export async function openDb(opts: DbOptions = {}): Promise<OpenedDb> {
  if (opts.connectionString) {
    let poolOptions: string | undefined;
    let schema: string | undefined;
    if (opts.isolatedSchema) {
      schema = `ledger_t_${Math.random().toString(36).slice(2, 10)}_${process.pid}`;
      const admin = new Pool({ connectionString: opts.connectionString, max: 1 });
      await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); // identifier generated above; safe
      await admin.end();
      poolOptions = `-c search_path=${schema},public`;
    }
    const pool = new Pool({
      connectionString: opts.connectionString,
      max: 10,
      ...(poolOptions ? { options: poolOptions } : {}),
    });
    const dialect: Dialect = new PostgresDialect({ pool });
    const db = new Kysely<Database>({ dialect });
    return {
      db,
      embedded: false,
      execScript: async (text) => {
        const client = await pool.connect();
        try {
          await client.query(text); // simple protocol: multi-statement script
        } finally {
          client.release();
        }
      },
      close: async () => {
        await pool.end();
        if (schema) {
          const admin = new Pool({ connectionString: opts.connectionString, max: 1 });
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
          await admin.end();
        }
      },
    };
  }

  const pglite = new PGlite(opts.pgliteDir);
  const db = new Kysely<Database>({ dialect: new PgliteDialect(pglite) });
  return {
    db,
    embedded: true,
    execScript: (text) => pglite.exec(text).then(() => undefined),
    close: async () => {
      await pglite.close();
    },
  };
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

interface SchemaMigrationsTable {
  name: string;
  applied_at: ColumnType<Date, Date | undefined, never>;
}
type FullDatabase = Database & { schema_migrations: SchemaMigrationsTable };

/**
 * Apply all `*.sql` files in MIGRATIONS_DIR in filename order, exactly once,
 * bookkeeping in schema_migrations. Each file is one script.
 */
export async function migrate(
  opened: Pick<OpenedDb, 'db' | 'execScript'>,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  const { execScript } = opened;
  const db = opened.db as unknown as Kysely<FullDatabase>;
  await db.schema
    .createTable('schema_migrations')
    .ifNotExists()
    .addColumn('name', 'text', (col) => col.primaryKey())
    .addColumn('applied_at', 'timestamptz', (col) => col.defaultTo(sql`now()`))
    .execute();

  const applied = new Set(
    (await db.selectFrom('schema_migrations').select('name').execute()).map((r) => r.name),
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const newly: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    await execScript(await readFile(join(dir, file), 'utf8'));
    await db.insertInto('schema_migrations').values({ name: file }).execute();
    newly.push(file);
  }
  return newly;
}
