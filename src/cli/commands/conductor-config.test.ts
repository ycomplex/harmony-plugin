import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BUILTIN_PROFILES, resetConductorWarningDedupe } from '../../config/conductor-config.js';
import {
  defaultCliDeps,
  findConflicts,
  flattenLayer,
  registerConductorCommands,
  runDoctor,
  runMigrate,
  runSync,
  type ConductorCliDeps,
} from './conductor-config.js';

let dir: string;
let home: string;
const j = (v: unknown) => JSON.stringify(v, null, 2);

const projectGke = {
  version: 1,
  channel: 'staging',
  profile: 'gke',
  gcp: { project: 'proj', region: 'us-east1' },
  gke: { cluster: 'cl', location: 'us-east1-b', namespace: 'ns-project' },
};
const hostOk = {
  version: 1,
  config_repo: 'o/r',
  plugin_dir: '/plug',
  github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' },
};

function deps(env: NodeJS.ProcessEnv = {}, extra: Partial<ConductorCliDeps> = {}): ConductorCliDeps {
  // secretExists: undefined = skip the gcloud existence check (never spawn a real gcloud from a test).
  return { ...defaultCliDeps(), secretExists: undefined, env: { HARMONY_HOME: home, ...env }, ...extra };
}
const write = (name: string, v: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof v === 'string' ? v : j(v));
  return p;
};

beforeEach(() => {
  resetConductorWarningDedupe();
  dir = mkdtempSync(join(tmpdir(), 'conductor-cli-'));
  home = join(dir, 'home');
  mkdirSync(home);
});

const legacyDeployment = () => ({
  worker_image: 'harmony-build-env',
  profiles: { gke: { ...BUILTIN_PROFILES.gke, gcloud_project: 'old-proj', maxConcurrentWorkers: 3 } },
  launcher: { plugin_dir: '/old-plug', github_app: { app_id: '9', installation_id: '8', private_key_path: '/old.pem' } },
  env: { HARMONY_PLUGIN_POSTURE: 'ack:staging', HARMONY_API_TOKEN: 'secret-token-value' },
});

describe('migrate', () => {
  it('is a dry run by default: prints both files, dropped and warnings, and writes nothing', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const r = await runMigrate(deps(), { config: legacy });
    expect(r.exitCode).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('DRY RUN');
    expect(out).toContain('"profile": "gke"');
    expect(out).toContain('"plugin_dir": "/old-plug"');
    expect(out).toContain('DROPPED');
    expect(out).toContain('HARMONY_API_TOKEN');
    expect(out).toContain('secret value');
    expect(out).toContain('WARNINGS');
    expect(out).toContain('Old files left untouched');
    expect(out).toContain('rename them away yourself');
    expect(out).toContain('Next steps');
    expect(out).toContain('harmony conductor config doctor');
    expect(out).not.toContain('secret-token-value');
    expect(existsSync(join(home, 'conductor-host.json'))).toBe(false);
    expect((r.data as { written: string[] }).written).toEqual([]);
  });

  it('ambiguous profile is an error that says what to pass', async () => {
    const legacy = write('deployment.json', { ...legacyDeployment(), profiles: { gke: BUILTIN_PROFILES.gke, cloud: BUILTIN_PROFILES.cloud } });
    const r = await runMigrate(deps(), { config: legacy });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('--profile');
  });

  it('--write requires --out-project and has no implicit default', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const r = await runMigrate(deps(), { config: legacy, write: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('--out-project');
    expect(existsSync(join(home, 'conductor-host.json'))).toBe(false);
  });

  it('--write creates both files (host 0600, default host path), never touching the legacy file', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const before = readFileSync(legacy, 'utf8');
    const mtime = statSync(legacy).mtimeMs;
    const outProject = join(dir, 'out', 'conductor.json');
    const r = await runMigrate(deps(), { config: legacy, write: true, outProject });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(outProject, 'utf8')).profile).toBe('gke');
    const hostPath = join(home, 'conductor-host.json');
    expect(JSON.parse(readFileSync(hostPath, 'utf8')).plugin_dir).toBe('/old-plug');
    expect(statSync(hostPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(legacy, 'utf8')).toBe(before);
    expect(statSync(legacy).mtimeMs).toBe(mtime);
    expect(r.lines.join('\n')).toContain('Old files left untouched');
  });

  it('refuses to overwrite an existing output without --force, then overwrites with it', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const outProject = write('project-out.json', 'precious');
    const outHost = join(dir, 'host-out.json');
    const r = await runMigrate(deps(), { config: legacy, write: true, outProject, outHost });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('--force');
    expect(readFileSync(outProject, 'utf8')).toBe('precious');
    expect(existsSync(outHost)).toBe(false); // nothing was written at all
    const forced = await runMigrate(deps(), { config: legacy, write: true, outProject, outHost, force: true });
    expect(forced.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(outProject, 'utf8')).version).toBe(1);
    expect(existsSync(outHost)).toBe(true);
  });

  it('refuses to write over the legacy deployment config even with --force', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const before = readFileSync(legacy, 'utf8');
    const r = await runMigrate(deps(), { config: legacy, write: true, outProject: legacy, force: true });
    expect(r.exitCode).toBe(1);
    expect(readFileSync(legacy, 'utf8')).toBe(before);
  });

  it('an existing host file at the default path is protected too', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    const hostPath = join(home, 'conductor-host.json');
    writeFileSync(hostPath, 'mine');
    chmodSync(hostPath, 0o600);
    const r = await runMigrate(deps(), { config: legacy, write: true, outProject: join(dir, 'p.json') });
    expect(r.exitCode).toBe(1);
    expect(readFileSync(hostPath, 'utf8')).toBe('mine');
    expect(existsSync(join(dir, 'p.json'))).toBe(false);
  });

  // B-1183
  describe('secrets block, existence check and the "deployment.json still needed" warning', () => {
    const mini = () => ({
      ...legacyDeployment(),
      profiles: { gke: { ...BUILTIN_PROFILES.gke, gcloud_project: 'old-proj' }, cloud: { ...BUILTIN_PROFILES.cloud, gcloud_project: 'old-proj' } },
      env: { HARMONY_PLUGIN_POSTURE: 'ack:staging', HARMONY_TARGET: 'prod', CLAUDE_HEADLESS_FLAGS: '--verbose', HARMONY_API_TOKEN: 'secret-token-value', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-value' },
      repos: [{ url: 'https://github.com/o/w.git', path: '/w', meta_repo_role: true }],
    });
    const checker = (missing: string[] = [], state: 'missing' | 'unchecked' = 'missing') => {
      const calls: { name: string; ctx: { project?: string; account?: string } }[] = [];
      const secretExists: ConductorCliDeps['secretExists'] = async (name, ctx) => {
        calls.push({ name, ctx });
        return missing.includes(name) ? state : 'exists';
      };
      return { calls, secretExists };
    };

    it('writes the project file four keys and the host secrets block, and checks each name by metadata', async () => {
      const legacy = write('deployment.json', mini());
      const c = checker();
      const outProject = join(dir, 'out', 'conductor.json');
      const r = await runMigrate(deps({}, { secretExists: c.secretExists }), { config: legacy, write: true, outProject, profile: 'gke' });
      expect(r.exitCode).toBe(0);
      const project = JSON.parse(readFileSync(outProject, 'utf8'));
      expect(project).toMatchObject({ target: 'prod', agent_flags: { 'claude-code': '--verbose' }, repos: [{ path: '/w' }], profiles: { gke: {}, cloud: {} } });
      const host = JSON.parse(readFileSync(join(home, 'conductor-host.json'), 'utf8'));
      expect(host.secrets).toEqual({ api_token: 'HARMONY_API_TOKEN', github_app_private_key: 'harmony-daemon-app-private-key', claude_oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN' });
      expect(c.calls.map((x) => x.name)).toEqual(['HARMONY_API_TOKEN', 'harmony-daemon-app-private-key', 'CLAUDE_CODE_OAUTH_TOKEN']);
      expect(c.calls[0].ctx.project).toBe('old-proj');
      expect(r.lines.join('\n')).not.toContain('WARNING: secret');
      // no value anywhere, in the files or the output
      const everything = [readFileSync(outProject, 'utf8'), JSON.stringify(host), r.lines.join('\n'), JSON.stringify(r.data)].join('\n');
      expect(everything).not.toContain('secret-token-value');
      expect(everything).not.toContain('oauth-secret-value');
    });

    it('a missing secret is a WARNING printing the exact gcloud secrets create command; the files are still written', async () => {
      const legacy = write('deployment.json', mini());
      const c = checker(['HARMONY_API_TOKEN']);
      const r = await runMigrate(deps({}, { secretExists: c.secretExists }), { config: legacy, write: true, outProject: join(dir, 'p.json'), profile: 'gke' });
      expect(r.exitCode).toBe(0);
      expect(r.lines.join('\n')).toContain('gcloud secrets create HARMONY_API_TOKEN --project=old-proj --replication-policy=automatic --data-file=-');
      expect(existsSync(join(dir, 'p.json'))).toBe(true);
    });

    it('an unreachable gcloud is "could not check", never a create command', async () => {
      const legacy = write('deployment.json', mini());
      const c = checker(['HARMONY_API_TOKEN'], 'unchecked');
      const r = await runMigrate(deps({}, { secretExists: c.secretExists }), { config: legacy, profile: 'gke' });
      const out = r.lines.join('\n');
      expect(out).toContain('could not check whether secret HARMONY_API_TOKEN');
      expect(out).not.toContain('gcloud secrets create');
    });

    it('flags override each secret name', async () => {
      const legacy = write('deployment.json', mini());
      const c = checker();
      const r = await runMigrate(deps({}, { secretExists: c.secretExists }), { config: legacy, profile: 'gke', secretApiToken: 'tok', secretGithubAppKey: 'key', secretClaudeOauthToken: 'oauth' });
      expect((r.data as { host_file: { secrets: unknown } }).host_file.secrets).toEqual({ api_token: 'tok', github_app_private_key: 'key', claude_oauth_token: 'oauth' });
      expect(c.calls.map((x) => x.name)).toEqual(['tok', 'key', 'oauth']);
    });

    it('--write with only secrets dropped prints no "still needed" warning', async () => {
      const legacy = write('deployment.json', mini());
      const r = await runMigrate(deps(), { config: legacy, write: true, outProject: join(dir, 'p.json'), profile: 'gke' });
      expect(r.lines.join('\n')).not.toContain('STILL NEEDED');
      expect((r.data as { deployment_json_still_needed: string[] }).deployment_json_still_needed).toEqual([]);
    });

    it('--write with a non-secret item left in dropped warns that deployment.json is still needed', async () => {
      const legacy = write('deployment.json', { ...mini(), env: { ...mini().env, WEB_REF: 'main' }, launcher: { ...legacyDeployment().launcher, supabase_refs: { abc: 'prod' } } });
      const r = await runMigrate(deps(), { config: legacy, write: true, outProject: join(dir, 'p.json'), profile: 'gke' });
      const out = r.lines.join('\n');
      expect(out).toContain('deployment.json is STILL NEEDED');
      expect(out).toContain('env.WEB_REF');
      expect(out).toContain('launcher.supabase_refs');
    });
  });
});

describe('doctor', () => {
  it('lists EVERY issue, not just the first, and exits 1', () => {
    // channel missing, gke needs cluster/location/gcp.project, host needs plugin_dir + github_app
    write('conductor-host.json', { version: 1 });
    const project = write('project.json', { version: 1, profile: 'gke' });
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project }));
    expect(r.exitCode).toBe(1);
    const out = r.lines.join('\n');
    // project file fails schema first (channel is required there): that is one issue; fix it and look again
    expect(out).toContain('ISSUES (');
    expect(out).toMatch(/project\.json › channel: required .* is missing\. Fix:/);
  });

  it('reports all semantic requirement failures together', () => {
    writeFileSync(join(home, 'conductor-host.json'), j({ version: 1 }));
    const project = write('project.json', { version: 1, channel: 'staging', profile: 'gke' });
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project }));
    expect(r.exitCode).toBe(1);
    const issues = (r.data as { issues: { key: string; text: string }[] }).issues;
    expect(issues.map((i) => i.key)).toEqual(
      expect.arrayContaining(['gcp.project', 'gke.cluster', 'gke.location', 'plugin_dir', 'github_app.app_id', 'github_app.installation_id', 'github_app.private_key_path']),
    );
    expect(issues.length).toBeGreaterThanOrEqual(7);
    for (const i of issues) expect(i.text).toMatch(/^.+ › .+: .+\. Fix: .+/);
  });

  it('is green (exit 0) for a complete config and shows sources and the hot/restart summary', () => {
    writeFileSync(join(home, 'conductor-host.json'), j(hostOk));
    const project = write('project.json', projectGke);
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project }));
    expect(r.exitCode).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('SOURCES');
    expect(out).toMatch(/\[found \] project override file.*project\.json/);
    expect(out).toMatch(/\[found \] host file/);
    expect(out).toMatch(/\[absent\] legacy deployment\.json/);
    expect(out).toContain('ISSUES (0)');
    expect(out).toContain('CONFLICTS (0)');
    expect(out).toMatch(/HOT .*concurrency\.max_workers.*\| RESTART NEEDED: channel, profile/);
  });

  it('shows the snapshot with fetched_at and sha', () => {
    writeFileSync(join(home, 'conductor-host.json'), j(hostOk));
    writeFileSync(
      join(home, 'conductor-snapshot.json'),
      j({ version: 1, source: { repo: 'o/r', ref: 'main', path: '.harmony/conductor.json' }, etag: null, sha: 'abc123', fetched_at: '2026-01-01T00:00:00.000Z', content: j(projectGke) }),
    );
    const r = runDoctor(deps());
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toMatch(/\[found \] project snapshot.*o\/r@main, fetched 2026-01-01T00:00:00\.000Z, sha abc123/);
  });

  it('reports conflicts between project and host, and between env and host, naming the winner', () => {
    writeFileSync(join(home, 'conductor-host.json'), j({ ...hostOk, gke: { namespace: 'ns-host' } }));
    const project = write('project.json', projectGke);
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project, HARMONY_CONDUCTOR_GKE_NAMESPACE: 'ns-env' }));
    expect(r.exitCode).toBe(0); // conflicts are warnings
    const c = (r.data as { conflicts: { key: string; winner: string }[] }).conflicts.filter((x) => x.key === 'gke.namespace');
    expect(c).toHaveLength(1);
    expect(c[0].winner).toContain('HARMONY_CONDUCTOR_GKE_NAMESPACE');
    const out = r.lines.join('\n');
    expect(out).toContain('ns-project');
    expect(out).toContain('ns-host');
    expect(out).toContain('ns-env');
  });

  it('flags a legacy env knob that differs from the new file with the special note, and lists legacy in use', () => {
    writeFileSync(join(home, 'conductor-host.json'), j(hostOk));
    const project = write('project.json', projectGke);
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project, HARMONY_GKE_NAMESPACE: 'ns-legacy', HARMONY_GKE_CPU: '2' }));
    expect(r.exitCode).toBe(0);
    const out = r.lines.join('\n');
    expect(out).toContain('environment wins at launch (deprecated) — unset it or remove it from conductor.env');
    expect(out).toMatch(/gke\.namespace: .*ns-project.*ns-legacy.* -> env HARMONY_GKE_NAMESPACE wins/);
    expect(out).toContain('LEGACY IN USE (2)');
    expect(out).toContain('env HARMONY_GKE_CPU is read as a legacy fallback; set gke.cpu in .harmony/conductor.json instead');
    // HARMONY_GKE_CPU has no new-file value: it fills, so it is legacy-in-use but NOT a conflict
    expect((r.data as { conflicts: { key: string }[] }).conflicts.map((x) => x.key)).toEqual(['gke.namespace']);
  });

  it('flags deployment.json values the new files override', () => {
    writeFileSync(join(home, 'conductor-host.json'), j(hostOk));
    const project = write('project.json', { ...projectGke, concurrency: { max_workers: 5 } });
    const legacy = write('deployment.json', legacyDeployment());
    const r = runDoctor(deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project }), { config: legacy });
    expect(r.exitCode).toBe(0);
    const conflicts = (r.data as { conflicts: { key: string; winner: string }[] }).conflicts;
    expect(conflicts.find((c) => c.key === 'concurrency.max_workers')?.winner).toContain('project');
    expect(conflicts.find((c) => c.key === 'plugin_dir')?.winner).toContain('host');
    expect(r.lines.join('\n')).toContain('deployment.json › launcher.plugin_dir is read as a legacy fallback; set plugin_dir in ~/.harmony/conductor-host.json instead');
  });

  it('a legacy-only host with no new files is not an error', () => {
    const legacy = write('deployment.json', legacyDeployment());
    const r = runDoctor(deps(), { config: legacy });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('nothing to validate');
    expect(r.lines.join('\n')).toContain('LEGACY IN USE');
  });

  it('a malformed legacy deployment.json is an issue', () => {
    const legacy = write('deployment.json', '{ nope');
    const r = runDoctor(deps(), { config: legacy });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toContain('deployment.json › (file)');
  });

  it('findConflicts / flattenLayer basics', () => {
    expect([...flattenLayer({ version: 1, a: { b: 1, c: [1] }, d: 'x' }).entries()]).toEqual([['a.b', 1], ['a.c', [1]], ['d', 'x']]);
    expect(
      findConflicts({ project: { a: 1 }, host: { a: 1 }, env: {}, legacyDeployment: {}, legacyEnv: [], labels: { project: 'p', host: 'h' } }),
    ).toEqual([]);
  });
});

describe('sync', () => {
  const GOOD = j(projectGke);
  const reply = (status: number, body = '', headers: Record<string, string> = {}) => new Response(status === 304 ? null : body, { status, headers });
  const fetchOf = (...responses: Response[]) => {
    const queue = [...responses];
    return vi.fn(async () => queue.shift() ?? reply(500)) as unknown as typeof fetch;
  };
  const withHost = (over: Record<string, unknown> = {}) => writeFileSync(join(home, 'conductor-host.json'), j({ version: 1, config_repo: 'o/r', ...over }));

  it('updated: writes the snapshot, exit 0', async () => {
    withHost();
    const r = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(200, GOOD, { etag: 'W/"1"' })) }));
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('updated');
    expect(JSON.parse(readFileSync(join(home, 'conductor-snapshot.json'), 'utf8')).content).toBe(GOOD);
  });

  it('unchanged: exit 0', async () => {
    withHost();
    await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(200, GOOD, { etag: 'W/"1"' })) }));
    const r = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(304)) }));
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('unchanged');
  });

  it('kept-last-good: exit 0 with a loud warning line', async () => {
    withHost();
    await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(200, GOOD)) }));
    const r = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(200, '{ "version": 1, "channel": "x" }')) }));
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('kept-last-good');
    expect(r.lines.join('\n')).toContain('WARNING: the project file was NOT refreshed');
  });

  it('unreachable with a snapshot: exit 0 + warning; without one: exit 1', async () => {
    withHost();
    const none = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(500)) }));
    expect(none.exitCode).toBe(1);
    expect(none.lines[0]).toContain('unreachable');
    await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(200, GOOD)) }));
    const some = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(500)) }));
    expect(some.exitCode).toBe(0);
    expect(some.lines.join('\n')).toContain('WARNING');
  });

  it('404 mentions the App installation', async () => {
    withHost();
    const r = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf(reply(404)) }));
    expect(r.exitCode).toBe(1);
    expect(r.lines.join('\n')).toContain('installation');
  });

  it('missing config_repo prints the standard issue and exits 1', async () => {
    withHost({ config_repo: undefined });
    const r = await runSync(deps({ GH_TOKEN: 't' }, { fetchImpl: fetchOf() }));
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('conductor-host.json › config_repo: missing');
  });

  it('no GitHub credential exits 1', async () => {
    withHost();
    const r = await runSync(deps({}, { fetchImpl: fetchOf() }));
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('no GitHub credential');
  });
});

describe('commander wiring and --json', () => {
  class ExitSentinel extends Error {
    constructor(readonly code: number) {
      super(`process.exit(${code})`);
    }
  }
  let logSpy: MockInstance;
  let errSpy: MockInstance;
  let exitSpy: MockInstance;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitSentinel(code ?? 0);
    }) as never);
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
  const run = (argv: string[], d: ConductorCliDeps) => {
    const program = new Command();
    program.name('harmony').option('--json', 'Output results as JSON', false);
    registerConductorCommands(program, () => d);
    return program.parseAsync(argv, { from: 'user' });
  };
  const printed = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  it('migrate --json prints machine-readable output', async () => {
    const legacy = write('deployment.json', legacyDeployment());
    await run(['--json', 'conductor', 'config', 'migrate', '--config', legacy], deps());
    const out = JSON.parse(printed());
    expect(out.mode).toBe('dry-run');
    expect(out.project_file.profile).toBe('gke');
    expect(Array.isArray(out.dropped)).toBe(true);
  });

  it('doctor --json after the subcommand works and exit code 1 comes through', async () => {
    writeFileSync(join(home, 'conductor-host.json'), j({ version: 1 }));
    const project = write('project.json', { version: 1, channel: 'staging', profile: 'gke' });
    await expect(run(['conductor', 'config', 'doctor', '--json'], deps({ HARMONY_CONDUCTOR_PROJECT_FILE: project }))).rejects.toMatchObject({ code: 1 });
    const out = JSON.parse(printed());
    expect(out.ok).toBe(false);
    expect(out.issues.length).toBeGreaterThan(1);
  });

  it('sync --json reports the outcome', async () => {
    writeFileSync(join(home, 'conductor-host.json'), j({ version: 1, config_repo: 'o/r' }));
    const fetchImpl = (async () => new Response(j(projectGke), { status: 200 })) as unknown as typeof fetch;
    await run(['conductor', 'config', 'sync', '--json'], deps({ GH_TOKEN: 't' }, { fetchImpl }));
    expect(JSON.parse(printed()).outcome).toBe('updated');
  });

  it('human output goes to console.log and errors to console.error', async () => {
    writeFileSync(join(home, 'conductor-host.json'), j({ version: 1 }));
    await expect(run(['conductor', 'config', 'sync'], deps({ GH_TOKEN: 't' }))).rejects.toMatchObject({ code: 1 });
    expect(errSpy.mock.calls.join('\n')).toContain('config_repo');
  });
});
