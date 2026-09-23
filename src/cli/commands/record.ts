// B-1062 step 8 — `harmony record <ticket>` — the CLI entry to the zero-worker-leg gate-walk core
// (src/tools/record-walk.ts). See that file's header, and docs/recorded-walk-contract.md, for the
// full contract; this file is a THIN WRAPPER — the CLI and the MCP `record` tool (src/tools/index.ts)
// drive the exact SAME `runRecordedWalk` implementation, never two.
//
// `--check` follows the "doctor convention" (src/cli/commands/doctor.ts): prints EVERY item's verdict
// AND the value it was read from, mutates nothing, and reports success/failure purely through the
// process exit code (0 = eligible, 1 = at least one item failed or was unattested) — never through a
// thrown error, since a failing/unattested `--check` is an ordinary, expected outcome, not a bug.

import { Command } from 'commander';
import { runCommand } from '../run-command.js';
import { runRecordedWalk, describeIneligibility, type RecordWalkResult } from '../../tools/record-walk.js';
import { evaluateEligibility, gatherEvidenceSignals } from '../../tools/record-eligibility.js';

interface RecordOpts {
  summary: string;
  evidence: string[];
  attestWalk?: string;
  check?: boolean;
}

function formatWalkResult(result: RecordWalkResult): string {
  const lines = [`Recorded ${result.task_id} — ${result.gates.length} gate(s) landed:`];
  for (const g of result.gates) lines.push(`  - ${g.gate}${g.reason ? ` (${g.reason})` : ''}: landed`);
  if (result.attestation_recorded) lines.push('Verify-walk attestation recorded (ticket comment + clarify gate slot).');
  lines.push("Marked 'recorded, not conducted' — ratified_by: 'recorded' on every gate slot.");
  return lines.join('\n');
}

export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description(
      "Walk a non-conducted ticket's gates (clarify -> decompose -> design -> plan -> build -> release) " +
        'from a human-supplied summary + evidence links, with ZERO worker legs — producing the same ' +
        "gate-slot/knowledge-entry trail a conducted ticket would get, marked 'recorded, not conducted'.",
    )
    .argument('<ticket>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--summary <text>', 'A one-sentence-statable account of the change this ticket records')
    .option('--evidence <url>', 'Evidence link (repeatable — pass --evidence multiple times)', (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--attest-walk <who-what>', "Attest a 5+ minute verify walk — who/what was walked. Never auto-passed; omit to leave this item UNATTESTED.")
    .option('--check', 'Print every eligibility item\'s verdict and mutate nothing. Exits non-zero if any item fails or is unattested.', false)
    .action(async (ticket: string, opts: RecordOpts) => {
      if (opts.check) {
        // A best-effort repo/path gather so --check reads the SAME real values the walk itself would
        // refuse or proceed on. `gh` unavailable/unauthenticated degrades to url-only evidence (each
        // link's repo/paths read as their own neutral "none determined" value) rather than failing
        // --check outright — a read-only diagnostic must not itself require network access to report.
        let gathered: Awaited<ReturnType<typeof gatherEvidenceSignals>>;
        try {
          gathered = await gatherEvidenceSignals(opts.evidence);
        } catch {
          gathered = opts.evidence.map((url) => ({ url }));
        }
        const report = evaluateEligibility({ summary: opts.summary, evidence: gathered, attestWalk: opts.attestWalk });
        for (const item of report.items) {
          const line = `harmony record --check ${ticket}: ${item.label} — ${item.verdict.toUpperCase()} (${item.value}${item.detail ? ' — ' + item.detail : ''})`;
          if (item.verdict === 'pass') console.log(line); else console.error(line);
        }
        process.exit(report.eligible ? 0 : 1);
      }

      await runCommand(
        program.opts(),
        async (ctx) => {
          const evidence = await gatherEvidenceSignals(opts.evidence);
          const result = await runRecordedWalk(ctx.client, ctx.projectId, ctx.userId, {
            task_id: ticket,
            summary: opts.summary,
            evidence,
            attest_walk: opts.attestWalk,
          });
          if (result.refused) throw new Error(describeIneligibility(result.eligibility));
          if (result.error) throw new Error(result.error);
          return result;
        },
        formatWalkResult,
      );
    });
}
