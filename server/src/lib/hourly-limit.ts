// hourly-limit.ts — a per-key, in-memory counter for public routes: `limited(key)` is true once a key has made more than
// `max` calls inside the hour. Same pattern as the paperwork page's limiter (routes/group-forms.ts); one box, one process.

export function hourlyLimiter(max: number, now: () => number = Date.now): (key: string) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key) => {
    const t = now();
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt < t) hits.delete(k);
    const e = hits.get(key);
    if (!e || e.resetAt < t) { hits.set(key, { count: 1, resetAt: t + 60 * 60 * 1000 }); return false; }
    e.count++;
    return e.count > max;
  };
}
