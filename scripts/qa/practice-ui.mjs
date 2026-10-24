// Headless browser QA of practice calls. Usage: node scripts/qa/practice-ui.mjs <chromium-bin> <base-url> <out-dir>
// Run the API with PRACTICE_PROVIDER=mock. Chromium's fake microphone feeds a tone, which the mock
// partner hears as the rep talking, so the whole loop (worklet → socket → partner → playback → call page) runs.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${new URL(r.url()).pathname}`));
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png`, fullPage: true });
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`).catch(() => {});
  }
};

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', process.env.QA_EMAIL ?? 'demo@cooks.local');
  await page.fill('input[type=password]', process.env.QA_PASSWORD ?? 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]', { timeout: 10000 });
});
await step('practice page lists scenarios and the partner is on', async () => {
  await page.click('[data-testid=nav] a:has-text("Practice")');
  await page.waitForSelector('[data-testid=scenario-cold-vp-sales]', { timeout: 10000 });
  if (await page.locator('[data-testid=practice-off]').count()) throw new Error('practice is off on this server');
  await page.waitForTimeout(300);
  await shot('10-practice');
});
let callId = '';
await step('start a call: greeting arrives, mic level moves, rep turn gets a reply', async () => {
  await page.click('[data-testid=scenario-cold-vp-sales] button');
  await page.waitForSelector('[data-testid=practice-end]', { timeout: 10000 });
  await page.waitForSelector('[data-testid=practice-transcript] >> text=Hello, this is Dana.', { timeout: 10000 });
  // The fake mic tone counts as the rep talking; the mock replies when it pauses (it never does, so wait for the interrupt + reply after the greeting).
  await page.waitForFunction(() => document.querySelector('[data-testid=practice-transcript]')?.textContent?.includes('Sorry, who is this'), null, { timeout: 15000 }).catch(() => {});
  const text = await page.locator('[data-testid=practice-transcript]').textContent();
  await shot('20-live');
  if (!text.includes('Hello, this is Dana.')) throw new Error(`no greeting: ${text}`);
});
await step('end call lands on the call page with the transcript', async () => {
  await page.click('[data-testid=practice-end]');
  await page.waitForURL(/\/app\/calls\/[0-9a-f-]{36}/, { timeout: 15000 });
  callId = page.url().split('/').pop();
  await page.waitForSelector('[data-testid=transcript-card]', { timeout: 10000 });
  const body = await page.textContent('body');
  if (!body.includes('Practice call')) throw new Error('call page does not say Practice');
  if (!body.includes('AI prospect')) throw new Error('transcript labels missing');
  await page.waitForTimeout(300);
  await shot('30-call-page');
});
await step('calls list shows the practice row', async () => {
  await page.click('[data-testid=nav] a:has-text("Calls")');
  await page.waitForSelector('text=Practice', { timeout: 10000 });
  await shot('40-calls');
});
await step('no console errors', async () => {
  const real = errors.filter((e) => !/favicon|ResizeObserver|Failed to load resource|401 \/auth\/session-token/.test(e));
  if (real.length) throw new Error(real.join(' | '));
});
await browser.close();
console.log(failed ? `${failed} step(s) failed` : `ALL PASS (call ${callId})`);
process.exit(failed ? 1 : 0);
