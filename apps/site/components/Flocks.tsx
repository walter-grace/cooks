/** Two flocks of birds: SVG paths whose shape animates with SMIL, drifted across the sky by CSS. */
const flap = (rest: string, mid: string, dur: string, begin?: string) => (
  <path>
    <animate attributeName="d" dur={dur} begin={begin} repeatCount="indefinite" values={`${rest};${mid};${rest}`} />
  </path>
);

export function Flocks() {
  return (
    <>
      <div className="flock">
        <svg viewBox="0 0 180 70">
          {flap('M80 8 Q86 2 92 8 Q98 2 104 8', 'M80 6 Q86 10 92 6 Q98 10 104 6', '0.55s')}
          {flap('M56 22 Q61 17 66 22 Q71 17 76 22', 'M56 20 Q61 24 66 20 Q71 24 76 20', '0.62s', '0.1s')}
          {flap('M104 24 Q109 19 114 24 Q119 19 124 24', 'M104 22 Q109 26 114 22 Q119 26 124 22', '0.58s', '0.25s')}
          {flap('M30 36 Q34 32 38 36 Q42 32 46 36', 'M30 35 Q34 38 38 35 Q42 38 46 35', '0.66s', '0.05s')}
          {flap('M130 40 Q134 36 138 40 Q142 36 146 40', 'M130 39 Q134 42 138 39 Q142 42 146 39', '0.6s', '0.35s')}
        </svg>
      </div>
      <div className="flock b">
        <svg viewBox="0 0 180 70">
          {flap('M70 20 Q75 15 80 20 Q85 15 90 20', 'M70 18 Q75 22 80 18 Q85 22 90 18', '0.7s')}
          {flap('M100 34 Q104 30 108 34 Q112 30 116 34', 'M100 33 Q104 36 108 33 Q112 36 116 33', '0.74s', '0.2s')}
          {flap('M44 40 Q48 36 52 40 Q56 36 60 40', 'M44 39 Q48 42 52 39 Q56 42 60 39', '0.68s', '0.4s')}
        </svg>
      </div>
    </>
  );
}

/** A skillet drawn in one line: the brand mark. */
export function Brand({ href = '#top', label = 'Cooks home' }: { href?: string; label?: string }) {
  return (
    <a className="brand" href={href} aria-label={label}>
      <svg viewBox="0 0 44 30" aria-hidden="true">
        <circle cx="15" cy="18" r="9.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
        <path d="M24.5 18h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M11 6c-1.5-2 1.5-3 0-5M16 6c-1.5-2 1.5-3 0-5M21 6c-1.5-2 1.5-3 0-5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>C<span className="oo">oo</span>ks</span>
    </a>
  );
}
