// B-1073 (daemon-files-recording round) — the daemon's READ-ONLY view of one GitHub PR's merge state,
// wired into SchedulerDeps.getPrMergeState (src/bin/daemon.ts). Used to confirm a fast-track PR is
// MERGED before the daemon files its post-merge recording (src/daemon/fasttrack-release-recording.ts).
//
// CREDENTIAL. The daemon process holds no GitHub credential of its own by design (B-694 two-envelope
// rule: worker credentials live only in the launch profile's env-file). It does, however, run on the
// LAUNCHER host, whose environment carries the harmony-daemon GitHub App identity the launch template's
// `scripts/mint-installation-token.mjs` reads (HARMONY_APP_ID, HARMONY_APP_INSTALLATION_ID,
// HARMONY_APP_PRIVATE_KEY_PATH | HARMONY_APP_PRIVATE_KEY — validated by the boot preflight). This module
// mints an installation token from that SAME identity (same JWT claims; duplicated here because the
// script is a zero-dependency .mjs outside `src/`'s rootDir) and caches it until shortly before expiry.
// A plain `GH_TOKEN` / `GITHUB_TOKEN` in the daemon's env is used instead when no App identity is set.
// With NEITHER, `createGithubPrMergeStateReader` returns `undefined` and the daemon simply does not
// intercept — every fast-track wake takes the ordinary worker path (today's behaviour).
//
// Read-only (GET /repos/{owner}/{repo}/pulls/{n}); any failure is 'unknown' — never throws.

import { createGithubTokenProvider, GITHUB_API_DEFAULT } from '../config/github-app-token.js';
import type { PrMergeState } from './fasttrack-release-recording.js';

const REQUEST_TIMEOUT_MS = 10_000;
const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?/i;

/** Pure: `https://github.com/o/r/pull/12` -> { owner, repo, number }, else null. */
export function parseGithubPrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = PR_URL.exec(url.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** Pure: GitHub's pull-request JSON -> PrMergeState. `merged === true` wins; else open/closed by `state`. */
export function prMergeStateFromPullJson(json: unknown): PrMergeState {
  const pr = json as { merged?: unknown; state?: unknown } | null;
  if (!pr || typeof pr !== 'object') return 'unknown';
  if (pr.merged === true) return 'merged';
  if (pr.state === 'open') return 'open';
  if (pr.state === 'closed') return 'closed';
  return 'unknown';
}

export interface GithubPrReaderDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFile?: (path: string) => string;
  now?: () => number;
}

/** A PR merge-state reader, or `undefined` when the daemon has no usable GitHub credential source. */
export function createGithubPrMergeStateReader(
  deps: GithubPrReaderDeps,
): ((prUrl: string) => Promise<PrMergeState>) | undefined {
  const { env } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const api = env.GITHUB_API_URL || GITHUB_API_DEFAULT;
  // B-1170: the App-JWT + installation-token minting (and its cache) moved to the shared provider.
  const getToken = createGithubTokenProvider({ env, fetchImpl, readFile: deps.readFile, now: deps.now });
  if (!getToken) return undefined;

  return async (prUrl: string): Promise<PrMergeState> => {
    try {
      const parsed = parseGithubPrUrl(prUrl);
      if (!parsed) return 'unknown';
      const token = await getToken();
      if (!token) return 'unknown';
      const res = await fetchImpl(`${api}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return 'unknown';
      return prMergeStateFromPullJson(await res.json());
    } catch {
      return 'unknown';
    }
  };
}
