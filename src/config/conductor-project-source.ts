// B-1170 (round A): the ASYNC side of conductor config — getting `.harmony/conductor.json` from `main` of
// a GitHub repo into the local last-good SNAPSHOT that src/config/conductor-config.ts reads synchronously.
//
// DESIGN (decision bd577c82 on B-1170): the daemon reads the file through the GitHub contents API with its
// existing App installation token (src/config/github-app-token.ts) — no clone, no new credential. The
// loader itself stays synchronous and offline; THIS module is the only thing that touches the network, and
// it exists to keep one invariant: a good snapshot is NEVER lost. A bad commit to the project file, a
// GitHub outage, an uninstalled App — every failure keeps the last-good snapshot and says why in a single
// warning. Nothing here throws, nothing deletes or truncates a snapshot (writes are temp file + rename).
//
// Everything with a side effect is injected (tokenProvider, fetchImpl, now, warn), so tests run offline.

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CONDUCTOR_PROJECT_PATH,
  ConductorConfigError,
  parseSnapshotText,
  validateProjectFileText,
  type ConductorSnapshot,
} from './conductor-config.js';
import { GITHUB_API_DEFAULT } from './github-app-token.js';

export { resolveConfigRepo, missingConfigRepoIssue } from './conductor-config.js';

const REQUEST_TIMEOUT_MS = 10_000;

export type FetchProjectFileResult =
  | { status: 'ok'; text: string; etag: string | null; sha: string }
  | { status: 'not-modified' }
  | { status: 'error'; code: string; message: string };

export interface FetchProjectFileInput {
  repo: string;
  ref?: string;
  path?: string;
  etag?: string | null;
  tokenProvider: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  apiBase?: string;
}

/** The git blob sha of `text` — the same value the contents API reports as `sha`, computed locally
 *  because the raw media type returns the bare file body. */
export function gitBlobSha(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** GET the project file. Never throws. */
export async function fetchProjectFile(input: FetchProjectFileInput): Promise<FetchProjectFileResult> {
  const ref = input.ref ?? 'main';
  const path = input.path ?? CONDUCTOR_PROJECT_PATH;
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiBase = (input.apiBase ?? GITHUB_API_DEFAULT).replace(/\/+$/, '');
  const where = `${input.repo}:${path}@${ref}`;
  try {
    let token: string | null;
    try {
      token = await input.tokenProvider();
    } catch (err) {
      return { status: 'error', code: 'no-token', message: `could not obtain a GitHub token to read ${where}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!token) {
      return { status: 'error', code: 'no-token', message: `no GitHub token available to read ${where} (the harmony-daemon App token could not be minted)` };
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (input.etag) headers['If-None-Match'] = input.etag;
    const res = await fetchImpl(`${apiBase}/repos/${input.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 304) return { status: 'not-modified' };
    if (res.status === 404 || res.status === 403) {
      const code = res.status === 404 ? 'not-found' : 'forbidden';
      return {
        status: 'error',
        code,
        message: `${res.status} reading ${where}: ${res.status === 404 ? 'the file or repo was not found' : 'access was refused'}. The harmony-daemon App installation may not include ${input.repo} (add the repo to the installation), or the file does not exist on ${ref}`,
      };
    }
    if (res.status === 401) {
      return { status: 'error', code: 'unauthorized', message: `401 reading ${where}: the GitHub token was rejected` };
    }
    if (!res.ok) {
      return { status: 'error', code: `http-${res.status}`, message: `HTTP ${res.status} reading ${where}` };
    }
    const text = await res.text();
    return { status: 'ok', text, etag: res.headers?.get?.('etag') ?? null, sha: gitBlobSha(text) };
  } catch (err) {
    return { status: 'error', code: 'network', message: `network error reading ${where}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The snapshot at `path`, or null when absent/unreadable/malformed. */
export function readSnapshot(path: string): ConductorSnapshot | null {
  try {
    return parseSnapshotText(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomic write: temp file in the same directory (mode 0600) then rename over the target. */
export function writeSnapshot(path: string, snap: ConductorSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(snap, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export type RefreshOutcome = 'updated' | 'unchanged' | 'kept-last-good' | 'unreachable';

export interface RefreshProjectFileInput {
  repo: string;
  ref?: string;
  snapshotPath: string;
  tokenProvider: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
  path?: string;
  apiBase?: string;
}

/** Fetch with the snapshot's etag; replace the snapshot only with a VALID new file. Never throws; never
 *  deletes or truncates a good snapshot. */
export async function refreshProjectFile(
  input: RefreshProjectFileInput,
): Promise<{ outcome: RefreshOutcome; warnings: string[] }> {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    try {
      input.warn?.(m);
    } catch {
      /* a broken warn sink must not break the refresh */
    }
  };
  const ref = input.ref ?? 'main';
  const path = input.path ?? CONDUCTOR_PROJECT_PATH;
  const now = input.now ?? Date.now;
  try {
    const existing = readSnapshot(input.snapshotPath);
    const sameSource = existing && existing.source.repo === input.repo && existing.source.ref === ref && existing.source.path === path;
    const res = await fetchProjectFile({
      repo: input.repo,
      ref,
      path,
      etag: sameSource ? existing.etag : null,
      tokenProvider: input.tokenProvider,
      fetchImpl: input.fetchImpl,
      now: input.now,
      apiBase: input.apiBase,
    });
    if (res.status === 'not-modified') return { outcome: 'unchanged', warnings };
    if (res.status === 'error') {
      warn(`conductor config refresh failed (${res.code}): ${res.message}; ${existing ? 'keeping the last-good snapshot' : 'no snapshot exists yet'}`);
      return { outcome: 'unreachable', warnings };
    }
    const v = validateProjectFileText(`conductor.json (${ref})`, res.text);
    if (!v.ok) {
      warn(`conductor config on ${input.repo}@${ref} is invalid; ${existing ? 'keeping the last-good snapshot' : 'no snapshot exists yet'}:\n${new ConductorConfigError(v.issues).message}`);
      return { outcome: 'kept-last-good', warnings };
    }
    if (existing && sameSource && existing.sha === res.sha) return { outcome: 'unchanged', warnings };
    writeSnapshot(input.snapshotPath, {
      version: 1,
      source: { repo: input.repo, ref, path },
      etag: res.etag,
      sha: res.sha,
      fetched_at: new Date(now()).toISOString(),
      content: res.text,
    });
    return { outcome: 'updated', warnings };
  } catch (err) {
    warn(`conductor config refresh failed unexpectedly: ${err instanceof Error ? err.message : String(err)}; the last-good snapshot is untouched`);
    return { outcome: 'unreachable', warnings };
  }
}
