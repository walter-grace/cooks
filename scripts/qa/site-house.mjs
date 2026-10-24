// Scroll the house tour and screenshot every stop. Usage: node scripts/qa/site-house.mjs <base-url> <out-dir> [chromium-bin]
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [, , base, outDir, bin] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch(bin ? { executablePath: bin } : {});
const errors = [];
const run = async (name, viewport, extra = {}) => {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text().slice(0, 140)}`));
  page.on('pageerror', (e) => errors.push(`${name}: ${String(e).slice(0, 140)}`));
  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const stops = await page.$$eval('.house .stop', (els) => els.map((e) => e.id));
  for (const id of stops) {
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
    await page.waitForTimeout(900);
    const t = await page.$eval('svg.house-svg', (s) => `${s.dataset.room} ${s.style.transform}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: `${outDir}/${name}-${id}.png` });
    console.log(`${name.padEnd(8)} ${id.padEnd(18)} ${t.slice(0, 70)}  overflowX ${overflow}`);
  }
  await page.evaluate(() => document.getElementById('compare').scrollIntoView({ behavior: 'instant' }));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}-compare.png` });
  await ctx.close();
};
await run('desktop', { width: 1360, height: 900 });
await run('phone', { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
await run('dark', { width: 1360, height: 900 }, { colorScheme: 'dark' });
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
