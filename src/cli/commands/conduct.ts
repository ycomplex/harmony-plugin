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
import { runCommand } from '../run-command.js';

export function registerConductCommand(program: Command): void {
  program
    .command('conduct')
    .description('Create a conduction for a ticket — the conductor daemon picks it up and drives the run')
    .argument('<ticket>', 'Task ID (UUID, number, or B-123)')
    .option('--unpark', 'Revive a Parked ticket and hand it to the conductor in this same call (B-964)', false)
    .option('--resume-to <state>', 'Target workflow_state override when reviving a Parked ticket (defaults to the ticket\'s own parked_from, else Proposed)')
    .action(async (ticket: string, opts: { unpark?: boolean; resumeTo?: string }) => {
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
            return await createConduction(ctx.client, {
              task_id: taskId,
              mode: 'controlled',
              created_by: ctx.userId,
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
