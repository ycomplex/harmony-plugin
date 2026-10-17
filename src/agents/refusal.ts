// B-1149: the refusal verdict of seam 10 (telemetry) — "the runtime refused this turn because a plan
// quota or a rate limit is exhausted". Each adapter recognises its OWN CLI's refusal shapes in its
// telemetry parse (codex.ts, claude-code.ts); the daemon never sees a byte of worker output — the
// verdict travels as two columns on the leg's conduction_leg_costs row (refusal_kind,
// refusal_resets_at), written by `harmony leg-cost record` on the worker's side, and read back by the
// scheduler at settle (src/daemon/scheduler.ts → classify.ts).
//
// Pure functions, no I/O.

export type RefusalKind = 'quota' | 'rate-limit';

export interface Refusal {
  kind: RefusalKind;
  /** ISO timestamp when the runtime said the limit resets, or null when it did not say (or said it
   *  in a form that cannot be placed on a calendar without guessing, e.g. a bare "3pm"). */
  resets_at: string | null;
}

export const REFUSAL_KINDS: readonly RefusalKind[] = ['quota', 'rate-limit'];

export function isRefusalKind(v: unknown): v is RefusalKind {
  return v === 'quota' || v === 'rate-limit';
}

/** B-1149 test hook: set to `quota` or `rate-limit` and every adapter's telemetry parse reports that
 *  refusal (resets_at null), whatever the capture says — so staging can drive the daemon's
 *  pause/retry path end to end without exhausting a real plan. Any other value is ignored. Test-only:
 *  never set it on a production deployment. */
export const FORCE_REFUSAL_ENV = 'HARMONY_TEST_FORCE_REFUSAL';

export function forcedRefusal(env: Readonly<Record<string, string | undefined>> = process.env): Refusal | null {
  const v = env[FORCE_REFUSAL_ENV];
  return isRefusalKind(v) ? { kind: v, resets_at: null } : null;
}

/** Turn a seconds-from-now figure into an ISO time, or null for a non-positive/non-finite value. */
export function resetsInSeconds(seconds: unknown, now: Date): string | null {
  const n = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return new Date(now.getTime() + n * 1000).toISOString();
}

/** An absolute reset time: epoch seconds, epoch milliseconds, or an ISO-like date string. Null when
 *  it cannot be placed on a calendar. */
export function absoluteResetTime(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // < 1e12 ⇒ seconds (an epoch-ms figure is 13 digits until the year 33658).
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const t = v.trim();
    if (/^\d+$/.test(t)) return absoluteResetTime(Number(t));
    // Only strings that carry a calendar date: a bare clock time ("3:05 PM") is a guess about the day
    // and the timezone, so it is NOT placed — the daemon's default hold applies instead.
    if (!/\d{4}-\d{2}-\d{2}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(t)) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
};

/** "try again in 2 days 3 hours 5 minutes" / "retry after 30s" / "resets in 4h 10m" → seconds. */
export function relativeResetSeconds(text: string): number | null {
  const m = /(?:try again|retry|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m) return null;
  let total = 0;
  let any = false;
  for (const part of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = UNIT_SECONDS[part[2].toLowerCase()];
    if (unit === undefined) continue;
    total += Number(part[1]) * unit;
    any = true;
  }
  return any && total > 0 ? total : null;
}

/** "try again at 2026-10-17T20:00:00Z" / "resets at Oct 18, 2026 9:00 AM UTC" → ISO, else null. */
export function absoluteResetFromText(text: string): string | null {
  const m = /(?:try again|resets?|available again)\s+(?:at|on)\s+([^.;\n)]+)/i.exec(text);
  return m ? absoluteResetTime(m[1]) : null;
}

/** The reset time a free-text refusal message names, relative or absolute, else null. */
export function resetFromText(text: string, now: Date): string | null {
  const rel = relativeResetSeconds(text);
  if (rel !== null) return resetsInSeconds(rel, now);
  return absoluteResetFromText(text);
}
