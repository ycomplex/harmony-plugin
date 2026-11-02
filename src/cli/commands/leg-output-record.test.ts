import { Command } from 'commander';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { record } = vi.hoisted(() => ({ record: vi.fn().mockResolvedValue(true) }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: vi.fn().mockResolvedValue({ client: {} }) }));
vi.mock('../../tools/leg-cost-record.js', () => ({ resolveLegCostContext: vi.fn().mockResolvedValue({ task_id: 'task' }) }));
vi.mock('../../tools/leg-output-record.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../tools/leg-output-record.js')>(), recordLegOutput: record,
}));
import { registerLegOutputCommands } from './leg-output.js';

const dirs: string[] = [];
afterEach(() => { dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })); dirs.length = 0; vi.clearAllMocks(); });
async function run(stdout: string | null, source = 'worker') {
  const dir = mkdtempSync(join(tmpdir(), 'b1368-output-')); dirs.push(dir);
  const path = join(dir, 'capture');
  if (stdout !== null) writeFileSync(path, stdout);
  const program = new Command(); registerLegOutputCommands(program);
  await program.parseAsync(['leg-output', 'record', '--file', path, '--source', source,
    '--agent', 'codex', '--leg-key', 'leg', '--gate', 'build', '--conduction-id', 'conduction'], { from: 'user' });
  return record.mock.calls.at(-1)?.[1];
}
describe('leg-output record command capture-to-row path', () => {
  it('writes final-turn prose with worker provenance and statement byte count', async () => {
    const stream = ['{"type":"turn.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"Finished — done."}}', '{"type":"turn.completed"}'].join('\n');
    expect(await run(stream)).toMatchObject({ source: 'worker', leg_key: 'leg', gate: 'build', task_id: 'task',
      tail: 'Finished — done.', total_bytes: Buffer.byteLength('Finished — done.') });
  });
  it('still records an explanatory row when the capture file is unreadable', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const row = await run(null);
      expect(JSON.parse(row.tail).harmony_codex_output).toMatchObject({ status: 'unavailable', raw_excerpt: '' });
      expect(row.total_bytes).toBe(Buffer.byteLength(row.tail));
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
  it('never extracts Codex-shaped launcher diagnostics', async () => {
    const raw = '{"type":"turn.failed"}';
    expect(await run(raw, 'launcher')).toMatchObject({ source: 'launcher', tail: raw });
  });
});
