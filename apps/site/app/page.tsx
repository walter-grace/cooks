import { Brand, Flocks } from '@/components/Flocks';
import { DialerDemo } from '@/components/DialerDemo';
import { FooterReveal } from '@/components/FooterReveal';
import { House } from '@/components/House';
import { HouseScene } from '@/components/HouseScene';

const GITHUB = 'https://github.com/walter-grace/cooks';
const APP = 'https://cooks-app.vercel.app/app';
const RELEASE = `${GITHUB}/releases/latest/download/cooks-mcp.tgz`;
const QUICKSTART = `${GITHUB}#quick-start`;
const doc = (name: string) => `${GITHUB}/blob/main/docs/${name}.md`;
const API_URL = 'http://localhost:8080';

export default function Page() {
  return (
    <>
      <div className="topbar">
        <header className="top wrap" id="top">
          <Brand />
          <nav className="top">
            <a className="sub" href="#house">Tour</a>
            <a className="sub" href="#dialer">Dialer</a>
            <a className="sub" href="#assistant">Assistant</a>
            <a className="sub" href="#compare">Compare</a>
            <a className="sub" href="#selfhost">Self-host</a>
            <a href={doc('api-compat')}>API</a>
            <a href={GITHUB}>GitHub</a>
            <a href={`${APP}/login`}>Sign in</a>
          </nav>
        </header>
      </div>

      <HouseScene scene={<House />}>
        <li className="stop hero on" id="hero">
          <div className="wrap">
            <div className="card">
              <h1>Let your reps <em>cook</em>.</h1>
              <p className="lead">Cooks is sales engagement software you run on your own server. It handles sequences, a parallel dialer, buying signals and call coaching, and your Claude or Grok can operate it through MCP.</p>
              <div className="ctas">
                <a className="cta fill" href={`${APP}/signup`}>Sign up</a>
                <a className="cta" href={QUICKSTART}>Get the code</a>
                <a className="cta" href="#room-dialer">Take the tour <span aria-hidden="true">↓</span></a>
              </div>
              <p className="fine"><span>MIT license</span><span>Hosted for you</span><span>Or self-host on Node and Postgres</span></p>
            </div>
          </div>
        </li>

        <li className="stop" id="room-dialer">
          <div className="wrap">
            <div className="card">
              <div className="n">Switchboard · Parallel dialer</div>
              <h2>A dialer that rings four prospects at once</h2>
              <p>It rings up to four numbers at a time and connects the rep to the first person who picks up. The person hears no beep and no recording. When a voicemail answers, Cooks hangs up before it plays.</p>
              <p className="soft">Cooks listens to the pickup audio itself, so a &quot;Hello?&quot; is recognized in under a second. The carrier&apos;s machine detection takes about three.</p>
              <a className="more" href="#dialer">How detection works <span aria-hidden="true">↓</span></a>
            </div>
          </div>
        </li>

        <li className="stop" id="room-sequencing">
          <div className="wrap">
            <div className="card">
              <div className="n">Prep line · Sequencing</div>
              <h2>Sequences that send in the prospect&apos;s time zone</h2>
              <p>A sequence mixes email, call, LinkedIn and manual steps. Emails go out inside a send window in the prospect&apos;s time zone and under a daily cap per mailbox. A reply or a bounce stops the sequence for that person.</p>
              <p className="soft">An email step can be drafted by AI, and the draft waits for a rep when the model is unsure. Unsubscribe links and A/B variants are included.</p>
            </div>
          </div>
        </li>

        <li className="stop" id="room-signals">
          <div className="wrap">
            <div className="card">
              <div className="n">Lookout · Signals</div>
              <h2>A feed of reasons to call</h2>
              <p>Link clicks, replies, web research, CRM changes and anything your bot posts through the API land in one feed, tied to the prospect and account. Rules act on it. A second click within a week, for example, enrolls the prospect in a follow-up and creates a task for the owner.</p>
              <p className="soft">Accounts in an active sequence get a web scan every seven days.</p>
            </div>
          </div>
        </li>

        <li className="stop" id="room-coaching">
          <div className="wrap">
            <div className="card">
              <div className="n">Tasting room · Coaching</div>
              <h2>Coaching from the recording</h2>
              <p>Recordings are split by speaker and transcribed, then scored on opener, discovery, listening, value, objections and next step. The report includes talk ratio, the longest monologue and one specific tip.</p>
              <p className="soft">Next door, a rep can practice against an AI prospect that interrupts and pushes back. Practice calls are scored the same way.</p>
              <a className="more" href={doc('coaching')}>Coaching docs</a>
            </div>
          </div>
        </li>

        <li className="stop" id="room-assistant">
          <div className="wrap">
            <div className="card">
              <div className="n">Control desk · Your assistant</div>
              <h2>Run it from Claude, Grok or Cursor</h2>
              <p>Cooks includes an MCP server. The assistant you already use can look up an account, enroll a prospect, draft an email, place a call and log the result, working on your Cooks data.</p>
              <p className="soft">Sending rules such as suppression lists, unsubscribes and daily caps are enforced on the server, not in the prompt.</p>
              <a className="more" href="#assistant">Setup <span aria-hidden="true">↓</span></a>
            </div>
          </div>
        </li>

        <li className="stop" id="room-selfhost">
          <div className="wrap">
            <div className="card">
              <div className="n">Cellar · Self-host</div>
              <h2>Runs on Node and Postgres</h2>
              <p>Jobs, rate limits, webhook delivery and MCP sessions are stored in the same Postgres as your prospects, so there is no Redis or queue to operate. Setup is five commands, or one with Docker Compose.</p>
              <div className="ctas">
                <a className="cta fill" href={QUICKSTART}>Get the code</a>
                <a className="cta" href="#selfhost">Setup steps <span aria-hidden="true">↓</span></a>
              </div>
            </div>
          </div>
        </li>
      </HouseScene>

      <main className="wrap">
        <section className="sec" id="dialer">
          <div className="split">
            <div>
              <div className="n">Detection</div>
              <h2>How Cooks tells a person from a machine</h2>
              <p>When a carrier answers, Cooks streams the callee&apos;s audio back and runs it through voice-activity detection and a few rules. &quot;Hello?&quot; followed by silence is a person. &quot;You&apos;ve reached&quot;, a beep or a long unbroken speech is a machine. If that is unclear, a small model decides within a few hundred milliseconds.</p>
              <p className="soft">Twilio&apos;s answering-machine detection runs at the same time as a fallback. The first verdict on a line wins and the other is ignored.</p>
              <table className="t" aria-label="Time from answer to verdict">
                <thead><tr><th scope="col">Pickup</th><th scope="col">Verdict lands</th></tr></thead>
                <tbody>
                  <tr><td>Person saying &quot;Hello?&quot;</td><td>0.8 s</td></tr>
                  <tr><td>Voicemail greeting</td><td>1.0 s</td></tr>
                  <tr className="amd"><td>Carrier machine detection</td><td>3.0 s</td></tr>
                </tbody>
              </table>
              <p className="cap">Measured against the mock carrier in the repo. Timing depends on the recognizer you configure: OpenAI Realtime, a local Nemotron model through sherpa-onnx, or none.</p>
            </div>
            <div>
              <figure>
                <DialerDemo />
                <figcaption className="cap">A demo of one batch with example names. Log a call with a disposition, then dial the next batch. The clock runs four times faster than real time.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="sec" id="assistant">
          <div className="n">MCP</div>
          <h2>Connecting an assistant</h2>
          <div className="split">
            <div>
              <p>The MCP server is a thin client over the REST API. Run it on a laptop against a hosted Cooks, or next to the API for the team. In this setup Cooks itself spends no tokens.</p>
              <p className="soft">Cooks can also run its own agents for drafts, reply classification and research. Add a key for the model provider you use, or point it at a local model, and each run is logged with its tokens and cost.</p>
              <div className="panel" role="img" aria-label="A chat with an assistant that uses Cooks tools to find accounts, enroll prospects and place a call">
                <div className="bar"><b>Claude Code</b><span>cooks mcp</span></div>
                <div className="chat">
                  <div className="msg me">Find the three accounts with the strongest signals this week, enroll their champions in the Q4 sequence, and call the one who clicked twice.</div>
                  <div className="msg">Strongest this week: Globex, Initech, Hooli. <span className="tool">cooks_list_signals</span><br />Enrolled Maya Chen, Dev Patel and Sam Okafor in Q4 outbound. <span className="tool">cooks_enroll_prospect</span> ×3<br />Maya clicked twice, so I&apos;m ringing her now and will log the outcome. <span className="tool">cooks_dial</span></div>
                </div>
              </div>
              <p className="cap">An example session. The assistant calls Cooks tools; Cooks applies the workspace rules and records every action.</p>
            </div>
            <div>
              <div className="n">What the tools cover</div>
              <ul className="tools">
                <li>Prospects and accounts: find, create, update, tag, add notes.</li>
                <li>Sequences and steps: build, edit, reorder, or draft a sequence from a brief.</li>
                <li>Enrollments: enroll, pause, resume and finish, with the rules enforced.</li>
                <li>Tasks: list, complete and skip what is due today.</li>
                <li>Dialer: place a call, hand one to a Speko voice agent, fetch the transcript, log it.</li>
                <li>Power dialer: start a session, dial the next batch, see who answered.</li>
                <li>Inbox: read the unified inbox, send SMS and iMessage with consent checks.</li>
                <li>Email: draft, send, and import mail that happened outside Cooks.</li>
              </ul>
            </div>
          </div>
          <div className="agents">
            <div>
              <h3>Claude Code</h3>
              <pre>{`claude mcp add cooks \\
  -e COOKS_API_URL=${API_URL} \\
  -e COOKS_API_KEY=cooks-api-... \\
  -- npx -y ${RELEASE}`}</pre>
              <p>Create the key under Settings, then API keys. The tarball on GitHub Releases is the distribution; nothing is published to npm.</p>
            </div>
            <div>
              <h3>Claude Desktop <small>and Cursor</small></h3>
              <pre>{`{
  "mcpServers": {
    "cooks": {
      "command": "npx",
      "args": ["-y", "${RELEASE}"],
      "env": { "COOKS_API_URL": "${API_URL}", "COOKS_API_KEY": "cooks-api-..." }
    }
  }
}`}</pre>
              <p>Paste into <code>claude_desktop_config.json</code> or <code>.cursor/mcp.json</code>. Windsurf and Codex take the same shape.</p>
            </div>
            <div>
              <h3>Grok</h3>
              <pre>pnpm --filter cooks-mcp dev          <span className="c"># hosts https://your-host/mcp</span>{'\n'}<span className="c"># grok.com/connectors → New connector → Custom</span>{'\n'}<span className="c">#   URL    https://your-host/mcp</span>{'\n'}<span className="c">#   then sign in when Grok asks</span></pre>
              <p>Grok runs the OAuth sign-in in a pop-up, so each person signs in with their own account and approves scopes. The host has to be reachable from the public internet.</p>
            </div>
            <div>
              <h3>claude.ai <small>and remote clients</small></h3>
              <pre>claude mcp add --transport http cooks https://your-host/mcp{'\n'}<span className="c"># or paste https://your-host/mcp as a claude.ai connector</span></pre>
              <p>No key to share. The client gets a 401 with OAuth discovery, registers itself, and each person signs in and approves scopes for one workspace. Tokens carry their role, so a rep cannot delete a sequence they do not own.</p>
            </div>
          </div>
          <p className="guard">A draft is sent only after a person confirms it. Suppression lists, unsubscribes and daily caps are checked by the server on every send. Tool errors return the API&apos;s error code, so an assistant that enrolls someone twice sees &quot;already enrolled&quot; and moves on.</p>
        </section>

        <section className="sec" id="more">
          <h2 className="wide">Also included</h2>
          <div className="box">
            <div><h3>Mailboxes</h3><p>Gmail, Microsoft 365 or SMTP, with inbound sync for replies and bounces.</p></div>
            <div><h3>Inkbox channels</h3><p>An email address, an SMS number and an iMessage line per rep, with one inbox and STOP honored.</p></div>
            <div><h3>HubSpot</h3><p>Contact and company sync, auto-enroll from a list or deal stage, calls and email on the timeline.</p></div>
            <div><h3>Voice agents</h3><p>A Speko agent places the call from a script and brings back the outcome, transcript and recording.</p></div>
            <div><h3>Compatible API</h3><p>Same paths, envelopes and paging as the commercial API it mirrors. Existing clients change one base URL.</p></div>
            <div><h3>Webhooks</h3><p>Signed, retried events for calls, emails, enrollments, tasks and prospects.</p></div>
            <div><h3>Sign-in</h3><p>API keys, OAuth 2.1 with PKCE, or Clerk SSO. Secrets are encrypted at rest with a key you hold.</p></div>
            <div><h3>Web app</h3><p>Tasks, prospects, sequences, emails, calls, dialer, practice, signals and settings.</p></div>
          </div>
        </section>

        <section className="sec" id="compare">
          <h2 className="wide">Compared with Nooks and Orum</h2>
          <p>Nooks and Orum charge per seat and quote prices on a sales call. Cooks is MIT licensed, so the recurring costs are telephony and your server.</p>
          <table className="compare">
            <thead><tr><th scope="col"><span className="sr">Topic</span></th><th scope="col">Cooks</th><th scope="col">Nooks</th><th scope="col">Orum</th></tr></thead>
            <tbody>
              <tr><th scope="row">License</th><td className="us"><b>Free, MIT.</b> No per-seat fee.</td><td>Custom quote</td><td>Custom quote</td></tr>
              <tr><th scope="row">Pricing published</th><td className="us">This page</td><td>No, &quot;get in touch&quot;</td><td>No, &quot;based on package and users&quot;</td></tr>
              <tr><th scope="row">Minimum seats</th><td className="us">None</td><td>Not published</td><td>Nine</td></tr>
              <tr><th scope="row">Parallel dialer</th><td className="us">Up to four lines; the first person to answer is connected</td><td>Yes</td><td>Yes, on the Ascend plan</td></tr>
              <tr><th scope="row">Telephony</th><td className="us">Twilio at its published rate: $0.014 a minute in the US, $1.15 a month per number</td><td>Not published</td><td>Not published</td></tr>
              <tr><th scope="row">Try it</th><td className="us">Whole product, locally, against a mock carrier, for as long as you like</td><td>Not published</td><td>Trial capped at 500 dials</td></tr>
              <tr><th scope="row">Where the data lives</th><td className="us">Your Postgres, your server</td><td>Their cloud</td><td>Their cloud</td></tr>
              <tr><th scope="row">Assistant access</th><td className="us">MCP server for Claude, Grok and Cursor</td><td>Not on their public pages</td><td>Not on their public pages</td></tr>
            </tbody>
          </table>
          <p className="cap">Nooks, Orum and Twilio facts read from their pricing pages in October 2026, linked in the footer. Check them before you buy; they change.</p>
          <div className="sum">
            <div><div className="n">Ten seats, reported</div><div className="big">$7.8k–18k<small>a year on Nooks</small></div><p>Buyers report $65 to $150 per user per month (Vendr, February 2026). The list quote is said to run higher.</p></div>
            <div><div className="n">Ten seats, reported</div><div className="big">$12k–24k<small>a year on Orum</small></div><p>Buyers report $100 to $200 per user per month (Vendr, February 2026), and nine seats is the floor.</p></div>
            <div><div className="n">Ten seats on Cooks</div><div className="big">$0<small>a year in licenses</small></div><p>100,000 outbound minutes cost about $1,400 at Twilio&apos;s rate, ten numbers $138, plus whatever your server costs.</p></div>
          </div>
        </section>

        <section className="sec" id="selfhost">
          <div className="split">
            <div>
              <div className="n">Self-host</div>
              <h2>Setup</h2>
              <p>You need Node 22, pnpm 9 and Postgres 15 or newer. Jobs, rate limits, the webhook outbox and MCP sessions live in that database, so there is nothing else to operate. Bootstrap prints a workspace API key once, and the web app is served at <code>/app</code>.</p>
              <p className="soft">Docker Compose starts Postgres, the API, the worker, the MCP server and Mailpit together. Production notes, Twilio setup and the mock carrier for trying the dialer without an account are in the <a href={doc('self-host')}>self-hosting guide</a>.</p>
            </div>
            <div>
              <pre>{`git clone ${GITHUB}.git && cd cooks
pnpm install
createdb cooks && cp .env.example .env
pnpm bootstrap --email you@example.com --workspace "My Team"
`}pnpm --filter @cooks/api dev    <span className="c"># http://localhost:8080</span>{'\n'}pnpm --filter @cooks/worker dev <span className="c"># engine, mail, webhooks, AI</span></pre>
            </div>
          </div>
        </section>
      </main>

      <footer id="footer">
        <div className="wrap fwrap">
          <div className="fbrand">
            <Brand />
            <p>Open-source sales engagement, built from public documentation. The API, worker and MCP server share one service layer, so the rules are enforced the same way everywhere.</p>
            <div className="copy">Cooks © 2026, MIT. An independent project, not affiliated with or endorsed by Nooks.</div>
          </div>
          <div className="col"><h3>Product</h3><ul><li><a href={QUICKSTART}>Quick start</a></li><li><a href={doc('api-compat')}>API reference</a></li><li><a href={GITHUB}>GitHub</a></li><li><a href={`${GITHUB}/releases/latest`}>Releases</a></li></ul></div>
          <div className="col"><h3>Guides</h3><ul><li><a href={doc('self-host')}>Self-hosting</a></li><li><a href={doc('mcp')}>Connect an assistant</a></li><li><a href={doc('dialer')}>Dialer</a></li><li><a href={doc('coaching')}>Coaching</a></li><li><a href={doc('signals')}>Signals</a></li></ul></div>
          <div className="col"><h3>Project</h3><ul><li><a href="https://www.nooks.ai/pricing">Nooks pricing</a></li><li><a href="https://www.orum.com/pricing">Orum pricing</a></li><li><a href="https://www.twilio.com/en-us/voice/pricing/us">Twilio voice rates</a></li><li><a href={`${GITHUB}/blob/main/LICENSE`}>MIT License</a></li><li><a href={`${GITHUB}/blob/main/SECURITY.md`}>Security</a></li><li><a href={`${GITHUB}/blob/main/CONTRIBUTING.md`}>Contributing</a></li><li><a href={doc('api-compat')}>API compatibility</a></li></ul></div>
        </div>

        <div className="art" aria-hidden="true">
          <div className="layer hill" />
          <div className="layer water" />
          <div className="shimmer" />
          <div className="sky"><Flocks /></div>
          <div className="boat"><div className="bob"><div className="refl" /><div className="hull" /></div></div>
          <div className="boat far"><div className="bob"><div className="refl" /><div className="hull" /></div></div>
        </div>
        <FooterReveal />
      </footer>
    </>
  );
}
