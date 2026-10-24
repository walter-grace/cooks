/**
 * The Cooks house: a cross-section of a sales floor drawn as a building, in the page's own ink.
 * Every room is a product area. The scroll camera in HouseScene zooms from room to room; without
 * script the whole building shows at once. Pure SVG, no images.
 *
 * Coordinates are in a 1600 x 1000 box. Floors are thick slabs, walls are hatched, people wear
 * the same long coat. Rooms carry data-id so the camera can dim the others.
 */

const INK = 'currentColor';

/* ------------------------------------------------------------------ primitives */

function Person({ x, y, s = 1, arm = 'down', flip = false, headset = false }: { x: number; y: number; s?: number; arm?: 'down' | 'up' | 'out' | 'point' | 'phone'; flip?: boolean; headset?: boolean }) {
  const arms = { down: 'M-8 -36 L-13 -16 M8 -36 L13 -16', up: 'M-8 -36 L-13 -16 M8 -36 L15 -54', out: 'M-8 -36 L-13 -16 M8 -36 L22 -34', point: 'M-8 -36 L-13 -16 M8 -36 L24 -44', phone: 'M-8 -36 L-13 -16 M8 -36 L10 -46' }[arm];
  return (
    <g transform={`translate(${x} ${y}) scale(${flip ? -s : s} ${s})`} className="person">
      <path d="M-5 -8 V0 M5 -8 V0" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M-8 -40 L8 -40 L11 -8 L-11 -8 Z" className="pp" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M0 -40 V-10" stroke={INK} strokeWidth="1" opacity=".5" />
      <path d={arms} stroke={INK} strokeWidth="2.2" strokeLinecap="round" fill="none" />
      <circle cx="0" cy="-48" r="7" className="pp" stroke={INK} strokeWidth="1.8" />
      <path d="M-7 -50 Q0 -58 7 -50" stroke={INK} strokeWidth="1.8" fill="none" />
      {headset && <path d="M-9 -47 Q0 -62 9 -47 M7 -44 L11 -40" stroke={INK} strokeWidth="1.6" fill="none" strokeLinecap="round" />}
      {arm === 'phone' && <path d="M8 -50 L12 -42" stroke={INK} strokeWidth="3" strokeLinecap="round" />}
    </g>
  );
}

function Room({ id, x, y, w, h, label, children }: { id: string; x: number; y: number; w: number; h: number; label: string; children?: React.ReactNode }) {
  return (
    <g className="room" data-id={id}>
      <rect x={x} y={y} width={w} height={h} fill="url(#wall)" />
      <rect x={x} y={y} width={w} height={h} fill="url(#plank)" opacity=".5" />
      <path d={`M${x} ${y + h} H${x + w}`} stroke={INK} strokeWidth="1" opacity=".5" />
      <text x={x + 12} y={y + 20} className="lab">{label}</text>
      {children}
    </g>
  );
}

const Slab = ({ x, y, w, h = 12 }: { x: number; y: number; w: number; h?: number }) => <rect x={x} y={y} width={w} height={h} fill={INK} />;
const Wall = ({ x, y, h, w = 10 }: { x: number; y: number; h: number; w?: number }) => <rect x={x} y={y} width={w} height={h} fill={INK} />;

function Screen({ x, y, w = 44, h = 30, lines = 3 }: { x: number; y: number; w?: number; h?: number; lines?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="2" className="pp" stroke={INK} strokeWidth="1.6" />
      {Array.from({ length: lines }, (_, i) => (
        <path key={i} d={`M${x + 6} ${y + 8 + i * 7} H${x + w - 6 - (i % 2) * 10}`} stroke={INK} strokeWidth="1.2" opacity=".6" />
      ))}
      <path d={`M${x + w / 2 - 6} ${y + h + 6} H${x + w / 2 + 6} M${x + w / 2} ${y + h} V${y + h + 6}`} stroke={INK} strokeWidth="1.6" />
    </g>
  );
}

function Desk({ x, y, w = 110 }: { x: number; y: number; w?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height="6" fill={INK} />
      <path d={`M${x + 8} ${y + 6} V${y + 40} M${x + w - 8} ${y + 6} V${y + 40}`} stroke={INK} strokeWidth="3" />
    </g>
  );
}

function Window({ x, y, w = 40, h = 50 }: { x: number; y: number; w?: number; h?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} className="pp" stroke={INK} strokeWidth="2" />
      <path d={`M${x + w / 2} ${y} V${y + h} M${x} ${y + h / 2} H${x + w}`} stroke={INK} strokeWidth="1.2" />
      <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} fill="url(#glass)" />
    </g>
  );
}

function Envelope({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x="-12" y="-8" width="24" height="16" className="pp" stroke={INK} strokeWidth="1.5" />
      <path d="M-12 -8 L0 2 L12 -8" stroke={INK} strokeWidth="1.3" fill="none" />
    </g>
  );
}

function Handset({ x, y, ring = false }: { x: number; y: number; ring?: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="-12" y="-16" width="24" height="30" rx="3" className="pp" stroke={INK} strokeWidth="1.6" />
      <path d="M-7 -8 Q0 -14 7 -8" stroke={INK} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      <circle cx="0" cy="4" r="3" fill={ring ? 'var(--ink)' : INK} className={ring ? 'led' : undefined} />
      {ring && (
        <g className="ring">
          <path d="M-16 -20 Q-20 -10 -16 0" stroke="var(--ink)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M16 -20 Q20 -10 16 0" stroke="var(--ink)" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ the building */

export function House() {
  return (
    <svg viewBox="0 0 1600 1000" className="house-svg" role="img" aria-label="A cross-section of the Cooks house, one room per part of the product.">
      <defs>
        <pattern id="wall" patternUnits="userSpaceOnUse" width="5" height="5">
          <path d="M2.5 0 V5" stroke={INK} strokeWidth=".6" opacity=".22" />
        </pattern>
        <pattern id="plank" patternUnits="userSpaceOnUse" width="80" height="18">
          <path d="M0 17.5 H80" stroke={INK} strokeWidth=".8" opacity=".25" />
        </pattern>
        <pattern id="siding" patternUnits="userSpaceOnUse" width="6" height="6">
          <path d="M0 3 H6" stroke={INK} strokeWidth=".8" opacity=".55" />
        </pattern>
        <pattern id="roof" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
          <path d="M0 3.5 H7" stroke={INK} strokeWidth="1.2" opacity=".7" />
        </pattern>
        <pattern id="soil" patternUnits="userSpaceOnUse" width="9" height="9">
          <circle cx="2" cy="2" r=".9" fill={INK} opacity=".35" />
          <circle cx="6.5" cy="6" r=".9" fill={INK} opacity=".25" />
        </pattern>
        <pattern id="glass" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(-45)">
          <path d="M0 3 H6" stroke={INK} strokeWidth=".5" opacity=".3" />
        </pattern>
        <pattern id="floor" patternUnits="userSpaceOnUse" width="14" height="14">
          <path d="M0 14 L14 0" stroke={INK} strokeWidth=".6" opacity=".25" />
        </pattern>
      </defs>

      {/* ---------- ground and soil ---------- */}
      <rect x="0" y="792" width="290" height="190" fill="url(#soil)" />
      <rect x="1260" y="792" width="340" height="190" fill="url(#soil)" />
      <rect x="290" y="900" width="970" height="82" fill="url(#soil)" />
      <path d="M40 792 H240 M1300 792 H1560" stroke={INK} strokeWidth="3" strokeLinecap="round" />
      <path d="M20 800 q10 -6 20 0 M1540 806 q12 -7 24 0 M80 812 q8 -5 16 0" stroke={INK} strokeWidth="1.2" fill="none" opacity=".6" />

      {/* ---------- exterior: left sign, door, lamp ---------- */}
      <g className="exterior">
        <path d="M150 792 V640" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <path d="M150 640 q-22 -2 -22 -22 h44 q0 20 -22 22 Z" className="pp" stroke={INK} strokeWidth="2" />
        <ellipse cx="150" cy="624" rx="7" ry="4" fill="var(--ink)" className="led" />
        {/* vertical marquee */}
        <rect x="178" y="470" width="58" height="236" rx="4" className="pp" stroke={INK} strokeWidth="3" />
        <path d="M236 480 H250 M236 696 H250" stroke={INK} strokeWidth="4" />
        {['C', 'O', 'O', 'K', 'S'].map((c, i) => (
          <text key={i} x="207" y={516 + i * 44} className="marquee" textAnchor="middle">{c}</text>
        ))}
        <path d="M186 478 H228 M186 698 H228" stroke="var(--ink)" strokeWidth="2" strokeDasharray="2 5" className="led" />
        {/* steps and door */}
        <path d="M200 792 H240 M208 780 H240 M216 768 H240" stroke={INK} strokeWidth="3" />
        <rect x="240" y="716" width="12" height="76" fill="var(--paper)" />
        <rect x="241" y="718" width="10" height="74" fill="url(#plank)" stroke={INK} strokeWidth="2" />
        <circle cx="248" cy="758" r="1.6" fill={INK} />
        <rect x="196" y="736" width="30" height="20" rx="2" className="pp" stroke={INK} strokeWidth="1.4" />
        <path d="M201 743 H221 M201 749 H216" stroke={INK} strokeWidth="1.2" />
        {/* bicycle on the right */}
        <g transform="translate(1400 792)">
          <circle cx="-26" cy="-14" r="14" className="pp" stroke={INK} strokeWidth="2" />
          <circle cx="26" cy="-14" r="14" className="pp" stroke={INK} strokeWidth="2" />
          <path d="M-26 -14 L-6 -40 L14 -40 L26 -14 M-6 -40 L2 -14 L-26 -14 M2 -14 L14 -40 M-10 -46 L-2 -40 M12 -46 h8" stroke={INK} strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      </g>

      {/* ---------- roofs, tank, chimney, tower ---------- */}
      <g className="exterior">
        {/* gable over the switchboard */}
        <path d="M222 440 L500 362 L778 440 Z" fill="url(#roof)" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
        <path d="M222 440 H778" stroke={INK} strokeWidth="6" />
        {/* chimney with steam */}
        <rect x="560" y="300" width="44" height="100" fill="url(#siding)" stroke={INK} strokeWidth="3" />
        <rect x="554" y="292" width="56" height="12" fill={INK} />
        <g className="steam">
          <circle cx="582" cy="270" r="12" className="puff" />
          <circle cx="596" cy="250" r="16" className="puff" style={{ animationDelay: '-1.3s' }} />
          <circle cx="576" cy="226" r="20" className="puff" style={{ animationDelay: '-2.6s' }} />
          <circle cx="602" cy="200" r="24" className="puff" style={{ animationDelay: '-3.9s' }} />
        </g>
        {/* water tank on the tasting-room roof */}
        <path d="M828 468 V430 M932 468 V430 M848 430 V392 M912 430 V392" stroke={INK} strokeWidth="3" />
        <rect x="836" y="372" width="88" height="58" rx="4" fill="url(#siding)" stroke={INK} strokeWidth="3" />
        <path d="M832 372 L880 350 L928 372 Z" fill={INK} />
        <path d="M836 392 H924 M836 412 H924" stroke={INK} strokeWidth="1.4" />
        {/* tower roof and mast */}
        <path d="M1024 270 L1170 190 L1316 270 Z" fill="url(#roof)" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
        <path d="M1024 270 H1316" stroke={INK} strokeWidth="6" />
        <path d="M1250 226 V130" stroke={INK} strokeWidth="4" />
        <g className="dish" transform="translate(1250 130)">
          <path d="M-26 0 A26 26 0 0 1 26 0 Z" className="pp" stroke={INK} strokeWidth="2.4" transform="rotate(-20)" />
          <path d="M0 0 V-18" stroke={INK} strokeWidth="2" transform="rotate(-20)" />
          <circle cx="0" cy="-18" r="3" fill="var(--ink)" transform="rotate(-20)" className="led" />
          <g className="sweep">
            <path d="M0 0 L60 -20" stroke="var(--ink)" strokeWidth="1.4" strokeDasharray="3 4" />
          </g>
        </g>
        {/* birds */}
        <path d="M380 300 q6 -6 12 0 q6 -6 12 0 M330 322 q5 -5 10 0 q5 -5 10 0 M1380 150 q6 -6 12 0 q6 -6 12 0" stroke={INK} strokeWidth="1.3" fill="none" />
      </g>

      {/* ---------- rooms ---------- */}

      <Room id="signals" x={1050} y={270} w={240} h={186} label="LOOKOUT">
        <Window x={1206} y={300} w={54} h={64} />
        <Person x={1190} y={456} s={1.05} arm="point" />
        <path d="M1212 414 L1250 396" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <path d="M1246 392 L1256 402" stroke={INK} strokeWidth="2" />
        {/* signal board */}
        <rect x={1068} y={300} width="112" height="86" className="pp" stroke={INK} strokeWidth="2" />
        <path d="M1078 376 H1170 M1078 376 V312" stroke={INK} strokeWidth="1.2" />
        <path d="M1078 360 L1098 350 L1116 356 L1134 334 L1152 340 L1168 318" stroke={INK} strokeWidth="1.6" fill="none" />
        <circle cx="1134" cy="334" r="3.5" fill="var(--ink)" className="blip" />
        <circle cx="1168" cy="318" r="3.5" fill="var(--ink)" className="blip" style={{ animationDelay: '-.7s' }} />
        <circle cx="1098" cy="350" r="3" fill="var(--ink)" className="blip" style={{ animationDelay: '-1.4s' }} />
        <text x="1080" y="398" className="tiny">CLICKED ×2 · HIRING · DEAL STAGE</text>
        <rect x={1070} y={414} width="60" height="42" fill="url(#floor)" stroke={INK} strokeWidth="1.6" />
        <path d="M1070 428 H1130 M1070 442 H1130" stroke={INK} strokeWidth="1.2" />
      </Room>

      <Room id="dialer" x={250} y={452} w={500} h={158} label="SWITCHBOARD">
        {/* wall of lines */}
        <rect x={286} y={478} width="190" height="78" className="pp" stroke={INK} strokeWidth="2" />
        <Handset x={316} y={506} ring />
        <Handset x={360} y={506} ring />
        <Handset x={404} y={506} ring />
        <Handset x={448} y={506} />
        <path d="M316 522 V540 M360 522 V540 M404 522 V540 M448 522 V540 M296 540 H466" stroke={INK} strokeWidth="1.2" opacity=".7" />
        <text x="292" y="572" className="tiny">4 LINES</text>
        {/* gauge */}
        <g transform="translate(540 512)">
          <circle r="34" className="pp" stroke={INK} strokeWidth="2.4" />
          <path d="M-24 -24 A34 34 0 0 1 24 -24" stroke={INK} strokeWidth="1.2" fill="none" strokeDasharray="2 6" />
          <path d="M0 0 L18 -26" stroke="var(--ink)" strokeWidth="2.6" strokeLinecap="round" className="needle" />
          <circle r="3" fill={INK} />
          <text y="22" textAnchor="middle" className="tiny">0.8 s</text>
        </g>
        <text x="500" y="574" className="tiny">PICKUP</text>
        {/* rep at desk */}
        <Desk x={606} y={568} w={120} />
        <Screen x={626} y={532} w={46} h={30} />
        <Person x={690} y={610} s={1.05} arm="phone" headset flip />
        <path d="M612 612 q8 -22 24 -22 h30" stroke={INK} strokeWidth="2" fill="none" />
        {/* cable to the control desk */}
        <path d="M740 600 q-10 -40 10 -46" stroke={INK} strokeWidth="1.2" fill="none" strokeDasharray="3 3" opacity=".6" />
      </Room>

      <Room id="coaching" x={770} y={480} w={270} h={130} label="TASTING ROOM">
        <Desk x={812} y={572} w={100} />
        <Person x={800} y={610} s={0.95} arm="out" headset />
        <Person x={928} y={610} s={0.95} arm="down" headset flip />
        <circle cx="862" cy="560" r="7" className="pp" stroke={INK} strokeWidth="1.6" />
        <path d="M862 553 V548 M856 562 H868" stroke={INK} strokeWidth="1.4" />
        {/* scorecard */}
        <rect x={930} y={500} width="94" height="66" className="pp" stroke={INK} strokeWidth="2" />
        {[0.5, 0.75, 0.75, 0.6, 0.85, 0.7].map((v, i) => (
          <g key={i}>
            <path d={`M940 ${510 + i * 9} H1014`} stroke={INK} strokeWidth="2" opacity=".18" />
            <path d={`M940 ${510 + i * 9} H${940 + 74 * v}`} stroke={i === 4 ? 'var(--ink)' : INK} strokeWidth="2" className="bar" style={{ animationDelay: `${i * .12}s` }} />
          </g>
        ))}
        <text x="790" y="562" className="tiny">SCORECARD</text>
      </Room>

      <Room id="practice" x={1050} y={467} w={240} h={143} label="PRACTICE BOOTH">
        <rect x={1092} y={494} width="76" height="116" className="pp" stroke={INK} strokeWidth="2.4" />
        <rect x={1098} y={500} width="64" height="60" fill="url(#glass)" stroke={INK} strokeWidth="1.2" />
        <path d="M1130 500 V560" stroke={INK} strokeWidth="1" />
        <Person x={1130} y={610} s={0.92} arm="phone" />
        <rect x={1198} y={520} width="64" height="44" rx="6" className="pp" stroke={INK} strokeWidth="1.8" />
        <path d="M1198 556 L1188 568 L1206 560" className="pp" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
        <text x="1230" y="538" textAnchor="middle" className="tiny">“WHO IS</text>
        <text x="1230" y="552" textAnchor="middle" className="tiny">THIS?”</text>
        <circle cx="1240" cy="590" r="8" className="pp" stroke={INK} strokeWidth="1.6" />
        <path d="M1240 582 V572 M1234 572 H1246" stroke={INK} strokeWidth="1.4" />
        <text x="1178" y="600" className="tiny">AI PROSPECT</text>
      </Room>

      <Room id="sequencing" x={250} y={622} w={650} h={158} label="PREP LINE">
        {/* three clocks */}
        {[[320, 'SF'], [372, 'NYC'], [424, 'BER']].map(([cx, l], i) => (
          <g key={l} transform={`translate(${cx} 660)`}>
            <circle r="14" className="pp" stroke={INK} strokeWidth="1.8" />
            <path d={`M0 0 L0 -9 M0 0 L${[6, -5, 7][i]} ${[3, 5, -3][i]}`} stroke={INK} strokeWidth="1.6" strokeLinecap="round" />
            <text y="30" textAnchor="middle" className="tiny">{l}</text>
          </g>
        ))}
        <text x="300" y="712" className="tiny">SEND WINDOW 8–18</text>
        {/* conveyor */}
        <g className="conveyor">
          <circle cx="480" cy="750" r="14" className="pp" stroke={INK} strokeWidth="2.4" />
          <circle cx="860" cy="750" r="14" className="pp" stroke={INK} strokeWidth="2.4" />
          <circle cx="480" cy="750" r="4" fill={INK} />
          <circle cx="860" cy="750" r="4" fill={INK} />
          <path d="M480 736 H860 M480 764 H860" stroke={INK} strokeWidth="2.4" />
          <path d="M480 736 H860" stroke={INK} strokeWidth="2.4" strokeDasharray="10 8" className="belt" />
          <path d="M520 764 V780 M820 764 V780 M670 764 V780" stroke={INK} strokeWidth="3" />
          <g className="parcels">
            <Envelope x={540} y={726} />
            <Envelope x={620} y={726} />
            <Envelope x={700} y={726} />
            <Envelope x={780} y={726} />
          </g>
        </g>
        {/* stamp arm */}
        <path d="M740 652 V700 M716 700 H764" stroke={INK} strokeWidth="4" strokeLinecap="round" />
        <rect x={726} y={700} width="28" height="18" fill={INK} className="stamp" />
        <text x="702" y="646" className="tiny">DRAFTS</text>
        {/* people */}
        <Person x={462} y={780} s={1.05} arm="out" />
        <Person x={888} y={780} s={1.05} arm="up" flip />
        <Envelope x={884} y={722} s={0.9} />
        {/* mail slot to the inbox */}
        <rect x={262} y={736} width="60" height="44" fill="url(#floor)" stroke={INK} strokeWidth="1.6" />
        <path d="M270 748 H314 M270 760 H314 M270 772 H314" stroke={INK} strokeWidth="1.2" />
        <text x="262" y="730" className="tiny">REPLIES</text>
      </Room>

      <Room id="assistant" x={920} y={622} w={370} h={158} label="CONTROL DESK">
        {/* panel of 66 knobs: 6 rows x 11 */}
        <rect x={938} y={646} width="168" height="98" className="pp" stroke={INK} strokeWidth="2" />
        {Array.from({ length: 66 }, (_, i) => {
          const r = Math.floor(i / 11);
          const c = i % 11;
          const on = [3, 17, 24, 40, 51, 58].includes(i);
          return <circle key={i} cx={948 + c * 15} cy={658 + r * 15} r="4" fill={on ? 'var(--ink)' : 'none'} stroke={INK} strokeWidth="1.2" className={on ? 'led' : undefined} style={on ? { animationDelay: `${(i % 7) * .3}s` } : undefined} />;
        })}
        <text x="938" y="762" className="tiny">MCP TOOLS</text>
        {/* robot at the console */}
        <g transform="translate(1180 780)">
          <rect x="-26" y="-54" width="52" height="40" rx="6" className="pp" stroke={INK} strokeWidth="2" />
          <rect x="-18" y="-46" width="36" height="22" rx="2" fill="url(#glass)" stroke={INK} strokeWidth="1.4" />
          <circle cx="-7" cy="-35" r="3" fill="var(--ink)" className="blip" />
          <circle cx="7" cy="-35" r="3" fill="var(--ink)" className="blip" style={{ animationDelay: '-.5s' }} />
          <path d="M0 -54 V-70" stroke={INK} strokeWidth="2" />
          <circle cx="0" cy="-72" r="3.5" fill="var(--ink)" className="led" />
          <rect x="-16" y="-14" width="32" height="14" className="pp" stroke={INK} strokeWidth="2" />
          <path d="M-26 -40 L-48 -22 M26 -40 L48 -30" stroke={INK} strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="-48" cy="-22" r="4" fill={INK} />
          <circle cx="48" cy="-30" r="4" fill={INK} />
        </g>
        <path d="M1118 740 L1150 736" stroke={INK} strokeWidth="2" />
        <Screen x={1200} y={660} w={60} h={38} lines={4} />
        <text x="1120" y="662" className="tiny">CLAUDE · GROK</text>
        <text x="1120" y="676" className="tiny">CURSOR</text>
        {/* cables up into the house */}
        <path d="M1110 646 q0 -30 -40 -36" stroke={INK} strokeWidth="1.4" fill="none" strokeDasharray="4 3" opacity=".7" />
        <path d="M1010 646 q0 -24 -30 -24" stroke={INK} strokeWidth="1.4" fill="none" strokeDasharray="4 3" opacity=".7" />
      </Room>

      <Room id="selfhost" x={300} y={792} w={950} h={98} label="CELLAR">
        {/* the one tank */}
        <g transform="translate(560 890)">
          <rect x="-96" y="-82" width="192" height="82" rx="10" fill="url(#siding)" stroke={INK} strokeWidth="3" />
          <path d="M-96 -56 H96 M-96 -30 H96" stroke={INK} strokeWidth="1.6" />
          <rect x="-40" y="-72" width="80" height="26" rx="3" className="pp" stroke={INK} strokeWidth="1.6" />
          <text x="0" y="-55" textAnchor="middle" className="tiny">POSTGRES</text>
          <path d="M96 -40 h22 v10 M118 -30 l-4 6 M118 -30 l4 6" stroke={INK} strokeWidth="2.6" strokeLinecap="round" fill="none" />
          <circle cx="112" cy="-16" r="2" fill="var(--ink)" className="drip" />
        </g>
        {/* pipes from the floors above */}
        <path d="M400 792 V812 H464 M980 792 V812 H660" stroke={INK} strokeWidth="2.6" fill="none" />
        <path d="M464 812 V820 M660 812 V820" stroke={INK} strokeWidth="2.6" />
        {/* shelves of jars */}
        <path d="M720 830 H1000 M720 866 H1000" stroke={INK} strokeWidth="3" />
        {['JOBS', 'RATE LIMITS', 'WEBHOOKS', 'SESSIONS'].map((l, i) => (
          <g key={l} transform={`translate(${756 + i * 66} 830)`}>
            <rect x="-18" y="-28" width="36" height="28" rx="3" className="pp" stroke={INK} strokeWidth="1.6" />
            <rect x="-12" y="-34" width="24" height="6" fill={INK} />
            <text y="-11" textAnchor="middle" className="tiny" style={{ fontSize: 8 }}>{l}</text>
          </g>
        ))}
        {['PROSPECTS', 'CALLS', 'EMAILS'].map((l, i) => (
          <g key={l} transform={`translate(${790 + i * 80} 866)`}>
            <rect x="-24" y="-24" width="48" height="24" rx="3" className="pp" stroke={INK} strokeWidth="1.6" />
            <text y="-9" textAnchor="middle" className="tiny" style={{ fontSize: 8 }}>{l}</text>
          </g>
        ))}
        {/* hanging bulb and a person with a lamp */}
        <g transform="translate(1100 792)">
          <g className="bulb">
            <path d="M0 0 V30" stroke={INK} strokeWidth="1.6" />
            <circle cx="0" cy="38" r="8" fill="var(--ink)" className="led" />
          </g>
        </g>
        <Person x={1150} y={890} s={1} arm="up" />
                <text x="320" y="880" className="tiny">docker compose up</text>
      </Room>

      {/* ---------- structure: slabs and walls on top of the rooms ---------- */}
      <g className="structure">
        <Wall x={240} y={440} h={352} />
        <Wall x={1290} y={262} h={530} />
        <Wall x={1040} y={262} h={206} />
        <Slab x={236} y={440} w={812} />
        <Slab x={1040} y={455} w={260} />
        <Slab x={750} y={468} w={300} />
        <Wall x={750} y={452} h={158} w={20} />
        <Wall x={1040} y={468} h={142} />
        <Slab x={236} y={610} w={1064} />
        <Wall x={900} y={622} h={158} w={20} />
        <Slab x={236} y={780} w={1064} />
        <Wall x={290} y={792} h={108} />
        <Wall x={1250} y={792} h={108} />
        <Slab x={290} y={890} w={970} h={10} />
        {/* door and stair openings */}
        <path d="M770 610 H830" stroke="var(--paper)" strokeWidth="12" />
        <path d="M775 624 l6 -14 M787 624 l6 -14 M799 624 l6 -14 M811 624 l6 -14" stroke={INK} strokeWidth="2" />
        <path d="M1160 780 H1220" stroke="var(--paper)" strokeWidth="12" />
        <path d="M1165 794 l6 -14 M1177 794 l6 -14 M1189 794 l6 -14 M1201 794 l6 -14" stroke={INK} strokeWidth="2" />
      </g>
    </svg>
  );
}
