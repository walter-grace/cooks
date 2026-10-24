import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

type Schema = typeof schema;
type Rel = ExtractTablesWithRelations<Schema>;

/** Driver-agnostic handle: postgres-js in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT, Schema, Rel>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, Rel>;
export type DbOrTx = Db | Tx;

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDb(url: string, opts: { max?: number; connectTimeout?: number; idleTimeout?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {}, ...(opts.connectTimeout ? { connect_timeout: opts.connectTimeout } : {}), ...(opts.idleTimeout ? { idle_timeout: opts.idleTimeout } : {}) });
  const db = drizzle(sql, { schema, casing: 'snake_case' }) as unknown as Db;
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Run `fn` in a transaction, reusing the current one when already inside. */
export async function withTx<T>(db: DbOrTx, fn: (tx: DbOrTx) => Promise<T>): Promise<T> {
  return (db as Db).transaction(async (tx) => fn(tx as unknown as DbOrTx));
}
