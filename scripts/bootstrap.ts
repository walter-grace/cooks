/**
 * Create a workspace, an admin user and the first API key.
 *   pnpm bootstrap --email you@example.com --workspace "My Team" [--name "Your Name"] [--slug my-team]
 * Idempotent on (workspace slug, user email): re-running issues a new key for the existing workspace.
 */
import { and, eq } from 'drizzle-orm';
import { loadEnv } from '@cooks/config';
import { createApiKey, hashPassword } from '@cooks/auth';
import { createDb, runMigrations, users, workspaceMembers, workspaces } from '@cooks/db';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']);
    return acc;
  }, []),
);
const email = args.email;
const wsName = args.workspace ?? 'My Workspace';
if (!email) {
  console.error('usage: pnpm bootstrap --email you@example.com --workspace "My Team" [--name "Your Name"] [--slug my-team] [--password ...]');
  process.exit(1);
}
const slug = args.slug ?? wsName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const env = loadEnv();
const h = createDb(env.DATABASE_URL, { max: 1 });
await runMigrations(h.db, env.DATABASE_URL);

let [ws] = await h.db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
if (!ws) [ws] = await h.db.insert(workspaces).values({ name: wsName, slug }).returning();
let [user] = await h.db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
if (!user) [user] = await h.db.insert(users).values({ email: email.toLowerCase(), name: args.name ?? email.split('@')[0]! }).returning();
if (args.password && args.password !== 'true') await h.db.update(users).set({ passwordHash: await hashPassword(args.password) }).where(eq(users.id, user!.id));
const [member] = await h.db
  .select()
  .from(workspaceMembers)
  .where(and(eq(workspaceMembers.workspaceId, ws!.id), eq(workspaceMembers.userId, user!.id)))
  .limit(1);
if (!member) await h.db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: user!.id, role: 'admin' });
const key = await createApiKey(h.db, { workspaceId: ws!.id, name: `bootstrap ${new Date().toISOString().slice(0, 10)}`, createdBy: user!.id, prefix: env.COOKS_API_KEY_PREFIX });
await h.close();

console.log(`workspace  ${ws!.name} (${ws!.id})`);
console.log(`admin user ${user!.email} (${user!.id})`);
console.log(`api key    ${key.token}`);
console.log('\nStore the key now; it is not shown again.');
if (process.env.COOKS_BOOTSTRAP_JSON) console.log(JSON.stringify({ workspaceId: ws!.id, userId: user!.id, token: key.token }));
