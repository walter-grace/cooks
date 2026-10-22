// Headless browser QA of the HubSpot connect flow. Usage: node scripts/qa/hubspot-ui.mjs <chromium-bin> <base-url> <out-dir>
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true });
const step = async (name, fn) => { try { await fn(); console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}: ${e.message}`); await shot(`fail-${name.replace(/\W+/g, '-')}`); throw e; } };

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'demo@cooks.local');
  await page.fill('input[type=password]', 'demo-pass-123');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('nav .brand', { timeout: 10000 });
});
await step('settings shows CRM not connected', async () => {
  await page.click('nav a:has-text("Settings")');
  await page.waitForSelector('h2:has-text("CRM")', { timeout: 10000 });
  await page.waitForSelector('text=Not connected', { timeout: 10000 });
  await shot('10-crm-disconnected');
});
await step('bad token is rejected', async () => {
  await page.fill('input[placeholder="pat-na1-…"]', 'pat-na1-wrong');
  await page.click('button:has-text("Connect with token")');
  await page.waitForSelector('.toast', { timeout: 10000 });
  const t = await page.textContent('.toast');
  if (!/rejected|token/i.test(t)) throw new Error(`unexpected toast: ${t}`);
});
await step('connect with token', async () => {
  await page.fill('input[placeholder="pat-na1-…"]', 'pat-na1-qa-token');
  await page.click('button:has-text("Connect with token")');
  await page.waitForSelector('text=portal 777001', { timeout: 15000 });
  await shot('11-crm-connected');
});
await step('add list rule and run it', async () => {
  await page.selectOption('form.card select >> nth=0', 'list');
  await page.fill('form.card input[placeholder=""], form.card label:has-text("List id") input', '55');
  await page.selectOption('form.card label:has-text("Sequence") select', { label: 'New logo outreach' });
  await page.selectOption('form.card label:has-text("Owner") select', { index: 1 });
  await page.click('button:has-text("Add rule")');
  await page.waitForSelector('text=list 55', { timeout: 10000 });
  await page.click('button:has-text("Run now")');
  await page.waitForSelector('text=/Synced 2, enrolled/', { timeout: 20000 });
  await shot('12-crm-rule-run');
});
await step('import by email', async () => {
  await page.fill('input[placeholder="ada@globex.com, grace@globex.com"]', 'linus@kernel.example, nobody@nowhere.example');
  await page.click('button:has-text("Import from HubSpot")');
  await page.waitForSelector('text=/Imported 1, 1 not found/', { timeout: 10000 });
});
await step('prospects list shows the synced contacts with enrollments', async () => {
  await page.click('nav a:has-text("Prospects")');
  await page.waitForSelector('table tbody tr:has-text("Linus Torvalds")', { timeout: 10000 });
  await page.waitForSelector('table tbody tr:has-text("Grace Hopper")', { timeout: 10000 });
  await shot('13-prospects-after-sync');
});
await step('note to HubSpot from prospect page', async () => {
  // via API through the page context to keep it black-box but fast
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
