import { Brand, Flocks } from '@/components/Flocks';
import { DialerDemo } from '@/components/DialerDemo';
import { FooterReveal } from '@/components/FooterReveal';

const GITHUB = 'https://github.com/walter-grace/cooks';
const RELEASE = `${GITHUB}/releases/latest/download/cooks-mcp.tgz`;
const QUICKSTART = `${GITHUB}#quick-start`;
const doc = (name: string) => `${GITHUB}/blob/main/docs/${name}.md`;
const API_URL = 'http://localhost:8080';

export default function Page() {
  return (
    <>
      <header className="top wrap" id="top">
        <Brand />
        <nav className="top">
          <a className="sub" href="#features">Features</a>
          <a className="sub" href="#dialer">Dialer</a>
          <a className="sub" href="#assistant">Assistant</a>
          <a className="sub" href="#compare">Compare</a>
          <a className="sub" href="#selfhost">Self-host</a>
          <a href={doc('api-compat')}>API</a>
          <a href={GITHUB}>GitHub</a>
        </nav>
      </header>

      <main className="wrap">
        <section className="hero">
          <h1>Let your reps <em>cook</em>.</h1>
          <p className="lead">Cooks is open-source sales engagement you host yourself: sequences, a parallel dialer, buying signals and call coaching on one Postgres. Point Claude, Grok or any MCP client at it and the bot does the typing.</p>
          <div className="ctas">
            <a className="cta fill" href={QUICKSTART}>Get the code</a>
            <a className="cta" href="#selfhost">Self-host in five minutes <span aria-hidden="true">↓</span></a>
          </div>
          <p className="fine"><span>MIT licensed</span><span>One Postgres, no Redis</span><span>66 MCP tools</span><span>Yours to fork</span></p>
        </section>

        <section className="feats" id="features">
          <h2 className="sr">What Cooks does</h2>
          <div><div className="n">Sequencing</div><h3>Cadences that respect the clock</h3><p>Email, call, LinkedIn and manual steps with per-prospect time zones, send windows and daily caps per mailbox. Reply and bounce detection, A/B variants, one-click unsubscribe. AI drafts any email step and hands it to a person when unsure.</p></div>
          <div><div className="n">Dialer</div><h3>Four lines ring, one person answers</h3><p>Reps call on Twilio from the browser or a bridge to their phone. The power dialer rings three or four prospects at once and drops the first human into the rep&apos;s ear, with no beep and no message. Machines are hung up before anyone hears them.</p></div>
          <div><div className="n">Signals</div><h3>One feed of reasons to call</h3><p>Email engagement, web research, CRM changes and anything your bot pushes in, as one stream. Rules turn a matching signal into an enrollment or a task. Accounts in active sequences get a web scan every seven days.</p></div>
          <div><div className="n">Coaching</div><h3>Every call gets a scorecard</h3><p>Recorded calls are split by speaker, transcribed, and scored on six parts: opener, discovery, listening, value, objections, next step. Talk ratio, monologues, questions asked and one concrete tip per call.</p></div>
        </section>

        <section className="sec" id="dialer">
          <div className="split">
            <div>
              <div className="n">Fast pickup</div>
              <h2>It hears the hello.</h2>
              <p>The instant a carrier answers, the held line streams the callee&apos;s audio back to Cooks. A voice-activity timeline and a small rule judge settle it: &quot;Hello?&quot; followed by silence is a person. &quot;You&apos;ve reached&quot;, a beep or a long monologue is a machine. When the words are unclear, TypeSafe&apos;s Jev on OpenRouter makes the call in a few hundred milliseconds.</p>
              <p className="soft">Carrier answering-machine detection keeps running underneath as the fallback. Each line takes exactly one verdict, so whichever detector is slower becomes a no-op.</p>
              <table className="t" aria-label="Time from answer to verdict">
                <thead><tr><th scope="col">Pickup</th><th scope="col">Verdict lands</th></tr></thead>
                <tbody>
                  <tr><td>Person saying &quot;Hello?&quot;</td><td>0.8 s</td></tr>
                  <tr><td>Voicemail greeting</td><td>1.0 s</td></tr>
                  <tr className="amd"><td>Carrier machine detection</td><td>3.0 s</td></tr>
                </tbody>
              </table>
              <p className="cap">Measured on the mock carrier that ships with the repo. Your numbers will depend on the recognizer you pick: OpenAI Realtime, a local Nemotron model through sherpa-onnx, or none.</p>
            </div>
            <div>
              <figure>
                <DialerDemo />
                <figcaption className="cap">One batch as the rep sees it, with example names. Log the call with a disposition, then dial the next batch and watch the gate settle each line. The clock runs four times faster than life.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="sec" id="signals">
          <div className="split">
            <div>
              <div className="n">Signals</div>
              <h2>Call when there is a reason.</h2>
              <p>Every engagement event, web find, CRM change and reply lands in one feed with the prospect and account attached. Rules watch the feed and act: a second click in a week enrolls the prospect in a follow-up and puts a task in front of the owner.</p>
              <p className="soft">Your bot can push its own signals through the API, so research it does in the morning shows up as reasons to call in the afternoon.</p>
            </div>
            <div>
              <figure>
                <div className="panel" role="img" aria-label="The signals feed with four recent signals and the rule that acts on them">
                  <div className="bar"><b>Signals</b><span>This week · 14 new</span></div>
                  <div className="sig"><div className="k">Clicked ×2</div><div className="d">Maya Chen opened the pricing link twice<small>Q4 outbound, step 3 · Globex</small></div><div className="t">2 h ago</div></div>
                  <div className="sig"><div className="k soft">Hiring</div><div className="d">Initech posted three SDR roles<small>Weekly web scan · careers page</small></div><div className="t">Yesterday</div></div>
                  <div className="sig"><div className="k soft">Deal stage</div><div className="d">Hooli moved to Evaluation<small>HubSpot sync</small></div><div className="t">Mon</div></div>
                  <div className="sig"><div className="k soft">Replied</div><div className="d">Lena Fischer: &quot;loop in my VP&quot;<small>Classified as a referral, confidence 0.92</small></div><div className="t">Mon</div></div>
                  <div className="rule"><b>Rule</b> · clicked twice within 7 days → enroll in Hot follow-up, task for the owner</div>
                </div>
                <figcaption className="cap">The feed and one rule. Example data.</figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className="sec" id="assistant">
          <div className="n">Your bot is the brain</div>
          <h2>Sixty-six tools, zero tokens of ours.</h2>
          <div className="split">
            <div>
              <p>Cooks ships an MCP server, so the assistant you already pay for can research an account, enroll the prospect, draft the email, place the call and log the outcome. It is a thin client over the REST API: it runs on a laptop against a hosted Cooks, or next to the API for the whole team. In that mode Cooks spends no tokens of its own.</p>
              <p className="soft">Prefer hosted agents? Give a workspace its own key on Anthropic, xAI, OpenAI, OpenRouter or Ollama. Drafts, reply classification and research then run in the worker with a ledger of every run&apos;s tokens and cost.</p>
              <div className="panel" role="img" aria-label="A chat with an assistant that uses Cooks tools to find accounts, enroll prospects and place a call">
                <div className="bar"><b>Claude Code</b><span>cooks · 66 tools</span></div>
                <div className="chat">
                  <div className="msg me">Find the three accounts with the strongest signals this week, enroll their champions in the Q4 sequence, and call the one who clicked twice.</div>
                  <div className="msg">Strongest this week: Globex, Initech, Hooli. <span className="tool">cooks_list_signals</span><br />Enrolled Maya Chen, Dev Patel and Sam Okafor in Q4 outbound. <span className="tool">cooks_enroll_prospect</span> ×3<br />Maya clicked twice, so I&apos;m ringing her now and will log the outcome. <span className="tool">cooks_dial</span></div>
                </div>
              </div>
              <p className="cap">What a session looks like once the server is connected. Cooks does the work with your rules, your mailboxes and your audit trail.</p>
            </div>
            <div>
              <div className="n">What the tools cover</div>
              <ul className="tools">
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
              <pre>pnpm --filter cooks-mcp dev          <span className="c"># hosts https://your-host/mcp</span>{'\n'}<span className="c"># In Grok: add a custom MCP connector</span>{'\n'}<span className="c">#   URL    https://your-host/mcp</span>{'\n'}<span className="c">#   Auth   Bearer cooks-api-...</span></pre>
              <p>Grok talks to the hosted server over streamable HTTP with a workspace key. The connector screen changes often, so check xAI&apos;s current docs for where the fields live.</p>
            </div>
            <div>
              <h3>claude.ai <small>and remote clients</small></h3>
              <pre>claude mcp add --transport http cooks https://your-host/mcp{'\n'}<span className="c"># or paste https://your-host/mcp as a claude.ai connector</span></pre>
              <p>No key to share. The client gets a 401 with OAuth discovery, registers itself, and each person signs in and approves scopes for one workspace. Tokens carry their role, so a rep cannot delete a sequence they do not own.</p>
            </div>
          </div>
          <p className="guard">Nothing goes to a prospect unless a person confirms the draft, and suppression lists, unsubscribes and daily caps are enforced in the send pipeline where the model cannot reach them. Tool errors carry the API&apos;s error envelope, so the assistant sees &quot;already enrolled&quot; and recovers on its own.</p>
        </section>

        <section className="sec" id="more">
          <div className="n">Also in the box</div>
          <h2 className="wide">Everything a floor needs, on one database.</h2>
          <div className="box">
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

        <section className="sec" id="compare">
          <div className="n">Compared</div>
          <h2 className="wide">What a floor pays to dial.</h2>
          <p>Nooks and Orum are good products that charge per seat behind a sales call. Cooks is the same shape of product under MIT, so what recurs is the phone company&apos;s bill and whatever runs your server.</p>
          <table className="compare">
            <thead><tr><th scope="col"><span className="sr">Topic</span></th><th scope="col">Cooks</th><th scope="col">Nooks</th><th scope="col">Orum</th></tr></thead>
            <tbody>
              <tr><th scope="row">License</th><td className="us"><b>Free, MIT.</b> No per-seat fee.</td><td>Custom quote</td><td>Custom quote</td></tr>
              <tr><th scope="row">Pricing published</th><td className="us">This page</td><td>No, &quot;get in touch&quot;</td><td>No, &quot;based on package and users&quot;</td></tr>
              <tr><th scope="row">Minimum seats</th><td className="us">None</td><td>Not published</td><td>Nine</td></tr>
              <tr><th scope="row">Parallel dialer</th><td className="us">Four lines, first person wins, hears the pickup</td><td>Yes</td><td>Yes, on the Ascend plan</td></tr>
              <tr><th scope="row">Telephony</th><td className="us">Twilio at its published rate: $0.014 a minute in the US, $1.15 a month per number</td><td>Not published</td><td>Not published</td></tr>
              <tr><th scope="row">Try it</th><td className="us">Whole product, locally, against a mock carrier, for as long as you like</td><td>Not published</td><td>Trial capped at 500 dials</td></tr>
              <tr><th scope="row">Where the data lives</th><td className="us">Your Postgres, your server</td><td>Their cloud</td><td>Their cloud</td></tr>
              <tr><th scope="row">Driven by your assistant</th><td className="us">66 MCP tools for Claude, Grok, Cursor</td><td>Not on their public pages</td><td>Not on their public pages</td></tr>
            </tbody>
          </table>
          <p className="cap">Nooks, Orum and Twilio facts read from their pricing pages in October 2026, linked in the footer. Check them before you buy, since they change.</p>
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
              <h2>Five commands and a Postgres.</h2>
              <p>Node 22, pnpm 9 and Postgres 15 or newer. Jobs, rate limits, the webhook outbox and MCP sessions all live in that one database, so there is nothing else to operate. Bootstrap prints a workspace API key once, and the app is at <code>/app</code>.</p>
              <p className="soft">Docker Compose brings up Postgres, the API, the worker, the MCP server and Mailpit in one line. Production notes, Twilio setup and the mock carrier for trying the dialer without an account are in the <a href={doc('self-host')}>self-hosting guide</a>.</p>
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
            <p>Open-source sales engagement, built from public documentation and meant to be forked. The service layer is the one place the rules live; the API, worker and MCP server all call it in process.</p>
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
