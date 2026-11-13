// B-1305: the credential scan a project brief section's markdown passes before compose_brief files it.
//
// Two checks, the first finding wins:
//   1. shape — every entry of the shared TOKEN_SHAPES list (src/tools/token-shapes.ts) EXCEPT the
//      `long-base64-run` catch-all. That catch-all also matches a full 40-character git SHA and a long
//      path, which a section about the ticket's work legitimately quotes; the named shapes do not.
//   2. env — the exact value of any environment variable whose NAME contains TOKEN, KEY, SECRET,
//      PASSWORD or CREDENTIAL (any case) and whose value is at least 16 characters, as a substring.
//
// A finding names the shape or the variable, never the matched value: the result is printed in a
// refusal, and the refusal must not become the leak.

import { TOKEN_SHAPES } from './token-shapes.js';

export type SectionScanFinding = { kind: 'shape'; shape: string } | { kind: 'env'; variable: string };

const CATCH_ALL = 'long-base64-run';
const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL/i;
export const ENV_VALUE_MIN_LENGTH = 16;

/** The first credential finding in `text`, or null. Never throws; never returns the matched value. */
export function scanSectionText(
  text: string,
  env: Record<string, string | undefined> = process.env,
): SectionScanFinding | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const { name, pattern } of TOKEN_SHAPES) {
    if (name === CATCH_ALL) continue;
    if (new RegExp(pattern.source, pattern.flags.replace('g', '')).test(text)) return { kind: 'shape', shape: name };
  }
  for (const [variable, value] of Object.entries(env)) {
    if (!CREDENTIAL_NAME.test(variable)) continue;
    if (typeof value !== 'string' || value.length < ENV_VALUE_MIN_LENGTH) continue;
    if (text.includes(value)) return { kind: 'env', variable };
  }
  return null;
}

/** One line describing a finding — the shape name or the variable NAME only. */
export function describeScanFinding(f: SectionScanFinding): string {
  return f.kind === 'shape'
    ? `it contains text shaped like a credential (${f.shape})`
    : `it contains the value of the environment variable ${f.variable}`;
}
