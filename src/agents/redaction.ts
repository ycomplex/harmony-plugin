// B-1076: redact credential material from text that leaves the worker (recorded output tails,
// failure tails, diagnostics). Pure; never throws. The Codex login cache (auth.json) holds a bearer
// access token, a refresh token and an id token, and a failing Codex run can echo any of them
// (a 401 body, a debug line, a JSONL error event). The adapter's contract is that the secret never
// enters env or logs — this is the backstop for the "logs" half.
//
// Patterns are deliberately about SHAPE, not about known values (the worker never reads the file):
//  - `Authorization: Bearer <token>` / `Bearer <token>`
//  - JSON / query / env style `"refresh_token": "<v>"`, `refresh_token=<v>`, and the same for
//    access_token, id_token, api_key, OPENAI_API_KEY, CODEX_API_KEY, CODEX_ACCESS_TOKEN
//  - bare JWTs (three base64url segments starting `eyJ`)
//  - OpenAI-style secret keys (`sk-…`)

export const REDACTED = '[REDACTED]';

const KEY_NAMES = '(?:refresh_token|access_token|id_token|api[_-]?key|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)';

const RULES: ReadonlyArray<{ re: RegExp; replace: string | ((m: string, ...g: string[]) => string) }> = [
  // Bearer <token> (header or prose). The token charset covers opaque tokens and JWTs.
  { re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: `$1${REDACTED}` },
  // "refresh_token": "value" — JSON, with optional escaped quotes (\"…\") when nested in a string.
  {
    re: new RegExp(`((?:\\\\?["'])?${KEY_NAMES}(?:\\\\?["'])?\\s*[:=]\\s*(?:\\\\?["'])?)[^\\s"'\\\\,;&}]{4,}`, 'gi'),
    replace: `$1${REDACTED}`,
  },
  // bare JWT
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, replace: REDACTED },
  // sk-… secret keys
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, replace: REDACTED },
];

/** Replace bearer tokens, refresh/access/id tokens, JWTs and API keys in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const { re, replace } of RULES) {
    out = out.replace(re, replace as string);
  }
  return out;
}
