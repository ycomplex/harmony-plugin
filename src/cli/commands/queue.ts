import { Command } from 'commander';
import { runCommand } from '../run-command.js';
import { queryTasks } from '../../tools/query-tasks.js';
import { getProject } from '../../tools/project.js';
import { getBrief } from '../../tools/briefs.js';
import { handoffInstruction, type HandoffRef } from '../../tools/fasttrack-handoff.js';

export function formatQueueRow(task: { key: string; title: string; state: string; instruction: string; pr_url?: string; refusal?: string }) {
  return `${task.key} [${task.state}] ${task.title}\n  ${task.instruction}${task.pr_url ? `\n  ${task.pr_url}` : ''}${task.refusal ? `\n  Recording refused: ${task.refusal}` : ''}`;
}
export function registerQueueCommand(program: Command) {
  program.command('queue').description('Show this project’s human turns and stale tickets; read-only.').action(async () => {
    await runCommand(program.opts(), async ctx => {
      const project = await getProject(ctx.client, ctx.projectId);
      const readAll = async (filter: { awaiting_human_input?: boolean; stale?: boolean }) => {
        const rows = [];
        for (let offset = 0; ; offset += 100) {
          const page = await queryTasks(ctx.client, ctx.projectId, { ...filter, sort_by: 'priority', limit: 100, offset });
          rows.push(...page);
          if (page.length < 100) return rows;
        }
      };
      const [awaiting, stale] = await Promise.all([readAll({ awaiting_human_input: true }), readAll({ stale: true })]);
      const tasks = [...new Map([...awaiting, ...stale].map(t => [t.id, t])).values()];
      tasks.sort((a,b) => Number(!!b.awaiting_human_ref?.incident) - Number(!!a.awaiting_human_ref?.incident));
      return Promise.all(tasks.map(async t => {
        const ref = t.awaiting_human_ref as HandoffRef | null;
        const handoff = t.awaiting_human_reason === 'fast-track-merge-pending' && ref?.kind === 'fast-track-merge';
        const brief = (handoff ? null : await getBrief(ctx.client, ctx.projectId, { task_id: t.id })) as { doc?: { decide?: string } } | null;
        return { key: `${project.key}-${t.task_number}`, title: t.title, state: t.workflow_state,
          instruction: handoff ? handoffInstruction(ref) : brief?.doc?.decide ?? t.awaiting_human_reason ?? 'Stale — knowledge changed',
          ...(handoff ? { pr_url: ref.pr_url, refusal: ref.refusal_reason } : {}) };
      }));
    }, rows => rows.length ? rows.map(formatQueueRow).join('\n\n') : 'Nothing awaiting you.');
  });
}
