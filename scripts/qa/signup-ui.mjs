// Headless check of self-serve sign-up. Usage: node scripts/qa/signup-ui.mjs <chromium-bin> <base-url> <out-dir>
// Run the API with COOKS_SIGNUP=open. Mail is not read here; the API tests cover verification and reset links.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/40[13]/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && !/\/auth\/(session-token|signup|login)/.test(r.url()) && errors.push(`${r.status()} ${new URL(r.url()).pathname}`));
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: `${outDir}/fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
};
const stamp = Date.now().toString(36);
const email = `qa-${stamp}@example.test`;
const password = 'a perfectly fine passphrase';

await step('login page links to sign-up and password reset', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=login-signup]', { timeout: 10000 });
  await page.waitForSelector('[data-testid=login-forgot]');
  await page.screenshot({ path: `${outDir}/10-login.png` });
});
await step('sign-up creates a workspace and lands in the app as admin', async () => {
  await page.click('[data-testid=login-signup]');
  await page.waitForSelector('[data-testid=signup]');
  await page.fill('#su-name', 'QA Person');
  await page.fill('#su-ws', `QA Workspace ${stamp}`);
  await page.fill('#su-email', email);
  await page.fill('#su-pw', password);
  await page.screenshot({ path: `${outDir}/20-signup.png` });
  await page.click('[data-testid=signup] button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=verify-banner]', { timeout: 5000 });
  const side = await page.textContent('aside');
  if (!side.includes(`QA Workspace ${stamp}`) || !side.includes('admin')) throw new Error(`sidebar: ${side.slice(0, 120)}`);
  await page.screenshot({ path: `${outDir}/30-fresh-workspace.png` });
});
await step('a fresh workspace is empty but usable', async () => {
  const body = await page.textContent('body');
  if (!body.includes('Tasks')) throw new Error('no tasks page');
});
await step('settings shows members and sends an invite', async () => {
  await page.goto(`${base}/app/settings?tab=workspace`);
  await page.waitForSelector('[data-testid=members]', { timeout: 10000 });
  const members = await page.textContent('[data-testid=members]');
  if (!members.includes(email)) throw new Error(`members: ${members}`);
  await page.fill('[data-testid=invite-email]', `teammate-${stamp}@example.test`);
  await page.click('[data-testid=invite-send]');
  await page.waitForSelector('[data-testid=invites]', { timeout: 10000 });
  const pending = await page.textContent('[data-testid=invites]');
  if (!pending.includes(`teammate-${stamp}@example.test`)) throw new Error(`pending: ${pending}`);
  await page.screenshot({ path: `${outDir}/40-invites.png` });
});
await step('sign out, then sign in with the new password', async () => {
  await page.click('button[aria-label="Sign out"]');
  await page.waitForURL(/\/app\/login/, { timeout: 10000 });
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 10000 });
});
await step('forgot-password page accepts an address', async () => {
  await page.goto(`${base}/app/forgot`);
  await page.waitForSelector('[data-testid=forgot]');
  await page.fill('#fg-email', email);
  await page.click('[data-testid=forgot] button[type=submit]');
  await page.waitForSelector('text=on its way', { timeout: 10000 });
  await page.screenshot({ path: `${outDir}/50-forgot.png` });
});
await step('no console errors', async () => {
  if (errors.length) throw new Error(errors.join(' | ').slice(0, 300));
});
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
