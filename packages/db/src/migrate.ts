import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadEnv } from '@cooks/config';
import { createDb, type Db } from './client.js';

export const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db as unknown as Parameters<typeof migrate>[0], { migrationsFolder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = loadEnv();
  const h = createDb(env.DATABASE_URL, { max: 1 });
  runMigrations(h.db)
    .then(() => h.close())
    .then(() => console.log('migrations applied'))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
