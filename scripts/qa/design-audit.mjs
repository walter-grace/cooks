// Front-end design audit of the web app: screenshots + measured metrics per page.
// Usage: node scripts/qa/design-audit.mjs <chromium-bin> <base-url> <out-dir>
// Measures: any hue left on screen, font-size spread, tap targets, clipped text, off-scale gaps,
// numeric table cells that are not right-aligned, WCAG contrast, heading order, page overflow.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [, , bin, base, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: bin, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

const METRICS = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  // ---- colour parsing: rgb()/rgba()/oklch()/color(srgb …) → {r,g,b,a} in 0..1 plus a hue flag
  const parse = (s) => {
    if (!s) return null;
    let m = s.match(/^rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = s.match(/^oklch\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean);
      const L = Number(p[0]), C = Number(p[1]);
      const a = p[3] ? (p[3].endsWith('%') ? Number(p[3]) / 100 : Number(p[3])) : 1;
      // grey approximation is all we need for contrast; chroma is reported separately
      const l = Math.max(0, Math.min(1, L));
      const lin = l ** 3; // oklab L≈cube-root of relative luminance
      const srgb = lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
      return { r: srgb, g: srgb, b: srgb, a, chroma: C };
    }
    m = s.match(/^color\(srgb ([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    return null;
  };
  const hueOf = (c) => (c == null ? 0 : c.chroma !== undefined ? c.chroma : Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b));
  const lum = (c) => {
    const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => {
    let acc = null;
    for (let e = el; e; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) acc = acc ? over(acc, c) : c;
      if (acc && acc.a >= 0.99) return acc;
    }
    const body = parse(getComputedStyle(document.body).backgroundColor) || { r: 1, g: 1, b: 1, a: 1 };
    return acc ? over(acc, body) : body;
  };
  const contrast = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 3).join('.') : ''}`;
  const all = [...document.querySelectorAll('body *')].filter((el) => !['SCRIPT', 'STYLE', 'SVG', 'PATH', 'CANVAS'].includes(el.tagName) && vis(el));

  // ---- hue
  const hue = new Map();
  for (const el of all) {
    const cs = getComputedStyle(el);
    for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'outlineColor', 'textDecorationColor']) {
      const c = parse(cs[prop]);
      if (!c || c.a < 0.05) continue;
      if (prop === 'borderTopColor' && parseFloat(cs.borderTopWidth) === 0) continue;
      if (prop === 'outlineColor' && cs.outlineStyle === 'none') continue;
      if (hueOf(c) > 0.03) {
        const k = `${prop} ${cs[prop]}`;
        const v = hue.get(k) || { count: 0, sample: label(el) };
        v.count++;
        hue.set(k, v);
      }
    }
  }
  // images with colour (flags, avatars) are reported separately
  const colourImages = [...document.querySelectorAll('img, svg[class*=flag]')].filter(vis).length;

  // ---- font sizes
  const sizes = {};
  const textEls = all.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  for (const el of textEls) {
    const s = getComputedStyle(el).fontSize;
    sizes[s] = (sizes[s] || 0) + 1;
  }

  // ---- contrast
  const contrastFails = [];
  for (const el of textEls) {
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const ratio = contrast(fg.a < 1 ? over(fg, bg) : fg, bg);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) contrastFails.push({ el: label(el), text: el.textContent.trim().slice(0, 40), ratio: +ratio.toFixed(2), px });
  }

  // ---- tap targets
  const targets = [...document.querySelectorAll('a, button, [role=button], [role=tab], input, select, textarea, summary, [role=radio], [role=switch], [role=checkbox]')].filter(vis);
  const smallTargets = targets
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ el, r }) => r.width > 1 && r.height > 1 && (r.height < 28 || r.width < 28) && !(el.tagName === 'A' && getComputedStyle(el).display === 'inline'))
    .map(({ el, r }) => ({ el: label(el), text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) }));

  // ---- clipped text
  const clipped = all
    .filter((el) => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 1 && el.clientHeight > 1)
    .filter((el) => {
      const cs = getComputedStyle(el);
      return cs.overflowX !== 'auto' && cs.overflowX !== 'scroll' && cs.textOverflow !== 'ellipsis' && !el.closest('[data-slot=table-container], pre, code, .ck-scope');
    })
    .map((el) => ({ el: label(el), text: el.textContent.trim().slice(0, 40), by: el.scrollWidth - el.clientWidth }));

  // ---- gaps between block siblings in main (two levels)
  const main = document.querySelector('main') || document.body;
  const gaps = [];
  const walk = (parent, depth) => {
    const kids = [...parent.children].filter(vis);
    for (let i = 1; i < kids.length; i++) {
      const a = kids[i - 1].getBoundingClientRect();
      const b = kids[i].getBoundingClientRect();
      if (b.top >= a.bottom - 1 && Math.abs(b.left - a.left) < 4) gaps.push({ gap: Math.round(b.top - a.bottom), between: `${label(kids[i - 1])} → ${label(kids[i])}` });
    }
    if (depth > 0) for (const k of kids) if (!k.matches('table, thead, tbody, tr, [data-slot=table-container]')) walk(k, depth - 1);
  };
  walk(main, 2);
  const offScale = gaps.filter((g) => g.gap > 0 && g.gap % 4 !== 0 && (g.gap - 1) % 4 !== 0 && (g.gap + 1) % 4 !== 0);

  // ---- numeric cells
  const numeric = [];
  for (const table of document.querySelectorAll('table')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll('tbody tr')) {
      [...tr.children].forEach((td, i) => {
        const t = td.textContent.trim();
        if (/^[$€£]?\d[\d,.]*(\s?(s|ms|wpm|%|×))?$|^\d+:\d{2}(:\d{2})?$/.test(t)) {
          const align = getComputedStyle(td).textAlign;
          if (align !== 'right' && align !== 'end') numeric.push({ col: heads[i] || `#${i}`, text: t, align });
        }
      });
    }
  }

  // ---- headings
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis).map((h) => +h.tagName[1]);
  let skips = 0;
  for (let i = 1; i < headings.length; i++) if (headings[i] > headings[i - 1] + 1) skips++;

  // ---- long lines
  const longLines = [...document.querySelectorAll('p, li, [data-slot=card-description]')].filter(vis).filter((el) => {
    const cs = getComputedStyle(el);
    const cpl = el.clientWidth / (parseFloat(cs.fontSize) * 0.5);
    return cpl > 95 && el.textContent.trim().length > 120;
  }).length;

  return {
    hue: [...hue.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.count - a.count).slice(0, 12),
    hueTotal: [...hue.values()].reduce((s, v) => s + v.count, 0),
    colourImages,
    fontSizes: Object.fromEntries(Object.entries(sizes).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))),
    contrastFails: contrastFails.slice(0, 10),
    contrastFailCount: contrastFails.length,
    smallTargets: smallTargets.slice(0, 10),
    smallTargetCount: smallTargets.length,
    clipped: clipped.slice(0, 10),
    clippedCount: clipped.length,
    gaps: gaps.map((g) => g.gap),
    offScale: offScale.slice(0, 10),
    offScaleCount: offScale.length,
    numericLeft: numeric.slice(0, 10),
    numericLeftCount: numeric.length,
    headings,
    headingSkips: skips,
    h1Count: headings.filter((h) => h === 1).length,
    longLines,
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
};

const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, permissions: ['microphone'] });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 160)));
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
page.on('response', (r) => r.status() >= 400 && consoleErrors.push(`${r.status()} ${new URL(r.url()).pathname}`));

await page.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
await page.fill('input[type=email]', process.env.QA_EMAIL ?? 'demo@cooks.local');
await page.fill('input[type=password]', process.env.QA_PASSWORD ?? 'demo-pass-123');
await page.click('button[type=submit]');
await page.waitForSelector('[data-testid=nav]', { timeout: 15000 });

const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(400);
};
const firstRow = async (sel) => {
  const row = page.locator(sel).first();
  if (!(await row.count())) return false;
  await row.click();
  await settle();
  return true;
};

const PAGES = [
  { id: 'tasks', go: () => page.goto(`${base}/app/`) },
  { id: 'prospects', go: () => page.goto(`${base}/app/prospects`) },
  { id: 'prospect-detail', go: async () => (await page.goto(`${base}/app/prospects`), await settle(), firstRow('[data-testid=prospect-row]')) },
  { id: 'sequences', go: () => page.goto(`${base}/app/sequences`) },
  { id: 'sequence-detail', go: async () => (await page.goto(`${base}/app/sequences`), await settle(), firstRow('[data-testid=sequence-row]')) },
  { id: 'emails', go: () => page.goto(`${base}/app/emails`) },
  { id: 'inbox', go: () => page.goto(`${base}/app/inbox`) },
  { id: 'signals', go: () => page.goto(`${base}/app/signals`) },
  { id: 'calls', go: () => page.goto(`${base}/app/calls`) },
  { id: 'call-detail', go: async () => (await page.goto(`${base}/app/calls`), await settle(), firstRow('[data-testid=call-row]')) },
  { id: 'dialer', go: () => page.goto(`${base}/app/dialer`) },
  { id: 'practice', go: () => page.goto(`${base}/app/practice`) },
  { id: 'settings-mailboxes', go: () => page.goto(`${base}/app/settings`) },
  ...['crm', 'dialer', 'channels', 'signals', 'ai', 'workspace', 'api', 'webhooks'].map((tab) => ({ id: `settings-${tab}`, go: async () => { await page.goto(`${base}/app/settings`); await settle(); const t = page.locator(`[role=tab][data-testid=tab-${tab}], [role=tab]:has-text("${tab}")`).first(); if (await t.count()) await t.click(); } })),
];

const results = {};
for (const p of PAGES) {
  const before = consoleErrors.length;
  try {
    await p.go();
    await settle();
    const metrics = await page.evaluate(METRICS);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: `${outDir}/${p.id}.png` });
    if (h > 900) await page.screenshot({ path: `${outDir}/${p.id}-full.png`, fullPage: true, clip: { x: 0, y: 0, width: 1360, height: Math.min(h, 2000) } });
    results[p.id] = { ...metrics, height: h, url: page.url().replace(base, ''), consoleErrors: consoleErrors.slice(before) };
    const m = metrics;
    console.log(`${p.id.padEnd(20)} hue ${String(m.hueTotal).padStart(3)}  sizes ${String(Object.keys(m.fontSizes).length).padStart(2)}  contrast ${String(m.contrastFailCount).padStart(3)}  targets ${String(m.smallTargetCount).padStart(2)}  clipped ${String(m.clippedCount).padStart(2)}  offscale ${String(m.offScaleCount).padStart(2)}  numLeft ${String(m.numericLeftCount).padStart(2)}  h1 ${m.h1Count} skips ${m.headingSkips}  overflow ${m.pageOverflowX}  errs ${consoleErrors.length - before}`);
  } catch (e) {
    results[p.id] = { error: e.message.split('\n')[0] };
    console.log(`${p.id.padEnd(20)} ERROR ${e.message.split('\n')[0]}`);
  }
}

// phone pass on the pages people use on the go
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const pp = await phone.newPage();
await pp.goto(`${base}/app/login`, { waitUntil: 'networkidle' });
await pp.fill('input[type=email]', process.env.QA_EMAIL ?? 'demo@cooks.local');
await pp.fill('input[type=password]', process.env.QA_PASSWORD ?? 'demo-pass-123');
await pp.click('button[type=submit]');
await pp.waitForSelector('[data-testid=nav]', { timeout: 15000 });
for (const [id, path] of [['tasks', '/app/'], ['prospects', '/app/prospects'], ['calls', '/app/calls'], ['practice', '/app/practice'], ['settings', '/app/settings']]) {
  await pp.goto(`${base}${path}`);
  await pp.waitForLoadState('networkidle').catch(() => {});
  await pp.waitForTimeout(400);
  const m = await pp.evaluate(METRICS);
  const h = await pp.evaluate(() => document.documentElement.scrollHeight);
  await pp.screenshot({ path: `${outDir}/phone-${id}.png`, fullPage: true, clip: { x: 0, y: 0, width: 390, height: Math.min(h, 1000) } });
  results[`phone-${id}`] = { ...m, height: h };
  console.log(`${('phone-' + id).padEnd(20)} hue ${String(m.hueTotal).padStart(3)}  targets ${String(m.smallTargetCount).padStart(2)}  clipped ${String(m.clippedCount).padStart(2)}  overflow ${m.pageOverflowX}`);
}

// dark scheme on two pages
await page.emulateMedia({ colorScheme: 'dark' });
for (const [id, path] of [['dark-tasks', '/app/'], ['dark-calls', '/app/calls'], ['dark-sequence-detail', '/app/sequences']]) {
  await page.goto(`${base}${path}`);
  await settle();
  if (id === 'dark-sequence-detail') await firstRow('[data-testid=sequence-row]');
  const m = await page.evaluate(METRICS);
  await page.screenshot({ path: `${outDir}/${id}.png` });
  results[id] = m;
  console.log(`${id.padEnd(20)} hue ${String(m.hueTotal).padStart(3)}  contrast ${String(m.contrastFailCount).padStart(3)}`);
}

writeFileSync(`${outDir}/audit.json`, JSON.stringify(results, null, 2));
await browser.close();
