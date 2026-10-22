// Headless QA for Signals + Dialer + Coaching. Usage: node scripts/qa/phase2-ui.mjs <chromium-bin> <base-url> <out-dir>
// Requires: API + worker started with TWILIO_API_BASE/TRANSCRIBE_API_BASE pointing at scripts/qa/mock-twilio.mjs (:18100).
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true });
const step = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); await shot(`fail-${name.replace(/\W+/g, '-')}`); throw e; } };
const pick = async (trigger, optionText) => { await page.click(trigger); await page.click(`[role=option]:has-text("${optionText}")`); };
const apiInPage = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const s = await (await fetch('/auth/session-token', { method: 'POST' })).json();
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, { method, path, body });

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'demo@cooks.local');
  await page.fill('input[type=password]', 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 10000 });
});
let prospectId;
await step('seed: prospect phone, reset telephony', async () => {
  const list = await apiInPage('GET', '/v1/prospects?filter[primaryEmail]=ada@globex.example');
  prospectId = list.json.data[0].id;
  await apiInPage('PATCH', `/v1/prospects/${prospectId}`, { data: { phone: '+15550102020' } });
  await apiInPage('DELETE', '/v1/workspace/telephony');
});
await step('settings → dialer: connect mock Twilio', async () => {
  await page.goto(`${base}/app/settings?tab=dialer`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=twilio-form]', { timeout: 10000 });
  await shot('20-dialer-disconnected');
  await page.fill('[data-testid=twilio-sid]', 'ACqa00000000000000000000000000001');
  await page.fill('[data-testid=twilio-token]', 'wrong-token-xx');
  await page.click('[data-testid=twilio-connect]');
  await page.waitForSelector('[data-sonner-toast]:has-text("rejected")', { timeout: 10000 });
  await page.fill('[data-testid=twilio-token]', 'qa-auth-token');
  await page.click('[data-testid=twilio-connect]');
  await page.waitForSelector('[data-testid=dialer-connected]', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot('21-dialer-connected');
});
let callId;
await step('prospect → Call (bridge) → status progresses → log', async () => {
  await page.goto(`${base}/app/prospects/${prospectId}`, { waitUntil: 'networkidle' });
  await page.click('[data-testid=prospect-call]');
  await page.waitForSelector('[data-testid=dial-dialog] [data-testid=dial-start]', { timeout: 10000 });
  await page.fill('[data-testid=dial-rep-phone]', '+15559998888');
  await shot('22-dial-dialog');
  await page.click('[data-testid=dial-start]');
  await page.waitForSelector('[data-testid=dial-status]', { timeout: 10000 });
  await page.waitForSelector('[data-testid=dial-status]:has-text("In progress")', { timeout: 20000 });
  await shot('23-dial-in-progress');
  await page.waitForSelector('[data-testid=dial-status]:has-text("Completed")', { timeout: 20000 });
  await pick('[data-testid=dial-outcome]', 'Meeting booked');
  await page.fill('[data-testid=dial-notes]', 'Demo Thursday 10am');
  await page.click('[data-testid=dial-log]');
  await page.waitForSelector('[data-sonner-toast]:has-text("Call logged")', { timeout: 10000 });
  const calls = await apiInPage('GET', `/v1/calls?filter[prospect][id]=${prospectId}&page[size]=1`);
  callId = calls.json.data[0].id;
  if (calls.json.data[0].notes !== 'Demo Thursday 10am') throw new Error('notes not saved');
});
await step('calls list + detail: recording, transcript, coaching', async () => {
  await page.goto(`${base}/app/calls`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=call-row]', { timeout: 10000 });
  await shot('24-calls-list');
  await page.click(`[data-testid=call-row]:has-text("Ada Lovelace")`);
  await page.waitForSelector('h1:has-text("Call with Ada Lovelace")', { timeout: 10000 });
  await page.waitForSelector('[data-testid=transcript-card]', { timeout: 60000 });
  await page.waitForSelector('[data-testid=coaching-card]', { timeout: 90000 });
  await page.click('[data-testid=call-play]');
  await page.waitForSelector('audio', { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot('25-call-detail');
});
await step('signals: push via API, feed shows it, enroll from it, dismiss another', async () => {
  const r1 = await apiInPage('POST', '/v1/signals', { data: { kind: 'web.visit', title: 'Visited /pricing twice today', url: 'https://globex.example/pricing', score: 0.8, prospect: { id: prospectId }, dedupeKey: `qa-visit-${Date.now()}` } });
  if (r1.status !== 201) throw new Error(`push failed ${r1.status} ${JSON.stringify(r1.json)}`);
  await apiInPage('POST', '/v1/signals', { data: { kind: 'research.funding', title: 'Globex raises $40M Series B', url: 'https://news.example/globex', score: 0.9, prospect: { id: prospectId }, dedupeKey: `qa-funding-${Date.now()}` } });
  await page.goto(`${base}/app/signals`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=signal-row]:has-text("Visited /pricing")', { timeout: 10000 });
  await page.waitForSelector('[data-testid=signal-summary]', { timeout: 10000 });
  await shot('26-signals');
  await page.locator('[data-testid=signal-row]:has-text("Series B") [data-testid=signal-enroll]').first().click();
  await page.waitForSelector('[data-testid=signal-act-dialog]', { timeout: 5000 });
  await pick('[data-testid=signal-sequence]', 'New logo outreach');
  await page.click('[data-testid=signal-act-submit]');
  await page.waitForSelector('[data-sonner-toast]', { timeout: 10000 });
  await page.locator('[data-testid=signal-row]:has-text("Visited /pricing") [data-testid=signal-dismiss]').first().click();
  await page.waitForSelector('[data-sonner-toast]:has-text("Dismissed")', { timeout: 10000 });
  await page.click('[role=tab]:has-text("All")');
  await page.waitForSelector('[data-testid=signal-row]:has-text("dismissed")', { timeout: 10000 });
  await shot('27-signals-all');
});
await step('settings → signals: add a rule', async () => {
  await page.goto(`${base}/app/settings?tab=signals`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=signal-rule-form]', { timeout: 10000 });
  await page.fill('[data-testid=rule-kind]', 'research.hiring');
  await page.click('[data-testid=rule-owner-select]');
  await page.click('[role=option] >> nth=0');
  await page.click('[data-testid=rule-add]');
  await page.waitForSelector('[data-testid=signal-rule-row]:has-text("research.hiring")', { timeout: 10000 });
  await shot('28-signal-rules');
});
await step('tasks: call task shows a Call button', async () => {
  await apiInPage('POST', '/v1/tasks', { data: { action: 'call', dueAt: new Date().toISOString(), ownerId: (await apiInPage('GET', '/v1/me')).json.data.userId ?? (await apiInPage('GET', '/v1/users?page[size]=1')).json.data[0].id, prospectId, note: 'QA call task' } });
  await page.goto(`${base}/app/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=task-row]:has-text("QA call task") [data-testid=task-call]', { timeout: 10000 });
  await shot('29-tasks-call');
});
console.log(JSON.stringify({ consoleErrors: errors.filter((e) => !/401/.test(e)) }));
await browser.close();
