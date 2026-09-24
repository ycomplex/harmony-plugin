// B-696: `harmony conduct <ticket>` — the conduction-creation CLI primitive.
//
// Creates the durable conduction record (status 'active') for a ticket; the conductor daemon
// (dist/bin/daemon.js) notices it on its next pass and drives the run by firing one-shot workers.
// Creating the record IS the whole job here — the atomic insert is the lease-acquisition primitive
// (conduction-record.ts), so a second `conduct` on the same ticket loses cleanly. B-697's surfaces
// reuse this same primitive.
//
// B-758: a ticket a human has explicitly taken away from the conductor (`conductor_excluded_at`
// set — the web's "Take away from conductor" action) must refuse a handoff here too, checked BEFORE
// the duplicate-conduction guard so the more specific "you pulled this out of the conductor's
// reach" reason wins over the generic "already conducting" one when both would apply.
//
// B-964: `--unpark` (+ optional `--resume-to <state>`) folds a Parked ticket's revive into this
// SAME call — reviveParkedTicketIfNeeded (conduction-record.ts) is a no-op for a non-Parked ticket,
// so it always runs first, ahead of the excluded/duplicate guards, and is the CLI's half of the same
// shared mechanics the `create_conduction` MCP tool uses. Never inferred: a human must pass
// `--unpark` explicitly (AC5) — this command never revives on its own.
//
// B-925: `--model`, `--session-resume`/`--no-session-resume`, `--auto-approve-gates`/
// `--no-auto-approve-gates` build a `run_config` for THIS run, which is then filled in from this
// project's own stored conduction defaults (settings, web-side) for whichever of those three
// fields the caller left unset — the CLI's half of the same fill create-conduction.ts (the MCP
// tool) applies. This command has no `run_config` option at all before B-925 and does not go
// through create-conduction.ts's wrapper; it reuses the same fill helper + RunConfigSchema import
// directly against the thin conduction-record.ts insert primitive.

import { Command } from 'commander';
import { resolveTaskId } from '../../tools/resolve-task-id.js';
import {
  createConduction,
  assertNotExcluded,
  reviveParkedTicketIfNeeded,
  ActiveConductionExistsError,
  ConductorExcludedError,
  TicketParkedError,
  TicketStaleReviveRefusedError,
} from '../../tools/conduction-record.js';
import { RunConfigSchema, type RunConfig } from '../../config/run-config.js';
import { getProjectConductionDefaults, fillRunConfigDefaults } from '../../config/conduction-defaults.js';
import { runCommand } from '../run-command.js';

export function registerConductCommand(program: Command): void {
  program
    .command('conduct')
    .description('Create a conduction for a ticket — the conductor daemon picks it up and drives the run')
    .argument('<ticket>', 'Task ID (UUID, number, or B-123)')
    .option('--unpark', 'Revive a Parked ticket and hand it to the conductor in this same call (B-964)', false)
    .option('--resume-to <state>', 'Target workflow_state override when reviving a Parked ticket (defaults to the ticket\'s own parked_from, else Proposed)')
    .option('--model <alias>', 'B-925: explicit model alias for this run (fills run_config.model.default)')
    .option('--session-resume', 'B-925: explicitly enable session-resume for this run')
    .option('--no-session-resume', 'B-925: explicitly disable session-resume for this run')
    .option('--auto-approve-gates <gates>', 'B-925: comma-separated forward gates to auto-approve for this run')
    .option('--no-auto-approve-gates', 'B-925: explicitly auto-approve no gates for this run')
    .action(async (
      ticket: string,
      opts: {
        unpark?: boolean;
        resumeTo?: string;
        model?: string;
        sessionResume?: boolean;
        autoApproveGates?: string | false;
      },
    ) => {
      await runCommand(
        program.opts(),
        async (ctx) => {
          const taskId = await resolveTaskId(ctx.client, ctx.projectId, ticket);
          try {
            // B-964: a no-op when the ticket isn't Parked; refuses cleanly (TicketParkedError) when
            // it IS Parked and --unpark was not passed, and revalidates (tasks.stale) + unparks
            // BEFORE any conduction is created when it was.
            await reviveParkedTicketIfNeeded(ctx.client, ctx.projectId, ctx.userId, taskId, {
              unpark: opts.unpark,
              resume_to: opts.resumeTo,
              revived_by: `human via CLI (harmony conduct --unpark), acting user ${ctx.userId}`,
            });
            await assertNotExcluded(ctx.client, taskId);

            // B-925: build a run_config from whichever of --model / --session-resume /
            // --no-session-resume / --auto-approve-gates / --no-auto-approve-gates flags were
            // actually passed — a flag NOT passed is omitted entirely (never defaulted to
            // false/empty), so "not passed" stays distinguishable from "explicitly off" all the
            // way into RunConfigSchema.parse and fillRunConfigDefaults.
            const runConfigInput: Record<string, unknown> = {};
            if (opts.model !== undefined) {
              runConfigInput.model = { default: opts.model };
            }
            if (opts.sessionResume !== undefined) {
              runConfigInput.session_resume = { enabled: opts.sessionResume };
            }
            if (opts.autoApproveGates !== undefined) {
              runConfigInput.auto_approve_gates =
                opts.autoApproveGates === false
                  ? []
                  : opts.autoApproveGates
                      .split(',')
                      .map((g) => g.trim())
                      .filter(Boolean);
            }
            const callerRunConfig: RunConfig | undefined =
              Object.keys(runConfigInput).length > 0
                ? RunConfigSchema.parse(runConfigInput)
                : undefined;
            const defaults = await getProjectConductionDefaults(ctx.client, ctx.projectId);
            const filledRunConfig = fillRunConfigDefaults(callerRunConfig, defaults);

            return await createConduction(ctx.client, {
              task_id: taskId,
              mode: 'controlled',
              created_by: ctx.userId,
              ...(filledRunConfig !== undefined ? { run_config: filledRunConfig } : {}),
            });
          } catch (err) {
            if (err instanceof TicketParkedError || err instanceof TicketStaleReviveRefusedError) {
              throw new Error(err.message, { cause: err });
            }
            if (err instanceof ConductorExcludedError) {
              throw new Error(
                `${ticket} is taken away from the conductor — Return it first (the "Return to ` +
                  `conductor" action) before handing it off`,
                { cause: err },
              );
            }
            if (err instanceof ActiveConductionExistsError) {
              throw new Error(
                `${ticket} is already being conducted — a ticket has at most one active conduction; ` +
                  `park or complete the existing run first`,
                { cause: err },
              );
            }
            throw err;
          }
        },
        (row: { id: string; status: string; mode: string }) =>
          `Conduction ${row.id} created for ${ticket} (${row.status}, mode: ${row.mode}).\n` +
          `The conductor daemon will pick it up on its next pass.\n` +
          `Note: the duplicate-guard can only detect an active conduction record — it can't see an ` +
          `in-progress terminal session, so make sure any in-session work on this ticket has stopped ` +
          `before handing it off.`,
      );
    });
}
