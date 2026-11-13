// B-1452: the ONE list of token-shaped patterns the plugin's TypeScript code recognises.
//
// Used by:
//   - src/hooks/stop-gate.ts `safeRef` — a waiting_on ref that looks like a credential is printed as
//     `[redacted]` in the Stop hook's block reason (the original home of these regexes).
//   - src/tools/incident.ts `raiseIncident` — the what / where / human-steps text of a raised incident is
//     scrubbed BEFORE anything is written (exchange round, task ref, comment, return value).
//   - src/tools/brief-section-scan.ts (B-1305) — a project brief section's markdown is refused when it
//     carries any shape here except the long-base64-run catch-all.
//
// KEEP IN STEP: B-1451's shell pre-push guard (container/git-guard*) carries its OWN list of token
// shapes, in shell. The two lists are deliberately separate (one runs in TypeScript, the other in a git
// hook with no node), so a shape added or removed here must be added or removed there too, and the
// reverse.
//
// Every pattern is cheap and low on false positives, with ONE deliberate exception kept from safeRef:
// a run of 32 or more base64-ish characters. That also catches a full 40-character git SHA and a long
// slash-joined path with no dots or dashes; over-redacting is the safe side for both callers. Name a
// commit by a short SHA (31 characters or fewer) when it must survive.

export interface TokenShape {
  /** What the shape is, for tests and messages. Never the matched value. */
  name: string;
  /** Global pattern matching the WHOLE token (prefix and body), so scrubbing removes all of it. */
  pattern: RegExp;
}

/** Preceded by start-of-string or a non-alphanumeric character (so `risk-` never reads as `sk-`). */
const B = '(?<![A-Za-z0-9])';

export const TOKEN_SHAPES: readonly TokenShape[] = [
  { name: 'github', pattern: new RegExp(`${B}(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]*`, 'g') },
  { name: 'sk-key', pattern: new RegExp(`${B}sk-[A-Za-z0-9_-]*`, 'g') },
  { name: 'jwt', pattern: new RegExp(`${B}eyJ[A-Za-z0-9_+/=.-]*`, 'g') },
  { name: 'slack', pattern: new RegExp(`${B}xox[abpr]-[A-Za-z0-9-]+`, 'g') },
  { name: 'aws-access-key', pattern: new RegExp(`${B}AKIA[0-9A-Z]{16}`, 'g') },
  // Every Figma token prefix: `figd_` (personal access token), `figu_` (OAuth user token, the shape that
  // leaked on 2026-11-11), and any other `fig<letter>_` Figma adds. Matches prefix AND body, so a scrub
  // leaves no prefix behind, including a body with `_` or `-` in short runs the long-run fallback misses.
  { name: 'figma', pattern: new RegExp(`${B}fig[a-z]_[A-Za-z0-9_-]+`, 'g') },
  { name: 'google-api-key', pattern: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}`, 'g') },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // B-1305: a Supabase secret (service) key, `sb_secret_` and its body.
  { name: 'supabase-secret-key', pattern: new RegExp(`${B}sb_secret_[A-Za-z0-9_-]+`, 'g') },
  // B-1305: a Harmony API token, `harmony_` and 64 hex characters.
  { name: 'harmony-api-token', pattern: new RegExp(`${B}harmony_[0-9a-f]{64}(?![0-9a-f])`, 'g') },
  // Last: it would otherwise eat part of a longer, more specific match above.
  { name: 'long-base64-run', pattern: /[A-Za-z0-9+/]{32,}={0,2}/g },
];

export const REDACTED = '[redacted]';

/** True when `s` contains any token shape. Never throws. */
export function containsTokenShape(s: string): boolean {
  if (typeof s !== 'string' || s.length === 0) return false;
  return TOKEN_SHAPES.some(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace('g', '')).test(s));
}

/** `s` with every token-shaped match replaced by `[redacted]`. Idempotent; never throws (a non-string
 *  reads as empty). */
export function scrubTokenShapes(s: string): string {
  if (typeof s !== 'string') return '';
  let out = s;
  for (const { pattern } of TOKEN_SHAPES) {
    out = out.replace(new RegExp(pattern.source, pattern.flags), REDACTED);
  }
  return out;
}
