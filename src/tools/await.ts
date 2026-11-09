/**
 * `harmony await` (B-1423): one blocking wait on a GitHub condition, probed ONLY through the `gh`
 * CLI subprocess. gh uses its own login; this code reads no token and needs no Harmony board auth.
 *
 * Exit codes: 0 = condition met; 1 = condition can no longer be met; 2 = fatal (bad or missing
 * arguments, gh not installed, gh not logged in); 3 = max wait passed with the condition pending.
 *
 * A probe whose gh call fails (non-zero exit, unparseable JSON) is NOT fatal — keep polling — but
 * every failed probe prints one stderr line naming the exact command, its exit code and its stderr.
 */
import { execFile } from 'node:child_process';

export const AWAIT_EXIT = { met: 0, unmeetable: 1, fatal: 2, timedOut: 3 } as const;

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the gh executable itself could not be found (ENOENT). */
  notFound?: boolean;
}
export type GhRunner = (args: string[]) => Promise<GhResult>;

export interface AwaitIo {
  out: (line: string) => void;
  err: (line: string) => void;
}
export interface AwaitDeps {
  gh: GhRunner;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  io: AwaitIo;
  json: boolean;
}

export interface CommonAwaitOptions {
  interval?: string | number;
  maxWait?: string | number;
}
export interface CiAwaitOptions extends CommonAwaitOptions { repo?: string; sha?: string; pr?: string | number }
export interface PrAwaitOptions extends CommonAwaitOptions { repo?: string; until?: string }
export interface BranchAwaitOptions extends CommonAwaitOptions { repo?: string; names?: string }
export interface PromoteAwaitOptions extends CommonAwaitOptions {
  webRepo?: string; pluginRepo?: string; webSha?: string; pluginSha?: string;
}

/** gh missing, or gh reports it is not logged in / auth failed. */
export class AwaitFatalError extends Error {}

type ProbeState = 'met' | 'pending' | 'unmeetable';
interface ProbeOutcome { state: ProbeState; summary: string; detail?: Record<string, unknown> }

const DEFAULT_INTERVAL_S = 30;
const DEFAULT_MAX_WAIT_S = 1800;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-fA-F]{7,40}$/;
const AUTH_FAILURE_RE = /not logged in|authentication required|gh auth login|bad credentials|HTTP 401/i;

/** Default runner: `gh` via execFile, no shell, prompts disabled. */
export const defaultGhRunner: GhRunner = (args) => new Promise((resolve) => {
  execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
    (error, stdout, stderr) => {
      const out = String(stdout ?? ''); const errText = String(stderr ?? '');
      if (!error) { resolve({ code: 0, stdout: out, stderr: errText }); return; }
      const e = error as NodeJS.ErrnoException & { code?: string | number };
      if (e.code === 'ENOENT') { resolve({ code: 127, stdout: out, stderr: errText || e.message, notFound: true }); return; }
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: out, stderr: errText || e.message });
    });
});

export function defaultAwaitDeps(json: boolean): AwaitDeps {
  return {
    gh: defaultGhRunner,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    io: { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) },
    json,
  };
}

function quoteArg(a: string): string {
  return /^[A-Za-z0-9_./:@=,+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}
export function formatGhCommand(args: string[]): string {
  return ['gh', ...args].map(quoteArg).join(' ');
}

/**
 * Runs one gh call and parses its JSON. Returns undefined on a failed probe (after printing it);
 * throws AwaitFatalError when gh is missing or not logged in.
 */
async function ghJson(deps: AwaitDeps, args: string[]): Promise<unknown | undefined> {
  const res = await deps.gh(args);
  const cmd = formatGhCommand(args);
  const stderr = res.stderr.trim();
  if (res.notFound) throw new AwaitFatalError(`gh is not installed or not on PATH (${cmd}: ${stderr || 'ENOENT'})`);
  if (res.code !== 0) {
    if (AUTH_FAILURE_RE.test(stderr)) throw new AwaitFatalError(`gh is not logged in (${cmd} exited ${res.code}: ${stderr})`);
    deps.io.err(`probe failed: ${cmd} exited ${res.code}: ${stderr || '(no stderr)'}`);
    return undefined;
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    deps.io.err(`probe failed: ${cmd} exited 0 with unparseable JSON (${(e as Error).message}): stderr: ${stderr || '(no stderr)'}`);
    return undefined;
  }
}

function emit(deps: AwaitDeps, event: Record<string, unknown>, text: string): void {
  deps.io.out(deps.json ? JSON.stringify(event) : text);
}

function parseSeconds(raw: string | number | undefined, fallback: number, name: string, allowZero: boolean): number {
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new AwaitArgError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number of seconds (got ${String(raw)})`);
  }
  return n;
}

export class AwaitArgError extends Error {}

function requireRepo(raw: string | undefined, flag: string): string {
  if (!raw) throw new AwaitArgError(`${flag} <owner/name> is required`);
  if (!REPO_RE.test(raw)) throw new AwaitArgError(`${flag} must be owner/name (got ${raw})`);
  return raw;
}
function requireSha(raw: string | undefined, flag: string): string {
  if (!raw) throw new AwaitArgError(`${flag} <sha> is required`);
  if (!SHA_RE.test(raw)) throw new AwaitArgError(`${flag} must be a commit sha (got ${raw})`);
  return raw;
}
function optionalSha(raw: string | undefined, flag: string): string | undefined {
  return raw === undefined ? undefined : requireSha(raw, flag);
}

/** The shared poll loop: probe at least once, then until met / unmeetable / max wait. */
async function pollUntil(
  deps: AwaitDeps, mode: string, common: CommonAwaitOptions, probe: () => Promise<ProbeOutcome>,
): Promise<number> {
  const intervalMs = parseSeconds(common.interval, DEFAULT_INTERVAL_S, '--interval', false) * 1000;
  const maxWaitMs = parseSeconds(common.maxWait, DEFAULT_MAX_WAIT_S, '--max-wait', true) * 1000;
  const start = deps.now();
  for (let attempt = 1; ; attempt++) {
    const outcome = await probe();
    const elapsedMs = deps.now() - start;
    emit(deps, { event: 'probe', mode, attempt, state: outcome.state, summary: outcome.summary, elapsed_s: Math.round(elapsedMs / 1000), ...outcome.detail },
      `await ${mode}: ${outcome.state} — ${outcome.summary}`);
    if (outcome.state === 'met') return finish(deps, mode, 'met', AWAIT_EXIT.met, outcome.summary);
    if (outcome.state === 'unmeetable') return finish(deps, mode, 'can-no-longer-be-met', AWAIT_EXIT.unmeetable, outcome.summary);
    if (elapsedMs >= maxWaitMs) {
      return finish(deps, mode, 'timed-out', AWAIT_EXIT.timedOut, `max wait ${maxWaitMs / 1000}s passed; still pending: ${outcome.summary}`);
    }
    await deps.sleep(Math.min(intervalMs, maxWaitMs - elapsedMs));
  }
}

function finish(deps: AwaitDeps, mode: string, outcome: string, exitCode: number, summary: string): number {
  emit(deps, { event: 'result', mode, outcome, exit_code: exitCode, summary }, `await ${mode}: ${outcome} (exit ${exitCode}) — ${summary}`);
  return exitCode;
}

/** Wraps a mode: argument errors and fatal gh errors exit 2 with one stderr line. */
async function guarded(deps: AwaitDeps, mode: string, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof AwaitArgError || e instanceof AwaitFatalError) {
      deps.io.err(`await ${mode}: fatal — ${e.message}`);
      if (deps.json) deps.io.out(JSON.stringify({ event: 'result', mode, outcome: 'fatal', exit_code: AWAIT_EXIT.fatal, summary: e.message }));
      return AWAIT_EXIT.fatal;
    }
    throw e;
  }
}

// ---------- ci ----------

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const SKIPPED_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL']);

interface NormalizedCheck { name: string; complete: boolean; conclusion: string }

/** Normalizes gh pr view statusCheckRollup entries (CheckRun + StatusContext). */
function normalizeRollup(rollup: unknown[]): NormalizedCheck[] {
  return rollup.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    if (c.__typename === 'StatusContext' || (c.context !== undefined && c.status === undefined)) {
      const state = String(c.state ?? '').toUpperCase();
      return { name: String(c.context ?? '(unnamed status)'), complete: state !== 'PENDING' && state !== 'EXPECTED' && state !== '', conclusion: state };
    }
    const status = String(c.status ?? '').toUpperCase();
    return { name: String(c.name ?? '(unnamed check)'), complete: status === 'COMPLETED', conclusion: String(c.conclusion ?? '').toUpperCase() };
  });
}

/** Normalizes REST check-runs (`gh api repos/R/commits/<sha>/check-runs`). */
function normalizeCheckRuns(runs: unknown[]): NormalizedCheck[] {
  return runs.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    return {
      name: String(c.name ?? '(unnamed check)'),
      complete: String(c.status ?? '').toLowerCase() === 'completed',
      conclusion: String(c.conclusion ?? '').toUpperCase(),
    };
  });
}

export function classifyChecks(checks: NormalizedCheck[]): ProbeOutcome {
  if (checks.length === 0) return { state: 'pending', summary: 'no checks reported yet', detail: { checks: [] } };
  const failed = checks.filter((c) => c.complete && (FAILING_CONCLUSIONS.has(c.conclusion) || (!SKIPPED_CONCLUSIONS.has(c.conclusion) && c.conclusion !== 'SUCCESS')));
  const incomplete = checks.filter((c) => !c.complete);
  const skipped = checks.filter((c) => c.complete && SKIPPED_CONCLUSIONS.has(c.conclusion));
  const passed = checks.filter((c) => c.complete && c.conclusion === 'SUCCESS');
  const detail = {
    passed: passed.map((c) => c.name),
    not_covered: skipped.map((c) => `${c.name} (${c.conclusion.toLowerCase()})`),
    failed: failed.map((c) => `${c.name} (${c.conclusion.toLowerCase() || 'no conclusion'})`),
    pending: incomplete.map((c) => c.name),
  };
  const notCovered = skipped.length ? `; not covered: ${detail.not_covered.join(', ')}` : '';
  if (failed.length) return { state: 'unmeetable', summary: `failed: ${detail.failed.join(', ')}${notCovered}`, detail };
  if (incomplete.length) {
    return { state: 'pending', summary: `${checks.length - incomplete.length}/${checks.length} checks complete; waiting on: ${detail.pending.join(', ')}`, detail };
  }
  return { state: 'met', summary: `${passed.length} passed${notCovered}`, detail };
}

export async function awaitCi(opts: CiAwaitOptions, deps: AwaitDeps): Promise<number> {
  return guarded(deps, 'ci', async () => {
    const repo = requireRepo(opts.repo, '--repo');
    if ((opts.sha === undefined) === (opts.pr === undefined)) throw new AwaitArgError('give exactly one of --sha <sha> or --pr <n>');
    let probe: () => Promise<ProbeOutcome>;
    if (opts.pr !== undefined) {
      const pr = parsePrNumber(opts.pr);
      const args = ['pr', 'view', String(pr), '--repo', repo, '--json', 'statusCheckRollup,headRefOid'];
      probe = async () => {
        const data = await ghJson(deps, args) as { statusCheckRollup?: unknown; headRefOid?: string } | undefined;
        if (data === undefined) return { state: 'pending', summary: 'probe failed; retrying' };
        if (!Array.isArray(data.statusCheckRollup)) return probeShapeFailure(deps, args, 'statusCheckRollup is not an array');
        const o = classifyChecks(normalizeRollup(data.statusCheckRollup));
        return { ...o, summary: `PR #${pr} head ${String(data.headRefOid ?? '?').slice(0, 7)}: ${o.summary}`, detail: { ...o.detail, head: data.headRefOid } };
      };
    } else {
      const sha = requireSha(opts.sha, '--sha');
      const args = ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`];
      probe = async () => {
        const data = await ghJson(deps, args) as { check_runs?: unknown } | undefined;
        if (data === undefined) return { state: 'pending', summary: 'probe failed; retrying' };
        if (!Array.isArray(data.check_runs)) return probeShapeFailure(deps, args, 'check_runs is not an array');
        const o = classifyChecks(normalizeCheckRuns(data.check_runs));
        return { ...o, summary: `commit ${sha.slice(0, 7)}: ${o.summary}`, detail: { ...o.detail, head: sha } };
      };
    }
    return pollUntil(deps, 'ci', opts, probe);
  });
}

function probeShapeFailure(deps: AwaitDeps, args: string[], why: string): ProbeOutcome {
  deps.io.err(`probe failed: ${formatGhCommand(args)} exited 0 with unexpected JSON: ${why}`);
  return { state: 'pending', summary: 'probe failed; retrying' };
}

function parsePrNumber(raw: string | number | undefined): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(n) || n <= 0) throw new AwaitArgError(`PR number must be a positive integer (got ${String(raw)})`);
  return n;
}

// ---------- pr ----------

export async function awaitPr(prRaw: string | number | undefined, opts: PrAwaitOptions, deps: AwaitDeps): Promise<number> {
  return guarded(deps, 'pr', async () => {
    const pr = parsePrNumber(prRaw);
    const repo = requireRepo(opts.repo, '--repo');
    const until = opts.until ?? 'merged';
    if (until !== 'merged' && until !== 'mergeable') throw new AwaitArgError(`--until must be merged or mergeable (got ${until})`);
    const args = ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,mergeable,mergedAt'];
    return pollUntil(deps, 'pr', opts, async () => {
      const data = await ghJson(deps, args) as { state?: string; mergeable?: string; mergedAt?: string | null } | undefined;
      if (data === undefined) return { state: 'pending', summary: 'probe failed; retrying' };
      const state = String(data.state ?? '').toUpperCase();
      const mergeable = String(data.mergeable ?? '').toUpperCase();
      const detail = { pr, state, mergeable, merged_at: data.mergedAt ?? null };
      const label = `PR #${pr} state ${state || '?'}, mergeable ${mergeable || '?'}`;
      if (state === 'MERGED') return { state: 'met', summary: `${label} (merged ${data.mergedAt ?? ''})`.trim(), detail };
      if (state === 'CLOSED') return { state: 'unmeetable', summary: `${label}: closed without merging`, detail };
      if (until === 'mergeable') {
        if (mergeable === 'MERGEABLE') return { state: 'met', summary: label, detail };
        if (mergeable === 'CONFLICTING') return { state: 'unmeetable', summary: `${label}: has conflicts`, detail };
      }
      return { state: 'pending', summary: label, detail };
    });
  });
}

// ---------- branch / promote ----------

/** Compare-ancestor test: true when `sha` is the head of, or an ancestor of, `branch`. Undefined on a failed probe. */
async function branchNames(deps: AwaitDeps, repo: string, branch: string, sha: string): Promise<{ names: boolean; status: string } | undefined> {
  const args = ['api', `repos/${repo}/compare/${sha}...${branch}`, '--jq', '{status: .status, ahead_by: .ahead_by, behind_by: .behind_by}'];
  const data = await ghJson(deps, args) as { status?: string } | undefined;
  if (data === undefined) return undefined;
  const status = String(data.status ?? '');
  if (!status) { probeShapeFailure(deps, args, 'no .status'); return undefined; }
  return { names: status === 'identical' || status === 'ahead', status };
}

function validBranch(raw: string | undefined, label: string): string {
  if (!raw) throw new AwaitArgError(`${label} is required`);
  if (!/^[A-Za-z0-9_./-]+$/.test(raw)) throw new AwaitArgError(`${label} is not a valid branch name (got ${raw})`);
  return raw;
}

export async function awaitBranch(branchRaw: string | undefined, opts: BranchAwaitOptions, deps: AwaitDeps): Promise<number> {
  return guarded(deps, 'branch', async () => {
    const branch = validBranch(branchRaw, 'branch');
    const repo = requireRepo(opts.repo, '--repo');
    const sha = requireSha(opts.names, '--names');
    return pollUntil(deps, 'branch', opts, async () => {
      const r = await branchNames(deps, repo, branch, sha);
      if (r === undefined) return { state: 'pending', summary: 'probe failed; retrying' };
      const detail = { repo, branch, sha, compare_status: r.status };
      return { state: r.names ? 'met' : 'pending', summary: `${repo} ${branch} ${r.names ? 'names' : 'does not yet name'} ${sha.slice(0, 7)} (compare ${r.status})`, detail };
    });
  });
}

async function branchHead(deps: AwaitDeps, repo: string, branch: string): Promise<string | undefined> {
  const args = ['api', `repos/${repo}/branches/${branch}`, '--jq', '{sha: .commit.sha}'];
  const data = await ghJson(deps, args) as { sha?: string } | undefined;
  if (data === undefined) return undefined;
  if (typeof data.sha !== 'string' || !SHA_RE.test(data.sha)) { probeShapeFailure(deps, args, 'no .commit.sha'); return undefined; }
  return data.sha;
}

export async function awaitPromote(opts: PromoteAwaitOptions, deps: AwaitDeps): Promise<number> {
  return guarded(deps, 'promote', async () => {
    const webRepo = requireRepo(opts.webRepo ?? 'ycomplex/harmony-web', '--web-repo');
    const pluginRepo = requireRepo(opts.pluginRepo ?? 'ycomplex/harmony-plugin', '--plugin-repo');
    const sides = [
      { label: 'web', repo: webRepo, source: 'main', target: optionalSha(opts.webSha, '--web-sha'), given: opts.webSha !== undefined },
      { label: 'plugin', repo: pluginRepo, source: 'staging', target: optionalSha(opts.pluginSha, '--plugin-sha'), given: opts.pluginSha !== undefined },
    ];
    const announce = (s: typeof sides[number]): void => emit(deps,
      { event: 'target', side: s.label, repo: s.repo, sha: s.target, from: s.given ? 'flag' : `${s.source} head` },
      `await promote: ${s.label} target ${s.target} (${s.given ? 'given' : `head of ${s.repo} ${s.source}`})`);
    // Capture targets at start; a failed capture is a failed probe, retried on the next poll.
    for (const s of sides) {
      if (s.target === undefined) s.target = await branchHead(deps, s.repo, s.source);
      if (s.target !== undefined) announce(s);
    }
    return pollUntil(deps, 'promote', opts, async () => {
      const parts: string[] = [];
      let allMet = true;
      const detail: Record<string, unknown> = {};
      for (const s of sides) {
        if (s.target === undefined) {
          s.target = await branchHead(deps, s.repo, s.source);
          if (s.target === undefined) { allMet = false; parts.push(`${s.label} target not captured yet`); continue; }
          announce(s);
        }
        const r = await branchNames(deps, s.repo, 'prod', s.target);
        if (r === undefined) { allMet = false; parts.push(`${s.label} probe failed`); continue; }
        if (!r.names) allMet = false;
        detail[`${s.label}_prod`] = { sha: s.target, compare_status: r.status, names: r.names };
        parts.push(`${s.label} prod ${r.names ? 'names' : 'does not yet name'} ${s.target.slice(0, 7)} (compare ${r.status})`);
      }
      return { state: allMet ? 'met' : 'pending', summary: parts.join('; '), detail };
    });
  });
}
