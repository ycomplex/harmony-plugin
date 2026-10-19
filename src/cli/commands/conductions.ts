// B-1164: `harmony conductions active` — the board-side read container/gke/switch-daemon-profile.sh
// uses to confirm a daemon profile switch. It lists the ACTIVE conductions with their lease holder and
// heartbeat, so "which daemon holds this run, and is it alive?" is answered from the board itself rather
// than from a daemon log line (log wording changes; the board columns are the contract).
//
// Read-only. The holder string is the daemon's own `<hostname>:<pid>:<suffix>` (src/bin/daemon.ts).

import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listConductions } from '../../tools/conduction-record.js';
import { getProject } from '../../tools/project.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export interface ActiveConductionRow {
  id: string;
  /** "<project key>-<task number>", e.g. B-1164; null when the task could not be resolved. */
  ticket: string | null;
  status: string;
  lease_holder: string | null;
  last_heartbeat_at: string | null;
  leg_started_at: string | null;
  clean_shutdown_at: string | null;
}

export async function listActiveConductions(client: SupabaseClient, projectId: string): Promise<ActiveConductionRow[]> {
  const rows = await listConductions(client, { status: 'active' });
  if (rows.length === 0) return [];
  const projectKey = (await getProject(client, projectId)).key as string;
  const { data, error } = await client.from('tasks').select('id, task_number').in('id', rows.map((r) => r.task_id));
  if (error) throw error;
  const numbers = new Map<string, number>(((data as Array<{ id: string; task_number: number }>) ?? []).map((t) => [t.id, t.task_number]));
  return rows.map((r) => ({
    id: r.id,
    ticket: numbers.has(r.task_id) ? `${projectKey}-${numbers.get(r.task_id)}` : null,
    status: r.status,
    lease_holder: r.lease_holder,
    last_heartbeat_at: r.last_heartbeat_at,
    leg_started_at: r.leg_started_at,
    clean_shutdown_at: r.clean_shutdown_at,
  }));
}

export function registerConductionsCommands(program: Command): void {
  const conductions = program.command('conductions').description('Read conduction (run) records');
  conductions
    .command('active')
    .description('List active conductions with their lease holder and heartbeat (use --json for scripting)')
    .action(async () => {
      await runCommand(program.opts(), async (ctx) => listActiveConductions(ctx.client, ctx.projectId),
        (rows) => formatTable(rows, [
          { key: 'ticket', header: 'Ticket' },
          { key: 'id', header: 'Conduction' },
          { key: 'lease_holder', header: 'Lease holder' },
          { key: 'last_heartbeat_at', header: 'Heartbeat' },
          { key: 'leg_started_at', header: 'Leg started' },
        ]),
      );
    });
}
