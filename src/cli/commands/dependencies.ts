import { Command } from 'commander';
import { listDependencies, manageDependencies } from '../../tools/dependencies.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerDependencyCommands(program: Command): void {
  const deps = program.command('deps').description('Manage task blockers and dependencies');

  deps
    .command('list')
    .description('Show blockers and downstream tasks for a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listDependencies(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => {
          const blockedByRows = (data.blocked_by ?? []).map((r: any) => ({
            id: r.id,
            task_number: r.blocker?.task_number ?? '?',
            title: r.blocker?.title ?? '?',
            status: r.blocker?.status ?? '?',
          }));
          const blockingRows = (data.blocking ?? []).map((r: any) => ({
            id: r.id,
            task_number: r.downstream?.task_number ?? '?',
            title: r.downstream?.title ?? '?',
            status: r.downstream?.status ?? '?',
          }));

          const columns = [
            { key: 'id', header: 'Dep ID', width: 38 },
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status' },
          ];

          const blockedByOut = blockedByRows.length === 0
            ? '  (none)'
            : formatTable(blockedByRows, columns);
          const blockingOut = blockingRows.length === 0
            ? '  (none)'
            : formatTable(blockingRows, columns);

          return `Blocked by:\n${blockedByOut}\n\nBlocking:\n${blockingOut}`;
        },
      );
    });

  deps
    .command('add')
    .description('Add one or more blockers to a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123) that is blocked')
    .requiredOption('--by <blockers...>', 'One or more blocker task IDs')
    .action(async (taskId, opts) => {
      const blockers: string[] = Array.isArray(opts.by) ? opts.by : [opts.by];
      await runCommand(program.opts(), async (ctx) =>
        manageDependencies(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          add: blockers,
        }),
        (result) => `Added ${result.added.length} blocker(s).`,
      );
    });

  deps
    .command('remove')
    .description('Remove blocker links from a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <dependency-ids...>', 'task_dependencies row ID(s) from `deps list`')
    .action(async (taskId, opts) => {
      const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(program.opts(), async (ctx) =>
        manageDependencies(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          remove: ids,
        }),
        (result) => `Removed ${result.removed.length} blocker link(s).`,
      );
    });
}
