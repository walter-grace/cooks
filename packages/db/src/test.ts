/**
 * Test database on PGlite (in-process Postgres, no Docker). Applies the committed
 * migrations so tests exercise the same DDL as production.
 */
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from './client.js';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from './schema/index.js';
import { migrationsFolder } from './migrate.js';


export async function createTestDb(): Promise<{ db: Db; client: PGlite; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Db;
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
  return { db, client, close: () => client.close() };
}
