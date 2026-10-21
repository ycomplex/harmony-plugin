import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PREFLIGHT_PLUGIN_FILES, runConductorBoot, type BootDeps } from './conductor-boot.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

const HOST = JSON.stringify({
  version: 1,
  gcp: { project: 'proj-x' },
  secrets: { api_token: 'HARMONY_API_TOKEN' },
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
    fileExists: () => true,
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
    expect(t.calls[0]).toContain('--secret=HARMONY_API_TOKEN');
    expect(JSON.stringify([t.out, t.err, t.calls])).not.toContain(VALUE);
  });

  it('exec fails (exit 1, command not run) when a secret cannot be resolved, naming the secret only', async () => {
    const t = deps({ exec: async () => ({ code: 1, stdout: '' }) });
    expect(await runConductorBoot(['exec', '--', 'true'], t.d)).toBe(1);
    expect(t.ran).toHaveLength(0);
    expect(t.err.join('\n')).toContain('HARMONY_API_TOKEN');
  });

  it('exec outside remote mode with a host file naming no secrets just runs the command (no call)', async () => {
    const t = deps({ env: {}, readFile: () => '{"version":1}' });
    expect(await runConductorBoot(['exec', '--', 'true'], t.d)).toBe(7);
    expect(t.calls).toHaveLength(0);
  });

  it('exec outside remote mode resolves the named secrets too (B-1173: the resolver is mode-independent)', async () => {
    const t = deps({ env: {} });
    expect(await runConductorBoot(['exec', '--', 'true'], t.d)).toBe(7);
    expect(t.calls.length).toBeGreaterThan(0);
  });

  it('check-host prints secret NAMES for a valid file and fails on an invalid one', async () => {
    const ok = deps();
    expect(await runConductorBoot(['check-host', '/x.json'], ok.d)).toBe(0);
    expect(ok.out.join('\n')).toContain('api_token=HARMONY_API_TOKEN');
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

describe('conductor-boot preflight (B-1186)', () => {
  // The REAL example files; the plugin dir is this checkout, so the presence checks run against real paths.
  const real = (over: Partial<BootDeps> = {}) => {
    const probed: string[] = [];
    const t = deps({
      env: { PATH: '/bin' },
      readFile: (p) => readFileSync(p, 'utf8'),
      fileExists: (p) => existsSync(p) || p.startsWith(`${REPO}/dist/`), // dist/ is generated, not tracked on main
      run: async (_c, a) => {
        probed.push(a[1] ?? '');
        return 0;
      },
      ...over,
    });
    return { ...t, probed };
  };
  const args = ['preflight', '--plugin-dir', REPO];

  it('passes on the shipped example host + project files with every tool present', async () => {
    const t = real();
    expect(await runConductorBoot(args, t.d)).toBe(0);
    expect(t.out.join('\n')).toContain('preflight: ok - profile gke, remote mode');
    expect(t.probed).toEqual(expect.arrayContaining(['command -v node', 'command -v kubectl']));
    expect(t.err).toEqual([]);
    expect(t.calls).toEqual([]); // no gcloud / secret call: nothing credentialed
  });

  it('every file it checks exists in the repo (so the list cannot name something renamed away)', () => {
    for (const f of PREFLIGHT_PLUGIN_FILES) {
      if (f.startsWith('dist/')) continue; // built output
      expect(existsSync(`${REPO}/${f}`), f).toBe(true);
    }
  });

  it('a missing tool the pod needs fails with the tool named', async () => {
    const t = real({ run: async (_c, a) => (a[1] === 'command -v kubectl' ? 1 : 0) });
    expect(await runConductorBoot(args, t.d)).toBe(1);
    expect(t.err.join('\n')).toContain('Missing required tool "kubectl"');
    expect(t.out.join('\n')).not.toContain('ok');
  });

  it('gke-gcloud-auth-plugin is NOT required in remote mode (the pod authenticates with its service account token)', async () => {
    const t = real({ run: async (_c, a) => (a[1] === 'command -v gke-gcloud-auth-plugin' ? 1 : 0) });
    expect(await runConductorBoot(args, t.d)).toBe(0);
  });

  it('a missing scripts/ file fails, naming it', async () => {
    const t = real({ fileExists: (p) => !p.endsWith('scripts/mint-installation-token.mjs') && (existsSync(p) || p.startsWith(`${REPO}/dist/`)) });
    expect(await runConductorBoot(args, t.d)).toBe(1);
    expect(t.err.join('\n')).toContain('scripts/mint-installation-token.mjs');
  });

  it('a missing gke launcher script fails too', async () => {
    const t = real({ fileExists: (p) => !p.endsWith('container/gke/gke-worker-launch.sh') });
    expect(await runConductorBoot(args, t.d)).toBe(1);
    expect(t.err.join('\n')).toContain('container/gke/gke-worker-launch.sh');
  });

  it('a host file that does not load fails with the config issue', async () => {
    const t = real({ readFile: (p) => (p.endsWith('conductor.host.example.json') ? '{"version":1,"bogus":true}' : readFileSync(p, 'utf8')) });
    expect(await runConductorBoot(args, t.d)).toBe(1);
    expect(t.err.join('\n')).toContain('do not load');
  });

  it('defaults to the files baked at /opt/harmony-plugin', async () => {
    const paths: string[] = [];
    const t = real({ readFile: (p) => (paths.push(p), readFileSync(p.replace('/opt/harmony-plugin', REPO), 'utf8')), fileExists: () => true });
    expect(await runConductorBoot(['preflight'], t.d)).toBe(0);
    expect(paths).toEqual(expect.arrayContaining(['/opt/harmony-plugin/container/conductor.host.example.json', '/opt/harmony-plugin/container/conductor.project.example.json']));
  });
});
