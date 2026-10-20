import { describe, expect, it } from 'vitest';
import { runConductorBoot, type BootDeps } from './conductor-boot.js';

const HOST = JSON.stringify({
  version: 1,
  gcp: { project: 'proj-x' },
  secrets: { api_token: 'harmony-conductor-api-token' },
});
const VALUE = 'SENTINEL-TOKEN-VALUE-1234567890';

function deps(over: Partial<BootDeps> = {}): { d: BootDeps; out: string[]; err: string[]; ran: Array<{ c: string; a: string[]; env: Record<string, string | undefined> }>; calls: string[][] } {
  const out: string[] = [];
  const err: string[] = [];
  const ran: Array<{ c: string; a: string[]; env: Record<string, string | undefined> }> = [];
  const calls: string[][] = [];
  const d: BootDeps = {
    env: { HARMONY_CONDUCTOR_REMOTE: '1', HARMONY_HOME: '/h' },
    exec: async (file, args) => {
      calls.push([file, ...args]);
      return { code: 0, stdout: `${VALUE}\n` };
    },
    readFile: () => HOST,
    run: async (c, a, env) => {
      ran.push({ c, a, env });
      return 7;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...over,
  };
  return { d, out, err, ran, calls };
}

describe('conductor-boot', () => {
  it('exec resolves secrets into the CHILD env only, runs the command and returns its exit code', async () => {
    const t = deps();
    const code = await runConductorBoot(['exec', '--', 'bash', 'x.sh', '--flag'], t.d);
    expect(code).toBe(7);
    expect(t.ran).toHaveLength(1);
    expect(t.ran[0]!.c).toBe('bash');
    expect(t.ran[0]!.a).toEqual(['x.sh', '--flag']);
    expect(t.ran[0]!.env.HARMONY_API_TOKEN).toBe(VALUE);
    expect(t.d.env.HARMONY_API_TOKEN).toBeUndefined();
    expect(t.calls[0]).toContain('--secret=harmony-conductor-api-token');
    expect(JSON.stringify([t.out, t.err, t.calls])).not.toContain(VALUE);
  });

  it('exec fails (exit 1, command not run) when a secret cannot be resolved, naming the secret only', async () => {
    const t = deps({ exec: async () => ({ code: 1, stdout: '' }) });
    expect(await runConductorBoot(['exec', '--', 'true'], t.d)).toBe(1);
    expect(t.ran).toHaveLength(0);
    expect(t.err.join('\n')).toContain('harmony-conductor-api-token');
  });

  it('exec outside remote mode just runs the command', async () => {
    const t = deps({ env: {} });
    expect(await runConductorBoot(['exec', '--', 'true'], t.d)).toBe(7);
    expect(t.calls).toHaveLength(0);
  });

  it('check-host prints secret NAMES for a valid file and fails on an invalid one', async () => {
    const ok = deps();
    expect(await runConductorBoot(['check-host', '/x.json'], ok.d)).toBe(0);
    expect(ok.out.join('\n')).toContain('api_token=harmony-conductor-api-token');
    const bad = deps({ readFile: () => '{"version":1,"bogus":true}' });
    expect(await runConductorBoot(['check-host', '/x.json'], bad.d)).toBe(1);
    const garbled = deps({ readFile: () => 'nope' });
    expect(await runConductorBoot(['check-host', '/x.json'], garbled.d)).toBe(1);
  });

  it('usage errors exit 2', async () => {
    expect(await runConductorBoot([], deps().d)).toBe(2);
    expect(await runConductorBoot(['exec'], deps().d)).toBe(2);
    expect(await runConductorBoot(['check-host'], deps().d)).toBe(2);
  });
});
