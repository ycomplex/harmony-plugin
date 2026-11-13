import { Command } from 'commander';
import { listBriefs } from '../../tools/briefs.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
import { formatBriefSections, readBriefSections } from '../../tools/brief-project-sections.js';

/**
 * B-878 — the terminal mirror of `list_briefs`: the full brief history of a ticket (every gate ask,
 * every retained revision, at every status). A READ only — briefs are composed/resolved through the
 * conductor skills, never from here.
 */
// B-1364: any future resolve/reshape command MUST call the guarded shared handler with ctx.userId.
export function registerBriefCommands(program: Command): void {
  const briefs = program.command('briefs').description("Read a task's brief history");

  briefs
    .command('list')
    .description('List every gate ask on a task (lineages) and its retained revisions')
    .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
    .action(async (taskId) => {
      await runCommand(program.opts(), async (ctx) =>
        listBriefs(ctx.client, ctx.projectId, { task_id: taskId }),
        (data) => {
          if (!data.lineages.length) return '(no briefs on this task)';
          return formatTable(data.lineages.map((l) => ({
            lineage_id: l.lineage_id,
            reason: l.reason ?? '',
            status: l.status ?? '',
            revisions: String(l.retained_revisions),
            // The count of revisions whose TEXT is gone — reported, never rounded away.
            unretained: l.has_unretained_revisions ? String(l.unretained_revisions) : '',
          })), [
            { key: 'lineage_id', header: 'Lineage', width: 38 },
            { key: 'reason', header: 'Gate', width: 26 },
            { key: 'status', header: 'Status' },
            { key: 'revisions', header: 'Revisions' },
            { key: 'unretained', header: 'Not retained' },
          ]);
        },
      );
    });

  // B-1305 — the terminal mirror of `read_brief_sections`: the brief sections this project declares for a
  // gate, read from each repository's default branch. Local only (git), so it needs no board login.
  program
    .command('brief')
    .description("Read this project's brief settings")
    .command('sections')
    .description("Show the brief sections this project declares for a gate (from each repository's default branch)")
    .argument('<gate>', 'clarify | decompose | design | plan | release | verify')
    .action(async (gate: string) => {
      const json = !!program.opts().json;
      try {
        const data = await readBriefSections({ gate });
        console.log(json ? JSON.stringify(data, null, 2) : formatBriefSections(data));
      } catch (err: unknown) {
        const message = (err as Error)?.message ?? String(err);
        console.error(json ? JSON.stringify({ error: message }) : `Error: ${message}`);
        process.exit(1);
      }
    });
}
