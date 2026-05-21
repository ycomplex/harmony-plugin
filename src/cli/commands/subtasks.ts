import { Command } from 'commander';
import { listSubtasks, listParent, manageSubtasks } from '../../tools/decomposition.js';
import { updateTask } from '../../tools/tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerSubtaskCommands(program: Command): void {
  const sub = program.command('subtasks').description("Manage a task's children and parent");

  sub
    .command('list')
    .description('List the immediate subtasks (children) of a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .option('--depth <n>', 'Walk depth (default 1, use -1 for unbounded)', '1')
    .action(async (taskId, opts) => {
      await runCommand(program.opts(), async (ctx) =>
        listSubtasks(ctx.client, ctx.projectId, { task_id: taskId, depth: parseInt(opts.depth, 10) }),
        (data: any[]) => {
          if (!data.length) return '(no subtasks)';
          return formatTable(data.map(r => ({
            id: r.id, task_number: r.task_number, title: r.title, status: r.status,
          })), [
            { key: 'id', header: 'UUID', width: 38 },
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status' },
          ]);
        },
      );
    });

  sub
    .command('parent')
    .description('Show the immediate parent of a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listParent(ctx.client, ctx.projectId, { task_id: taskId }),
        (data: any) => data ? `${data.task_number} ${data.title} [${data.status}]` : '(no parent)',
      );
    });

  sub
    .command('add')
    .description('Attach existing tasks as children of <task-id>')
    .argument('<task-id>', 'Parent task ID')
    .requiredOption('--child <ids...>', 'One or more child task IDs')
    .action(async (taskId, opts) => {
      const children: string[] = Array.isArray(opts.child) ? opts.child : [opts.child];
      await runCommand(program.opts(), async (ctx) =>
        manageSubtasks(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, add: children }),
        (result: any) => `Attached ${result.attached.length} subtask(s).`,
      );
    });

  sub
    .command('remove')
    .description('Detach children from <task-id>')
    .argument('<task-id>', 'Parent task ID')
    .requiredOption('--child <ids...>', 'One or more child task IDs to detach')
    .action(async (taskId, opts) => {
      const children: string[] = Array.isArray(opts.child) ? opts.child : [opts.child];
      await runCommand(program.opts(), async (ctx) =>
        manageSubtasks(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, remove: children }),
        (result: any) => `Detached ${result.detached.length} subtask(s).`,
      );
    });

  sub
    .command('set-parent')
    .description('Set the parent of a task')
    .argument('<task-id>', 'Task whose parent to set')
    .requiredOption('--parent <id>', 'New parent task ID')
    .action(async (taskId, opts) => {
      await runCommand(program.opts(), async (ctx) =>
        updateTask(ctx.client, ctx.projectId, { task_id: taskId, parent_task_id: opts.parent }),
        () => 'Parent set.',
      );
    });

  sub
    .command('unparent')
    .description('Detach a task from its parent')
    .argument('<task-id>', 'Task to detach')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        updateTask(ctx.client, ctx.projectId, { task_id: taskId, parent_task_id: null }),
        () => 'Detached from parent.',
      );
    });
}
