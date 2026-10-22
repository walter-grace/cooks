import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadEnv } from '@cooks/config';
import { createDb, type Db } from './client.js';

export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const MIGRATION_LOCK = 727_272_001;

/**
 * Apply committed migrations. When `lockUrl` is given, a session-level advisory lock held on a
 * dedicated connection serializes concurrent starters (api + worker booting together).
 */
export async function runMigrations(db: Db, lockUrl?: string): Promise<void> {
  if (!lockUrl) {
    await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
    return;
  }
  const lock = postgres(lockUrl, { max: 1, onnotice: () => {} });
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
    } finally {
      await lock`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await lock.end({ timeout: 5 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = loadEnv();
  const h = createDb(env.DATABASE_URL, { max: 1 });
  runMigrations(h.db, env.DATABASE_URL)
    .then(() => h.close())
    .then(() => console.log('migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
