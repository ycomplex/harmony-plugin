// B-1410 — `harmony criteria carry|drop`: settle one unticked acceptance criterion at the verify gate.
// Calls the same core handler as the MCP tool `settle_acceptance_criterion`.
//
// Exit codes: 0 settled, 1 refused (or any other error), 2 unavailable on this environment.
import { Command } from 'commander';
import chalk from 'chalk';
import { getAuthenticatedContext } from '../auth.js';
import { settleAcceptanceCriterion, type SettleArgs, type SettleResult } from '../../tools/settle-criteria.js';

export const CRITERIA_EXIT = { settled: 0, refused: 1, unavailable: 2 } as const;

/** One line for a person: the refusal sentence, the unavailable message, or what was settled. */
export function formatSettleResult(result: SettleResult, destinationLabel?: string): string {
  switch (result.status) {
    case 'refused':
      return `Refused (${result.code}): ${result.message}`;
    case 'unavailable':
      return result.message;
    case 'settled': {
      const again = result.already_settled ? ' (already settled — nothing changed)' : '';
      if (result.action === 'dropped') return `Dropped the criterion${again}.`;
      const dest = destinationLabel ?? result.destination_task_id ?? 'the destination ticket';
      return `Carried the criterion to ${result.destination_minted ? 'new ticket ' : ''}${dest}${again}.`;
    }
  }
}

async function runSettle(json: boolean, args: SettleArgs, destinationLabel?: string): Promise<void> {
  let result: SettleResult;
  try {
    const ctx = await getAuthenticatedContext();
    result = await settleAcceptanceCriterion(ctx.client, ctx.projectId, args);
  } catch (err: any) {
    if (json) console.error(JSON.stringify({ error: err.message }));
    else console.error(chalk.red(`Error: ${err.message}`));
    process.exit(1);
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'settled') console.log(formatSettleResult(result, destinationLabel));
  else console.error(formatSettleResult(result));
  process.exit(CRITERIA_EXIT[result.status]);
}

export function registerCriteriaCommands(program: Command): void {
  const criteria = program
    .command('criteria')
    .description('Settle an unticked acceptance criterion at the verify gate: carry it or drop it (B-1410)');

  criteria
    .command('carry')
    .description('Carry a criterion to an open ticket in this project (--to <ticket>) or to a new one (--new)')
    .argument('<criterion-id>', 'Acceptance criterion UUID')
    .option('--to <ticket>', 'An existing open ticket (UUID, number, or B-123)')
    .option('--new', 'Mint a new ticket to carry it to')
    .option('--title <title>', 'Title of the new ticket (with --new)')
    .option('--milestone <source|none>', "Milestone of the new ticket: 'source' (this ticket's) or 'none' (with --new)")
    .option('--reason <why>', 'Why the new ticket lands where it does (with --new)')
    .option('--task <ticket>', 'The ticket the criterion is on; refuses a criterion that is not on it')
    .option('--json', 'Output as JSON')
    .action(async (criterionId: string, opts) => {
      const json = Boolean(opts.json || program.opts().json);
      if (Boolean(opts.to) === Boolean(opts.new)) {
        console.error(chalk.red('Error: give exactly one of --to <ticket> or --new.'));
        process.exit(1);
      }
      const args: SettleArgs = { criterion_id: criterionId, action: 'carry', task_id: opts.task };
      if (opts.to) {
        args.destination_task_id = opts.to;
      } else {
        args.mint = { title: opts.title, milestone: opts.milestone, landing_reason: opts.reason };
      }
      await runSettle(json, args, opts.to);
    });

  criteria
    .command('drop')
    .description('Drop a criterion, with a required reason')
    .argument('<criterion-id>', 'Acceptance criterion UUID')
    .requiredOption('--reason <why>', 'Why the criterion is dropped')
    .option('--task <ticket>', 'The ticket the criterion is on; refuses a criterion that is not on it')
    .option('--json', 'Output as JSON')
    .action(async (criterionId: string, opts) => {
      const json = Boolean(opts.json || program.opts().json);
      await runSettle(json, { criterion_id: criterionId, action: 'drop', drop_reason: opts.reason, task_id: opts.task });
    });
}
