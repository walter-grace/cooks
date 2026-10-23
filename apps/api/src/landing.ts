/**
 * Public landing page served at `/`.
 *
 * One quiet editorial page: Newsreader on warm white paper, a single red ink for every line, link and
 * illustration. The footer is a one-ink woodblock riverscape (two alpha PNGs tinted through CSS masks,
 * so the same art turns rose on the dark theme) that reveals once on scroll while birds and boats keep
 * moving. The only script is the reveal observer; there is no tracking.
 *
 * `landingBody()` is the page without a document shell so the same markup can be published elsewhere;
 * `landingHtml()` wraps it for the API.
 */

export interface LandingOptions {
  /** Where this Cooks instance lives; used in the MCP command. */
  publicUrl: string;
  /** URL of the MCP tarball for `npx -y`. */
  release: string;
  /** Where "Open the app" goes. Defaults to `/app/`. */
  appUrl?: string;
  /** Where the API reference lives. Defaults to `/docs`. */
  docsUrl?: string;
  /** Base path for scene.png, boat.png and the screenshots. Defaults to `/landing`. */
  assetBase?: string;
}

const GITHUB = 'https://github.com/walter-grace/cooks';
const DOC = (name: string) => `${GITHUB}/blob/main/docs/${name}.md`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function css(asset: string) {
  return `
  /* Layout: one column of calm prose on paper. Every size comes from one type scale and every gap from one
     spacing scale (4px base); columns sit on a four-column grid with a 32px gutter so each second column shares
     the same left edge. The footer is a single-ink river scene the text sits above. */
  :root {
    --paper: #fffbf9;          /* page ground: white with a breath of warmth */
    --paper-2: #fff1ee;        /* code blocks, panels */
    --ink: #c41e3a;            /* the one illustration/link ink */
    --ink-strong: #3b0d15;     /* headings and body copy */
    --ink-soft: #8a515b;       /* muted copy and labels (6:1 on paper) */
    --line: rgba(196, 30, 58, .2);
    --font: "Newsreader", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    /* type scale */
    --t-eyebrow: 13px; --t-cap: 14px; --t-small: 16px; --t-body: 17px; --t-h3: 22px;
    --t-lead: clamp(18px, 1.6vw, 22px); --t-h2: clamp(30px, 3.6vw, 46px); --t-h1: clamp(42px, 7vw, 84px);
    /* spacing scale */
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px; --s9: 96px;
    --gut: 32px; --sec: 80px;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #170b0e; --paper-2: #231417; --ink: #ff7085; --ink-strong: #ffe9ec; --ink-soft: #c48f97; --line: rgba(255, 112, 133, .22);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --paper: #170b0e; --paper-2: #231417; --ink: #ff7085; --ink-strong: #ffe9ec; --ink-soft: #c48f97; --line: rgba(255, 112, 133, .22);
    color-scheme: dark;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--paper); color: var(--ink-strong);
    font-family: var(--font); font-size: var(--t-body); line-height: 1.5;
    -webkit-font-smoothing: antialiased; overflow-x: hidden;
  }
  a { color: var(--ink); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: .18em; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: 2px; }
  code { font-family: var(--mono); font-size: .88em; }
  p { margin: 0; }
  .wrap {
    max-width: 1240px; margin: 0 auto;
    padding-left: max(24px, env(safe-area-inset-left, 0px));
    padding-right: max(24px, env(safe-area-inset-right, 0px));
  }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

  /* ---------- the scene behind the page ---------- */
  .bgart { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
  .bgart .scene {
    position: absolute; left: 50%; top: 46%; width: 150vw; max-width: 2300px; aspect-ratio: 1600 / 679; transform: translate(-50%, -50%);
    background: var(--ink); opacity: .055;
    -webkit-mask: url(${asset}/scene.png) no-repeat center / 100% auto; mask: url(${asset}/scene.png) no-repeat center / 100% auto;
  }
  .bgart .fade { position: absolute; inset: 0; background: linear-gradient(to bottom, var(--paper) 0, transparent 28%, transparent 72%, var(--paper) 100%); }
  .bgart .sky { top: 9%; height: 18%; opacity: .5; }
  header.top, main { position: relative; z-index: 1; }

  /* ---------- header ---------- */
  header.top { padding-block: var(--s4); display: flex; justify-content: space-between; align-items: center; gap: var(--s4); flex-wrap: wrap; }
  .brand { display: inline-flex; align-items: center; gap: var(--s3); color: var(--ink-strong); font-size: var(--t-h3); font-weight: 500; letter-spacing: .01em; }
  .brand:hover { text-decoration: none; }
  .brand svg { width: 44px; height: 30px; display: block; color: var(--ink); }
  nav.top { display: flex; flex-wrap: wrap; gap: 0 var(--s4); font-size: var(--t-small); }
  nav.top a { display: inline-block; padding: var(--s2) var(--s1); min-height: 40px; line-height: 24px; }

  /* ---------- hero ---------- */
  .hero { padding-block: var(--s9) var(--s9); max-width: 780px; }
  .hero h1 { font-size: var(--t-h1); line-height: .98; font-weight: 400; margin: 0 0 var(--s5); letter-spacing: -.015em; text-wrap: balance; }
  .hero h1 em { font-style: italic; color: var(--ink); }
  .hero .lead { font-size: var(--t-lead); line-height: 1.45; color: var(--ink-soft); max-width: 34em; margin: 0 0 var(--s6); }
  .ctas { display: flex; flex-wrap: wrap; gap: var(--s3); align-items: center; }
  .cta { display: inline-flex; align-items: center; gap: var(--s2); border: 1px solid var(--ink); color: var(--ink); padding: 11px 20px; min-height: 44px; border-radius: 999px; font-size: var(--t-small); }
  .cta:hover { background: var(--ink); color: var(--paper); text-decoration: none; }
  .cta.fill { background: var(--ink); color: var(--paper); }
  .cta.fill:hover { background: var(--ink-strong); border-color: var(--ink-strong); }
  .hero .fine { margin: var(--s5) 0 0; font-size: var(--t-cap); color: var(--ink-soft); letter-spacing: .01em; display: flex; flex-wrap: wrap; gap: var(--s1) 0; }
  .fine span { white-space: nowrap; }
  .fine span:not(:last-child)::after { content: "·"; margin: 0 .6em; }

  /* ---------- shared editorial pieces ---------- */
  .n { font-size: var(--t-eyebrow); line-height: 1.4; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); }
  .n + h2, .n + h3 { margin-top: var(--s3); }
  .sec { border-top: 1px solid var(--line); padding-block: var(--sec); }
  .sec h2 { font-size: var(--t-h2); line-height: 1.05; font-weight: 400; margin: 0 0 var(--s4); letter-spacing: -.01em; text-wrap: balance; max-width: 16em; }
  .sec h2.wide { max-width: none; }
  .sec .n + h2, .sec .n + h3 { margin-top: var(--s3); }
  .sec h2 + .split, .sec h2 + .box, .sec h2 + .compare { margin-top: var(--s6); }
  .sec p { max-width: 30em; }
  .sec p + p, .sec p + table, .sec p + blockquote, .sec p + .panel { margin-top: var(--s4); }
  .sec p.soft, p.cap, cite { color: var(--ink-soft); }
  p.cap { font-size: var(--t-cap); line-height: 1.45; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--gut); align-items: start; }
  .split > * { min-width: 0; }

  /* ---------- pillars ---------- */
  .feats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s7) var(--gut); padding-block: var(--s6) var(--sec); border-top: 1px solid var(--line); }
  .feats > div { min-width: 0; }
  .feats h3 { margin: var(--s3) 0 var(--s2); font-weight: 500; font-size: var(--t-h3); line-height: 1.15; text-wrap: balance; }
  .feats p, .box p { color: var(--ink-soft); font-size: var(--t-small); line-height: 1.5; }

  /* ---------- tables, code, quotes ---------- */
  table.t { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  table.t th, table.t td { text-align: left; padding: var(--s3) 0; border-bottom: 1px solid var(--line); font-weight: 400; vertical-align: baseline; }
  table.t th { font-size: var(--t-eyebrow); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); padding-top: 0; }
  table.t td:last-child, table.t th:last-child { text-align: right; }
  table.t td:last-child { font-size: var(--t-h3); color: var(--ink); white-space: nowrap; }
  table.t tr.amd td { color: var(--ink-soft); }
  table.t + p.cap, .compare + p.cap, .panel + p.cap { margin-top: var(--s3); }
  pre { margin: 0; background: var(--paper-2); border: 1px solid var(--line); border-radius: 10px; padding: var(--s4) 20px; overflow-x: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--t-cap)/1.6 var(--mono); color: var(--ink-strong); }
  pre .c { color: var(--ink-soft); }
  blockquote { margin: 0; padding-left: var(--s4); border-left: 2px solid var(--ink); font-size: 21px; line-height: 1.35; font-style: italic; color: var(--ink-strong); max-width: 30em; }
  blockquote cite { display: block; margin-top: var(--s3); font-size: var(--t-cap); line-height: 1.45; font-style: normal; }
  figure { margin: 0; }
  figure .cap { margin-top: var(--s3); }

  /* ---------- product panels: the UI drawn in the page's own ink ---------- */
  .panel { border: 1px solid var(--line); border-radius: 12px; background: var(--paper); box-shadow: 0 30px 60px -44px rgba(59, 13, 21, .5); overflow: hidden; font-size: var(--t-cap); line-height: 1.4; color: var(--ink-strong); max-width: 100%; }
  .panel .bar { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); background: var(--paper-2); font-size: var(--t-eyebrow); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-soft); }
  .panel .bar b { font-weight: 500; color: var(--ink-strong); letter-spacing: 0; text-transform: none; font-size: var(--t-cap); }
  .panel .live { display: inline-flex; align-items: center; gap: 6px; color: var(--ink); letter-spacing: .08em; }
  .panel .live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ink); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .25; } }
  .panel .rows { display: grid; }
  .panel .row { display: grid; grid-template-columns: 1.2fr 1fr 4em; gap: var(--s3); align-items: baseline; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
  .panel .row:last-child { border-bottom: 0; }
  .panel .row .who { font-weight: 500; }
  .panel .row .who small { display: block; font-weight: 400; color: var(--ink-soft); font-size: var(--t-eyebrow); letter-spacing: 0; font-family: var(--mono); margin-top: 2px; }
  .panel .row .st { color: var(--ink-soft); }
  .panel .row .st q { quotes: "\\201C" "\\201D"; font-style: italic; color: var(--ink-strong); }
  .panel .row .t { font-family: var(--mono); font-size: var(--t-eyebrow); color: var(--ink-soft); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .panel .row.on { background: var(--paper-2); }
  .panel .row.on .st { color: var(--ink); }
  .panel .row.on .t { color: var(--ink); }
  .panel .foot { display: flex; flex-wrap: wrap; gap: var(--s2); padding: var(--s3) var(--s4); border-top: 1px solid var(--line); }
  .panel .chip { border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; min-height: 28px; font: 400 var(--t-eyebrow)/1.4 var(--font); color: var(--ink-soft); background: transparent; letter-spacing: .01em; }
  .panel button.chip { cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
  .panel button.chip:hover { border-color: var(--ink); color: var(--ink); }
  .panel button.chip:active { transform: translateY(1px); }
  .panel .chip.fill, .panel button.chip.fill:hover { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .panel .chip.ok { border-color: var(--ink); color: var(--ink); }
  .panel .row.done .st { color: var(--ink-strong); }
  .panel .row.ring .t::after { content: ""; display: inline-block; width: 5px; height: 5px; margin-left: 6px; border-radius: 50%; background: var(--ink); vertical-align: middle; animation: pulse 1s ease-in-out infinite; }
  .panel .sig { display: grid; grid-template-columns: 7.5em 1fr 5.5em; gap: var(--s3); align-items: start; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
  .panel .sig:last-of-type { border-bottom: 0; }
  .panel .sig .k { font-size: var(--t-eyebrow); letter-spacing: .08em; text-transform: uppercase; color: var(--ink); padding-top: 2px; }
  .panel .sig .k.soft { color: var(--ink-soft); }
  .panel .sig .d small { display: block; color: var(--ink-soft); margin-top: 2px; }
  .panel .sig .t { font-family: var(--mono); font-size: var(--t-eyebrow); color: var(--ink-soft); white-space: nowrap; text-align: right; }
  .panel .rule { padding: var(--s3) var(--s4); border-top: 1px solid var(--line); background: var(--paper-2); color: var(--ink-soft); }
  .panel .rule b { color: var(--ink-strong); font-weight: 500; }
  .panel .chat { padding: var(--s4); display: grid; gap: var(--s3); }
  .panel .msg { max-width: 92%; padding: var(--s2) var(--s3); border-radius: 12px; border: 1px solid var(--line); }
  .panel .msg.me { justify-self: end; background: var(--paper-2); border-color: transparent; }
  .panel .msg .tool { display: inline-block; font-family: var(--mono); font-size: var(--t-eyebrow); color: var(--ink); background: var(--paper); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; margin: 2px 4px 2px 0; }

  /* ---------- comparison ---------- */
  .compare { width: 100%; border-collapse: collapse; font-size: var(--t-small); }
  .compare th, .compare td { text-align: left; padding: var(--s3) var(--s3) var(--s3) 0; border-bottom: 1px solid var(--line); vertical-align: top; font-weight: 400; }
  .compare th { font-size: var(--t-eyebrow); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); padding-top: 0; }
  .compare th:first-child { width: 18%; }
  .compare th:nth-child(2) { width: 40%; }
  .compare td:first-child { color: var(--ink-soft); }
  .compare td.us { color: var(--ink-strong); }
  .compare td.us b { color: var(--ink); font-weight: 500; }
  .compare td.us::before { content: ""; }
  .compare .src { font-size: var(--t-eyebrow); color: var(--ink-soft); letter-spacing: 0; text-transform: none; }
  .sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s6) var(--gut); margin-top: var(--s7); padding-top: var(--s6); border-top: 1px solid var(--line); }
  .sum > div { min-width: 0; }
  .sum .big { font-size: var(--t-h2); line-height: 1; color: var(--ink); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .sum .big small { font-size: var(--t-small); color: var(--ink-soft); letter-spacing: 0; margin-left: 4px; }
  .sum p { margin-top: var(--s3); color: var(--ink-soft); font-size: var(--t-small); }
  .sum .n { margin-bottom: var(--s2); }

  /* ---------- agent fields ---------- */
  .agents { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s7) var(--gut); margin-top: var(--s7); padding-top: var(--s7); border-top: 1px solid var(--line); }
  .agents > div { min-width: 0; }
  .agents h3 { margin: 0 0 var(--s3); font-weight: 500; font-size: var(--t-h3); line-height: 1.15; }
  .agents h3 small { font-weight: 400; color: var(--ink-soft); font-size: var(--t-small); margin-left: var(--s2); }
  .agents pre + p { margin-top: var(--s3); color: var(--ink-soft); font-size: var(--t-small); max-width: 32em; }
  .tools { list-style: none; margin: var(--s3) 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3) var(--gut); font-size: var(--t-small); line-height: 1.5; }
  .tools li { padding-left: var(--s4); position: relative; color: var(--ink-soft); }
  .tools li::before { content: ""; position: absolute; left: 0; top: .62em; width: 6px; height: 6px; border-radius: 50%; background: var(--ink); }
  .tools b { font-weight: 500; color: var(--ink-strong); }
  .guard { margin-top: var(--s7); padding-top: var(--s5); border-top: 1px solid var(--line); font-size: var(--t-small); color: var(--ink-soft); max-width: 44em; }

  /* ---------- "also in the box" ---------- */
  .box { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s7) var(--gut); }
  .box > div { min-width: 0; }
  .box h3 { margin: 0 0 var(--s2); font-weight: 500; font-size: var(--t-h3); line-height: 1.15; }

  /* ---------- footer ---------- */
  footer { position: relative; z-index: 2; overflow: hidden; border-top: 1px solid var(--line); background: var(--paper); }
  .fwrap { position: relative; z-index: 3; display: grid; grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, .6fr)); gap: var(--s6) var(--gut); padding-top: var(--s8); }
  .fwrap > * { min-width: 0; }
  .fbrand p { color: var(--ink-soft); max-width: 26em; margin: var(--s4) 0 0; font-size: var(--t-small); }
  .fbrand .copy { margin-top: var(--s7); color: var(--ink); font-size: var(--t-cap); }
  .col h4 { margin: 0 0 var(--s3); font-weight: 400; font-size: var(--t-eyebrow); letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); line-height: 1.4; }
  .col ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s2); font-size: var(--t-body); }
  .col a { display: inline-block; padding: 6px 0; }
  .col ul { gap: 0; }

  /* the illustration stack */
  .art { position: relative; margin-top: -4.5vw; width: 100%; max-width: 100%; aspect-ratio: 1600 / 679; z-index: 1; pointer-events: none; }
  .layer {
    position: absolute; inset: 0; background: var(--ink);
    -webkit-mask: url(${asset}/scene.png) no-repeat center bottom / 100% auto; mask: url(${asset}/scene.png) no-repeat center bottom / 100% auto;
  }
  .layer.hill { clip-path: inset(0 0 29% 0); transform-origin: 50% 42%; }
  .layer.water { clip-path: inset(71% 0 0 0); }
  .shimmer {
    position: absolute; left: 0; right: 0; bottom: 0; height: 30%; opacity: .38;
    background: repeating-linear-gradient(to bottom, transparent 0 3px, var(--paper) 3px 4px);
    -webkit-mask: linear-gradient(to bottom, transparent, #000 35% 90%, transparent); mask: linear-gradient(to bottom, transparent, #000 35% 90%, transparent);
    animation: crawl 2.8s linear infinite; z-index: 2;
  }
  @keyframes crawl { to { transform: translateY(4px); } }

  .sky { position: absolute; left: 0; top: 16%; width: 100%; height: 22%; overflow: visible; }
  .flock { position: absolute; top: 0; left: 0; width: 300px; height: 117px; animation: fly 34s linear infinite; }
  .flock.b { top: 34%; width: 190px; height: 74px; animation-duration: 47s; animation-delay: -21s; opacity: .8; }
  .flock svg { width: 100%; height: 100%; overflow: visible; }
  .flock path { fill: none; stroke: var(--ink); stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; }
  @keyframes fly { from { transform: translateX(-30vw) translateY(10px); } 50% { transform: translateX(45vw) translateY(-14px); } to { transform: translateX(120vw) translateY(4px); } }

  .boat { position: absolute; bottom: 1.5%; left: 0; width: 11.5%; aspect-ratio: 700 / 205; z-index: 2; animation: drift 82s linear infinite; }
  .boat.far { bottom: 9.5%; width: 7.5%; animation-duration: 118s; animation-delay: -64s; opacity: .85; }
  .boat .hull, .boat .refl { position: absolute; inset: 0; background: var(--ink); -webkit-mask: url(${asset}/boat.png) no-repeat center / contain; mask: url(${asset}/boat.png) no-repeat center / contain; }
  .boat .refl { top: 92%; transform: scaleY(-.55); opacity: .22; -webkit-mask-image: url(${asset}/boat.png), linear-gradient(to top, #000 20%, transparent 85%); mask-image: url(${asset}/boat.png), linear-gradient(to top, #000 20%, transparent 85%); -webkit-mask-composite: source-in; mask-composite: intersect; }
  .boat .bob { position: absolute; inset: 0; animation: bob 4.2s ease-in-out infinite; }
  .boat.far .bob { animation-duration: 5.1s; animation-delay: -2s; }
  @keyframes drift { from { transform: translateX(-120%); } to { transform: translateX(900%); } }
  @keyframes bob { 0%, 100% { transform: translateY(0) rotate(0deg); } 50% { transform: translateY(-2.5px) rotate(-.8deg); } }

  /* reveal: at rest everything is visible; .in plays the entrance once */
  footer.in .layer.hill { animation: hillIn 1.15s cubic-bezier(.2, .7, .2, 1) both; }
  footer.in .layer.water { animation: waterIn 1.1s .18s cubic-bezier(.2, .7, .2, 1) both; }
  footer.in .sky, footer.in .shimmer { animation-name: fadeIn; animation-duration: .9s; animation-delay: .75s; animation-fill-mode: both; }
  footer.in .boat { animation: fadeIn .9s .8s both, drift 82s linear infinite; }
  footer.in .boat.far { animation: fadeIn .9s .9s both, drift 118s linear -64s infinite; }
  footer.in .flock { animation: fadeIn .9s .7s both, fly 34s linear infinite; }
  footer.in .flock.b { animation: fadeIn .9s .9s both, fly 47s linear -21s infinite; }
  footer.in .fwrap > * { animation: textIn .8s cubic-bezier(.2, .7, .2, 1) both; }
  footer.in .fwrap > :nth-child(1) { animation-delay: .55s; }
  footer.in .fwrap > :nth-child(2) { animation-delay: .7s; }
  footer.in .fwrap > :nth-child(3) { animation-delay: .82s; }
  footer.in .fwrap > :nth-child(4) { animation-delay: .94s; }
  @keyframes hillIn { from { opacity: 0; transform: translateY(-16%) scale(.38); filter: blur(14px); } 35% { opacity: .9; } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes waterIn { from { opacity: 0; transform: translateY(9%); filter: blur(6px); } to { opacity: 1; transform: none; filter: blur(0); } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes textIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .replay { position: absolute; right: max(16px, env(safe-area-inset-right, 0px)); bottom: 14px; z-index: 4; background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 999px; font: 500 var(--t-eyebrow)/1 var(--font); padding: 9px 14px; cursor: pointer; letter-spacing: .04em; }
  .replay:hover { border-color: var(--ink); }

  @media (min-width: 1081px) {
    .feats h3 { min-height: 2.3em; }   /* room for two title lines, so the four paragraphs start on one line */
  }
  @media (max-width: 1080px) {
    .feats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .box { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .agents { grid-template-columns: 1fr; }
    .sum { grid-template-columns: 1fr; }
    .fwrap { grid-template-columns: 1fr 1fr; }
    .fbrand { grid-column: 1 / -1; }
  }
  @media (max-width: 820px) {
    :root { --sec: 56px; }
    .hero { padding-block: var(--s7) var(--s8); }
    .hero h1 { margin-bottom: var(--s4); }
    .hero .lead { margin-bottom: var(--s5); }
    nav.top a.sub { display: none; }       /* phone nav: API, GitHub, Sign in */
    .split { grid-template-columns: 1fr; gap: var(--s6); }
    .split.rev > :first-child { order: 2; }
    .feats { grid-template-columns: 1fr; gap: var(--s6); }
    .box { grid-template-columns: 1fr; gap: var(--s5); }
    .tools { grid-template-columns: 1fr; }
    .agents { gap: var(--s6); }
    pre { white-space: pre; overflow-wrap: normal; padding: var(--s3) var(--s4); font-size: 13px; }   /* code scrolls sideways rather than wrapping mid-flag */
    blockquote { font-size: 19px; }
    .panel .row { grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: var(--s1) var(--s3); padding: 10px var(--s4); align-items: start; }
    .panel .row .who { grid-column: 1; grid-row: 1; }
    .panel .row .t { grid-column: 2; grid-row: 1; padding-top: 3px; }
    .panel .row .st { grid-column: 1 / -1; grid-row: 2; }
    .panel .row .who small { margin-top: 1px; }
    .panel .sig { grid-template-columns: 1fr auto; grid-template-rows: auto auto; gap: var(--s1) var(--s3); padding: 10px var(--s4); }
    .panel .sig .k { grid-column: 1; grid-row: 1; padding-top: 0; }
    .panel .sig .t { grid-column: 2; grid-row: 1; }
    .panel .sig .d { grid-column: 1 / -1; grid-row: 2; }
    .panel .bar { padding: 10px var(--s4); }
    .panel .foot { padding: 10px var(--s4); gap: var(--s2) 6px; }
    .panel .row .st { grid-column: 1 / -1; }
    .compare { display: block; overflow-x: auto; }
    .compare table { min-width: 560px; }
    .bgart .scene { width: 230vw; top: 40%; opacity: .045; }
    .bgart .sky { display: none; }
    .fbrand .copy { margin-top: var(--s5); }
    .art { margin-top: var(--s5); aspect-ratio: auto; height: 78vw; max-height: 560px; }
    .layer { -webkit-mask-size: auto 100%; mask-size: auto 100%; -webkit-mask-position: 36% bottom; mask-position: 36% bottom; }
    .boat { width: 26%; bottom: 1%; }
    .boat.far { width: 17%; bottom: 10%; }
    .flock { width: 170px; height: 66px; }
    .flock.b { width: 110px; height: 43px; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .flock, .boat, .boat .bob, .shimmer, .panel .live::before, footer.in * { animation: none !important; }
    .boat { left: 22%; } .boat.far { left: 62%; }
    .flock { left: 30%; } .flock.b { left: 58%; }
  }
`;
}

/** A skillet drawn in one line: the brand mark. */
const mark = `<svg viewBox="0 0 44 30" aria-hidden="true"><circle cx="15" cy="18" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M24.5 18h16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M11 6c-1.5-2 1.5-3 0-5M16 6c-1.5-2 1.5-3 0-5M21 6c-1.5-2 1.5-3 0-5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const flocks = `
      <div class="flock">
        <svg viewBox="0 0 180 70">
          <path><animate attributeName="d" dur="0.55s" repeatCount="indefinite" values="M80 8 Q86 2 92 8 Q98 2 104 8;M80 6 Q86 10 92 6 Q98 10 104 6;M80 8 Q86 2 92 8 Q98 2 104 8"/></path>
          <path><animate attributeName="d" dur="0.62s" begin="0.1s" repeatCount="indefinite" values="M56 22 Q61 17 66 22 Q71 17 76 22;M56 20 Q61 24 66 20 Q71 24 76 20;M56 22 Q61 17 66 22 Q71 17 76 22"/></path>
          <path><animate attributeName="d" dur="0.58s" begin="0.25s" repeatCount="indefinite" values="M104 24 Q109 19 114 24 Q119 19 124 24;M104 22 Q109 26 114 22 Q119 26 124 22;M104 24 Q109 19 114 24 Q119 19 124 24"/></path>
          <path><animate attributeName="d" dur="0.66s" begin="0.05s" repeatCount="indefinite" values="M30 36 Q34 32 38 36 Q42 32 46 36;M30 35 Q34 38 38 35 Q42 38 46 35;M30 36 Q34 32 38 36 Q42 32 46 36"/></path>
          <path><animate attributeName="d" dur="0.6s" begin="0.35s" repeatCount="indefinite" values="M130 40 Q134 36 138 40 Q142 36 146 40;M130 39 Q134 42 138 39 Q142 42 146 39;M130 40 Q134 36 138 40 Q142 36 146 40"/></path>
        </svg>
      </div>
      <div class="flock b">
        <svg viewBox="0 0 180 70">
          <path><animate attributeName="d" dur="0.7s" repeatCount="indefinite" values="M70 20 Q75 15 80 20 Q85 15 90 20;M70 18 Q75 22 80 18 Q85 22 90 18;M70 20 Q75 15 80 20 Q85 15 90 20"/></path>
          <path><animate attributeName="d" dur="0.74s" begin="0.2s" repeatCount="indefinite" values="M100 34 Q104 30 108 34 Q112 30 116 34;M100 33 Q104 36 108 33 Q112 36 116 33;M100 34 Q104 30 108 34 Q112 30 116 34"/></path>
          <path><animate attributeName="d" dur="0.68s" begin="0.4s" repeatCount="indefinite" values="M44 40 Q48 36 52 40 Q56 36 60 40;M44 39 Q48 42 52 39 Q56 42 60 39;M44 40 Q48 36 52 40 Q56 36 60 40"/></path>
        </svg>
      </div>`;

/** The page without a document shell: font link, styles, markup and the reveal script. */
export function landingBody(opts: LandingOptions): string {
  const asset = opts.assetBase ?? '/landing';
  const app = opts.appUrl ?? '/app/';
  const docs = opts.docsUrl ?? '/docs';
  const brand = (label: string) => `<a class="brand" href="#top" aria-label="${label}">${mark}Cooks</a>`;
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400;1,6..72,500&display=swap">
<style>${css(asset)}</style>

<div class="bgart" aria-hidden="true"><div class="scene"></div><div class="fade"></div><div class="sky">${flocks}
</div></div>

<header class="top wrap" id="top">
  ${brand('Cooks home')}
  <nav class="top"><a class="sub" href="#features">Features</a><a class="sub" href="#dialer">Dialer</a><a class="sub" href="#assistant">Assistant</a><a class="sub" href="#compare">Compare</a><a class="sub" href="#selfhost">Self-host</a><a href="${esc(docs)}">API</a><a href="${GITHUB}">GitHub</a><a href="${esc(app)}">Sign in</a></nav>
</header>

<main class="wrap">
  <section class="hero">
    <h1>Let your reps <em>cook</em>.</h1>
    <p class="lead">Cooks is open-source sales engagement you host yourself: sequences, a parallel dialer, buying signals and call coaching on one Postgres. Point Claude, Grok or any MCP client at it and the bot does the typing.</p>
    <div class="ctas"><a class="cta fill" href="${esc(app)}">Open the app</a><a class="cta" href="#selfhost">Self-host in five minutes <span aria-hidden="true">↓</span></a></div>
    <p class="fine"><span>MIT licensed</span><span>One Postgres, no Redis</span><span>66 MCP tools</span><span>Yours to fork</span></p>
  </section>

  <section class="feats" id="features">
    <h2 class="sr">What Cooks does</h2>
    <div><div class="n">Sequencing</div><h3>Cadences that respect the clock</h3><p>Email, call, LinkedIn and manual steps with per-prospect time zones, send windows and daily caps per mailbox. Reply and bounce detection, A/B variants, one-click unsubscribe. AI drafts any email step and hands it to a person when unsure.</p></div>
    <div><div class="n">Dialer</div><h3>Four lines ring, one person answers</h3><p>Reps call on Twilio from the browser or a bridge to their phone. The power dialer rings three or four prospects at once and drops the first human into the rep's ear, with no beep and no message. Machines are hung up before anyone hears them.</p></div>
    <div><div class="n">Signals</div><h3>One feed of reasons to call</h3><p>Email engagement, web research, CRM changes and anything your bot pushes in, as one stream. Rules turn a matching signal into an enrollment or a task. Accounts in active sequences get a web scan every seven days.</p></div>
    <div><div class="n">Coaching</div><h3>Every call gets a scorecard</h3><p>Recorded calls are split by speaker, transcribed, and scored on six parts: opener, discovery, listening, value, objections, next step. Talk ratio, monologues, questions asked and one concrete tip per call.</p></div>
  </section>

  <section class="sec" id="dialer">
    <div class="split">
      <div>
        <div class="n">Fast pickup</div>
        <h2>It hears the hello.</h2>
        <p>The instant a carrier answers, the held line streams the callee's audio back to Cooks. A voice-activity timeline and a small rule judge settle it: "Hello?" followed by silence is a person. "You've reached", a beep or a long monologue is a machine. When the words are unclear, TypeSafe's Jev on OpenRouter makes the call in a few hundred milliseconds.</p>
        <p class="soft">Carrier answering-machine detection keeps running underneath as the fallback. Each line takes exactly one verdict, so whichever detector is slower becomes a no-op.</p>
        <table class="t" aria-label="Time from answer to verdict">
          <thead><tr><th scope="col">Pickup</th><th scope="col">Verdict lands</th></tr></thead>
          <tbody>
            <tr><td>Person saying "Hello?"</td><td>0.8 s</td></tr>
            <tr><td>Voicemail greeting</td><td>1.0 s</td></tr>
            <tr class="amd"><td>Carrier machine detection</td><td>3.0 s</td></tr>
          </tbody>
        </table>
        <p class="cap">Measured on the mock carrier that ships with the repo. Your numbers will depend on the recognizer you pick: OpenAI Realtime, a local Nemotron model through sherpa-onnx, or none.</p>
      </div>
      <div>
        <figure>
          <div class="panel pd" id="pd" aria-label="Power dialer demo: log the connected call, then dial the next batch">
            <div class="bar"><b>Power dialer</b><span class="live" id="pd-live">Live · batch 3 of 12</span></div>
            <div class="rows" id="pd-rows" aria-live="polite">
              <div class="row on"><div class="who">Maya Chen<small>+1 415 555 0142 · Globex</small></div><div class="st">person · heard <q>Hello?</q></div><div class="t">0.8 s</div></div>
              <div class="row"><div class="who">Dev Patel<small>+1 312 555 0199 · Initech</small></div><div class="st">voicemail · heard <q>you've reached</q></div><div class="t">1.0 s</div></div>
              <div class="row"><div class="who">Sam Okafor<small>+1 646 555 0127 · Hooli</small></div><div class="st">hung up, rep is busy</div><div class="t">0:06</div></div>
              <div class="row"><div class="who">Lena Fischer<small>+1 206 555 0163 · Vandelay</small></div><div class="st">no answer · callback task made</div><div class="t">0:31</div></div>
            </div>
            <div class="foot" id="pd-foot"><span class="chip fill">Talking to Maya Chen</span><button class="chip" type="button" data-log="Meeting booked">Meeting booked</button><button class="chip" type="button" data-log="Left voicemail">Left voicemail</button><button class="chip" type="button" data-log="Not interested">Not interested</button><button class="chip" type="button" data-hangup>Hang up</button></div>
          </div>
          <figcaption class="cap">One batch as the rep sees it, with example names. Log the call with a disposition, then dial the next batch and watch the gate settle each line. The clock runs four times faster than life.</figcaption>
        </figure>
      </div>
    </div>
  </section>

  <section class="sec" id="signals">
    <div class="split">
      <div>
        <div class="n">Signals</div>
        <h2>Call when there is a reason.</h2>
        <p>Every engagement event, web find, CRM change and reply lands in one feed with the prospect and account attached. Rules watch the feed and act: a second click in a week enrolls the prospect in a follow-up and puts a task in front of the owner.</p>
        <p class="soft">Your bot can push its own signals through the API, so research it does in the morning shows up as reasons to call in the afternoon.</p>
      </div>
      <div>
        <figure>
          <div class="panel" role="img" aria-label="The signals feed with four recent signals and the rule that acts on them">
            <div class="bar"><b>Signals</b><span>This week · 14 new</span></div>
            <div class="sig"><div class="k">Clicked ×2</div><div class="d">Maya Chen opened the pricing link twice<small>Q4 outbound, step 3 · Globex</small></div><div class="t">2 h ago</div></div>
            <div class="sig"><div class="k soft">Hiring</div><div class="d">Initech posted three SDR roles<small>Weekly web scan · careers page</small></div><div class="t">Yesterday</div></div>
            <div class="sig"><div class="k soft">Deal stage</div><div class="d">Hooli moved to Evaluation<small>HubSpot sync</small></div><div class="t">Mon</div></div>
            <div class="sig"><div class="k soft">Replied</div><div class="d">Lena Fischer: "loop in my VP"<small>Classified as a referral, confidence 0.92</small></div><div class="t">Mon</div></div>
            <div class="rule"><b>Rule</b> · clicked twice within 7 days → enroll in Hot follow-up, task for the owner</div>
          </div>
          <figcaption class="cap">The feed and one rule. Example data.</figcaption>
        </figure>
      </div>
    </div>
  </section>

  <section class="sec" id="assistant">
    <div class="n">Your bot is the brain</div>
    <h2>Sixty-six tools, zero tokens of ours.</h2>
    <div class="split">
      <div>
        <p>Cooks ships an MCP server, so the assistant you already pay for can research an account, enroll the prospect, draft the email, place the call and log the outcome. It is a thin client over the REST API: it runs on a laptop against a hosted Cooks, or next to the API for the whole team. In that mode Cooks spends no tokens of its own.</p>
        <p class="soft">Prefer hosted agents? Give a workspace its own key on Anthropic, xAI, OpenAI, OpenRouter or Ollama. Drafts, reply classification and research then run in the worker with a ledger of every run's tokens and cost.</p>
        <div class="panel" role="img" aria-label="A chat with an assistant that uses Cooks tools to find accounts, enroll prospects and place a call">
          <div class="bar"><b>Claude Code</b><span>cooks · 66 tools</span></div>
          <div class="chat">
            <div class="msg me">Find the three accounts with the strongest signals this week, enroll their champions in the Q4 sequence, and call the one who clicked twice.</div>
            <div class="msg">Strongest this week: Globex, Initech, Hooli. <span class="tool">cooks_list_signals</span><br>Enrolled Maya Chen, Dev Patel and Sam Okafor in Q4 outbound. <span class="tool">cooks_enroll_prospect</span> ×3<br>Maya clicked twice, so I'm ringing her now and will log the outcome. <span class="tool">cooks_dial</span></div>
          </div>
        </div>
        <p class="cap">What a session looks like once the server is connected. Cooks does the work with your rules, your mailboxes and your audit trail.</p>
      </div>
      <div>
        <div class="n">What the tools cover</div>
        <ul class="tools">
          <li><b>Prospects and accounts.</b> Find, create, update, tag, add notes.</li>
          <li><b>Sequences and steps.</b> Build, edit, reorder; draft a whole sequence from a brief.</li>
          <li><b>Enrollments.</b> Enroll, pause, resume, finish, with the rules enforced.</li>
          <li><b>Task queue.</b> List, complete and skip what is due today.</li>
          <li><b>Dialer.</b> Place a call, hand one to a Speko voice agent, fetch the transcript, log it.</li>
          <li><b>Power dialer.</b> Start a session, dial the next batch, see who answered.</li>
          <li><b>Inbox.</b> Read the unified inbox, send SMS and iMessage with consent checks.</li>
          <li><b>Email.</b> Draft, send, and import mail that happened outside Cooks.</li>
        </ul>
      </div>
    </div>

    <div class="agents">
      <div>
        <h3>Claude Code</h3>
        <pre>claude mcp add cooks \\
  -e COOKS_API_URL=${esc(opts.publicUrl)} \\
  -e COOKS_API_KEY=cooks-api-... \\
  -- npx -y ${esc(opts.release)}</pre>
        <p>Create the key under Settings, then API keys. The tarball on GitHub Releases is the distribution; nothing is published to npm.</p>
      </div>
      <div>
        <h3>Claude Desktop <small>and Cursor</small></h3>
        <pre>{
  "mcpServers": {
    "cooks": {
      "command": "npx",
      "args": ["-y", "${esc(opts.release)}"],
      "env": { "COOKS_API_URL": "${esc(opts.publicUrl)}", "COOKS_API_KEY": "cooks-api-..." }
    }
  }
}</pre>
        <p>Paste into <code>claude_desktop_config.json</code> or <code>.cursor/mcp.json</code>. Windsurf and Codex take the same shape.</p>
      </div>
      <div>
        <h3>Grok</h3>
        <pre>pnpm --filter cooks-mcp dev          <span class="c"># hosts https://your-host/mcp</span>
<span class="c"># grok.com/connectors → New connector → Custom</span>
<span class="c">#   URL    https://your-host/mcp</span>
<span class="c">#   then sign in when Grok asks</span></pre>
        <p>Grok runs the OAuth sign-in in a pop-up, so each person signs in with their own account and approves scopes. The host has to be reachable from the public internet.</p>
      </div>
      <div>
        <h3>claude.ai <small>and remote clients</small></h3>
        <pre>claude mcp add --transport http cooks https://your-host/mcp
<span class="c"># or paste https://your-host/mcp as a claude.ai connector</span></pre>
        <p>No key to share. The client gets a 401 with OAuth discovery, registers itself, and each person signs in and approves scopes for one workspace. Tokens carry their role, so a rep cannot delete a sequence they do not own.</p>
      </div>
    </div>
    <p class="guard">Nothing goes to a prospect unless a person confirms the draft, and suppression lists, unsubscribes and daily caps are enforced in the send pipeline where the model cannot reach them. Tool errors carry the API's error envelope, so the assistant sees "already enrolled" and recovers on its own.</p>
  </section>

  <section class="sec" id="more">
    <div class="n">Also in the box</div>
    <h2 class="wide">Everything a floor needs, on one database.</h2>
    <div class="box">
      <div><h3>Mailboxes</h3><p>Gmail, Microsoft 365 or SMTP, with inbound sync for replies and bounces.</p></div>
      <div><h3>Inkbox channels</h3><p>An email address, an SMS number and an iMessage line per rep, with one inbox and STOP honored.</p></div>
      <div><h3>HubSpot</h3><p>Contact and company sync, auto-enroll from a list or deal stage, calls and email on the timeline.</p></div>
      <div><h3>Voice agents</h3><p>A Speko agent places the call from a script and brings back the outcome, transcript and recording.</p></div>
      <div><h3>Drop-in API</h3><p>Same paths, envelopes and paging as the commercial API it mirrors. Existing clients change one base URL.</p></div>
      <div><h3>Webhooks</h3><p>Signed, retried events for calls, emails, enrollments, tasks and prospects.</p></div>
      <div><h3>Sign-in your way</h3><p>API keys, OAuth 2.1 with PKCE, or Clerk SSO. Secrets encrypted at rest with a key you hold.</p></div>
      <div><h3>Web app</h3><p>Tasks, prospects, sequences, emails, calls, dialer, signals and settings. Light and dark.</p></div>
    </div>
  </section>

  <section class="sec" id="compare">
    <div class="n">Compared</div>
    <h2 class="wide">What a floor pays to dial.</h2>
    <p>Nooks and Orum are good products that charge per seat behind a sales call. Cooks is the same shape of product under MIT, so what recurs is the phone company's bill and whatever runs your server.</p>
    <table class="compare">
      <thead><tr><th scope="col"></th><th scope="col">Cooks</th><th scope="col">Nooks</th><th scope="col">Orum</th></tr></thead>
      <tbody>
        <tr><td>License</td><td class="us"><b>Free, MIT.</b> No per-seat fee.</td><td>Custom quote</td><td>Custom quote</td></tr>
        <tr><td>Pricing published</td><td class="us">This page</td><td>No, "get in touch"</td><td>No, "based on package and users"</td></tr>
        <tr><td>Minimum seats</td><td class="us">None</td><td>Not published</td><td>Nine</td></tr>
        <tr><td>Parallel dialer</td><td class="us">Four lines, first person wins, hears the pickup</td><td>Yes</td><td>Yes, on the Ascend plan</td></tr>
        <tr><td>Telephony</td><td class="us">Twilio at its published rate: $0.014 a minute in the US, $1.15 a month per number</td><td>Not published</td><td>Not published</td></tr>
        <tr><td>Try it</td><td class="us">Whole product, locally, against a mock carrier, for as long as you like</td><td>Not published</td><td>Trial capped at 500 dials</td></tr>
        <tr><td>Where the data lives</td><td class="us">Your Postgres, your server</td><td>Their cloud</td><td>Their cloud</td></tr>
        <tr><td>Driven by your assistant</td><td class="us">66 MCP tools for Claude, Grok, Cursor</td><td>Not on their public pages</td><td>Not on their public pages</td></tr>
      </tbody>
    </table>
    <p class="cap">Nooks, Orum and Twilio facts read from their pricing pages in October 2026, linked in the footer. Check them before you buy, since they change.</p>
    <div class="sum">
      <div><div class="n">Ten seats, reported</div><div class="big">$7.8k–18k<small>a year on Nooks</small></div><p>Buyers report $65 to $150 per user per month (Vendr, February 2026). The list quote is said to run higher.</p></div>
      <div><div class="n">Ten seats, reported</div><div class="big">$12k–24k<small>a year on Orum</small></div><p>Buyers report $100 to $200 per user per month (Vendr, February 2026), and nine seats is the floor.</p></div>
      <div><div class="n">Ten seats on Cooks</div><div class="big">$0<small>a year in licenses</small></div><p>100,000 outbound minutes cost about $1,400 at Twilio's rate, ten numbers $138, plus whatever your server costs.</p></div>
    </div>
  </section>

  <section class="sec" id="selfhost">
    <div class="split">
      <div>
        <div class="n">Self-host</div>
        <h2>Five commands and a Postgres.</h2>
        <p>Node 22, pnpm 9 and Postgres 15 or newer. Jobs, rate limits, the webhook outbox and MCP sessions all live in that one database, so there is nothing else to operate. Bootstrap prints a workspace API key once, and the app is at <code>/app</code>.</p>
        <p class="soft">Docker Compose brings up Postgres, the API, the worker, the MCP server and Mailpit in one line. Production notes, Twilio setup and the mock carrier for trying the dialer without an account are in the <a href="${DOC('self-host')}">self-hosting guide</a>.</p>
      </div>
      <div>
        <pre>git clone ${GITHUB}.git &amp;&amp; cd cooks
pnpm install
createdb cooks &amp;&amp; cp .env.example .env
pnpm bootstrap --email you@example.com --workspace "My Team"
pnpm --filter @cooks/api dev    <span class="c"># http://localhost:8080</span>
pnpm --filter @cooks/worker dev <span class="c"># engine, mail, webhooks, AI</span></pre>
      </div>
    </div>
  </section>
</main>

<footer id="footer">
  <div class="wrap fwrap">
    <div class="fbrand">
      ${brand('Cooks home')}
      <p>Open-source sales engagement, built from public documentation and meant to be forked. The service layer is the one place the rules live; the API, worker and MCP server all call it in process.</p>
      <div class="copy">Cooks © 2026, MIT. An independent project, not affiliated with or endorsed by Nooks.</div>
    </div>
    <div class="col"><h4>Product</h4><ul><li><a href="${esc(app)}">Open the app</a></li><li><a href="${esc(docs)}">API reference</a></li><li><a href="${GITHUB}">GitHub</a></li><li><a href="${GITHUB}/releases/latest">Releases</a></li></ul></div>
    <div class="col"><h4>Guides</h4><ul><li><a href="${DOC('self-host')}">Self-hosting</a></li><li><a href="${DOC('mcp')}">Connect an assistant</a></li><li><a href="${DOC('dialer')}">Dialer</a></li><li><a href="${DOC('coaching')}">Coaching</a></li><li><a href="${DOC('signals')}">Signals</a></li></ul></div>
    <div class="col"><h4>Project</h4><ul><li><a href="https://www.nooks.ai/pricing">Nooks pricing</a></li><li><a href="https://www.orum.com/pricing">Orum pricing</a></li><li><a href="https://www.twilio.com/en-us/voice/pricing/us">Twilio voice rates</a></li><li><a href="${GITHUB}/blob/main/LICENSE">MIT License</a></li><li><a href="${GITHUB}/blob/main/SECURITY.md">Security</a></li><li><a href="${GITHUB}/blob/main/CONTRIBUTING.md">Contributing</a></li><li><a href="${DOC('api-compat')}">API compatibility</a></li></ul></div>
  </div>

  <div class="art" aria-hidden="true">
    <div class="layer hill"></div>
    <div class="layer water"></div>
    <div class="shimmer"></div>
    <div class="sky">${flocks}
    </div>
    <div class="boat"><div class="bob"><div class="refl"></div><div class="hull"></div></div></div>
    <div class="boat far"><div class="bob"><div class="refl"></div><div class="hull"></div></div></div>
  </div>
  <button class="replay" id="replay" type="button">Replay reveal</button>
</footer>

<script>
  (function () {
    // Power dialer demo: scripted batches, a 4x clock, the same verdict timings the gate produces.
    var rows = document.getElementById('pd-rows'), foot = document.getElementById('pd-foot'), live = document.getElementById('pd-live');
    if (!rows || !foot || !live) return;
    var BATCHES = [
      [{ n: 'Maya Chen', p: '+1 415 555 0142', c: 'Globex', v: 'human', at: 0.8, q: 'Hello?' }, { n: 'Dev Patel', p: '+1 312 555 0199', c: 'Initech', v: 'voicemail', at: 1.0, q: "you've reached" }, { n: 'Sam Okafor', p: '+1 646 555 0127', c: 'Hooli', v: 'busy' }, { n: 'Lena Fischer', p: '+1 206 555 0163', c: 'Vandelay', v: 'noanswer', at: 31 }],
      [{ n: 'Priya Nair', p: '+1 512 555 0188', c: 'Acme', v: 'voicemail', at: 1.1, q: 'leave a message' }, { n: 'Tom Walsh', p: '+1 617 555 0134', c: 'Stark', v: 'human', at: 0.9, q: 'Hi, this is Tom' }, { n: 'Ana Costa', p: '+1 305 555 0171', c: 'Wayne', v: 'noanswer', at: 28 }, { n: 'Omar Haddad', p: '+1 206 555 0115', c: 'Umbrella', v: 'busy' }],
      [{ n: 'Grace Liu', p: '+1 408 555 0122', c: 'Soylent', v: 'human', at: 0.7, q: 'Hello, Grace speaking' }, { n: 'Jonas Berg', p: '+1 303 555 0149', c: 'Tyrell', v: 'voicemail', at: 1.2, q: 'not available' }, { n: 'Ravi Menon', p: '+1 212 555 0106', c: 'Cyberdyne', v: 'busy' }, { n: 'Elena Rossi', p: '+1 737 555 0160', c: 'Oscorp', v: 'machine', at: 3.0, q: '' }],
    ];
    var SPEED = 4, TICK = 250, batchNo = 3, bi = 0, lines, timers = [], clock = 0, human = -1, logged = null;
    function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
    function mmss(sec) { sec = Math.floor(sec); return Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60); }
    function status(l) {
      if (l.state === 'ring') return 'ringing';
      if (l.state === 'human') return 'person · heard <q>' + esc(l.q) + '</q>';
      if (l.state === 'voicemail') return 'voicemail · heard <q>' + esc(l.q) + '</q>';
      if (l.state === 'machine') return 'machine · carrier detection';
      if (l.state === 'busy') return 'hung up, rep is busy';
      if (l.state === 'noanswer') return 'no answer · callback task made';
      if (l.state === 'hungup') return 'hung up · log the call';
      if (l.state === 'logged') return 'logged · ' + esc(l.outcome);
      return '';
    }
    function tcell(l) { return l.state === 'human' || l.state === 'voicemail' || l.state === 'logged' || l.state === 'hungup' ? (l.at < 10 ? l.at.toFixed(1) + ' s' : mmss(l.at)) : l.state === 'machine' ? l.at.toFixed(1) + ' s' : mmss(l.settledAt != null ? l.settledAt : clock); }
    function render() {
      var h = '';
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i], cls = 'row' + (l.state === 'ring' ? ' ring' : '') + (i === human && (l.state === 'human' || l.state === 'hungup') ? ' on' : '') + (l.state === 'logged' ? ' done' : '');
        h += '<div class="' + cls + '"><div class="who">' + esc(l.n) + '<small>' + esc(l.p) + ' · ' + esc(l.c) + '</small></div><div class="st">' + status(l) + '</div><div class="t">' + tcell(l) + '</div></div>';
      }
      rows.innerHTML = h;
      var f = '';
      var settled = lines.every(function (l) { return l.state !== 'ring'; });
      if (human >= 0 && lines[human].state !== 'logged') {
        f += '<span class="chip fill">' + (lines[human].state === 'hungup' ? 'Call ended' : 'Talking to ' + esc(lines[human].n)) + '</span>';
        ['Meeting booked', 'Left voicemail', 'Not interested'].forEach(function (o) { f += '<button class="chip" type="button" data-log="' + o + '">' + o + '</button>'; });
        if (lines[human].state !== 'hungup') f += '<button class="chip" type="button" data-hangup>Hang up</button>';
      } else if (human >= 0) {
        f += '<span class="chip ok">Logged: ' + esc(lines[human].outcome) + '</span><button class="chip fill" type="button" data-next>Dial next batch</button>';
      } else if (settled) {
        f += '<span class="chip">No one answered</span><button class="chip fill" type="button" data-next>Dial next batch</button>';
      } else {
        f += '<span class="chip">Ringing ' + lines.filter(function (l) { return l.state === 'ring'; }).length + ' lines</span>';
      }
      foot.innerHTML = f;
      live.textContent = 'Live · batch ' + batchNo + ' of 12';
    }
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function start(script) {
      clear(); clock = 0; human = -1; logged = null;
      lines = script.map(function (x) { return { n: x.n, p: x.p, c: x.c, v: x.v, at: x.at, q: x.q, state: 'ring', settledAt: null }; });
      render();
      var tick = function () { clock += TICK / 1000 * SPEED; if (lines.some(function (l) { return l.state === 'ring'; })) { render(); later(TICK, tick); } };
      later(TICK, tick);
      lines.forEach(function (l, i) {
        if (l.v === 'human') later(l.at * 1000, function () {
          if (human >= 0) return;
          human = i; l.state = 'human';
          lines.forEach(function (o) { if (o.v === 'busy' && o.state === 'ring') { o.state = 'busy'; o.settledAt = clock + 0.3; } });
          render();
        });
        else if (l.v === 'voicemail' || l.v === 'machine') later(l.at * 1000, function () { if (l.state === 'ring') { l.state = l.v; render(); } });
        else if (l.v === 'noanswer') later(l.at * 1000 / SPEED, function () { if (l.state === 'ring') { l.state = 'noanswer'; l.settledAt = l.at; render(); } });
        else if (l.v === 'busy') later(6000, function () { if (l.state === 'ring') { l.state = 'noanswer'; l.settledAt = clock; render(); } });
      });
    }
    function seed() {
      // resting state = batch 3 fully settled, as printed in the HTML
      lines = BATCHES[0].map(function (x) { return { n: x.n, p: x.p, c: x.c, v: x.v, at: x.at, q: x.q, state: x.v === 'busy' ? 'busy' : x.v, settledAt: x.v === 'busy' ? 6 : x.v === 'noanswer' ? 31 : null }; });
      human = 0; render();
    }
    foot.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-log')) { lines[human].state = 'logged'; lines[human].outcome = b.getAttribute('data-log'); render(); }
      else if (b.hasAttribute('data-hangup')) { lines[human].state = 'hungup'; render(); }
      else if (b.hasAttribute('data-next')) { bi = (bi + 1) % BATCHES.length; batchNo = batchNo >= 12 ? 1 : batchNo + 1; start(BATCHES[bi]); }
    });
    seed();
  })();
  (function () {
    var f = document.getElementById('footer');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function play() {
      if (reduce) return;
      f.classList.remove('in');
      void f.offsetWidth;
      f.classList.add('in');
    }
    if ('IntersectionObserver' in window) {
      var seen = false;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !seen) { seen = true; play(); io.disconnect(); }
        });
      }, { threshold: 0.28 });
      io.observe(f);
    }
    document.getElementById('replay').addEventListener('click', play);
  })();
</script>`;
}

export function landingHtml(opts: LandingOptions): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark">
<title>Cooks: open-source sales engagement</title>
<meta name="description" content="Cooks is a free, self-hosted sales engagement platform: sequences, a parallel dialer, buying signals and call coaching, driven by the Claude or Grok assistant you already use.">
<meta property="og:title" content="Cooks"><meta property="og:description" content="Open-source sales engagement your own AI assistant can run."></head>
<body>${landingBody(opts)}
</body></html>`;
}
