import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerConductorCommands } from './conductor-config.js';
import { cloudFilter, parseDuration, registerConductorLogsCommand, runConductorLogs, type ConductorLogsDeps } from './conductor-logs.js';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const row = (ts: string, msg: string, extra: object = {}) => JSON.stringify({ ts, level: 'info', event: 'daemon', message: msg, ...extra });

function deps(files: Record<string, string>, over: Partial<ConductorLogsDeps> = {}): ConductorLogsDeps {
  return {
    env: { HARMONY_CONDUCTOR_LOG: '/l/conductor.log' },
    now: () => NOW,
    existsSync: (p) => p in files,
    readFileSync: (p) => files[p],
    runGcloud: vi.fn(async () => ({ code: 0, stdout: '[]', stderr: '' })),
    ...over,
  };
}

describe('conductor logs', () => {
  it('parses durations', () => {
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('x')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
  });

  it('reads the local file (incl. rotated), filters by --since, orders, limits, formats', async () => {
    const files = {
      '/l/conductor.log.1': `${row('2026-10-20T08:00:00.000Z', 'too old')}\n${row('2026-10-20T11:10:00.000Z', 'older')}\n`,
      '/l/conductor.log': `${row('2026-10-20T11:30:00.000Z', 'newer', { ticket: 'B-5', level: 'warn', event: 'leg.exit' })}\ntorn{\n`,
    };
    const r = await runConductorLogs(deps(files), { since: '1h' });
    expect(r.source).toBe('local');
    expect(r.lines).toEqual([
      '2026-10-20T11:10:00.000Z INFO    daemon - older',
      '2026-10-20T11:30:00.000Z WARN    leg.exit B-5 newer',
    ]);
    expect((await runConductorLogs(deps(files), { since: '1h', limit: 1 })).lines).toHaveLength(1);
  });

  it('uses Cloud Logging via gcloud with the documented filter when no local file exists', async () => {
    const gcloud = vi.fn(async () => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify([
        { timestamp: '2026-10-20T11:31:00Z', severity: 'WARNING', jsonPayload: { event: 'e2', message: 'second', ticket: 'B-2' } },
        { timestamp: '2026-10-20T11:30:00Z', severity: 'INFO', jsonPayload: { event: 'e1', message: 'first' } },
      ]),
    }));
    const r = await runConductorLogs(deps({}, { runGcloud: gcloud, env: { CLOUDSDK_CORE_PROJECT: 'p1' } }), { since: '30m' });
    expect(r.source).toBe('cloud');
    const args = gcloud.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['logging', 'read']);
    expect(args[2]).toBe(cloudFilter('p1', '2026-10-20T11:30:00.000Z'));
    expect(args[2]).toBe('logName="projects/p1/logs/harmony-conductor" AND timestamp>="2026-10-20T11:30:00.000Z"');
    expect(r.lines.map((l) => l.split(' ')[0])).toEqual(['2026-10-20T11:30:00Z', '2026-10-20T11:31:00Z']);
  });

  it('--source cloud is honoured even when the local file exists; --source local without a file fails', async () => {
    const files = { '/l/conductor.log': row('2026-10-20T11:59:00.000Z', 'x') };
    const g = vi.fn(async () => ({ code: 0, stdout: '[]', stderr: '' }));
    await runConductorLogs(deps(files, { runGcloud: g }), { since: '1h', source: 'cloud', project: 'p' });
    expect(g).toHaveBeenCalled();
    const r = await runConductorLogs(deps({}), { since: '1h', source: 'local' });
    expect(r.exitCode).toBe(1);
  });

  it('reports bad input and gcloud failures without throwing', async () => {
    expect((await runConductorLogs(deps({}), { since: 'soon' })).exitCode).toBe(2);
    expect((await runConductorLogs(deps({}), { since: '1h' })).errLines[0]).toMatch(/no GCP project/);
    const r = await runConductorLogs(deps({}, { runGcloud: async () => ({ code: 1, stdout: '', stderr: 'PERMISSION_DENIED: nope\nmore' }) }), { since: '1h', project: 'p' });
    expect(r.exitCode).toBe(1);
    expect(r.errLines[0]).toContain('PERMISSION_DENIED');
  });

  it('attaches `logs` to the existing conductor group without touching `config`', () => {
    const program = new Command();
    registerConductorCommands(program);
    registerConductorLogsCommand(program, () => deps({}));
    const conductor = program.commands.find((c) => c.name() === 'conductor')!;
    expect(conductor.commands.map((c) => c.name()).sort()).toEqual(['config', 'logs']);
  });
});
