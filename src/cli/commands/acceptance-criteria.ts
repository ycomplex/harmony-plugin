import { Command } from 'commander';
import { listAcceptanceCriteria, manageAcceptanceCriteria } from '../../tools/acceptance-criteria.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerAcceptanceCriteriaCommands(program: Command): void {
  const ac = program.command('ac').description('Manage acceptance criteria');

  ac.command('list')
    .description('List acceptance criteria for a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listAcceptanceCriteria(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => formatTable(data, [
          { key: 'id', header: 'ID', width: 38 },
          { key: 'content', header: 'Description', width: 60 },
          { key: 'checked', header: 'Met', transform: (v: boolean) => v ? 'yes' : 'no' },
          { key: 'position', header: 'Pos' },
        ]),
      );
    });

  ac.command('add')
    .description('Add acceptance criteria to a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--desc <descriptions...>', 'Acceptance criterion description(s) to add')
    .action(async (taskId, opts) => {
      const descs: string[] = Array.isArray(opts.desc) ? opts.desc : [opts.desc];
      await runCommand(program.opts(), async (ctx) =>
        manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          add: descs.map((content) => ({ content })),
        }),
        (result) => `Added ${result.added.length} acceptance criterion/criteria`,
      );
    });

  ac.command('update')
    .description('Update an acceptance criterion')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <id>', 'Acceptance criterion UUID')
    .option('--desc <description>', 'New description')
    .option('--met', 'Mark as met (checked)', false)
    .option('--not-met', 'Mark as not met (unchecked)', false)
    .action(async (taskId, opts) => {
      const checked = opts.met ? true : opts.notMet ? false : undefined;
      await runCommand(program.opts(), async (ctx) =>
        manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          update: [{ id: opts.id, content: opts.desc, checked }],
        }),
        (result) => `Updated ${result.updated.length} acceptance criterion/criteria`,
      );
    });

  ac.command('delete')
    .description('Delete acceptance criteria from a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <ids...>', 'Acceptance criterion UUID(s) to delete')
    .action(async (taskId, opts) => {
      const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(program.opts(), async (ctx) =>
        manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          delete: ids,
        }),
        (result) => `Deleted ${result.deleted.length} acceptance criterion/criteria`,
      );
    });
}
