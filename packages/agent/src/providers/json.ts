/** Tolerant JSON extraction for model output: code fences, leading prose, trailing text. */
export function extractJson(text: string): unknown | undefined {
  const t = text.trim();
  const attempts = [t, t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')];
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) attempts.push(t.slice(first, last + 1));
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* next */
    }
  }
  return undefined;
}
