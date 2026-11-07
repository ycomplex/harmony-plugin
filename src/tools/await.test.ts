import { describe, expect, it } from 'vitest';
import {
  awaitBranch, awaitCi, awaitPr, awaitPromote, formatGhCommand, type AwaitDeps, type GhResult,
} from './await.js';

type Reply = GhResult | ((args: string[]) => GhResult);
/** A faked gh: each matcher (substring of the joined args) serves its replies in order, the last repeating. */
function harness(routes: Array<[string, Reply[]]>, json = false) {
  const calls: string[][] = [];
  const out: string[] = []; const err: string[] = [];
  const served = new Map<string, number>();
  let clock = 0; const sleeps: number[] = [];
  const deps: AwaitDeps = {
    gh: async (args) => {
      calls.push(args);
      const joined = args.join(' ');
      const route = routes.find(([m]) => joined.includes(m));
      if (!route) throw new Error(`unexpected gh call: ${joined}`);
      const i = served.get(route[0]) ?? 0; served.set(route[0], i + 1);
      const r = route[1][Math.min(i, route[1].length - 1)];
      return typeof r === 'function' ? r(args) : r;
    },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    json,
  };
  return { deps, calls, out, err, sleeps };
}
const ok = (data: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const fail = (code: number, stderr: string): GhResult => ({ code, stdout: '', stderr });
const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
const rollupRun = (name: string, status: string, conclusion: string) => ({ __typename: 'CheckRun', name, status, conclusion });
const common = { interval: 10, maxWait: 60 };

describe('harmony await ci', () => {
  it('--sha: met when every check run is complete and none failed (exit 0)', async () => {
    const h = harness([['check-runs', [
      ok({ check_runs: [] }),
      ok({ check_runs: [run('test', 'in_progress', null), run('lint', 'completed', 'success')] }),
      ok({ check_runs: [run('test', 'completed', 'success'), run('lint', 'completed', 'success')] }),
    ]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(0);
    expect(h.calls[0]).toEqual(['api', 'repos/o/r/commits/abc1234/check-runs?per_page=100']);
    expect(h.out[0]).toContain('pending — commit abc1234: no checks reported yet');
    expect(h.out.at(-1)).toMatch(/^await ci: met \(exit 0\)/);
    expect(h.sleeps).toEqual([10000, 10000]);
  });

  it('--pr: skipped and neutral checks are reported as not covered, never as passed', async () => {
    const h = harness([['pr view', [ok({ headRefOid: 'deadbeef', statusCheckRollup: [
      rollupRun('test', 'COMPLETED', 'SUCCESS'), rollupRun('e2e', 'COMPLETED', 'SKIPPED'),
      rollupRun('docs', 'COMPLETED', 'NEUTRAL'), { __typename: 'StatusContext', context: 'deploy', state: 'SUCCESS' },
    ] })]]]);
    expect(await awaitCi({ repo: 'o/r', pr: '7', ...common }, h.deps)).toBe(0);
    expect(h.calls[0]).toEqual(['pr', 'view', '7', '--repo', 'o/r', '--json', 'statusCheckRollup,headRefOid']);
    const last = h.out.at(-1)!;
    expect(last).toContain('2 passed; not covered: e2e (skipped), docs (neutral)');
  });

  it('--json emits JSON lines with not_covered separate from passed', async () => {
    const h = harness([['check-runs', [ok({ check_runs: [run('a', 'completed', 'success'), run('b', 'completed', 'skipped')] })]]], true);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(0);
    const probe = JSON.parse(h.out[0]);
    expect(probe).toMatchObject({ event: 'probe', state: 'met', passed: ['a'], not_covered: ['b (skipped)'] });
    expect(JSON.parse(h.out[1])).toMatchObject({ event: 'result', outcome: 'met', exit_code: 0 });
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])('a check concluded %s can no longer be met (exit 1)', async (c) => {
    const h = harness([['check-runs', [ok({ check_runs: [run('test', 'completed', c), run('lint', 'in_progress', null)] })]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(1);
    expect(h.out.at(-1)).toContain(`can-no-longer-be-met (exit 1)`);
    expect(h.out.at(-1)).toContain(`test (${c})`);
  });

  it('max wait passed with checks still running (exit 3)', async () => {
    const h = harness([['check-runs', [ok({ check_runs: [run('test', 'queued', null)] })]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', interval: 10, maxWait: 25 }, h.deps)).toBe(3);
    expect(h.sleeps).toEqual([10000, 10000, 5000]);
    expect(h.out.at(-1)).toMatch(/timed-out \(exit 3\).*max wait 25s/);
  });

  it('a failed probe is printed with its command, exit code and stderr, and polling continues to success', async () => {
    const h = harness([['check-runs', [
      fail(1, "  failed to parse jq expression (line 1, column 3)\n"),
      { code: 0, stdout: 'not json', stderr: '' },
      ok({ check_runs: [run('test', 'completed', 'success')] }),
    ]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(0);
    expect(h.err).toHaveLength(2);
    expect(h.err[0]).toBe("probe failed: gh api 'repos/o/r/commits/abc1234/check-runs?per_page=100' exited 1: failed to parse jq expression (line 1, column 3)");
    expect(h.err[1]).toMatch(/exited 0 with unparseable JSON/);
  });

  it.each([
    [{ repo: 'o/r' }, 'exactly one of --sha'],
    [{ repo: 'o/r', sha: 'abc1234', pr: '3' }, 'exactly one of --sha'],
    [{ sha: 'abc1234' }, '--repo <owner/name> is required'],
    [{ repo: 'nope', sha: 'abc1234' }, '--repo must be owner/name'],
    [{ repo: 'o/r', sha: 'xyz' }, '--sha must be a commit sha'],
    [{ repo: 'o/r', pr: '0' }, 'PR number must be a positive integer'],
    [{ repo: 'o/r', sha: 'abc1234', interval: '0' }, '--interval must be a positive'],
  ])('bad or missing arguments are fatal (exit 2): %o', async (opts, msg) => {
    const h = harness([]);
    expect(await awaitCi(opts, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err[0]).toContain(msg);
  });

  it('gh not installed (ENOENT) is fatal (exit 2)', async () => {
    const h = harness([['check-runs', [{ code: 127, stdout: '', stderr: 'spawn gh ENOENT', notFound: true }]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/fatal — gh is not installed/);
  });

  it('gh not logged in is fatal (exit 2)', async () => {
    const h = harness([['check-runs', [fail(4, 'To get started with GitHub CLI, please run:  gh auth login')]]]);
    expect(await awaitCi({ repo: 'o/r', sha: 'abc1234', ...common }, h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/fatal — gh is not logged in/);
    expect(h.calls).toHaveLength(1);
  });
});

describe('harmony await pr', () => {
  const view = (state: string, mergeable: string, mergedAt: string | null = null) => ok({ state, mergeable, mergedAt });
  it('merged (default): met on MERGED after pending polls (exit 0)', async () => {
    const h = harness([['pr view', [view('OPEN', 'MERGEABLE'), view('MERGED', 'UNKNOWN', '2026-11-07T10:00:00Z')]]]);
    expect(await awaitPr('12', { repo: 'o/r', ...common }, h.deps)).toBe(0);
    expect(h.calls[0]).toEqual(['pr', 'view', '12', '--repo', 'o/r', '--json', 'state,mergeable,mergedAt']);
    expect(h.out[0]).toContain('pending');
  });
  it('merged: CLOSED unmerged can no longer be met (exit 1)', async () => {
    const h = harness([['pr view', [view('CLOSED', 'UNKNOWN')]]]);
    expect(await awaitPr('12', { repo: 'o/r', ...common }, h.deps)).toBe(1);
  });
  it('merged: max wait while OPEN (exit 3)', async () => {
    const h = harness([['pr view', [view('OPEN', 'MERGEABLE')]]]);
    expect(await awaitPr('12', { repo: 'o/r', interval: 30, maxWait: 60 }, h.deps)).toBe(3);
  });
  it('mergeable: met on MERGEABLE, and MERGED also counts', async () => {
    const a = harness([['pr view', [view('OPEN', 'UNKNOWN'), view('OPEN', 'MERGEABLE')]]]);
    expect(await awaitPr('12', { repo: 'o/r', until: 'mergeable', ...common }, a.deps)).toBe(0);
    const b = harness([['pr view', [view('MERGED', 'UNKNOWN')]]]);
    expect(await awaitPr('12', { repo: 'o/r', until: 'mergeable', ...common }, b.deps)).toBe(0);
  });
  it('mergeable: CONFLICTING or CLOSED can no longer be met (exit 1)', async () => {
    const a = harness([['pr view', [view('OPEN', 'CONFLICTING')]]]);
    expect(await awaitPr('12', { repo: 'o/r', until: 'mergeable', ...common }, a.deps)).toBe(1);
    const b = harness([['pr view', [view('CLOSED', 'MERGEABLE')]]]);
    expect(await awaitPr('12', { repo: 'o/r', until: 'mergeable', ...common }, b.deps)).toBe(1);
  });
  it('fatal on bad --until, missing PR number, or not logged in (exit 2)', async () => {
    expect(await awaitPr('12', { repo: 'o/r', until: 'closed' }, harness([]).deps)).toBe(2);
    expect(await awaitPr(undefined, { repo: 'o/r' }, harness([]).deps)).toBe(2);
    const h = harness([['pr view', [fail(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')]]]);
    expect(await awaitPr('12', { repo: 'o/r', ...common }, h.deps)).toBe(2);
  });
  it('a failed probe is printed and polling continues to success', async () => {
    const h = harness([['pr view', [fail(1, 'error connecting to api.github.com'), view('MERGED', 'UNKNOWN')]]]);
    expect(await awaitPr('12', { repo: 'o/r', ...common }, h.deps)).toBe(0);
    expect(h.err).toEqual(['probe failed: gh pr view 12 --repo o/r --json state,mergeable,mergedAt exited 1: error connecting to api.github.com']);
  });
});

describe('harmony await branch', () => {
  it('met when the compare status is ahead or identical (exit 0)', async () => {
    for (const final of ['ahead', 'identical']) {
      const h = harness([['compare', [ok({ status: 'behind' }), ok({ status: 'diverged' }), ok({ status: final })]]]);
      expect(await awaitBranch('staging', { repo: 'o/r', names: 'abc1234', ...common }, h.deps)).toBe(0);
      expect(h.calls[0].slice(0, 2)).toEqual(['api', 'repos/o/r/compare/abc1234...staging']);
      expect(h.calls).toHaveLength(3);
    }
  });
  it('max wait while behind (exit 3)', async () => {
    const h = harness([['compare', [ok({ status: 'behind' })]]]);
    expect(await awaitBranch('staging', { repo: 'o/r', names: 'abc1234', interval: 10, maxWait: 20 }, h.deps)).toBe(3);
  });
  it('max wait of 0 probes exactly once', async () => {
    const h = harness([['compare', [ok({ status: 'behind' })]]]);
    expect(await awaitBranch('staging', { repo: 'o/r', names: 'abc1234', maxWait: 0 }, h.deps)).toBe(3);
    expect(h.calls).toHaveLength(1);
  });
  it('fatal on missing --names or gh missing (exit 2)', async () => {
    expect(await awaitBranch('staging', { repo: 'o/r' }, harness([]).deps)).toBe(2);
    const h = harness([['compare', [{ code: 127, stdout: '', stderr: '', notFound: true }]]]);
    expect(await awaitBranch('staging', { repo: 'o/r', names: 'abc1234' }, h.deps)).toBe(2);
  });
  it('a failed probe (unknown sha 404) is printed with its stderr and polling continues', async () => {
    const h = harness([['compare', [fail(1, 'gh: Not Found (HTTP 404)'), ok({ status: 'ahead' })]]]);
    expect(await awaitBranch('staging', { repo: 'o/r', names: 'abc1234', ...common }, h.deps)).toBe(0);
    expect(h.err[0]).toContain("probe failed: gh api repos/o/r/compare/abc1234...staging --jq '{status: .status");
    expect(h.err[0]).toContain('exited 1: gh: Not Found (HTTP 404)');
  });
});

describe('harmony await promote', () => {
  const WEB = 'aaaaaaa1111111'; const PLUGIN = 'bbbbbbb2222222';
  it('captures targets at start and succeeds only when both prod refs name them', async () => {
    const h = harness([
      ['harmony-web/branches/main', [ok({ sha: WEB })]],
      ['harmony-plugin/branches/staging', [ok({ sha: PLUGIN })]],
      [`harmony-web/compare/${WEB}...prod`, [ok({ status: 'behind' }), ok({ status: 'ahead' })]],
      [`harmony-plugin/compare/${PLUGIN}...prod`, [ok({ status: 'behind' }), ok({ status: 'behind' }), ok({ status: 'identical' })]],
    ]);
    expect(await awaitPromote({ ...common }, h.deps)).toBe(0);
    expect(h.out[0]).toBe(`await promote: web target ${WEB} (head of ycomplex/harmony-web main)`);
    expect(h.out[1]).toBe(`await promote: plugin target ${PLUGIN} (head of ycomplex/harmony-plugin staging)`);
    const probes = h.out.filter((l) => l.startsWith('await promote: pending') || l.startsWith('await promote: met —'));
    expect(probes.map((l) => l.split(' ')[2])).toEqual(['pending', 'pending', 'met']);
    expect(probes[1]).toContain('web prod names');
    expect(probes[1]).toContain('plugin prod does not yet name');
    // Targets captured once, never re-read mid-wait.
    expect(h.calls.filter((c) => c[1].includes('/branches/'))).toHaveLength(2);
  });
  it('uses given shas and repos without reading branch heads', async () => {
    const h = harness([['compare', [ok({ status: 'identical' })]]]);
    expect(await awaitPromote({ webRepo: 'w/web', pluginRepo: 'p/plug', webSha: 'abc1234', pluginSha: 'def5678', ...common }, h.deps)).toBe(0);
    expect(h.calls.map((c) => c[1])).toEqual(['repos/w/web/compare/abc1234...prod', 'repos/p/plug/compare/def5678...prod']);
    expect(h.out[0]).toContain('web target abc1234 (given)');
  });
  it('a failed target capture is printed and retried on the next poll', async () => {
    const h = harness([
      ['branches/main', [fail(1, 'timeout'), ok({ sha: WEB })]],
      ['branches/staging', [ok({ sha: PLUGIN })]],
      ['compare', [ok({ status: 'ahead' })]],
    ]);
    expect(await awaitPromote({ ...common }, h.deps)).toBe(0);
    expect(h.err[0]).toContain('probe failed: gh api repos/ycomplex/harmony-web/branches/main');
    expect(h.err[0]).toContain('exited 1: timeout');
    expect(h.out.some((l) => l.includes(`web target ${WEB}`))).toBe(true);
  });
  it('max wait while plugin prod lags (exit 3), and bad sha is fatal (exit 2)', async () => {
    const h = harness([['compare', [ok({ status: 'behind' })]]]);
    expect(await awaitPromote({ webSha: 'abc1234', pluginSha: 'def5678', interval: 10, maxWait: 10 }, h.deps)).toBe(3);
    expect(await awaitPromote({ webSha: 'not-a-sha' }, harness([]).deps)).toBe(2);
  });
});

describe('formatGhCommand', () => {
  it('quotes args that need it', () => {
    expect(formatGhCommand(['api', 'x?y', '--jq', ".a b"])).toBe("gh api 'x?y' --jq '.a b'");
  });
});
