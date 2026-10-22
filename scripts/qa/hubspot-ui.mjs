// Headless browser QA of the HubSpot connect flow. Usage: node scripts/qa/hubspot-ui.mjs <chromium-bin> <base-url> <out-dir>
// Run the API with HUBSPOT_API_BASE pointing at scripts/qa/mock-hubspot.mjs (see docs/crm.md).
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true });
const step = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); await shot(`fail-${name.replace(/\W+/g, '-')}`); throw e; } };
const lastToast = async () => { await page.waitForSelector('[data-sonner-toast]', { timeout: 10000 }); return page.locator('[data-sonner-toast]').last().textContent(); };
const pick = async (trigger, optionText) => { await page.click(trigger); await page.click(typeof optionText === 'number' ? `[role=option] >> nth=${optionText}` : `[role=option]:has-text("${optionText}")`); };

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'demo@cooks.local');
  await page.fill('input[type=password]', 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 10000 });
});
await step('start from a disconnected CRM', async () => {
  // black-box reset through the same session the browser holds
  await page.evaluate(async () => {
    const s = await (await fetch('/auth/session-token', { method: 'POST' })).json();
    const h = { authorization: `Bearer ${s.access_token}` };
    const crm = await (await fetch('/v1/workspace/crm', { headers: h })).json();
    for (const r of crm.data?.settings?.autoEnroll ?? []) await fetch(`/v1/workspace/crm/rules/${r.id}`, { method: 'DELETE', headers: h });
    await fetch('/v1/workspace/crm', { method: 'DELETE', headers: h });
  });
  await page.click('[data-testid=nav] a:has-text("Settings")');
  await page.click('[data-testid=tab-crm]');
  await page.waitForSelector('[data-testid=crm-disconnected]', { timeout: 10000 });
  await page.waitForTimeout(300);
  await shot('10-crm-disconnected');
});
await step('bad token is rejected', async () => {
  await page.fill('[data-testid=hubspot-token]', 'pat-na1-wrong');
  await page.click('[data-testid=connect-hubspot-token]');
  const t = await lastToast();
  if (!/rejected|token/i.test(t)) throw new Error(`unexpected toast: ${t}`);
});
await step('connect with token', async () => {
  await page.fill('[data-testid=hubspot-token]', 'pat-na1-qa-token');
  await page.click('[data-testid=connect-hubspot-token]');
  await page.waitForSelector('[data-testid=crm-connected]:has-text("Portal 777001")', { timeout: 15000 });
  await page.waitForTimeout(300);
  await shot('11-crm-connected');
});
await step('add list rule and run it', async () => {
  await page.fill('[data-testid=rule-list-id]', '55');
  await pick('[data-testid=rule-sequence]', 'New logo outreach');
  await pick('[data-testid=rule-owner]', 0);
  await page.click('[data-testid=add-rule-form] button[type=submit]');
  await page.waitForSelector('[data-testid=rule-row]:has-text("list 55")', { timeout: 10000 });
  await page.click('[data-testid=rule-row]:has-text("list 55") button:has-text("Run now")');
  await page.waitForSelector('[data-testid=rule-result]:has-text("Synced 2, enrolled")', { timeout: 20000 });
  await shot('12-crm-rule-run');
});
await step('import by email', async () => {
  await page.fill('[data-testid=import-emails]', 'linus@kernel.example, nobody@nowhere.example');
  await page.click('button:has-text("Import from HubSpot")');
  await page.waitForSelector('[data-sonner-toast]:has-text("Imported 1, 1 not found")', { timeout: 10000 });
});
await step('prospects list shows the synced contacts with enrollments', async () => {
  await page.click('[data-testid=nav] a:has-text("Prospects")');
  await page.waitForSelector('[data-testid=prospect-row]:has-text("Linus Torvalds")', { timeout: 10000 });
  await page.waitForSelector('[data-testid=prospect-row]:has-text("Grace Hopper")', { timeout: 10000 });
  await shot('13-prospects-after-sync');
});
await step('note to HubSpot from prospect page', async () => {
  const r = await page.evaluate(async () => {
    const s = await (await fetch('/auth/session-token', { method: 'POST' })).json();
    const list = await (await fetch('/v1/prospects?filter[primaryEmail]=linus@kernel.example', { headers: { authorization: `Bearer ${s.access_token}` } })).json();
    const res = await fetch(`/v1/prospects/${list.data[0].id}/notes`, { method: 'POST', headers: { authorization: `Bearer ${s.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ data: { text: 'QA note from Cooks', integrationType: 'hubspot' } }) });
    return { status: res.status, body: await res.json() };
  });
  if (r.status !== 201 || r.body.data.integrationType !== 'hubspot') throw new Error(JSON.stringify(r));
});
console.log(JSON.stringify({ consoleErrors: errors.filter((e) => !/401/.test(e)) }));
await browser.close();
