// Headless check of the assistant drawer. Usage: node scripts/qa/assistant-ui.mjs <chromium-bin> <base-url> <out-dir>
// Without a model provider the drawer must open, take a question, and point at Settings → Hosted AI.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/40[13]|422/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
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
await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', process.env.QA_EMAIL ?? 'demo@cooks.local');
  await page.fill('input[type=password]', process.env.QA_PASSWORD ?? 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 10000 });
});
await step('⌘J opens the assistant with suggestions', async () => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+j' : 'Control+j');
  await page.waitForSelector('[data-testid=assistant][aria-hidden=false]', { timeout: 5000 });
  await page.waitForSelector('[data-testid=assistant-suggestion]');
  await page.screenshot({ path: `${outDir}/10-open.png` });
});
await step('a question gets an answer, or a pointer to Settings when no model is configured', async () => {
  await page.fill('[data-testid=assistant-input]', 'What is due today?');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=assistant-assistant]', { timeout: 10000 });
  // either a real reply (provider configured) or the unconfigured hint
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid=assistant-assistant]:last-of-type');
    const t = el?.textContent ?? '';
    return /Settings → Hosted AI/.test(document.body.textContent ?? '') || (el?.querySelector('p')?.textContent ?? '').trim().length > 0;
  }, null, { timeout: 90000 });
  const log = await page.textContent('[data-testid=assistant-log]');
  if (!log.includes('What is due today?')) throw new Error('user message missing');
  console.log(`     ${/Settings → Hosted AI/.test(log) ? 'no provider configured' : 'live reply: ' + (await page.$eval('[data-testid=assistant-assistant]:last-of-type p', (e) => e.textContent.slice(0, 120)))}`);
  await page.screenshot({ path: `${outDir}/20-answer.png` });
});
await step('the sidebar button and close work', async () => {
  await page.click('[data-testid=assistant] button[aria-label=Close]');
  await page.waitForSelector('[data-testid=assistant][aria-hidden=true]', { timeout: 5000 });
  await page.click('[data-testid=assistant-open]');
  await page.waitForSelector('[data-testid=assistant][aria-hidden=false]', { timeout: 5000 });
});
await step('no console errors', async () => {
  if (errors.length) throw new Error(errors.join(' | ').slice(0, 300));
});
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
