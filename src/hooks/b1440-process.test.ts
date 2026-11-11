import { describe, it, expect } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderClaudeHooks, renderCodexHooks, type HooksFile } from '../agents/hooks.js';

const stamp = '2026-11-10T15:42:00Z';
const task = 'a8193a21-b2ad-42b5-b464-59579691931d';
const marker = { kind: 'ci', ref: '12345', since: '2026-11-10T15:41:52Z', first_since: '2026-11-10T15:41:52Z' };
describe('B-1440 real command and rendered hook processes (no runtime/model launch)', () => {
  it.each(['claude-code', 'codex'])('%s session hook, breadcrumb CLI and Stop wrapper', adapter => {
    const home = mkdtempSync(join(tmpdir(), 'b1440-process-'));
    const root = join(home, 'plugin');
    mkdirSync(join(root, 'dist/bin'), { recursive: true });
    const env = { PATH: process.env.PATH, HOME: home, HARMONY_HOME: join(home, 'harmony'), CLAUDE_PLUGIN_ROOT: root };
    try {
      const hooks = (adapter === 'codex' ? JSON.parse(renderCodexHooks(root).content) : JSON.parse(renderClaudeHooks())) as HooksFile;
      const session = 'process-session';
      const started = spawnSync('sh', ['-c', hooks.hooks.SessionStart[1].hooks[0].command], { env, input: JSON.stringify({ session_id: session }), encoding: 'utf8' });
      expect(started.status).toBe(0);
      expect(readFileSync(join(env.HARMONY_HOME, 'conduct-sessions/current-session'), 'utf8')).toBe(session);
      // The production command, with auth absent, is a real local-only child process.
      const cli = join(process.cwd(), 'dist/bin/harmony.js');
      const stamped = spawnSync(process.execPath, [cli, 'conduct', 'breadcrumb', '--task', task, '--ticket', 'B-1440', '--session-id', session], { env, encoding: 'utf8' });
      expect(stamped.status, stamped.stderr).toBe(0);
      const breadcrumbPath = join(env.HARMONY_HOME, `conduct-sessions/${session}.json`);
      const breadcrumb = JSON.parse(readFileSync(breadcrumbPath, 'utf8'));
      expect(breadcrumb.task_id).toBe(task);
      expect(Number.isFinite(Date.parse(breadcrumb.started_at))).toBe(true);
      // A resumed pickup uses the same session id and replaces a previous leg's boundary.
      writeFileSync(breadcrumbPath, JSON.stringify({ ...breadcrumb, started_at: '2026-11-01T00:00:00Z' }));
      const resumed = spawnSync(process.execPath, [cli, 'conduct', 'breadcrumb', '--task', task, '--ticket', 'B-1440', '--session-id', session], { env, encoding: 'utf8' });
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(Date.parse(JSON.parse(readFileSync(breadcrumbPath, 'utf8')).started_at)).toBeGreaterThan(Date.parse('2026-11-01T00:00:00Z'));
      // Exercise the actual wrapper/runner; only the remote row accessor is a synthetic fixture.
      buildSync({ entryPoints: ['src/bin/stop-gate.ts'], bundle: true, platform: 'node', format: 'esm', outfile: join(root, 'dist/bin/stop-gate.js'), banner: { js: `Date.now = () => ${Date.parse(stamp)};` } });
      writeFileSync(join(root, 'dist/bin/harmony.js'), `console.log(${JSON.stringify(JSON.stringify({ workflow_state: 'Planned', awaiting_human_input: false, waiting_on: marker }))});`);
      writeFileSync(breadcrumbPath, JSON.stringify({ ...breadcrumb, started_at: '2026-11-10T16:00:00Z' }));
      const wrapper = join(process.cwd(), 'hooks/stop-gate.sh');
      const input = JSON.stringify({ session_id: session, stop_hook_active: false });
      expect(spawnSync('sh', [wrapper], { env, input, encoding: 'utf8' }).status).toBe(0);
      writeFileSync(breadcrumbPath, JSON.stringify({ ...breadcrumb, started_at: '2026-11-10T15:41:53Z' }));
      const rejected = spawnSync('sh', [wrapper], { env, input, encoding: 'utf8' });
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain('older than leg start');
      expect(rejected.stderr).toContain('kind=ci, ref=12345, since=2026-11-10T15:41:52Z');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
