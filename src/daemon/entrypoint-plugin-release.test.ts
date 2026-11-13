// B-1478 step 5: container/entrypoint.sh takes the plugin from the released download when the project opts in,
// and falls back to the clone on any failure.
//
// Real pieces: bash, curl (over real HTTPS against a server in this process, trusted through CURL_CA_BUNDLE),
// jq, sha256sum, unzip, and a release built by scripts/build-release.mjs from a fixture plugin repository.
// Stubbed: git (records argv, plants a recorder provision.sh in each "clone"), node. The release's own
// container/provision.sh is a recorder too, so the trace shows which provision.sh was exec'd and with what env.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, makeRepo } from '../test/release-fixture.js';
import {
  b64, baseEnv, commands, installScript, makeHarness, RECORDER, runScriptAsync, type Harness, type ScriptResult,
} from '../test/worker-script-harness.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const ENTRY = join(REPO, 'container/entrypoint.sh');
const TOKEN = 'hmy_fixture_token_b1478';
const PREFIX = '/functions/v1/plugin-download';

function has(cmd: string): boolean {
  try {
    execFileSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CAPABLE = ['bash', 'jq', 'curl', 'unzip', 'sha256sum', 'openssl', 'git', 'base64'].every(has);

interface Fixture {
  dir: string;
  certFile: string;
  serve: string; // <serve>/<channel>/... is what the server answers
  server: Server;
  base: string;
  requests: { path: string; authorized: boolean }[];
  releases: Record<string, { version: string; out: string }>;
}

let fx: Fixture;

/** Build a release from a fixture plugin repo into `out`. */
function buildRelease(version: string, channel: string, opts: { marker?: boolean; provision?: boolean } = {}): string {
  const repo = makeRepo();
  mkdirSync(join(repo.dir, 'container'), { recursive: true });
  if (opts.marker !== false) writeFileSync(join(repo.dir, 'container/release-runtime'), '# marker\n');
  if (opts.provision !== false) {
    writeFileSync(join(repo.dir, 'container/provision.sh'), RECORDER);
    chmodSync(join(repo.dir, 'container/provision.sh'), 0o755);
  }
  const sha = repo.commit(version);
  const out = join(repo.root, 'out');
  const r = build(repo.dir, { commit: sha, channel, out, baseUrl: 'https://downloads.example.test/plugin' });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

/** Publish a built release under <serve>/<channel>/ exactly as the bucket lays it out (minus `channels/`). */
function publish(serve: string, channel: string, out: string, version: string, mutate?: (release: Record<string, unknown>) => void): void {
  const dest = join(serve, channel);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'releases', version), { recursive: true });
  cpSync(join(out, `harmony-plugin-${version}.zip`), join(dest, 'releases', version, `harmony-plugin-${version}.zip`));
  const release = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')) as Record<string, unknown>;
  mutate?.(release);
  writeFileSync(join(dest, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
}

beforeAll(async () => {
  if (!CAPABLE) return;
  const dir = mkdtempSync(join(tmpdir(), 'b1478-release-'));
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  const serve = join(dir, 'serve');
  const requests: Fixture['requests'] = [];
  const server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    const url = req.url ?? '';
    const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
    requests.push({ path: url, authorized });
    if (!authorized) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (!url.startsWith(`${PREFIX}/`) || url.includes('..')) {
      res.writeHead(404).end();
      return;
    }
    const file = join(serve, url.slice(PREFIX.length + 1));
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  fx = {
    dir, certFile, serve, server, requests,
    base: `https://127.0.0.1:${port}${PREFIX}`,
    releases: {
      prod: { version: '1.4.2', out: buildRelease('1.4.2', 'prod') },
      staging: { version: '1.4.3', out: buildRelease('1.4.3', 'staging') },
    },
  };
}, 60_000);

afterAll(() => {
  if (!fx) return;
  fx.server.close();
  rmSync(fx.dir, { recursive: true, force: true });
});

function servePristine(): void {
  for (const ch of ['prod', 'staging'] as const) publish(fx.serve, ch, fx.releases[ch].out, fx.releases[ch].version);
}

interface Run extends ScriptResult {
  h: Harness;
  home: string;
}

async function runEntry(env: Record<string, string | undefined>, opts: { repos?: (h: Harness) => unknown[] } = {}): Promise<Run> {
  const h = makeHarness();
  const script = installScript(h, ENTRY, 'entrypoint.sh');
  const extra: Record<string, string | undefined> = { GIT_TOKEN: 'ghs_fixture', CURL_CA_BUNDLE: fx.certFile, ...env };
  if (opts.repos) extra.HARMONY_REPOS_JSON = b64(JSON.stringify(opts.repos(h)));
  const r = await runScriptAsync(h, script, ['headless', '/harmony-plugin:harmony-conduct B-1 --one-shot'], baseEnv(h, extra));
  return { ...r, h, home: h.home };
}

const RELEASE_ENV = (over: Record<string, string | undefined> = {}) => ({
  HARMONY_PLUGIN_SOURCE: 'release',
  HARMONY_PLUGIN_RELEASE_URL: fx.base,
  HARMONY_PLUGIN_POSTURE: 'prod',
  HARMONY_API_TOKEN: TOKEN,
  ...over,
});

/** The ENV lines of the record for the script that was exec'd as provision.sh. */
function execRecord(trace: string[]): { cmd: string; env: string[] } {
  const at = trace.findIndex((l) => /^CMD SCRIPT:.*\/container\/provision\.sh/.test(l));
  expect(at, trace.join('\n')).toBeGreaterThanOrEqual(0);
  const env: string[] = [];
  for (let i = at + 1; i < trace.length && trace[i].startsWith('  ENV '); i++) env.push(trace[i].slice(6));
  return { cmd: trace[at].slice(4).split('\x1f').join(' '), env };
}

const fallbackLines = (stderr: string) => stderr.split('\n').filter((l) => l.startsWith('PLUGIN-SOURCE-FALLBACK:'));

function cleanup(r: Run): void {
  r.h.cleanup();
}

describe.skipIf(!CAPABLE)('B-1478 entrypoint.sh: the plugin from the released download', () => {
  it('prod: fetches, verifies and runs the release provision.sh; the plugin is not cloned', async () => {
    servePristine();
    fx.requests.length = 0;
    const r = await runEntry(RELEASE_ENV());
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(fallbackLines(r.stderr)).toEqual([]);
      const cmds = commands(r.trace);
      // three-slot fallback shape: workspace and web are still cloned, the plugin is not
      expect(cmds.filter((c) => c.startsWith('git clone')).map((c) => c.split(' ').pop())).toEqual([
        '<ROOT>/workspace/workspace', '<ROOT>/workspace/workspace/web',
      ]);
      const rec = execRecord(r.trace);
      expect(rec.cmd).toBe('SCRIPT:<ROOT>/home/harmony-plugin/container/provision.sh headless /harmony-plugin:harmony-conduct B-1 --one-shot');
      expect(rec.env).toContain('HARMONY_PLUGIN_DIR=<ROOT>/home/harmony-plugin');
      expect(rec.env).toContain('HARMONY_PLUGIN_SOURCE_RESULT=release');
      const installed = JSON.parse(readFileSync(join(r.home, 'harmony-plugin/.claude-plugin/plugin.json'), 'utf8'));
      expect(installed.version).toBe('1.4.2');
      // read-only, and no work directory or header file left behind
      expect(statSync(join(r.home, 'harmony-plugin/container/provision.sh')).mode & 0o222).toBe(0);
      expect(statSync(join(r.home, 'harmony-plugin')).mode & 0o222).toBe(0);
      expect(execFileSync('ls', ['-A', r.home], { encoding: 'utf8' }).split('\n').filter((n) => n.startsWith('.harmony-plugin-release'))).toEqual([]);
      // both requests carried the bearer; the zip came from <base>/<channel>/<rest of the object path>
      expect(fx.requests).toEqual([
        { path: `${PREFIX}/prod/release.json`, authorized: true },
        { path: `${PREFIX}/prod/releases/1.4.2/harmony-plugin-1.4.2.zip`, authorized: true },
      ]);
      expect(r.stderr).toContain('B-1478 plugin from the prod release 1.4.2');
      expect(r.stderr + r.stdout).not.toContain(TOKEN);
    } finally {
      cleanup(r);
    }
  });

  it('staging (ack:staging): the staging release, its version shown', async () => {
    servePristine();
    const r = await runEntry(RELEASE_ENV({ HARMONY_PLUGIN_POSTURE: 'ack:staging' }));
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(fallbackLines(r.stderr)).toEqual([]);
      expect(r.stderr).toContain('B-1478 plugin from the staging release 1.4.3');
      expect(JSON.parse(readFileSync(join(r.home, 'harmony-plugin/.claude-plugin/plugin.json'), 'utf8')).version).toBe('1.4.3');
      expect(execRecord(r.trace).env).toContain('HARMONY_PLUGIN_SOURCE_RESULT=release');
    } finally {
      cleanup(r);
    }
  });

  it('repos[]: the meta repo still clones first and the other repos clone; the is_plugin entry does not', async () => {
    servePristine();
    const r = await runEntry(RELEASE_ENV(), {
      repos: (h) => [
        { url: 'https://example.invalid/acme/meta.git', path: h.workspace, meta_repo_role: true },
        { url: 'https://example.invalid/acme/plugin.git', path: h.pluginDir, is_plugin: true },
        { url: 'https://example.invalid/acme/app.git', path: join(h.workspace, 'app') },
      ],
    });
    try {
      expect(r.status, r.stderr).toBe(0);
      const clones = commands(r.trace).filter((c) => c.startsWith('git clone'));
      expect(clones).toEqual([
        'git clone --branch main https://example.invalid/acme/meta.git <ROOT>/workspace/workspace',
        'git clone --branch main https://example.invalid/acme/app.git <ROOT>/workspace/workspace/app',
      ]);
      expect(execRecord(r.trace).cmd).toMatch(/^SCRIPT:<ROOT>\/home\/harmony-plugin\/container\/provision\.sh /);
    } finally {
      cleanup(r);
    }
  });

  it('a re-leg on a persistent HOME replaces the earlier read-only release', async () => {
    servePristine();
    const h = makeHarness();
    try {
      const script = installScript(h, ENTRY, 'entrypoint.sh');
      const env = baseEnv(h, { GIT_TOKEN: 'g', CURL_CA_BUNDLE: fx.certFile, ...RELEASE_ENV() });
      expect((await runScriptAsync(h, script, ['headless', 'p'], env)).status).toBe(0);
      const second = await runScriptAsync(h, script, ['headless', 'p'], baseEnv(h, { GIT_TOKEN: 'g', CURL_CA_BUNDLE: fx.certFile, ...RELEASE_ENV({ HARMONY_PLUGIN_POSTURE: 'ack:staging' }) }));
      expect(second.status, second.stderr).toBe(0);
      expect(fallbackLines(second.stderr)).toEqual([]);
      expect(JSON.parse(readFileSync(join(h.home, 'harmony-plugin/.claude-plugin/plugin.json'), 'utf8')).version).toBe('1.4.3');
    } finally {
      h.cleanup();
    }
  });
});

/** The trace with the setting's own env lines removed: what must equal a no-setting run's trace. */
const withoutSetting = (trace: string[]) =>
  trace.filter((l) => !/^ {2}ENV (HARMONY_PLUGIN_SOURCE|HARMONY_PLUGIN_RELEASE_URL|HARMONY_PLUGIN_SOURCE_RESULT|CURL_CA_BUNDLE)=/.test(l));

describe.skipIf(!CAPABLE)('B-1478 entrypoint.sh: every failure falls back to the clone, exactly as today', () => {
  type Case = { name: string; env: Record<string, string | undefined>; serve?: () => void; reason: RegExp; ref?: string };
  const cases: Case[] = [
    { name: 'base_url missing', env: { HARMONY_PLUGIN_RELEASE_URL: undefined }, reason: /^plugin_release\.base_url \(HARMONY_PLUGIN_RELEASE_URL\) is not set$/ },
    { name: 'base_url not https', env: { HARMONY_PLUGIN_RELEASE_URL: 'http://127.0.0.1:1/x' }, reason: /^plugin_release\.base_url is not a plain https:\/\/ URL$/ },
    { name: 'a posture with no published channel', env: { HARMONY_PLUGIN_POSTURE: 'ack:main' }, reason: /^posture 'ack:main' has no published release channel/, ref: 'main' },
    { name: 'HARMONY_API_TOKEN missing', env: { HARMONY_API_TOKEN: undefined }, reason: /^HARMONY_API_TOKEN is not set$/ },
    { name: 'an unknown plugin_source', env: { HARMONY_PLUGIN_SOURCE: 'zip' }, reason: /^plugin_source 'zip' is neither clone nor release$/ },
    { name: 'HTTP 404 (no release on the channel)', env: {}, serve: () => rmSync(join(fx.serve, 'prod'), { recursive: true, force: true }), reason: /^release\.json: HTTP 404$/ },
    { name: 'a refused token (401)', env: { HARMONY_API_TOKEN: 'hmy_wrong_token' }, reason: /^release\.json: token refused \(HTTP 401\)$/ },
    {
      name: 'checksum mismatch', env: {},
      serve: () => publish(fx.serve, 'prod', fx.releases.prod.out, '1.4.2', (rel) => { (rel.zip as Record<string, unknown>).sha256 = 'a'.repeat(64); }),
      reason: /^checksum mismatch \(zip sha256 [0-9a-f]{64}, release\.json says a{64}\)$/,
    },
    {
      name: 'version mismatch', env: {},
      serve: () => publish(fx.serve, 'prod', fx.releases.prod.out, '1.4.2', (rel) => { rel.version = '1.4.9'; }),
      reason: /^version mismatch \(the zip's plugin\.json says '1\.4\.2', release\.json says '1\.4\.9'\)$/,
    },
    {
      name: 'marker missing', env: {},
      serve: () => publish(fx.serve, 'prod', buildRelease('1.4.4', 'prod', { marker: false }), '1.4.4'),
      reason: /^release 1\.4\.4 has no container\/release-runtime marker/,
    },
    {
      name: 'extract failure', env: {},
      serve: () => {
        publish(fx.serve, 'prod', fx.releases.prod.out, '1.4.2');
        const zip = join(fx.serve, 'prod/releases/1.4.2/harmony-plugin-1.4.2.zip');
        writeFileSync(zip, 'this is not a zip archive');
        const sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
        const relFile = join(fx.serve, 'prod/release.json');
        const rel = JSON.parse(readFileSync(relFile, 'utf8'));
        rel.zip.sha256 = sha;
        writeFileSync(relFile, JSON.stringify(rel));
      },
      reason: /^extract failed \(unzip exit \d+\)$/,
    },
    {
      name: 'release.json zip.object outside the channel', env: {},
      serve: () => publish(fx.serve, 'prod', fx.releases.prod.out, '1.4.2', (rel) => { (rel.zip as Record<string, unknown>).object = 'channels/staging/releases/1.4.3/harmony-plugin-1.4.3.zip'; }),
      reason: /^release\.json zip\.object is not under channels\/prod\/$/,
    },
    {
      name: 'an unreachable endpoint', env: { HARMONY_PLUGIN_RELEASE_URL: 'https://127.0.0.1:1/functions/v1/plugin-download' },
      reason: /^release\.json request failed \(curl exit 7/,
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      servePristine();
      c.serve?.();
      const ref = c.ref ?? (c.env.HARMONY_PLUGIN_POSTURE ?? 'prod').replace(/^ack:/, '');
      const r = await runEntry(RELEASE_ENV(c.env));
      // the same run with the setting absent: the clone, as before B-1478
      const plain = await runEntry({ ...RELEASE_ENV(c.env), HARMONY_PLUGIN_SOURCE: undefined, HARMONY_PLUGIN_RELEASE_URL: undefined });
      try {
        expect(r.status, r.stderr).toBe(0);
        const lines = fallbackLines(r.stderr);
        expect(lines, r.stderr).toHaveLength(1);
        const m = /^PLUGIN-SOURCE-FALLBACK: (.*); cloning (\S+)$/.exec(lines[0]);
        expect(m, lines[0]).not.toBeNull();
        expect(m![1]).toMatch(c.reason);
        expect(m![2]).toBe(ref);
        const rec = execRecord(r.trace);
        expect(rec.cmd).toMatch(/^SCRIPT:<ROOT>\/workspace\/workspace\/plugin\/container\/provision\.sh /);
        expect(rec.env).toContain(`HARMONY_PLUGIN_SOURCE_RESULT=clone-fallback(${m![1]})`);
        expect(rec.env.some((e) => e.startsWith('HARMONY_PLUGIN_DIR='))).toBe(false);
        expect(withoutSetting(r.trace)).toEqual(withoutSetting(plain.trace));
        expect(existsSync(join(r.home, 'harmony-plugin'))).toBe(false);
        expect(execFileSync('ls', ['-A', r.home], { encoding: 'utf8' })).not.toContain('.harmony-plugin-release');
        expect(r.stderr + r.stdout).not.toContain(TOKEN);
      } finally {
        cleanup(r);
        cleanup(plain);
      }
    });
  }

  it('explicit clone: no fetch, no fallback line, the result says clone', async () => {
    fx.requests.length = 0;
    const r = await runEntry(RELEASE_ENV({ HARMONY_PLUGIN_SOURCE: 'clone' }));
    try {
      expect(r.status).toBe(0);
      expect(fallbackLines(r.stderr)).toEqual([]);
      expect(fx.requests).toEqual([]);
      expect(execRecord(r.trace).env).toContain('HARMONY_PLUGIN_SOURCE_RESULT=clone');
    } finally {
      cleanup(r);
    }
  });

  it('a stray HARMONY_PLUGIN_DIR in the launch env never reaches a clone leg', async () => {
    const r = await runEntry({ HARMONY_PLUGIN_DIR: '/somewhere/else', HARMONY_PLUGIN_POSTURE: 'prod' });
    try {
      expect(r.status).toBe(0);
      expect(execRecord(r.trace).env.some((e) => e.startsWith('HARMONY_PLUGIN_DIR='))).toBe(false);
    } finally {
      cleanup(r);
    }
  });
});
