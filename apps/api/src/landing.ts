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
  /* Layout: one column of calm prose on paper; sections separated by hairlines, not cards; the footer is a single-ink river scene the text sits above. */
  :root {
    --paper: #fffbf9;          /* page ground: white with a breath of warmth */
    --paper-2: #fff1ee;        /* code blocks, table bands */
    --ink: #c41e3a;            /* the one illustration/link ink */
    --ink-strong: #3b0d15;     /* headings and body copy */
    --ink-soft: #a06a72;       /* muted copy, labels */
    --line: rgba(196, 30, 58, .2);
    --font: "Newsreader", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
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
    font-family: var(--font); font-size: 17px; line-height: 1.5;
    -webkit-font-smoothing: antialiased; overflow-x: hidden;
  }
  a { color: var(--ink); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: .18em; }
  a:focus-visible, button:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: 2px; }
  code { font-family: var(--mono); font-size: .88em; }
  .wrap {
    max-width: 1240px; margin: 0 auto;
    padding-left: max(24px, env(safe-area-inset-left, 0px));
    padding-right: max(24px, env(safe-area-inset-right, 0px));
  }

  /* ---------- header ---------- */
  header.top { padding-block: 22px; display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
  .brand { display: inline-flex; align-items: center; gap: 12px; color: var(--ink-strong); font-size: 22px; font-weight: 500; letter-spacing: .01em; }
  .brand:hover { text-decoration: none; }
  .brand svg { width: 44px; height: 30px; display: block; color: var(--ink); }
  nav.top { display: flex; flex-wrap: wrap; gap: 6px 26px; font-size: 16px; }

  /* ---------- hero ---------- */
  .hero { padding-block: 10vh 8vh; max-width: 780px; }
  .hero h1 { font-size: clamp(42px, 7vw, 84px); line-height: .98; font-weight: 400; margin: 0 0 22px; letter-spacing: -.015em; text-wrap: balance; }
  .hero h1 em { font-style: italic; color: var(--ink); }
  .hero p { font-size: clamp(18px, 1.6vw, 22px); color: var(--ink-soft); max-width: 34em; margin: 0 0 30px; }
  .ctas { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .cta { display: inline-flex; align-items: center; gap: 10px; border: 1px solid var(--ink); color: var(--ink); padding: 11px 20px; border-radius: 999px; font-size: 16px; }
  .cta:hover { background: var(--ink); color: var(--paper); text-decoration: none; }
  .cta.fill { background: var(--ink); color: var(--paper); }
  .cta.fill:hover { background: var(--ink-strong); border-color: var(--ink-strong); }
  .fine { margin: 26px 0 0; font-size: 14.5px; color: var(--ink-soft); letter-spacing: .01em; display: flex; flex-wrap: wrap; gap: 4px 0; }
  .fine span { white-space: nowrap; }
  .fine span + span::before { content: "·"; margin: 0 .6em; }

  /* ---------- pillars ---------- */
  .feats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 32px; padding-block: 28px 10vh; border-top: 1px solid var(--line); }
  .feats > div { min-width: 0; }
  .feats h3 { margin: 22px 0 8px; font-weight: 500; font-size: 21px; line-height: 1.2; text-wrap: balance; }
  .feats p { margin: 0; color: var(--ink-soft); font-size: 16px; }
  .n { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); }

  /* ---------- editorial sections ---------- */
  .sec { border-top: 1px solid var(--line); padding-block: 8vh; }
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 56px; align-items: start; }
  .split > * { min-width: 0; }
  .sec h2 { font-size: clamp(30px, 3.6vw, 46px); line-height: 1.05; font-weight: 400; margin: 10px 0 18px; letter-spacing: -.01em; text-wrap: balance; }
  .sec p { margin: 0 0 16px; max-width: 36em; }
  .sec p.soft { color: var(--ink-soft); }
  .sec p:last-child { margin-bottom: 0; }
  .shot { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--paper-2); box-shadow: 0 30px 60px -40px rgba(59, 13, 21, .45); max-width: 100%; }
  .shot img { display: block; width: 100%; height: auto; }
  .cap { margin-top: 10px; font-size: 14px; color: var(--ink-soft); }
  table.t { width: 100%; border-collapse: collapse; margin: 22px 0 6px; font-variant-numeric: tabular-nums; }
  table.t th, table.t td { text-align: left; padding: 10px 0; border-bottom: 1px solid var(--line); font-weight: 400; }
  table.t th { font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); }
  table.t td:last-child, table.t th:last-child { text-align: right; }
  table.t td:last-child { font-size: 22px; color: var(--ink); }
  table.t tr.amd td { color: var(--ink-soft); }
  table.t tr.amd td:last-child { color: var(--ink-soft); }
  pre { margin: 0; background: var(--paper-2); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; overflow-x: auto; font: 13.5px/1.6 var(--mono); color: var(--ink-strong); }
  pre .c { color: var(--ink-soft); }
  blockquote { margin: 22px 0 0; padding-left: 18px; border-left: 2px solid var(--ink); font-size: 21px; line-height: 1.35; font-style: italic; color: var(--ink-strong); max-width: 30em; }
  blockquote cite { display: block; margin-top: 10px; font-size: 14px; font-style: normal; color: var(--ink-soft); }
  .logos { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 22px; font-size: 15px; color: var(--ink-soft); }

  /* ---------- "also in the box" ---------- */
  .box { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 36px 32px; margin-top: 34px; }
  .box > div { min-width: 0; }
  .box h3 { margin: 0 0 8px; font-weight: 500; font-size: 20px; line-height: 1.2; }
  .box p { margin: 0; color: var(--ink-soft); font-size: 16px; }

  /* ---------- footer ---------- */
  footer { position: relative; overflow: hidden; border-top: 1px solid var(--line); }
  .fwrap { position: relative; z-index: 3; display: grid; grid-template-columns: minmax(0, 1.3fr) repeat(3, minmax(0, .6fr)); gap: 40px; padding-top: 56px; }
  .fwrap > * { min-width: 0; }
  .fbrand p { color: var(--ink-soft); max-width: 26em; margin: 14px 0 0; font-size: 15.5px; }
  .fbrand .copy { margin-top: 56px; color: var(--ink); font-size: 15px; }
  .col h4 { margin: 0 0 14px; font-weight: 400; font-size: 12.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-soft); }
  .col ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 9px; font-size: 18px; }

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

  .replay { position: absolute; right: max(16px, env(safe-area-inset-right, 0px)); bottom: 14px; z-index: 4; background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 999px; font: 500 13px/1 var(--font); padding: 9px 14px; cursor: pointer; letter-spacing: .04em; }
  .replay:hover { border-color: var(--ink); }

  @media (max-width: 1080px) {
    .feats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .box { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .fwrap { grid-template-columns: 1fr 1fr; gap: 28px; }
    .fbrand { grid-column: 1 / -1; }
  }
  @media (max-width: 820px) {
    .hero { padding-block: 7vh 6vh; }
    .split { grid-template-columns: 1fr; gap: 30px; }
    .split.rev > :first-child { order: 2; }
    .feats { grid-template-columns: 1fr; gap: 12px; }
    .box { grid-template-columns: 1fr; gap: 24px; }
    .fbrand .copy { margin-top: 24px; }
    nav.top { gap: 4px 18px; font-size: 15px; }
    .art { margin-top: 24px; aspect-ratio: auto; height: 78vw; max-height: 560px; }
    .layer { -webkit-mask-size: auto 100%; mask-size: auto 100%; -webkit-mask-position: 36% bottom; mask-position: 36% bottom; }
    .boat { width: 26%; bottom: 1%; }
    .boat.far { width: 17%; bottom: 10%; }
    .flock { width: 170px; height: 66px; }
    .flock.b { width: 110px; height: 43px; }
  }
  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    .flock, .boat, .boat .bob, .shimmer, footer.in * { animation: none !important; }
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

<header class="top wrap" id="top">
  ${brand('Cooks home')}
  <nav class="top"><a href="#features">Features</a><a href="#dialer">Dialer</a><a href="#assistant">Assistant</a><a href="#selfhost">Self-host</a><a href="${esc(docs)}">API</a><a href="${GITHUB}">GitHub</a><a href="${esc(app)}">Sign in</a></nav>
</header>

<main class="wrap">
  <section class="hero">
    <h1>Let your reps <em>cook</em>.</h1>
    <p>Cooks is open-source sales engagement you host yourself: sequences, a parallel dialer, buying signals and call coaching on one Postgres. Point Claude, Grok or any MCP client at it and the bot does the typing.</p>
    <div class="ctas"><a class="cta fill" href="${esc(app)}">Open the app</a><a class="cta" href="#selfhost">Self-host in five minutes <span aria-hidden="true">↓</span></a></div>
    <p class="fine"><span>MIT licensed</span><span>One Postgres, no Redis</span><span>66 MCP tools</span><span>Independent of Nooks</span></p>
  </section>

  <section class="feats" id="features">
    <div><div class="n">Sequencing</div><h3>Cadences that respect the clock</h3><p>Email, call, LinkedIn and manual steps with per-prospect time zones, send windows, daily caps and spacing per mailbox. Merge fields in strict templates, A/B variants, reply and bounce detection, out-of-office handling and one-click unsubscribe. AI drafts any email step and hands it to a person when it is unsure.</p></div>
    <div><div class="n">Dialer</div><h3>Four lines ring, one person answers</h3><p>Reps call on Twilio from the browser or through a bridge that rings their phone first. The power dialer rings three or four prospects at once and drops the first human into the rep's ear with no beep and no message. Machines are hung up before anyone hears them.</p></div>
    <div><div class="n">Signals</div><h3>One feed of reasons to call</h3><p>Email engagement, web research, CRM changes and anything your bot pushes in through the API, in one stream. Rules turn a matching signal into an enrollment or a task. Accounts in active sequences get a web scan every seven days.</p></div>
    <div><div class="n">Coaching</div><h3>Every call gets a scorecard</h3><p>Recorded calls are split by speaker, transcribed through any OpenAI-compatible endpoint, and scored on six parts: opener, discovery, listening, value, objections, next step. Talk ratio, monologues, questions asked and one concrete tip per call.</p></div>
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
        <figure style="margin:0">
          <div class="shot"><img src="${asset}/power-dialer.png" alt="The power dialer console with one prospect connected, two lines settled as voicemail and no answer, and the words the gate heard" width="1360" height="900" loading="lazy"></div>
          <figcaption class="cap">The console shows which detector won and the first words heard. Voicemail drop and dispositions sit one keystroke away.</figcaption>
        </figure>
      </div>
    </div>
  </section>

  <section class="sec" id="assistant">
    <div class="split rev">
      <div>
        <pre><span class="c"># Claude Code, Claude Desktop, Cursor or Grok</span>
claude mcp add cooks \\
  -e COOKS_API_URL=${esc(opts.publicUrl)} \\
  -e COOKS_API_KEY=cooks-api-... \\
  -- npx -y ${esc(opts.release)}</pre>
        <blockquote>"Find the three accounts with the strongest signals this week, enroll their champions in the Q4 sequence, and call the one who clicked twice."<cite>Something you can say once the server is connected. Cooks does it with your rules, your mailboxes and your audit trail.</cite></blockquote>
      </div>
      <div>
        <div class="n">Your bot is the brain</div>
        <h2>Sixty-six tools, zero tokens of ours.</h2>
        <p>Cooks ships an MCP server, so the assistant you already pay for can research an account, enroll the prospect, draft the email, place the call and log the outcome. In that mode Cooks spends no tokens of its own.</p>
        <p class="soft">Prefer hosted agents? Give a workspace its own key on Anthropic, xAI, OpenAI, OpenRouter or Ollama. Drafts, reply classification and research run in the worker, with a ledger of every run's tokens and cost, and anything the model is unsure about becomes a task for a human.</p>
        <div class="logos"><span>Claude Code</span><span>Claude Desktop</span><span>claude.ai connectors</span><span>Cursor</span><span>Grok</span></div>
      </div>
    </div>
  </section>

  <section class="sec" id="more">
    <div class="n">Also in the box</div>
    <h2>Everything a floor needs, on one database.</h2>
    <div class="box">
      <div><h3>Mailboxes</h3><p>Gmail, Microsoft 365 and plain SMTP, with inbound sync for replies and bounces. Threading, tracking and suppression lists are built in.</p></div>
      <div><h3>Inkbox channels</h3><p>Every rep or agent gets an email address, an SMS number and an iMessage line. Replies land in one inbox, texts respect consent and quiet hours, and STOP opts the prospect out.</p></div>
      <div><h3>HubSpot</h3><p>Contact and company sync, auto-enroll from a list or a deal stage, notes and email and call logging on the timeline. Salesforce teams run their own MCP next to this one.</p></div>
      <div><h3>Voice agents</h3><p>Let a Speko agent place the call from a script and bring back the outcome, the transcript and the recording. Dispositions close the linked task either way.</p></div>
      <div><h3>Drop-in API</h3><p>Same paths, envelopes, cursor paging, scopes and rate-limit headers as the commercial API it mirrors. Existing clients work by changing the base URL. A conformance diff runs in CI.</p></div>
      <div><h3>Webhooks</h3><p>Signed and retried events for calls, emails, enrollments, tasks and prospects. The call.logged payload is byte-compatible with the upstream one.</p></div>
      <div><h3>Sign-in your way</h3><p>Workspace API keys, OAuth 2.1 with PKCE and dynamic client registration, or Clerk SSO where organizations become workspaces. Secrets are encrypted at rest with a key you hold.</p></div>
      <div><h3>Web app</h3><p>Task queue, prospects, accounts, sequences, emails, calls, the power dialer, signals and settings, built on shadcn/ui. Light and dark.</p></div>
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
        <figure style="margin:28px 0 0">
          <div class="shot"><img src="${asset}/signals.png" alt="The signals feed: a list of buying signals with sources and the rules that act on them" width="1280" height="1141" loading="lazy"></div>
          <figcaption class="cap">The signals feed. A rule on the right turns a matching signal into an enrollment or a task.</figcaption>
        </figure>
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
    <div class="col"><h4>Project</h4><ul><li><a href="${GITHUB}/blob/main/LICENSE">MIT License</a></li><li><a href="${GITHUB}/blob/main/SECURITY.md">Security</a></li><li><a href="${GITHUB}/blob/main/CONTRIBUTING.md">Contributing</a></li><li><a href="${DOC('api-compat')}">API compatibility</a></li></ul></div>
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
