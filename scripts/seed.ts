/**
 * Demo data: accounts, prospects, a two-step sequence (AI-assisted email + call), a tag, a
 * mailbox for the admin, and one enrollment. Run after `pnpm bootstrap`.
 *   pnpm seed --workspace my-team            (slug from bootstrap)
 */
import { eq } from 'drizzle-orm';
import { loadEnv } from '@cooks/config';
import { createDb, runMigrations, accounts, emailTemplates, mailboxes, prospects, sequenceStates, sequenceSteps, sequences, tags, sequenceTags, users, workspaceMembers, workspaces } from '@cooks/db';

const args = Object.fromEntries(process.argv.slice(2).reduce<string[][]>((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith('--') ? arr[i + 1]! : 'true']] : acc), []));
const env = loadEnv();
const h = createDb(env.DATABASE_URL, { max: 1 });
await runMigrations(h.db, env.DATABASE_URL);

const [ws] = args.workspace ? await h.db.select().from(workspaces).where(eq(workspaces.slug, args.workspace)).limit(1) : await h.db.select().from(workspaces).limit(1);
if (!ws) {
  console.error('No workspace found. Run `pnpm bootstrap --email you@example.com --workspace "My Team"` first.');
  process.exit(1);
}
const [member] = await h.db.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id)).limit(1);
const [admin] = await h.db.select().from(users).where(eq(users.id, member!.userId)).limit(1);
const owner = admin!.id;

const existing = await h.db.select({ id: sequences.id }).from(sequences).where(eq(sequences.workspaceId, ws.id)).limit(1);
if (existing.length) {
  console.log(`Workspace ${ws.name} already has data; nothing seeded.`);
  await h.close();
  process.exit(0);
}

await h.db.insert(mailboxes).values({ workspaceId: ws.id, userId: owner, email: admin!.email, isDefault: true, minGapSeconds: 5, dailySendLimit: 200 }).onConflictDoNothing();
const acc = await h.db
  .insert(accounts)
  .values([
    { workspaceId: ws.id, name: 'Globex Corporation', domain: 'globex.example', industry: 'Manufacturing', numEmployees: 1200, description: 'Industrial automation, expanding into predictive maintenance.' },
    { workspaceId: ws.id, name: 'Initech', domain: 'initech.example', industry: 'Software', numEmployees: 240, description: 'B2B payments platform, recently raised a Series B.' },
    { workspaceId: ws.id, name: 'Hooli', domain: 'hooli.example', industry: 'Consumer internet', numEmployees: 9000 },
  ])
  .returning();
const ps = await h.db
  .insert(prospects)
  .values([
    { workspaceId: ws.id, accountId: acc[0]!.id, firstName: 'Ada', lastName: 'Lovelace', name: 'Ada Lovelace', title: 'VP Engineering', primaryEmail: 'ada@globex.example', timezone: 'America/New_York', ownerId: owner },
    { workspaceId: ws.id, accountId: acc[0]!.id, firstName: 'Grace', lastName: 'Hopper', name: 'Grace Hopper', title: 'Director of Operations', primaryEmail: 'grace@globex.example', timezone: 'America/Chicago', ownerId: owner },
    { workspaceId: ws.id, accountId: acc[1]!.id, firstName: 'Peter', lastName: 'Gibbons', name: 'Peter Gibbons', title: 'Head of Revenue Ops', primaryEmail: 'peter@initech.example', timezone: 'America/Los_Angeles', ownerId: owner },
    { workspaceId: ws.id, accountId: acc[1]!.id, firstName: 'Samir', lastName: 'Nagheenanajar', name: 'Samir Nagheenanajar', title: 'CTO', primaryEmail: 'samir@initech.example', timezone: 'America/Los_Angeles', ownerId: owner },
    { workspaceId: ws.id, accountId: acc[2]!.id, firstName: 'Gavin', lastName: 'Belson', name: 'Gavin Belson', title: 'CEO', primaryEmail: 'gavin@hooli.example', timezone: 'America/Los_Angeles', ownerId: owner },
  ])
  .returning();
const [tag] = await h.db.insert(tags).values({ workspaceId: ws.id, name: 'Outbound' }).returning();
const [seq] = await h.db.insert(sequences).values({ workspaceId: ws.id, name: 'New logo outreach', ownerId: owner, privacy: 'team_editable' }).returning();
await h.db.insert(sequenceTags).values({ sequenceId: seq!.id, tagId: tag!.id });
const [t1] = await h.db.insert(emailTemplates).values({ workspaceId: ws.id, name: 'Intro', subject: 'Quick question for {{ prospect.firstName }}', htmlBody: '<p>Hi {{ prospect.firstName | first_name_or }},</p><p>Teams like {{ account.name | default: "yours" }} use Cooks to run outbound without a per-seat tool bill. Worth a 15 minute look this week?</p><p>{{ owner.firstName }}</p>', source: 'step_auto', ownerId: owner }).returning();
const [t3] = await h.db.insert(emailTemplates).values({ workspaceId: ws.id, name: 'Bump', subject: '', htmlBody: '<p>Any thoughts, {{ prospect.firstName | first_name_or }}? Happy to send a two-line summary instead.</p>', source: 'step_auto', ownerId: owner }).returning();
await h.db.insert(sequenceSteps).values([
  { workspaceId: ws.id, sequenceId: seq!.id, order: 1, action: 'auto_email', intervalMinutes: 0, name: 'Intro email', emailTemplateId: t1!.id },
  { workspaceId: ws.id, sequenceId: seq!.id, order: 2, action: 'call', intervalMinutes: 2 * 24 * 60, name: 'Follow-up call', note: 'Reference the intro email. Ask about current outbound tooling.' },
  { workspaceId: ws.id, sequenceId: seq!.id, order: 3, action: 'manual_email_reply', intervalMinutes: 3 * 24 * 60, name: 'AI bump', emailTemplateId: t3!.id, aiEmail: { promptOverride: 'Short, friendly bump. One sentence of new value, one question.' } },
  { workspaceId: ws.id, sequenceId: seq!.id, order: 4, action: 'manual_linkedin_connection_request', intervalMinutes: 24 * 60, name: 'Connect on LinkedIn' },
]);
await h.db.insert(sequenceStates).values({ workspaceId: ws.id, sequenceId: seq!.id, prospectId: ps[0]!.id, accountId: ps[0]!.accountId, ownerId: owner, creatorId: owner, state: 'paused' });

console.log(`Seeded ${ws.name}: ${acc.length} accounts, ${ps.length} prospects, 1 sequence (4 steps), 1 paused enrollment (Ada Lovelace). Resume it from the UI or POST /v1/sequenceStates/{id}/actions/resume.`);
await h.close();
