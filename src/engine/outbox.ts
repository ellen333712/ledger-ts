import { sql } from 'kysely';
import type { LedgerDb } from '../db/open.js';

/**
 * Outbox relay (design doc §3): rows are written in the same transaction
 * as the log; the relay publishes strictly after commit. At-least-once
 * delivery — consumers dedupe on transaction_id. A crash between commit
 * and publish loses nothing: the row is still unpublished.
 */

export interface OutboxEvent {
  eventId: string;
  tenantId: string;
  transactionId: string;
  eventType: string;
  payload: unknown;
}

export type Subscriber = (event: OutboxEvent) => void | Promise<void>;

export interface RelayOptions {
  batchSize?: number;
  /** in production this is a Kafka producer; a callback keeps the demo honest
   *  about the shape of the boundary. */
  publish?: Subscriber;
}

export class OutboxRelay {
  private readonly db: LedgerDb;
  private readonly batchSize: number;
  private readonly publish?: Subscriber;
  private timer: NodeJS.Timeout | undefined = undefined;

  constructor(db: LedgerDb, opts: RelayOptions = {}) {
    this.db = db;
    this.batchSize = opts.batchSize ?? 100;
    if (opts.publish) this.publish = opts.publish;
  }

  /** Publish everything currently pending; returns the count published.
   *  FOR UPDATE SKIP LOCKED makes concurrent relays safe (multi-instance). */
  async drain(): Promise<OutboxEvent[]> {
    const events = await this.db.transaction().execute(async (trx) => {
      const rows = await sql<{
        event_id: string;
        tenant_id: string;
        transaction_id: string;
        event_type: string;
        payload: string;
      }>`
        SELECT event_id::text, tenant_id, transaction_id, event_type, payload::text
          FROM outbox
         WHERE published_at IS NULL
         ORDER BY event_id
         LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
      `.execute(trx);

      const parsed: OutboxEvent[] = rows.rows.map((r) => ({
        eventId: r.event_id,
        tenantId: r.tenant_id,
        transactionId: r.transaction_id,
        eventType: r.event_type,
        payload: JSON.parse(r.payload),
      }));

      if (parsed.length > 0) {
        await sql`
          UPDATE outbox SET published_at = now()
           WHERE event_id IN (${sql.join(parsed.map((p) => sql`${BigInt(p.eventId)}`), sql`, `)})
        `.execute(trx);
      }
      return parsed;
    });

    // relay (strictly after commit): deliver at-least-once, dedupe downstream
    if (this.publish) {
      for (const event of events) await this.publish(event);
    }
    return events;
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.drain().catch((err) => console.error('[outbox-relay]', err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pendingCount(): Promise<number> {
    const { rows } = await sql<{ n: string }>`
      SELECT COUNT(*)::text AS n FROM outbox WHERE published_at IS NULL
    `.execute(this.db);
    return Number(rows[0]!.n);
  }
}
