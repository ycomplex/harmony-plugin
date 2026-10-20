// B-1170: the daemon's GitHub credential, shared. Extracted from src/daemon/github-pr-state.ts
// (B-1073) so TWO readers use one implementation: the PR merge-state reader, and the conductor
// config source (src/config/conductor-project-source.ts), which reads `.harmony/conductor.json`
// from a repo's `main` with the SAME harmony-daemon App installation token.
//
// WHY ONE MODULE. Duplicating the JWT/installation-token dance would mean two token caches (two
// mints per hour instead of one) and two places to fix when GitHub changes a header. The script
// scripts/mint-installation-token.mjs stays a separate zero-dependency duplicate (it lives outside
// `src/`'s rootDir); this module is the in-process one.
//
// CREDENTIAL SOURCES, in order: the App identity (HARMONY_APP_ID, HARMONY_APP_INSTALLATION_ID,
// HARMONY_APP_PRIVATE_KEY_PATH | HARMONY_APP_PRIVATE_KEY) -> a static GH_TOKEN / GITHUB_TOKEN. With
// neither, `createGithubTokenProvider` returns `undefined` and callers degrade (no interception / no
// project file refresh).
//
// `appOverride` carries the HOST FILE's github_app block (~/.harmony/conductor-host.json). It only
// fills identity fields whose HARMONY_APP_* env var is UNSET — env always wins, so a daemon.env that
// still exports the old variables keeps behaving exactly as before the host file existed.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const GITHUB_API_DEFAULT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function buildAppJwt(appId: string, privateKey: string, nowSeconds: number): string {
  const b64url = (input: string) => Buffer.from(input).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

export interface GithubAppOverride {
  app_id?: string;
  installation_id?: string;
  private_key_path?: string;
}

export interface GithubTokenProviderDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  now?: () => number;
  /** Host-file defaults; each field applies only when its HARMONY_APP_* env var is unset. */
  appOverride?: GithubAppOverride;
}

/** A token getter, or `undefined` when there is no usable GitHub credential source. The getter may
 *  throw (unreadable key file); callers wrap it in their own never-throws boundary. */
export function createGithubTokenProvider(
  deps: GithubTokenProviderDeps,
): (() => Promise<string | null>) | undefined {
  const { env } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const now = deps.now ?? Date.now;
  const api = env.GITHUB_API_URL || GITHUB_API_DEFAULT;

  const appId = env.HARMONY_APP_ID || deps.appOverride?.app_id;
  const installationId = env.HARMONY_APP_INSTALLATION_ID || deps.appOverride?.installation_id;
  const keyPath = env.HARMONY_APP_PRIVATE_KEY_PATH || deps.appOverride?.private_key_path;
  const keyInline = env.HARMONY_APP_PRIVATE_KEY;
  const hasApp = !!(appId && installationId && (keyPath || keyInline));
  const staticToken = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!hasApp && !staticToken) return undefined;

  let cached: { token: string; expiresAtMs: number } | null = null;
  return async (): Promise<string | null> => {
    if (hasApp) {
      if (cached && cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;
      const privateKey = keyPath
        ? readFile(keyPath)
        : (keyInline as string).includes('\\n') ? (keyInline as string).replace(/\\n/g, '\n') : (keyInline as string);
      const jwt = buildAppJwt(appId as string, privateKey, Math.floor(now() / 1000));
      const res = await fetchImpl(`${api}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { token?: string; expires_at?: string };
      if (!body.token) return null;
      const exp = body.expires_at ? Date.parse(body.expires_at) : NaN;
      cached = { token: body.token, expiresAtMs: Number.isNaN(exp) ? now() + 50 * 60_000 : exp };
      return body.token;
    }
    return staticToken ?? null;
  };
}
