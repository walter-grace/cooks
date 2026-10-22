/** USD per million tokens. Unknown models report null cost (shown as "unpriced" in dashboards). */
const PRICES: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'grok-4.7': { in: 2, out: 6 },
  'grok-4.3': { in: 1.25, out: 2.5 },
};

export function estimateCostUsd(model: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): number | null {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ''];
  if (!p) return null;
  const cost =
    (u.input * p.in + u.output * p.out + (u.cacheRead ?? 0) * (p.cacheRead ?? p.in) + (u.cacheWrite ?? 0) * (p.cacheWrite ?? p.in)) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}
