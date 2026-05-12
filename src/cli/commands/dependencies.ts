import { Command } from 'commander';
import { listDependencies, manageDependencies } from '../../tools/dependencies.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerDependencyCommands(program: Command): void {
  const deps = program.command('deps').description('Manage task dependencies');

  deps
    .command('list')
    .description("Show a task's dependencies and the tasks that depend on it")
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listDependencies(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => {
          const dependsOnRows = (data.depends_on ?? []).map((r: any) => ({
            id: r.id,
            task_number: r.dependency?.task_number ?? '?',
            title: r.dependency?.title ?? '?',
            status: r.dependency?.status ?? '?',
          }));
          const blocksRows = (data.blocks ?? []).map((r: any) => ({
            id: r.id,
            task_number: r.dependent?.task_number ?? '?',
            title: r.dependent?.title ?? '?',
            status: r.dependent?.status ?? '?',
          }));

          const columns = [
            { key: 'id', header: 'Dep ID', width: 38 },
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status' },
          ];

          const dependsOnOut = dependsOnRows.length === 0
            ? '  (none)'
            : formatTable(dependsOnRows, columns);
          const blocksOut = blocksRows.length === 0
            ? '  (none)'
            : formatTable(blocksRows, columns);

          return `Depends on:\n${dependsOnOut}\n\nBlocks:\n${blocksOut}`;
        },
      );
    });

  deps
    .command('add')
    .description('Add one or more dependencies to a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--on <dependencies...>', 'Task IDs that this task depends on')
    .action(async (taskId, opts) => {
      const dependencies: string[] = Array.isArray(opts.on) ? opts.on : [opts.on];
      await runCommand(program.opts(), async (ctx) =>
        manageDependencies(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          add: dependencies,
        }),
        (result) => `Added ${result.added.length} ${result.added.length === 1 ? 'dependency' : 'dependencies'}.`,
      );
    });

  deps
    .command('remove')
    .description('Remove dependency links from a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <dependency-ids...>', 'task_dependencies row ID(s) from `deps list`')
    .action(async (taskId, opts) => {
      const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(program.opts(), async (ctx) =>
        manageDependencies(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          remove: ids,
        }),
        (result) => `Removed ${result.removed.length} dependency ${result.removed.length === 1 ? 'link' : 'links'}.`,
      );
    });
}
