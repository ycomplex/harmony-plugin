import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Local-only: task identity is already resolved by conduct; no auth/config read. */
export function writeConductBreadcrumb(
  input: { task: string; ticket: string; sessionId: string },
  options: { home?: string; now?: () => Date } = {},
): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.sessionId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.task) ||
      !/^[a-zA-Z][a-zA-Z0-9]*-[0-9]+$/.test(input.ticket)) {
    throw new Error('Invalid conduct identity');
  }
  const dir = join(options.home ?? process.env.HARMONY_HOME ?? join(homedir(), '.harmony'), 'conduct-sessions');
  const path = join(dir, `${input.sessionId}.json`);
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `${input.sessionId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ session_id: input.sessionId, task_id: input.task,
      ticket: input.ticket, started_at: startedAt }) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return path;
}
