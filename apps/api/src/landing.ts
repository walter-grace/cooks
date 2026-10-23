/** Public landing page served at `/`. No JS, no tracking; styled to match the app. */
const css = `
:root{--bg:#fff;--fg:#0a0a0a;--muted:#737373;--border:#e5e5e5;--card:#fafafa;--primary:#171717;--primary-fg:#fafafa;--ok:#15803d;--ok-bg:#dcfce7;--soon:#a16207;--soon-bg:#fef9c3}
@media(prefers-color-scheme:dark){:root{--bg:#0a0a0a;--fg:#fafafa;--muted:#a3a3a3;--border:#262626;--card:#171717;--primary:#fafafa;--primary-fg:#171717;--ok:#86efac;--ok-bg:#14532d;--soon:#fde047;--soon-bg:#713f12}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
a{color:inherit}.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 0}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;text-decoration:none}.logo{width:28px;height:28px;border-radius:7px;background:var(--primary);color:var(--primary-fg);display:grid;place-items:center;font-weight:700;font-size:14px}
nav a{margin-left:18px;color:var(--muted);text-decoration:none;font-size:14px}nav a:hover{color:var(--fg)}
.hero{padding:64px 0 40px}.hero h1{font-size:clamp(34px,6vw,56px);line-height:1.05;letter-spacing:-.02em;margin:0 0 18px;max-width:780px}
.hero p{font-size:19px;color:var(--muted);max-width:640px;margin:0 0 28px}
.btn{display:inline-block;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:500;font-size:15px;border:1px solid var(--border)}
.btn.primary{background:var(--primary);color:var(--primary-fg);border-color:var(--primary)}.btn+.btn{margin-left:10px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin:28px 0 56px}
.card{border:1px solid var(--border);background:var(--card);border-radius:12px;padding:18px}.card h3{margin:0 0 6px;font-size:16px;display:flex;align-items:center;gap:8px}.card p{margin:0;color:var(--muted);font-size:14px}
.pill{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}.pill.ok{color:var(--ok);background:var(--ok-bg)}.pill.soon{color:var(--soon);background:var(--soon-bg)}
h2{font-size:24px;letter-spacing:-.01em;margin:0 0 10px}.lead{color:var(--muted);margin:0 0 16px}
pre{max-width:100%;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;font-size:13px;line-height:1.5}
section{padding:24px 0}.two{display:grid;gap:28px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.two>div{min-width:0}@media(max-width:760px){.two{grid-template-columns:1fr}}
ul.plain{padding-left:18px;color:var(--muted);margin:0}ul.plain li{margin:6px 0}
footer{border-top:1px solid var(--border);margin-top:48px;padding:24px 0 40px;color:var(--muted);font-size:13px}
`;

export function landingHtml(opts: { publicUrl: string; release: string }) {
  const { publicUrl, release } = opts;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Cooks: open-source sales engagement</title>
<meta name="description" content="Cooks is a free, self-hosted sales engagement platform: sequences, dialer, signals and coaching, driven by the Claude or Grok bot you already use.">
<meta property="og:title" content="Cooks"><meta property="og:description" content="Open-source sales engagement your own AI assistant can run."><style>${css}</style></head>
<body><div class="wrap">
<header><a class="brand" href="/"><span class="logo">C</span>Cooks</a><nav><a href="/app/">Sign in</a><a href="/docs">API</a><a href="https://github.com/walter-grace/cooks">GitHub</a></nav></header>
<section class="hero">
<h1>Sales engagement you host, run by the assistant you already pay for.</h1>
<p>Sequences, a dialer, buying signals and call coaching on one Postgres, under MIT. Point Claude, Grok or any MCP client at it and let the bot do the typing.</p>
<a class="btn primary" href="/app/">Open the app</a><a class="btn" href="https://github.com/walter-grace/cooks#run-it-locally">Self-host in five minutes</a>
</section>
<div class="grid">
<div class="card"><h3>Sequencing <span class="pill ok">live</span></h3><p>Multi-step email, call and social cadences with send windows, merge fields, reply detection, bounce handling and AI drafts routed to a human when unsure.</p></div>
<div class="card"><h3>Dialer</h3><p>Browser softphone or phone bridge on Twilio Voice, AI-voiced calls on Speko with outcome and transcript, recordings, dispositions, and a byte-compatible <code>call.logged</code> webhook.</p></div>
<div class="card"><h3>Signals</h3><p>A feed of buying signals from email engagement, web research and anything your bot pushes in, with rules that enroll or create tasks.</p></div>
<div class="card"><h3>Coaching</h3><p>Transcripts, talk ratio and an AI scorecard for every recorded call, with the provider and model you choose.</p></div>
</div>
<section class="two">
<div><h2>Your bot is the brain</h2><p class="lead">One command adds 66 tools to Claude Code, Claude Desktop, Cursor or Grok. Cooks spends none of its own tokens in this mode.</p>
<pre>claude mcp add cooks \\
  -e COOKS_API_URL=${publicUrl} \\
  -e COOKS_API_KEY=cooks-api-... \\
  -- npx -y ${release}</pre></div>
<div><h2>Drop-in API</h2><p class="lead">Same paths, envelopes, paging, scopes and webhook signature as the commercial API it mirrors, so existing clients work by changing the base URL.</p>
<ul class="plain"><li>OAuth 2.1 with PKCE and dynamic client registration</li><li>Gmail, Microsoft 365 and SMTP mailboxes, or Inkbox identities with email, SMS and iMessage</li><li>HubSpot sync, notes and timeline logging</li><li>Clerk SSO, or plain passwords</li><li>Anthropic, xAI, OpenAI, OpenRouter or Ollama per workspace</li></ul></div>
</section>
<footer>Cooks is an independent open-source project and is not affiliated with or endorsed by Nooks. <a href="https://github.com/walter-grace/cooks/blob/main/LICENSE">MIT License</a> · <a href="/docs">OpenAPI</a> · <a href="/.well-known/oauth-authorization-server">OAuth metadata</a></footer>
</div></body></html>`;
}
