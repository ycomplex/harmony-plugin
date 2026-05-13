import { Command } from 'commander';
import { listChecklistItems, manageChecklistItems } from '../../tools/checklist-items.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerChecklistCommands(program: Command): void {
  const checklist = program.command('checklist').description('Manage checklist items');

  checklist.command('list')
    .description('List checklist items for a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listChecklistItems(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => formatTable(data, [
          { key: 'id', header: 'ID', width: 38 },
          { key: 'title', header: 'Title', width: 50 },
          { key: 'completed', header: 'Done', transform: (v: boolean) => v ? 'yes' : 'no' },
          { key: 'position', header: 'Pos' },
        ]),
      );
    });

  checklist.command('add')
    .description('Add checklist items to a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--title <titles...>', 'Checklist item title(s) to add')
    .action(async (taskId, opts) => {
      const titles: string[] = Array.isArray(opts.title) ? opts.title : [opts.title];
      await runCommand(program.opts(), async (ctx) =>
        manageChecklistItems(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          add: titles.map((t) => ({ title: t })),
        }),
        (result) => `Added ${result.added.length} checklist item(s)`,
      );
    });

  checklist.command('update')
    .description('Update a checklist item')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <id>', 'Checklist item UUID')
    .option('--title <title>', 'New title')
    .option('--done', 'Mark as completed', false)
    .option('--not-done', 'Mark as not completed', false)
    .action(async (taskId, opts) => {
      const completed = opts.done ? true : opts.notDone ? false : undefined;
      await runCommand(program.opts(), async (ctx) =>
        manageChecklistItems(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          update: [{ id: opts.id, title: opts.title, completed }],
        }),
        (result) => `Updated ${result.updated.length} checklist item(s)`,
      );
    });

  checklist.command('delete')
    .description('Delete checklist items from a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--id <ids...>', 'Checklist item UUID(s) to delete')
    .action(async (taskId, opts) => {
      const ids: string[] = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(program.opts(), async (ctx) =>
        manageChecklistItems(ctx.client, ctx.projectId, ctx.userId, {
          task_id: taskId,
          delete: ids,
        }),
        (result) => `Deleted ${result.deleted.length} checklist item(s)`,
      );
    });
}
