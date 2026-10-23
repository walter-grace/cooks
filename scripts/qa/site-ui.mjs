// Headless QA for the marketing site (apps/site). Usage: node scripts/qa/site-ui.mjs <base-url> <out-dir>
import { chromium } from 'playwright-core';
const bin = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const [, , base, out] = process.argv;
const browser = await chromium.launch({ executablePath: bin, headless: true });
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name, extra); if (!ok) failed++; };
const ctxOf = async (o) => { const ctx = await browser.newContext(o); const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('requestfailed', (r) => errors.push('REQ ' + r.url())); return { ctx, page, errors }; };

// desktop light: structure, no errors, no hscroll, fonts, demo interactions
{
  const { ctx, page, errors } = await ctxOf({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' });
  const res = await page.goto(base + '/', { waitUntil: 'networkidle' });
  check('200', res.status() === 200);
  await page.evaluate(() => document.fonts.ready);
  const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  check('self-hosted Newsreader applied', /Newsreader|__Newsreader/i.test(fam), fam.slice(0, 40));
  const gf = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /fonts\.g/.test(r.name)).length);
  check('no Google Fonts requests', gf === 0);
  for (const id of ['features', 'dialer', 'signals', 'assistant', 'more', 'compare', 'selfhost', 'footer']) check('section ' + id, (await page.$('#' + id)) !== null);
  check('no horizontal scroll', (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0);
  await page.evaluate(() => document.getElementById('dialer').scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/desk-dialer.png` });
  check('resting foot shows Talking to Maya', (await page.textContent('.pd .foot')).includes('Talking to Maya Chen'));
  await page.click('.pd .foot button:has-text("Meeting booked")');
  check('logged', (await page.textContent('.pd .foot')).includes('Logged: Meeting booked'));
  await page.click('.pd .foot button:has-text("Dial next batch")');
  await page.waitForTimeout(400);
  check('ringing', (await page.textContent('.pd .rows')).includes('ringing'));
  await page.waitForTimeout(1300);
  const rows = await page.textContent('.pd .rows');
  check('gate settled a person at 0.9 s', rows.includes('Hi, this is Tom') && rows.includes('0.9 s'), '');
  check('voicemail at 1.1 s', rows.includes('leave a message'));
  check('sibling hung up', rows.includes('rep is busy'));
  await page.screenshot({ path: `${out}/desk-dialer-ringing.png` });
  await page.click('.pd .foot button:has-text("Hang up")');
  check('hang up asks for disposition', (await page.textContent('.pd .foot')).includes('Call ended'));
  await page.waitForTimeout(7500);
  check('no answer became callback', (await page.textContent('.pd .rows')).includes('callback task made'));
  await page.evaluate(() => document.getElementById('footer').scrollIntoView());
  await page.waitForTimeout(2600);
  check('footer reveal played', await page.evaluate(() => document.getElementById('footer').classList.contains('in')));
  await page.screenshot({ path: `${out}/desk-footer.png` });
  await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/desk-top.png` });
  await page.screenshot({ path: `${out}/desk-full.png`, fullPage: true });
  check('desktop: no console errors or failed requests', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
// dark + phone
{
  const { ctx, page, errors } = await ctxOf({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/dark-top.png` });
  check('dark: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, page, errors } = await ctxOf({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base + '/', { waitUntil: 'networkidle' }); await page.waitForTimeout(300);
  check('phone: no horizontal scroll', (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) === 0);
  await page.screenshot({ path: `${out}/phone-top.png` });
  await page.locator('.pd').screenshot({ path: `${out}/phone-pd.png` });
  await page.locator('#signals .panel').screenshot({ path: `${out}/phone-sig.png` });
  await page.tap('.pd .foot button:has-text("Not interested")');
  await page.tap('.pd .foot button:has-text("Dial next batch")');
  await page.waitForTimeout(1500);
  await page.locator('.pd').screenshot({ path: `${out}/phone-pd-ring.png` });
  const small = await page.$$eval('a, button', (els) => els.filter((e) => e.getClientRects().length).map((e) => ({ t: e.textContent.trim().slice(0, 20), h: e.getBoundingClientRect().height })).filter((x) => x.h < 32));
  check('phone: tap targets >= 32px (inline text links excepted)', small.every((x) => x.t === 'self-hosting guide'), JSON.stringify(small));
  check('phone: no errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}
// OG image: 1200x630 card from the page's own styles
{
  const { ctx, page } = await ctxOf({ viewport: { width: 1200, height: 630 }, colorScheme: 'light' });
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    document.body.innerHTML = `<div class="bgart" aria-hidden="true"><div class="scene" style="opacity:.1;top:60%;width:1500px"></div></div>
      <div style="position:relative;z-index:1;padding:72px 84px;height:630px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between">
        <div class="brand" style="font-size:30px"><svg viewBox="0 0 44 30" style="width:58px;height:40px;color:var(--ink)"><circle cx="15" cy="18" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M24.5 18h16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M11 6c-1.5-2 1.5-3 0-5M16 6c-1.5-2 1.5-3 0-5M21 6c-1.5-2 1.5-3 0-5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Cooks</div>
        <div><h1 style="font-size:112px;line-height:.98;font-weight:400;letter-spacing:-.015em;margin:0 0 26px">Let your reps <em style="color:var(--ink)">cook</em>.</h1>
        <p style="font-size:30px;line-height:1.35;color:var(--ink-soft);max-width:28em;margin:0">Open-source sales engagement you host yourself, run by the assistant you already pay for.</p></div>
        <div style="font-size:20px;color:var(--ink-soft)">MIT licensed · One Postgres · 66 MCP tools · github.com/walter-grace/cooks</div></div>`;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/og.png` });
  await ctx.close();
}
await browser.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
