// B-696: `harmony conduct <ticket>` — the conduction-creation CLI primitive.
//
// Creates the durable conduction record (status 'active') for a ticket; the conductor daemon
// (dist/bin/daemon.js) notices it on its next pass and drives the run by firing one-shot workers.
// Creating the record IS the whole job here — the atomic insert is the lease-acquisition primitive
// (conduction-record.ts), so a second `conduct` on the same ticket loses cleanly. B-697's surfaces
// reuse this same primitive.

import { Command } from 'commander';
import { resolveTaskId } from '../../tools/resolve-task-id.js';
import { createConduction, ActiveConductionExistsError } from '../../tools/conduction-record.js';
import { runCommand } from '../run-command.js';

export function registerConductCommand(program: Command): void {
  program
    .command('conduct')
    .description('Create a conduction for a ticket — the conductor daemon picks it up and drives the run')
    .argument('<ticket>', 'Task ID (UUID, number, or B-123)')
    .action(async (ticket: string) => {
      await runCommand(
        program.opts(),
        async (ctx) => {
          const taskId = await resolveTaskId(ctx.client, ctx.projectId, ticket);
          try {
            return await createConduction(ctx.client, {
              task_id: taskId,
              mode: 'controlled',
              created_by: ctx.userId,
            });
          } catch (err) {
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
          `The conductor daemon will pick it up on its next pass.`,
      );
    });
}
