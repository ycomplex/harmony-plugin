// B-1452: `harmony incident raise` — the CLI twin of the `raise_incident` MCP tool. A worker that has
// no MCP tools (the harmony-build subagent) runs it by path:
//   node /workspace/workspace/plugin/dist/bin/harmony.js incident raise --task <ticket> ...
// Use ONLY when you discovered you exposed a credential outside the worker. Never pass the secret in
// any flag. After it succeeds, make no further change and end the turn.
import { Command } from 'commander';
import { raiseIncident, INCIDENT_KINDS, type RaiseIncidentResult } from '../../tools/incident.js';
import { runCommand } from '../run-command.js';

export function formatIncidentRaised(data: RaiseIncidentResult): string {
  const lines = [
    `Incident raised (${data.kind}) on exchange ${data.exchange_id}, round ${data.round}. The ticket now waits for a human.`,
    `What: ${data.what}`,
    `Where: ${data.where}`,
    `Only a human can do this: ${data.human_steps}`,
  ];
  if (data.scrubbed) lines.push('Token-shaped text was replaced with [redacted] before anything was written.');
  if (data.superseded_exchange_id) lines.push(`The open exchange ${data.superseded_exchange_id} was concluded 'abandoned'.`);
  if (data.comment_error) lines.push(`Warning: the INCIDENT-RAISED comment failed (${data.comment_error}); the round is filed.`);
  lines.push('Make no further change and end your turn.');
  return lines.join('\n');
}

export function registerIncidentCommands(program: Command): void {
  const incident = program.command('incident').description('Incidents a worker leg raises for a human (B-1452)');
  incident
    .command('raise')
    .description(
      'Raise an incident: use ONLY when you exposed a credential outside the worker. Never pass the secret itself; after it succeeds make no further change and end your turn.',
    )
    .requiredOption('--task <task>', 'Task ID, number or visual ID')
    .requiredOption('--kind <kind>', `Incident kind: ${INCIDENT_KINDS.join(' | ')}`)
    .requiredOption('--what <text>', 'What was exposed, described — never the value')
    .requiredOption('--where <text>', 'Where it was exposed (commit by short SHA, branch, PR, comment)')
    .requiredOption('--human-steps <text>', 'Exactly what only a human can do (revoke/rotate, rewrite history, ...)')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        (ctx) =>
          raiseIncident(ctx.client, ctx.projectId, ctx.userId, {
            task_id: opts.task,
            kind: opts.kind,
            what: opts.what,
            where: opts.where,
            human_steps: opts.humanSteps,
          }),
        formatIncidentRaised,
      );
    });
}
