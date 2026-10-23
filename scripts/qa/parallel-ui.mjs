// Headless QA for the parallel power dialer against scripts/qa/mock-twilio.mjs (phone mode).
// Usage: node scripts/qa/parallel-ui.mjs <chromium-bin> <base-url> <out-dir>
// Expects prospects named "QA Human" (+…1), "QA Machine" (+…2), "QA Noanswer" (+…3), "QA Slowhuman" (+…5)
// and Twilio connected to the mock (any SID, auth token qa-auth-token).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
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
const lineStatuses = () => page.$$eval('[data-testid=pd-line]', (els) => els.map((e) => `${(e.querySelector('.font-semibold') ?? e.querySelector('.font-medium'))?.textContent?.trim()}=${e.getAttribute('data-status')}`));

await step('login', async () => {
  await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', 'demo@cooks.local');
  await page.fill('input[type=password]', 'demo-pass-123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=nav]');
});
await step('settings → dialer: admin confirms B2B compliance mode', async () => {
  await page.goto(`${base}/app/settings?tab=dialer`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=parallel-compliance]');
  await page.locator('[data-testid=parallel-compliance]').scrollIntoViewIfNeeded();
  await shot('01-compliance-card');
  await page.click('[data-testid=pc-confirm]');
  await page.waitForSelector('[data-sonner-toast]');
  await page.waitForFunction(() => document.querySelector('[data-testid=parallel-compliance]')?.textContent?.includes('confirmed'), null, { timeout: 10000 });
});
await step('power dialer: end any leftover session, pick prospects, join by phone', async () => {
  await page.goto(`${base}/app/dialer`, { waitUntil: 'networkidle' });
  const endBtn = page.locator('[data-testid=pd-end]');
  if (await endBtn.count()) {
    await endBtn.click();
    await page.waitForSelector('[data-testid=pd-setup]', { timeout: 15000 });
  }
  await page.waitForSelector('[data-testid=pd-setup]');
  await page.click('[data-testid=pd-mode-phone]');
  await page.fill('[data-testid=pd-rep-phone]', '+15559998888');
  await page.fill('[data-testid=pd-search]', 'QA');
  await page.waitForSelector('[data-testid=pd-pick-row]');
  for (const name of ['QA Human', 'QA Machine', 'QA Noanswer', 'QA Slowhuman']) await page.click(`[data-testid=pd-pick-row]:has-text("${name}")`);
  await shot('02-setup-picked');
  await page.click('[data-testid=pd-start]');
  await page.waitForSelector('[data-testid=pd-rail]', { timeout: 15000 });
  // mock rings the rep, answers, posts conference callbacks → ready
  await page.waitForSelector('[data-testid=pd-dial]:not([disabled])', { timeout: 20000 });
  await shot('03-ready');
});
await step('dial a batch of three: human connects, machine and no-answer never reach the rep', async () => {
  await page.click('[data-testid=pd-dial]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=pd-line]').length >= 3, null, { timeout: 10000 });
  await page.waitForTimeout(1200);
  console.log('   lines while ringing:', (await lineStatuses()).join(', '));
  await shot('04-ringing');
  await page.waitForSelector('[data-testid=pd-connected]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const st = await lineStatuses();
  console.log('   lines after connect:', st.join(', '));
  await shot('05-connected');
  const liveName = await page.textContent('[data-testid=pd-connected]');
  if (!liveName?.includes('QA Human')) throw new Error(`human not connected: ${st} / ${liveName}`);
  // Speech gate (API started with SPEECH_PROVIDER=mock): the human line is settled by what was heard, before carrier AMD.
  const heard = await page.$$eval('[data-testid=pd-heard]', (els) => els.map((e) => e.textContent?.trim()));
  const human = await page.$eval('[data-testid=pd-connected]', (e) => e.textContent ?? '');
  console.log('   heard:', heard.join(' | ') || '(nothing: speech gate off)', '| connected cell:', /heard/.test(human) ? 'verdict by speech' : 'verdict by AMD');
  if (process.env.QA_EXPECT_SPEECH && !/heard/.test(human)) throw new Error('expected the speech gate to settle the human line before AMD');
  if (st.some((s) => s.includes('Machine=connected') || s.includes('Noanswer=connected'))) throw new Error('non-human connected');
  // the machine leg must end as voicemail (its verdict lands ~2.6 s after answer) and the no-answer leg as canceled or no_answer
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=pd-line]')].some((e) => e.textContent?.includes('QA Machine') && ['voicemail', 'canceled'].includes(e.getAttribute('data-status') ?? '')), null, { timeout: 15000 });
  console.log('   lines settled:', (await lineStatuses()).join(', '));
});
await step('hang up, log the call, dial the next batch (slow human), end the session', async () => {
  await page.click('[data-testid=pd-hangup]');
  await page.waitForFunction(() => document.querySelector('[data-testid=pd-connected]')?.textContent?.includes('Call ended'), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.click('[data-testid=pd-outcome-meeting_booked]');
  await page.fill('[data-testid=pd-notes]', 'Demo Thursday 10am (QA)');
  await page.click('[data-testid=pd-log]');
  await page.waitForSelector('[data-sonner-toast]');
  await shot('06-logged');
  await page.waitForSelector('[data-testid=pd-dial]:not([disabled])', { timeout: 10000 });
  await page.click('[data-testid=pd-dial]');
  await page.waitForSelector('[data-testid=pd-connected]:has-text("QA Slowhuman")', { timeout: 25000 });
  await shot('07-second-batch-connected');
  await page.click('[data-testid=pd-end]');
  await page.waitForSelector('[data-testid=pd-summary]', { timeout: 15000 });
  await shot('08-summary');
  console.log('   summary:', await page.textContent('[data-testid=pd-summary]'));
});
await step('calls page shows the parallel calls with dispositions', async () => {
  await page.goto(`${base}/app/calls`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=call-row]');
  const rows = await page.$$eval('[data-testid=call-row]', (els) => els.slice(0, 6).map((e) => e.textContent?.replace(/\s+/g, ' ').trim()));
  console.log('   ' + rows.join('\n   '));
  await shot('09-calls');
  if (!rows.some((r) => r?.includes('parallel'))) throw new Error('no parallel calls listed');
});

console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
await browser.close();
process.exit(failed ? 1 : 0);
