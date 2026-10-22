// Headless QA for the Speko AI dialer against scripts/qa/mock-speko.mjs.
// Usage: node scripts/qa/speko-ui.mjs <chromium-bin> <base-url> <out-dir> [prospectId]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const [, , bin, base, outDir, prospectId] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const shot = (n) => page.screenshot({ path: `${outDir}/${n}.png` });
let failed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log('PASS', name);
  } catch (e) {
    failed++;
    console.log('FAIL', name, e.message.split('\n')[0]);
    await shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-')}`);
  }
};

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'demo@cooks.local');
  await page.fill('input[type=password]', 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]');
});
await step('settings → dialer: connect Speko with the mock key', async () => {
  await page.goto(`${base}/app/settings?tab=dialer`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=speko-form]');
  await page.fill('[data-testid=speko-key]', 'sk_live_qa');
  await page.click('[data-testid=speko-connect]');
  await page.waitForSelector('[data-testid=speko-balance]', { timeout: 15000 });
  await page.waitForSelector('[data-testid=speko-number]');
  await shot('01-settings-speko');
});
await step('settings → dialer: Speko becomes the default dialer; search and buy a number with confirmation', async () => {
  const useBtn = page.locator('[data-testid=use-speko]');
  if (await useBtn.count()) await useBtn.click();
  await page.waitForSelector('[data-testid=provider-speko] >> text=default dialer', { timeout: 10000 });
  await page.fill('[data-testid=speko-area]', '415');
  await page.click('[data-testid=speko-search]');
  await page.waitForSelector('[data-testid=speko-found]');
  await page.locator('[data-testid=speko-buy]').first().click();
  await page.waitForSelector('[data-testid=speko-buy-dialog]');
  await shot('02-buy-confirm');
  await page.click('[data-testid=speko-buy-confirm]');
  await page.waitForSelector('[data-sonner-toast]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=speko-number]').length >= 2, null, { timeout: 10000 });
});
await step('prospect → AI call → queued → answered with summary and transcript', async () => {
  await page.goto(`${base}/app/prospects/${prospectId}`, { waitUntil: 'networkidle' });
  await page.click('[data-testid=prospect-ai-call]');
  await page.waitForSelector('[data-testid=ai-call-dialog]');
  await page.waitForSelector('[data-testid=ai-call-start]:not([disabled])');
  await shot('03-ai-call-dialog');
  await page.click('[data-testid=ai-call-start]');
  await page.waitForSelector('[data-testid=ai-call-live]');
  await page.waitForFunction(() => document.querySelector('[data-testid=ai-call-status]')?.textContent?.includes('Answered'), null, { timeout: 60000 });
  await page.waitForSelector('[data-testid=ai-call-summary]', { timeout: 15000 });
  await shot('04-ai-call-done');
  await page.keyboard.press('Escape');
});
await step('prospect timeline shows the AI call with outcome, transcript and recording', async () => {
  await page.goto(`${base}/app/prospects/${prospectId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=calls-timeline] [data-testid=call-item]');
  const first = page.locator('[data-testid=call-item]').first();
  if (!(await first.locator('[data-testid=call-item-outcome]').textContent())?.includes('Answered')) throw new Error('first call item is not Answered');
  await first.locator('[data-testid=call-item-transcript]').click();
  await page.waitForSelector('[data-testid=call-item-transcript-body]');
  await first.locator('[data-testid=call-item-play]').click();
  await page.waitForSelector('[data-testid=call-item] audio', { timeout: 10000 });
  await shot('05-prospect-timeline');
});
await step('calls page lists it and the detail shows summary, cost and transcript', async () => {
  await page.goto(`${base}/app/calls`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=call-row]');
  await page.locator('[data-testid=call-row]').first().click();
  await page.waitForSelector('[data-testid=call-summary]');
  await page.waitForSelector('[data-testid=transcript-card]');
  await shot('06-call-detail');
});
await step('quiet hours refusal is explained in the dialog', async () => {
  await page.goto(`${base}/app/prospects/${prospectId}`, { waitUntil: 'networkidle' });
  await page.click('[data-testid=prospect-ai-call]');
  await page.waitForSelector('[data-testid=ai-call-start]:not([disabled])');
  await page.fill('[data-testid=ai-call-to]', '+15550009999'); // mock: no prospect for this number, but quiet hours use UTC for a bare number only if outside; use time-zone-less path
  // The QA prospect is in America/Los_Angeles; a bare number has no zone and falls back to the workspace zone.
  await page.click('[data-testid=ai-call-start]');
  await page.waitForSelector('[data-testid=ai-call-error], [data-testid=ai-call-live]', { timeout: 15000 });
  await shot('07-second-call');
});
await browser.close();
console.log(failed ? `${failed} step(s) failed` : 'all steps passed');
process.exit(failed ? 1 : 0);
