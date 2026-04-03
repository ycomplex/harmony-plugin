import { Command } from 'commander';
import { listSubtasks, manageSubtasks } from '../../tools/subtasks.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerSubtaskCommands(program: Command): void {
  const subtasks = program.command('subtasks').description('Manage subtasks');

  subtasks.command('list')
    .description('List subtasks for a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listSubtasks(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => formatTable(data, [
          { key: 'id', header: 'ID', width: 38 },
          { key: 'title', header: 'Title', width: 50 },
          { key: 'completed', header: 'Done', transform: (v: boolean) => v ? 'yes' : 'no' },
          { key: 'position', header: 'Pos' },
        ]),
      );
    });

  subtasks.command('add')
    .description('Add subtasks to a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--title <titles...>', 'Subtask title(s) to add')
    .action(async (taskId, opts) => {
      const titles: string[] = Array.isArray(opts.title) ? opts.title : [opts.title];
      await runCommand(program.opts(), async (ctx) =>
        manageSubtasks(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          add: titles.map((t) => ({ title: t })),
        }),
        (result) => `Added ${result.added.length} subtask(s)`,
      );
    });

  subtasks.command('update')
    .description('Update a subtask')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <id>', 'Subtask UUID')
    .option('--title <title>', 'New title')
    .option('--done', 'Mark as completed', false)
    .option('--not-done', 'Mark as not completed', false)
    .action(async (taskId, opts) => {
      const completed = opts.done ? true : opts.notDone ? false : undefined;
      await runCommand(program.opts(), async (ctx) =>
        manageSubtasks(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          update: [{ id: opts.id, title: opts.title, completed }],
        }),
        (result) => `Updated ${result.updated.length} subtask(s)`,
      );
    });

  subtasks.command('delete')
    .description('Delete subtasks from a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <ids...>', 'Subtask UUID(s) to delete')
    .action(async (taskId, opts) => {
      const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(program.opts(), async (ctx) =>
        manageSubtasks(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          delete: ids,
        }),
        (result) => `Deleted ${result.deleted.length} subtask(s)`,
      );
    });
}
