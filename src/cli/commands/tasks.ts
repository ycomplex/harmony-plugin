import { Command } from 'commander';
import { listTasks, getTask, createTask, updateTask } from '../../tools/tasks.js';
import { listSubtasks } from '../../tools/decomposition.js';
import { classifyCleanRowShape } from '../../daemon/classify.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatPriority, formatStatus, formatDate } from '../formatter.js';

export function registerTaskCommands(program: Command): void {
  const tasks = program.command('tasks').description('Manage tasks');

  tasks.command('list')
    .description('List tasks with optional filters')
    .option('--status <status>', 'Filter by legacy status')
    .option('--state <states...>', 'Filter by workflow state(s) (opinionated-mode projects only)')
    .option('--assignee <id>', 'Filter by assignee')
    .option('--epic <id>', 'Filter by epic')
    .option('--milestone <id>', 'Filter by milestone')
    .option('--cycle <id>', 'Filter by cycle')
    .option('--label <ids...>', 'Filter by label IDs')
    .option('--archived', 'Include archived tasks', false)
    .option('--full', 'Include full descriptions (rows are lean by default)', false)
    .option('--limit <n>', 'Max results', '50')
    .option('--offset <n>', 'Skip results', '0')
    .action(async (opts) => {
      await runCommand(program.opts(), async (ctx) =>
        listTasks(ctx.client, ctx.projectId, {
          status: opts.status, assignee_id: opts.assignee, epic_id: opts.epic,
          workflow_state: opts.state?.length === 1 ? opts.state[0] : opts.state,
          milestone_id: opts.milestone, cycle_id: opts.cycle,
          label_ids: opts.label, archived: opts.archived,
          view: opts.full ? 'full' : undefined,
          limit: parseInt(opts.limit), offset: parseInt(opts.offset),
        }),
        (data) => formatTable(data, [
          { key: 'task_number', header: '#' },
          { key: 'title', header: 'Title', width: 50 },
          { key: 'status', header: 'Status', transform: (v: string) => formatStatus(v) },
          { key: 'priority', header: 'Priority', transform: (v: string) => formatPriority(v) },
          { key: 'due_date', header: 'Due', transform: (v: string | null) => formatDate(v) },
        ]),
      );
    });

  tasks.command('get')
    .description('Get full details of a task')
    .argument('<id>', 'Task ID (UUID, number, or B-123)')
    .action(async (id) => {
      await runCommand(program.opts(), async (ctx) => getTask(ctx.client, ctx.projectId, { task_id: id }),
        (task) => formatDetail([
          { label: 'ID', value: `#${task.task_number}` },
          { label: 'Title', value: task.title },
          { label: 'Status', value: formatStatus(task.status) },
          { label: 'Priority', value: formatPriority(task.priority) },
          { label: 'Assignee', value: task.assignee_id ?? 'Unassigned' },
          { label: 'Epic', value: task.epic_id ?? 'None' },
          { label: 'Due', value: formatDate(task.due_date) },
          { label: 'Description', value: task.description ?? '' },
        ]),
      );
    });

  // B-870: the minimal read the interactive STOP GATE needs — the two clean-shape fields plus the
  // non-archived child count, in ONE call, so the hook never reaches into the DB itself. The child
  // count is fetched only when the state is Decomposed, mirroring the daemon's own settle path
  // (src/bin/daemon.ts countNonArchivedChildren) exactly. `clean` is computed by the SHARED
  // predicate — the hook consumes it, and src/hooks/stop-gate.contract.test.ts fails if this and
  // the daemon's exit classifier ever disagree about a row shape.
  tasks.command('clean-check')
    .description('Report whether a task row is a clean place for a ticket-driving session to stop')
    .argument('<id>', 'Task ID (UUID, number, or B-123)')
    .action(async (id) => {
      await runCommand(program.opts(), async (ctx) => {
        const task = (await getTask(ctx.client, ctx.projectId, { task_id: id, view: 'meta' })) as {
          id: string;
          task_number?: number;
          workflow_state?: string | null;
          awaiting_human_input?: boolean | null;
          pending_acceptance_event_id?: string | null;
        };
        let nonArchivedChildCount = 0;
        if (task.workflow_state === 'Decomposed') {
          const children = (await listSubtasks(ctx.client, ctx.projectId, { task_id: id })) as Array<{
            archived?: boolean | null;
          }>;
          nonArchivedChildCount = children.filter((c) => !c.archived).length;
        }
        const kind = classifyCleanRowShape(task, nonArchivedChildCount);
        return {
          task_id: task.id,
          task_number: task.task_number ?? null,
          workflow_state: task.workflow_state ?? null,
          awaiting_human_input: task.awaiting_human_input ?? null,
          // B-818: surfaced so --json output and classifyCleanRowShape both see an outstanding
          // B-797 two-step accept — the gate this field defeats even when the row otherwise looks clean.
          pending_acceptance_event_id: task.pending_acceptance_event_id ?? null,
          non_archived_child_count: nonArchivedChildCount,
          clean: kind !== null,
          clean_kind: kind,
        };
      },
        (r) => (r.clean ? `clean (${r.clean_kind})` : 'NOT clean — nothing on the board for this leg'),
      );
    });

  tasks.command('create')
    .description('Create a new task')
    .requiredOption('--title <title>', 'Task title')
    .option('--status <status>', 'Status (default: Backlog)')
    .option('--priority <priority>', 'Priority: high, medium, low')
    .option('--assignee <id>', 'Assignee (name, email, or UUID)')
    .option('--epic <id>', 'Epic ID')
    .option('--description <text>', 'Task description')
    .option('--due <date>', 'Due date (YYYY-MM-DD)')
    .option('--cycle <id>', 'Cycle ID')
    .option('--milestone <id>', 'Milestone ID')
    .action(async (opts) => {
      await runCommand(program.opts(), async (ctx) =>
        createTask(ctx.client, ctx.projectId, ctx.userId, {
          title: opts.title, status: opts.status, priority: opts.priority,
          assignee_id: opts.assignee, epic_id: opts.epic, description: opts.description,
          due_date: opts.due, cycle_id: opts.cycle, milestone_id: opts.milestone,
        }),
        (task) => `Created task #${task.task_number}: ${task.title}`,
      );
    });

  tasks.command('update')
    .description('Update an existing task')
    .argument('<id>', 'Task ID')
    .option('--title <title>', 'New title')
    .option('--status <status>', 'New status')
    .option('--priority <priority>', 'New priority')
    .option('--assignee <id>', 'New assignee')
    .option('--epic <id>', 'New epic')
    .option('--description <text>', 'New description')
    .option('--due <date>', 'New due date')
    .option('--cycle <id>', 'Cycle ID')
    .option('--milestone <id>', 'Milestone ID')
    .action(async (id, opts) => {
      await runCommand(program.opts(), async (ctx) =>
        updateTask(ctx.client, ctx.projectId, {
          task_id: id, title: opts.title, status: opts.status, priority: opts.priority,
          assignee_id: opts.assignee, epic_id: opts.epic, description: opts.description,
          due_date: opts.due, cycle_id: opts.cycle, milestone_id: opts.milestone,
        }),
        (task) => `Updated task #${task.task_number}: ${task.title}`,
      );
    });
}
