import { Command } from 'commander';
import { listActivity } from '../../tools/activity.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

function buildActivitySummary(item: any): string {
  if (item.type === 'comment') {
    return item.content ?? '';
  }
  // event
  const parts: string[] = [];
  if (item.field_name) {
    parts.push(`${item.field_name}: ${item.old_value ?? '—'} → ${item.new_value ?? '—'}`);
  } else if (item.event_type) {
    parts.push(item.event_type);
  }
  return parts.join('; ');
}

export function registerActivityCommand(program: Command): void {
  program.command('activity')
    .description('Show activity timeline for a task')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listActivity(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => formatTable(data, [
          { key: 'timestamp', header: 'When', transform: (v: string) => formatDate(v) },
          { key: 'user_name', header: 'User', transform: (v: string | null) => v ?? '' },
          { key: 'event_type', header: 'Type', transform: (_v: string, row: any) => row.type === 'comment' ? 'comment' : (row.event_type ?? '') },
          { key: 'timestamp', header: 'Summary', transform: (_v: string, row: any) => buildActivitySummary(row) },
        ]),
      );
    });
}
