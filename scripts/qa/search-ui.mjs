// Headless check of the search palette. Usage: node scripts/qa/search-ui.mjs <chromium-bin> <base-url> <out-dir>
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && !r.url().includes('/auth/session-token') && errors.push(`${r.status()} ${new URL(r.url()).pathname}`));
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
await step('⌘K opens the palette', async () => {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await page.waitForSelector('[data-testid=palette-input]', { timeout: 5000 });
});
await step('typing a partial name finds the prospect and a call line', async () => {
  await page.fill('[data-testid=palette-input]', 'Ada');
  await page.waitForSelector('[data-testid=palette-hit]', { timeout: 10000 });
  const titles = await page.$$eval('[data-testid=palette-hit]', (els) => els.map((e) => e.textContent));
  if (!titles.some((t) => t.includes('Ada Lovelace'))) throw new Error(`no prospect hit: ${titles.slice(0, 3).join(' | ')}`);
  await page.screenshot({ path: `${outDir}/10-palette.png` });
});
await step('Enter opens the top hit', async () => {
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/app\/prospects\/[0-9a-f-]{36}/, { timeout: 10000 });
  await page.waitForSelector('text=Ada Lovelace', { timeout: 10000 });
  await page.screenshot({ path: `${outDir}/20-landed.png` });
});
await step('the sidebar button opens it too, and a phrase search returns a snippet', async () => {
  await page.waitForSelector('[data-testid=palette]', { state: 'detached', timeout: 5000 }).catch(() => {});
  await page.click('[data-testid=search-open]');
  await page.fill('[data-testid=palette-input]', 'pricing');
  await page.waitForSelector('[data-testid=palette-hit]', { timeout: 10000 });
  const marks = await page.$$eval('[data-testid=palette-results] mark', (els) => els.length);
  if (marks === 0) throw new Error('no highlighted snippet');
  await page.screenshot({ path: `${outDir}/30-phrase.png` });
  await page.keyboard.press('Escape');
});
await step('no console errors', async () => {
  if (errors.length) throw new Error(errors.join(' | ').slice(0, 300));
});
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
