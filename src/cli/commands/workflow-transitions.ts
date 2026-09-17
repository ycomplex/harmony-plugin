import { Command } from 'commander';
import { listWorkflowTransitions } from '../../tools/workflow-transitions.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

export function registerWorkflowTransitionsCommand(program: Command): void {
  program.command('workflow-transitions')
    .description('List workflow_state transitions across the whole project between two dates (one call instead of one per ticket)')
    .requiredOption('--from <iso>', 'Start of the created_at range (inclusive), ISO timestamp')
    .requiredOption('--to <iso>', 'End of the created_at range (exclusive), ISO timestamp')
    .option('--state <workflow_state>', 'Filter to transitions landing on this workflow_state (maps to new_value)')
    .option('--milestone <id>', 'Filter to tasks on this milestone')
    .option('--epic <id>', 'Filter to tasks on this epic')
    .option('--full', "Include each transition's task title (rows are lean by default)", false)
    .option('--limit <n>', 'Max results (default 100, hard cap 500)', '100')
    .option('--offset <n>', 'Skip results', '0')
    .action(async (opts) => {
      await runCommand(program.opts(), async (ctx) =>
        listWorkflowTransitions(ctx.client, ctx.projectId, {
          from: opts.from,
          to: opts.to,
          new_value: opts.state,
          milestone_id: opts.milestone,
          epic_id: opts.epic,
          view: opts.full ? 'full' : undefined,
          limit: parseInt(opts.limit),
          offset: parseInt(opts.offset),
        }),
        (data: any[]) => formatTable(data, [
          { key: 'created_at', header: 'When', transform: (v: string) => formatDate(v) },
          { key: 'visual_id', header: 'Ticket' },
          { key: 'old_value', header: 'From', transform: (v: string | null) => v ?? '—' },
          { key: 'new_value', header: 'To', transform: (v: string | null) => v ?? '—' },
          { key: 'order', header: 'Order', transform: (v: string | undefined) => v ?? '' },
        ]),
      );
    });
}
