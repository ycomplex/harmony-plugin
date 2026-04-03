import { Command } from 'commander';
import { listCycles, createCycle, updateCycle } from '../../tools/cycles.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail } from '../formatter.js';

export function registerCycleCommands(program: Command): void {
  const cycles = program.command('cycles').description('Manage cycles');

  cycles.command('list')
    .description('List all cycles in the project')
    .option('--status <status>', 'Filter by status: active, next, completed')
    .action(async (opts) => {
      await runCommand(program.opts(), async (ctx) =>
        listCycles(ctx.client, ctx.projectId, { status: opts.status }),
        (data) => formatTable(data, [
          { key: 'id', header: 'ID', width: 38 },
          { key: 'name', header: 'Name', width: 20 },
          { key: 'sequence_number', header: '#' },
          { key: 'start_date', header: 'Start' },
          { key: 'end_date', header: 'End' },
          { key: 'derived_status', header: 'Status' },
        ]),
      );
    });

  cycles.command('create')
    .description('Create the first cycle for a project (subsequent cycles are auto-created)')
    .requiredOption('--start <date>', 'Start date (YYYY-MM-DD)')
    .option('--name <name>', 'Cycle name (default: "Cycle 1")')
    .action(async (opts) => {
      await runCommand(program.opts(), async (ctx) =>
        createCycle(ctx.client, ctx.projectId, ctx.userId, {
          start_date: opts.start,
          name: opts.name,
        }),
        (cycle) => `Created cycle: ${cycle.name} (${cycle.start_date} – ${cycle.end_date})`,
      );
    });

  cycles.command('update')
    .description('Update a cycle name or end date')
    .argument('<id>', 'Cycle ID (UUID)')
    .option('--name <name>', 'New name')
    .option('--end <date>', 'New end date (YYYY-MM-DD)')
    .action(async (id, opts) => {
      await runCommand(program.opts(), async (ctx) =>
        updateCycle(ctx.client, ctx.projectId, {
          cycle_id: id,
          name: opts.name,
          end_date: opts.end,
        }),
        (cycle) => formatDetail([
          { label: 'ID', value: cycle.id },
          { label: 'Name', value: cycle.name },
          { label: 'Start', value: cycle.start_date },
          { label: 'End', value: cycle.end_date },
        ]),
      );
    });
}
