// B-1072 — `harmony fasttrack <check|scope-check>` — the two READ-ONLY CLI accessors the
// harmony-fasttrack skill's Check phase and pre-PR-open scope guard use. Both commands mutate
// NOTHING and report purely through stdout/stderr + the process exit code, mirroring `harmony
// record --check`'s own "doctor convention" (src/cli/commands/doctor.ts).
//
// `check` mirrors `harmony record --check` EXACTLY (same `evaluateEligibility` core, same
// gatherEvidenceSignals degrade-on-gh-failure posture) but renders its lines via
// `formatEligibilityLine('harmony fasttrack check', ...)` — step 1's ONE shared formatter, never a
// second copy that could drift from `record --check`'s own output shape.
//
// `scope-check` runs `git diff --numstat <base>...HEAD` (via `execFileSync`, never a shell string)
// in the current working directory, parses it with `parseNumstatLine`, and reports
// `evaluateScopeBudget`'s verdict against either a manifest-declared `fasttrack.scope_budget`
// override (when `.harmony/project.yml` is present and parses) or `DEFAULT_SCOPE_BUDGET`.

import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { evaluateEligibility, formatEligibilityLine, gatherEvidenceSignals } from '../../tools/record-eligibility.js';
import { evaluateScopeBudget, parseNumstatLine, DEFAULT_SCOPE_BUDGET, type ScopeBudget } from '../../tools/fasttrack-scope.js';
import { loadProjectManifest, getScopeBudget } from '../../config/project-manifest.js';

interface FasttrackCheckOpts {
  summary: string;
  evidence: string[];
  attestWalk?: string;
}

/** Resolves the effective scope budget for `projectRoot`: a manifest-declared `fasttrack.scope_budget`
 *  override (partial — either field may be omitted and falls back to the default) when
 *  `.harmony/project.yml` is present and parses `'ok'`, else `DEFAULT_SCOPE_BUDGET` unchanged. A
 *  malformed/absent manifest is never a reason to fail this read-only command — it degrades to the
 *  hard-coded default, same floor posture as every other `.harmony/project.yml` consumer. */
export function resolveScopeBudget(projectRoot: string): ScopeBudget {
  const result = loadProjectManifest(projectRoot);
  if (result.kind !== 'ok') return DEFAULT_SCOPE_BUDGET;
  const override = getScopeBudget(result.manifest);
  return {
    files: override.files ?? DEFAULT_SCOPE_BUDGET.files,
    lines: override.lines ?? DEFAULT_SCOPE_BUDGET.lines,
  };
}

export function registerFasttrackCommands(program: Command): void {
  const fasttrack = program
    .command('fasttrack')
    .description(
      'B-1072 — read-only accessors backing the harmony-fasttrack skill: the same eligibility ' +
        "floor harmony record --check uses, and a git-diff scope-budget guard. Neither mutates " +
        'anything.',
    );

  fasttrack
    .command('check')
    .description(
      "Print every eligibility item's verdict for <ticket> — the SAME floor harmony record --check " +
        'uses, rendered with the fasttrack command label. Mutates nothing. Exits non-zero if any ' +
        'item fails or is unattested.',
    )
    .argument('<ticket>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--summary <text>', 'A one-sentence-statable account of the change this ticket records')
    .option('--evidence <url>', 'Evidence link (repeatable — pass --evidence multiple times)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--attest-walk <who-what>', "Attest a 5+ minute verify walk — who/what was walked. Never auto-passed; omit to leave this item UNATTESTED.")
    .action(async (ticket: string, opts: FasttrackCheckOpts) => {
      // Same gh-unavailable degrade as `harmony record --check` (src/cli/commands/record.ts) — a
      // read-only diagnostic must not itself require network access to report.
      let gathered: Awaited<ReturnType<typeof gatherEvidenceSignals>>;
      try {
        gathered = await gatherEvidenceSignals(opts.evidence);
      } catch {
        gathered = opts.evidence.map((url) => ({ url }));
      }
      const report = evaluateEligibility({ summary: opts.summary, evidence: gathered, attestWalk: opts.attestWalk });
      for (const item of report.items) {
        const line = formatEligibilityLine('harmony fasttrack check', ticket, item);
        if (item.verdict === 'pass') console.log(line); else console.error(line);
      }
      process.exit(report.eligible ? 0 : 1);
    });

  fasttrack
    .command('scope-check')
    .description(
      'Run `git diff --numstat <base>...HEAD` in the current directory and report the scope-budget ' +
        'verdict (files changed, lines changed, within-budget or not) against any manifest-declared ' +
        '`.harmony/project.yml` fasttrack.scope_budget override, else the hard-coded default. ' +
        'Read-only — never mutates anything.',
    )
    .option('--base <ref>', 'Base ref to diff against', 'origin/main')
    .action((opts: { base: string }) => {
      const projectRoot = process.cwd();
      const budget = resolveScopeBudget(projectRoot);

      let raw: string;
      try {
        raw = execFileSync('git', ['diff', '--numstat', `${opts.base}...HEAD`], {
          cwd: projectRoot,
          encoding: 'utf8',
        });
      } catch (err: unknown) {
        console.error(
          `harmony fasttrack scope-check: could not run 'git diff --numstat ${opts.base}...HEAD' — ${
            (err as { message?: string })?.message ?? String(err)
          }`,
        );
        process.exit(1);
        return;
      }

      const entries = raw
        .split('\n')
        .map((line) => parseNumstatLine(line))
        .filter((e): e is NonNullable<typeof e> => e !== null);

      const evaluation = evaluateScopeBudget(entries, budget);
      console.log(
        `harmony fasttrack scope-check: ${evaluation.filesChanged} file(s), ${evaluation.linesChanged} ` +
          `line(s) changed against ${opts.base} — budget ${budget.files} file(s)/${budget.lines} line(s) — ` +
          `${evaluation.withinBudget ? 'WITHIN BUDGET' : 'OVER BUDGET'}`,
      );
      process.exit(evaluation.withinBudget ? 0 : 1);
    });
}
