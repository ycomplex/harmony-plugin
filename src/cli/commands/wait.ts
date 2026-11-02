import { Command } from 'commander';
import { declareWait, type DeclareWaitArgs } from '../../tools/wait.js';
import { runCommand } from '../run-command.js';

export function registerWaitCommands(program: Command): void {
  program.command('wait').description('Declare an external wait').command('declare')
    .requiredOption('--task <task>', 'Task ID, number or visual ID')
    .requiredOption('--kind <kind>', 'ci | pr-state | human-step | model-handoff')
    .requiredOption('--ref <ref>', 'Single-token reference to the awaited condition')
    .option('--resume-after <iso>', 'Optional ISO recheck time')
    .action(async (opts) => {
      await runCommand(program.opts(), async ctx => declareWait(ctx.client, ctx.projectId, ctx.userId, {
        task_id: opts.task, kind: opts.kind as DeclareWaitArgs['kind'], ref: opts.ref, resume_after: opts.resumeAfter,
      }), data => `Waiting on ${data.waiting_on.ref} (${data.waiting_on.kind}).`);
    });
}
