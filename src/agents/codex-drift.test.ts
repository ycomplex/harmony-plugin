// B-1076 drift guard for the Codex adapter, in two halves.
//
// A. SCRIPTS (always runs): the Dockerfile / cloudbuild / smoke / provision / launcher text still agree with
//    the adapter — the unpinned `CODEX_VERSION` policy, base and `agent` staying Codex-free, the mount
//    targets pre-created worker-owned, the launch going THROUGH the adapter, the env allowlist. Each check
//    is a pure function of the file text with a positive control proving it catches a mutation.
//
// B. THE INSTALLED CLI (runs only when a `codex` binary is on PATH, or HARMONY_CODEX_BIN names one; skips
//    cleanly in unit CI where none is installed). The same assertions run in the worker-image build path:
//    container/smoke.sh executes `codex --version` and checks the flags this adapter emits against
//    `codex exec --help` inside the freshly built image. Part B is the deeper check: it drives the REAL
//    CLI at a local MOCK model provider (no network, no login) with the adapter's own argv and rendered
//    config, and asserts what the adapter assumes — flags accepted, `--strict-config` clean, the
//    `thread.started` / `turn.completed` events, the rollout path, AGENTS.md and `$skill` delivery, the
//    required MCP server's env allowlist, and that a required server that fails to start stops the leg
//    BEFORE any model request.

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CODEX_ADD_DIR_FLAG,
  CODEX_BYPASS_FLAG,
  CODEX_HOOK_TRUST_FLAG,
  CODEX_CD_FLAG,
  CODEX_JSON_FLAG,
  CODEX_AUTH_FILE_ENV,
  CODEX_PROVIDER_ENV,
  CODEX_MODEL_FLAG,
  CODEX_MCP_ENV_VARS,
  codexAdapter as A,
  parseCodexThreadId,
  renderCodexConfig,
} from './codex.js';
import { claudeCodeAdapter } from './claude-code.js';
import { HARMONY_MCP_CONNECTION } from './contract.js';
import { provisionCodex } from './codex-provision.js';

const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(root(rel), 'utf8');

const DOCKERFILE = read('container/Dockerfile');
const CLOUDBUILD = read('container/cloudbuild.yaml');
const SMOKE = read('container/smoke.sh');
const PROVISION = read('container/provision.sh');
const CLOUD_LAUNCH = read('container/cloud-worker-launch.sh');
const DOCKER_HOST_LAUNCH = read('container/docker-host-worker-launch.sh');

const codeLines = (script: string) => script.split('\n').filter((l) => !/^\s*#/.test(l));

// ───────────────────────── A. scripts ─────────────────────────

/** The Dockerfile text of one stage (from its FROM to the next FROM / EOF). */
function stage(dockerfile: string, name: string): string {
  const re = new RegExp(`^FROM .* AS ${name}\\s*$`, 'm');
  const m = re.exec(dockerfile);
  if (!m) return '';
  const rest = dockerfile.slice(m.index + m[0].length);
  const next = /^FROM /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function dockerfileProblems(d: string): string[] {
  const p: string[] = [];
  const codex = stage(d, 'agent-codex');
  if (!/^FROM agent AS agent-codex\s*$/m.test(d)) p.push('no `FROM agent AS agent-codex` stage (the superset must build on `agent`)');
  if (!/^ARG CODEX_VERSION=latest\s*$/m.test(codex)) p.push('CODEX_VERSION must default to `latest` (B-1074 policy: resolved at build time, never pinned in the file)');
  if (/CODEX_VERSION=\d/.test(d)) p.push('CODEX_VERSION is pinned to an exact version in the Dockerfile');
  if (!codex.includes('npm install -g @openai/codex@${CODEX_VERSION}')) p.push('the stage does not install @openai/codex@${CODEX_VERSION}');
  if (!codex.includes('/etc/harmony-codex-version')) p.push('the resolved version is not written to /etc/harmony-codex-version');
  if (!/LABEL harmony\.codex_version="\$\{CODEX_VERSION\}"/.test(codex)) p.push('no harmony.codex_version label');
  for (const dir of ['/home/worker/.codex/sessions', '/home/worker/.codex-auth-src']) {
    if (!codex.includes(dir)) p.push(`${dir} is not pre-created (B-724: Docker would create the mount parent root-owned)`);
  }
  if (!/chown -R worker:worker \/home\/worker\/\.codex /.test(codex)) p.push('~/.codex is not chowned to worker');
  // base-layer rule: no agent CLI below agent-codex
  for (const name of ['base', 'agent']) {
    if (/codex/i.test(stage(d, name))) p.push(`the ${name} stage mentions codex — it must stay free of the Codex CLI`);
  }
  if (!/^FROM base AS agent\s*$/m.test(d)) p.push('`agent` no longer builds FROM base');
  // B-929 toolchain lines untouched
  if (!stage(d, 'base').includes('ARG FNM_RELEASE=latest')) p.push('B-929 fnm lines are gone from base');
  return p;
}

function cloudbuildProblems(c: string): string[] {
  const p: string[] = [];
  if (!c.includes('npm view @openai/codex version > /workspace/codex_version.txt')) p.push('no resolve-codex-version step');
  if (!c.includes('--build-arg CODEX_VERSION="$(cat /workspace/codex_version.txt)"')) p.push('CODEX_VERSION is not passed as a build-arg');
  if (!c.includes('--target agent-codex')) p.push('the image is not built from the agent-codex target');
  if (!/container\/smoke\.sh/.test(c)) p.push('the smoke gate is gone');
  return p;
}

function smokeProblems(s: string): string[] {
  const p: string[] = [];
  if (!s.includes('codex --version')) p.push('smoke.sh never runs `codex --version`');
  if (!s.includes('/etc/harmony-codex-version')) p.push('smoke.sh does not compare against the baked version');
  // the flags this adapter emits must be checked against the image's own `codex exec --help`
  if (!s.includes('codex exec --help')) p.push("smoke.sh does not check the adapter's flags against `codex exec --help`");
  for (const flag of [CODEX_JSON_FLAG, CODEX_CD_FLAG, CODEX_ADD_DIR_FLAG, CODEX_BYPASS_FLAG, CODEX_HOOK_TRUST_FLAG]) {
    if (!s.includes(flag)) p.push(`smoke.sh does not check ${flag}`);
  }
  return p;
}

function provisionProblems(prov: string): string[] {
  const p: string[] = [];
  const code = codeLines(prov).join('\n');
  if (!code.includes('agent render --plugin-dir "$PLUGIN_DIR" --workspace "$WORKDIR"')) p.push('provision.sh does not render the Codex config through `harmony agent render`');
  if (!code.includes('CLAUDE_HEADLESS_FLAGS="${CODEX_HEADLESS_FLAGS:-}"')) p.push("a non-Claude leg may inherit Claude's flags (CODEX_HEADLESS_FLAGS swap missing)");
  if (!code.includes('CURRENT_MODEL="${HARMONY_CODEX_MODEL:-}"')) p.push('a non-Claude leg may be handed a Claude model alias');
  if (!code.includes('SESSION_RESUME_ENABLED="false"')) p.push('a Claude session id could be offered to another runtime');
  if (!code.includes('/etc/harmony-codex-version')) p.push('provision.sh does not echo the Codex image version');
  // the launch itself is the adapter's: no hand-assembled `codex …` command
  if (/^\s*(?:exec\s+|_b772_run\s+)?codex\s/m.test(code)) p.push("a hand-assembled 'codex …' invocation is in provision.sh");
  // the credential file is never touched by provision.sh itself
  if (/auth\.json|HARMONY_CODEX_AUTH_FILE/.test(code)) p.push('provision.sh names the credential file — only the adapter may touch it');
  return p;
}

function launcherMounts(launcher: string): string[] {
  const code = codeLines(launcher);
  const line = code.find((l) => l.includes('CODEX_MOUNTS="-v')) ?? '';
  const literal = [...line.matchAll(/:(\/home\/worker\/[^\s:\\"]+)/g)].map((m) => m[1]);
  // the login-cache target rides a variable; resolve its assignment
  const assigned = code.map((l) => /^CODEX_AUTH_CONTAINER_PATH="(\/home\/worker\/[^"]+)"/.exec(l)).find((m) => m);
  return assigned ? [...literal, assigned[1]] : literal;
}

function launcherProblems(launcher: string, dockerfile: string): string[] {
  const p: string[] = [];
  const mounts = launcherMounts(launcher);
  if (mounts.length < 2) p.push(`expected the sessions and login-cache mounts, found ${JSON.stringify(mounts)}`);
  const codex = stage(dockerfile, 'agent-codex');
  for (const m of mounts) {
    const parent = m.slice(0, m.lastIndexOf('/'));
    const preCreated = codex.includes(m) || codex.includes(parent);
    if (!preCreated) p.push(`mount target ${m} (parent ${parent}) is not pre-created worker-owned in the agent-codex stage`);
  }
  if (!mounts.includes(A.session.root.replace('$HOME', '/home/worker'))) p.push('the sessions mount is not the adapter session root');
  if (!launcher.includes(':ro')) p.push('the login-cache file is not mounted read-only');
  return p;
}

function envFileBody(cloudLaunch: string): string {
  const m = /^write_exec_env_file\(\) \{\n([\s\S]*?)\n\}\n/m.exec(cloudLaunch);
  return m ? m[1].split('\n').filter((l) => !/^\s*#/.test(l)).join('\n') : '';
}

function envProblems(cloudLaunch: string): string[] {
  const body = envFileBody(cloudLaunch);
  if (!body) return ['write_exec_env_file() not found'];
  // B-1076: the ONE launcher-forwarded name outside the shared per-leg allowlist is the login-cache
  // PATH variable (the adapter's credential env), forwarded only for a Codex run — conformance keeps a
  // credential env out of the allowlist, so it is subtracted here and its CODEX_RUN gate is pinned.
  // B-1178: the gate also requires the openai provider (a provider leg runs on its key, never the cache),
  // and the provider NAME (HARMONY_CODEX_PROVIDER) is the second Codex-only name, pinned the same way.
  const credVar = CODEX_AUTH_FILE_ENV;
  const providerVar = CODEX_PROVIDER_ENV;
  const p: string[] = [];
  if (!new RegExp(`if \\[ "\\$\\{CODEX_RUN:-0\\}" = "1" \\] && \\[ "\\$\\{CODEX_PROVIDER:-openai\\}" = "openai" \\]; then\\n\\s*printf '${credVar}:`).test(body)) p.push(`${credVar} is not forwarded behind the CODEX_RUN + openai-provider gate`);
  if (!new RegExp(`if \\[ "\\$\\{CODEX_RUN:-0\\}" = "1" \\] && \\[ "\\$\\{CODEX_PROVIDER:-openai\\}" != "openai" \\]; then\\n\\s*printf '${providerVar}:`).test(body)) p.push(`${providerVar} is not forwarded behind the CODEX_RUN + provider gate`);
  const shell = [...new Set([...body.matchAll(/printf '([A-Z_]+):/g)].map((m) => m[1]))].filter((n) => n !== credVar && n !== providerVar).sort();
  const adapter = [...A.env.allowlist].sort();
  if (JSON.stringify(shell) !== JSON.stringify(adapter)) p.push(`env allowlist: shell [${shell}] ≠ adapter [${adapter}]`);
  return p;
}

describe('scripts ⇄ Codex adapter drift', () => {
  it('Dockerfile: agent-codex is FROM agent, unpinned, version-reporting, ~/.codex pre-created; base and agent stay Codex-free', () => {
    expect(dockerfileProblems(DOCKERFILE)).toEqual([]);
  });
  it('cloudbuild: resolves @openai/codex at build time, passes CODEX_VERSION, builds the agent-codex target, keeps the smoke gate', () => {
    expect(cloudbuildProblems(CLOUDBUILD)).toEqual([]);
  });
  it('smoke.sh: runs codex --version and checks the adapter\'s flags against `codex exec --help`', () => {
    expect(smokeProblems(SMOKE)).toEqual([]);
  });
  it('provision.sh: renders through the adapter, never names the credential file, never hands a Claude flag/session/model to another runtime', () => {
    expect(provisionProblems(PROVISION)).toEqual([]);
  });
  it('docker-host launcher: mount targets are pre-created in the agent-codex stage, the cache is read-only, sessions = the adapter session root', () => {
    expect(launcherProblems(DOCKER_HOST_LAUNCH, DOCKERFILE)).toEqual([]);
  });
  it('env: the Codex per-leg allowlist equals cloud-worker-launch.sh write_exec_env_file() — and the Claude one (the scripts serve both)', () => {
    expect(envProblems(CLOUD_LAUNCH)).toEqual([]);
    expect([...A.env.allowlist].sort()).toEqual([...claudeCodeAdapter.env.allowlist].sort());
  });
  it('mcp: every forwarded name is a HARMONY_ input the plugin actually reads', () => {
    const walk = (dir: string): string[] =>
      readdirSync(root(dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [`${dir}/${e.name}`] : [],
      );
    const source = walk('src')
      .map((f) => read(f))
      .join('\n');
    const unknown = CODEX_MCP_ENV_VARS.filter((v) => !source.includes(v));
    expect(unknown).toEqual([]);
  });
});

describe('Codex drift checks catch a mutation (positive controls)', () => {
  it.each<[string, () => string[]]>([
    ['Dockerfile: CODEX_VERSION pinned', () => dockerfileProblems(DOCKERFILE.replace('ARG CODEX_VERSION=latest', 'ARG CODEX_VERSION=0.163.0'))],
    ['Dockerfile: codex leaks into agent', () => dockerfileProblems(DOCKERFILE.replace('ARG CLAUDE_CODE_VERSION=latest', 'ARG CLAUDE_CODE_VERSION=latest\nRUN npm i -g @openai/codex'))],
    ['Dockerfile: ~/.codex not pre-created', () => dockerfileProblems(DOCKERFILE.split('/home/worker/.codex/sessions').join('/home/worker/.codex-x'))],
    ['Dockerfile: stage no longer FROM agent', () => dockerfileProblems(DOCKERFILE.replace('FROM agent AS agent-codex', 'FROM base AS agent-codex'))],
    ['cloudbuild: build-arg dropped', () => cloudbuildProblems(CLOUDBUILD.replace('--build-arg CODEX_VERSION=', '--build-arg OTHER='))],
    ['cloudbuild: target dropped', () => cloudbuildProblems(CLOUDBUILD.replace('--target agent-codex', ''))],
    ['smoke: codex --version dropped', () => smokeProblems(SMOKE.split('codex --version').join('true'))],
    ['provision: hand-built codex launch', () => provisionProblems(PROVISION + '\n    _b772_run codex exec --json "$PROMPT"\n')],
    ['provision: touches the credential file', () => provisionProblems(PROVISION + '\n    cp "$HARMONY_CODEX_AUTH_FILE" "$HOME/.codex/auth.json"\n')],
    ['provision: Claude flags reach Codex', () => provisionProblems(PROVISION.replace('CLAUDE_HEADLESS_FLAGS="${CODEX_HEADLESS_FLAGS:-}"', ''))],
    ['launcher: login cache mounted read-write', () => launcherProblems(DOCKER_HOST_LAUNCH.split(':ro').join(''), DOCKERFILE)],
    ['launcher: a new unprepared mount', () => launcherProblems(DOCKER_HOST_LAUNCH.replace('/home/worker/.codex/sessions', '/home/worker/.codex-new/sessions'), DOCKERFILE)],
    ['env: a newly forwarded var', () => envProblems(CLOUD_LAUNCH.replace(`printf 'TICKET: "%s"\\n' "$TICKET"`, `printf 'TICKET: "%s"\\n' "$TICKET"\n      printf 'NEW_VAR: "%s"\\n' "$X"`))],
  ])('%s', (_label, problems) => {
    expect(problems()).not.toEqual([]);
  });
});

// ───────────────────────── B. the installed CLI ─────────────────────────

const CODEX_BIN = process.env.HARMONY_CODEX_BIN || 'codex';
function codexVersion(): string | null {
  const r = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return r.status === 0 ? r.stdout.trim() : null;
}
const VERSION = codexVersion();
const HAVE_CODEX = VERSION !== null;

interface MockProvider {
  server: Server;
  port: number;
  requests: string[];
}
async function startMock(): Promise<MockProvider> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.includes('/responses')) {
        res.writeHead(404).end('{}');
        return;
      }
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('response.created', { response: { id: 'resp_mock' } });
      ev('response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'MOCK-DONE' }] } });
      ev('response.completed', {
        response: { id: 'resp_mock', usage: { input_tokens: 111, input_tokens_details: { cached_tokens: 22 }, output_tokens: 33, output_tokens_details: { reasoning_tokens: 4 }, total_tokens: 144 } },
      });
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  return { server, port: typeof addr === 'object' && addr ? addr.port : 0, requests };
}

function runCodex(args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((ok) => {
    const child = spawn(CODEX_BIN, args, { cwd: opts.cwd, env: { PATH: process.env.PATH ?? '', ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const t = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 90_000);
    child.on('close', (code) => {
      clearTimeout(t);
      ok({ code, stdout, stderr });
    });
  });
}

/** A stdio MCP server standing in for dist/index.js: records which env it was given, lists one tool. */
function writeStubMcp(path: string, envDump: string): void {
  const sdk = root('node_modules/@modelcontextprotocol/sdk/dist/esm');
  writeFileSync(
    path,
    [
      `import { Server } from '${sdk}/server/index.js';`,
      `import { StdioServerTransport } from '${sdk}/server/stdio.js';`,
      `import { ListToolsRequestSchema, CallToolRequestSchema } from '${sdk}/types.js';`,
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(process.env));`,
      `const s = new Server({ name: 'harmony', version: '0' }, { capabilities: { tools: {} } });`,
      `s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'get_task', description: 'stub', inputSchema: { type: 'object', properties: {} } }] }));`,
      `s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'x' }] }));`,
      `await s.connect(new StdioServerTransport());`,
    ].join('\n'),
  );
}

describe.skipIf(!HAVE_CODEX)(`the installed Codex CLI (${VERSION ?? 'not installed — skipped'})`, () => {
  const help = (args: string[]) => spawnSync(CODEX_BIN, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).stdout;

  it('--version is `codex-cli <semver>` (the shape the image bakes into /etc/harmony-codex-version)', () => {
    expect(VERSION).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  });

  it('`codex exec --help` lists every flag the cold-start argv emits', () => {
    const text = help(['exec', '--help']);
    for (const flag of [CODEX_JSON_FLAG, CODEX_CD_FLAG, CODEX_ADD_DIR_FLAG, CODEX_BYPASS_FLAG, CODEX_HOOK_TRUST_FLAG, CODEX_MODEL_FLAG, '--strict-config']) {
      expect(text, flag).toContain(flag);
    }
    expect(text).toMatch(/^\s+resume\s/m);
  });

  it('`codex exec resume --help` accepts every flag the resume argv emits', () => {
    const text = help(['exec', 'resume', '--help']);
    for (const flag of [CODEX_JSON_FLAG, CODEX_BYPASS_FLAG, CODEX_HOOK_TRUST_FLAG, CODEX_MODEL_FLAG]) expect(text, flag).toContain(flag);
  });

  it('the rendered config.toml is accepted by --strict-config; a bogus key is rejected (positive control)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1076-strict-'));
    try {
      const probe = async (content: string) => {
        const home = join(dir, `h${Math.random().toString(36).slice(2)}`);
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'config.toml'), content);
        const r = await runCodex(['exec', '--strict-config', '--skip-git-repo-check', '--json', 'x'], { cwd: dir, env: { CODEX_HOME: home, HOME: dir }, timeoutMs: 8_000 });
        return r.stdout + r.stderr;
      };
      const good = renderCodexConfig(HARMONY_MCP_CONNECTION, { pluginRoot: '/p' }).content;
      expect(await probe(good)).not.toMatch(/Error loading config\.toml|unknown configuration field/);
      expect(await probe('zzz_not_a_codex_key = 1\n' + good)).toMatch(/unknown configuration field/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('end to end against a local MOCK provider: adapter argv + provisioned config/AGENTS.md/skills → events, rollout path, resume, required-MCP failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1076-e2e-'));
    const mock = await startMock();
    try {
      const ws = join(dir, 'workspace');
      const plugin = join(ws, 'plugin');
      const codexHome = join(dir, 'home', '.codex');
      const auth = join(dir, 'auth.json');
      const envDump = join(dir, 'mcp-env.json');
      for (const d of [join(plugin, 'dist'), join(plugin, 'skills', 'harmony-conduct'), join(plugin, '.claude-plugin'), join(ws, 'web')]) mkdirSync(d, { recursive: true });
      spawnSync('git', ['init', '-q', '.'], { cwd: ws });
      writeFileSync(join(ws, 'CLAUDE.md'), 'E2E-WS-GUIDANCE\n');
      writeFileSync(join(plugin, 'CLAUDE.md'), 'E2E-PLUGIN-GUIDANCE\n');
      writeFileSync(join(ws, 'web', 'CLAUDE.md'), 'E2E-WEB-GUIDANCE\n');
      writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"harmony-plugin","version":"0.0.0-dev"}');
      writeFileSync(join(plugin, 'skills', 'harmony-conduct', 'SKILL.md'), '---\nname: harmony-conduct\ndescription: e2e conductor\nallowed-tools: mcp__harmony__* Read\n---\n\nE2E-SKILL-BODY-MARKER\n');
      writeStubMcp(join(plugin, 'dist', 'index.js'), envDump);
      // B-1150: provisionCodex writes $CODEX_HOME/hooks.json and the argv trusts it, so the REAL gate scripts
      // run in this e2e (no breadcrumb ⇒ both take their fast path). They must exist: a Stop hook command
      // that cannot run (exit 127) was observed to wedge codex 0.163.0 — see docs/codex-phase0-findings.md.
      mkdirSync(join(plugin, 'hooks'), { recursive: true });
      for (const f of ['stop-gate.sh', 'pretooluse-gate.sh', 'link-cli.sh']) writeFileSync(join(plugin, 'hooks', f), read(`hooks/${f}`));
      writeFileSync(auth, '{"fake":"not a real login cache"}');
      provisionCodex({ pluginDir: plugin, workspaceDir: ws, codexHome, authFile: auth });

      expect(readFileSync(join(codexHome, 'hooks.json'), 'utf8')).toContain(`${plugin}/hooks/stop-gate.sh`);

      // The mock provider rides beside the adapter's own rendered config (root keys must precede tables).
      const rendered = readFileSync(join(codexHome, 'config.toml'), 'utf8');
      writeFileSync(
        join(codexHome, 'config.toml'),
        `model = "mock-model"\nmodel_provider = "mock"\n${rendered}\n[model_providers.mock]\nname = "Mock"\nbase_url = "http://127.0.0.1:${mock.port}/v1"\nenv_key = "MOCK_KEY"\nwire_api = "responses"\n`,
      );
      const env = {
        CODEX_HOME: codexHome,
        HOME: join(dir, 'home'),
        MOCK_KEY: 'mock',
        HARMONY_API_TOKEN: 'hm_e2e',
        HARMONY_SUPABASE_URL: 'http://127.0.0.1:9',
        HARMONY_SUPABASE_ANON_KEY: 'anon',
        NOT_FORWARDED: 'must-not-reach-the-mcp-server',
      };

      // cold start — exactly the adapter's argv, via the real flags
      const argv = A.headless.buildArgv({ pluginDir: plugin, prompt: '/harmony-plugin:harmony-conduct B-1 --one-shot' });
      const cold = await runCodex(argv, { cwd: ws, env });
      expect(cold.code, cold.stderr).toBe(0);
      const threadId = parseCodexThreadId(cold.stdout);
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(A.telemetry.parse(cold.stdout, { model: 'mock-model', credential: 'login-cache' })).toMatchObject({
        runtime: 'codex',
        sessionId: threadId,
        isError: false,
        costRegime: 'plan-included',
        costUsd: null,
      });

      // AGENTS.md (all three guidance files), the explicit `$skill` body, and the required MCP server
      const body = mock.requests[0];
      for (const m of ['E2E-WS-GUIDANCE', 'E2E-PLUGIN-GUIDANCE', 'E2E-WEB-GUIDANCE', 'Codex worker overlay']) expect(body, m).toContain(m);
      expect(body).toContain('E2E-SKILL-BODY-MARKER');
      expect(body).toContain('mcp__harmony');
      const mcpEnv = JSON.parse(readFileSync(envDump, 'utf8')) as Record<string, string>;
      expect(mcpEnv.HARMONY_API_TOKEN).toBe('hm_e2e');
      expect(mcpEnv.HARMONY_SUPABASE_URL).toBe('http://127.0.0.1:9');
      expect(mcpEnv.NOT_FORWARDED).toBeUndefined();

      // the rollout lands where the adapter says, and its path round-trips to the thread id
      const rollouts: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) rollouts.push(p);
        }
      };
      walk(join(codexHome, 'sessions'));
      expect(rollouts).toHaveLength(1);
      expect(A.session.sessionIdFromPath(rollouts[0])).toBe(threadId);

      // resume — the adapter's resume argv keeps the thread
      const resumeArgv = A.headless.buildArgv({ pluginDir: plugin, prompt: 'continue', resumeSessionId: threadId!, model: 'mock-model' });
      const resumed = await runCodex(resumeArgv, { cwd: ws, env });
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(parseCodexThreadId(resumed.stdout)).toBe(threadId);

      // a REQUIRED MCP server that cannot start stops the leg before any model request
      const before = mock.requests.length;
      const badHome = join(dir, 'bad-home', '.codex');
      mkdirSync(badHome, { recursive: true });
      const badCfg = renderCodexConfig(HARMONY_MCP_CONNECTION, { pluginRoot: join(dir, 'does-not-exist') }).content;
      writeFileSync(join(badHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\n${badCfg}\n[model_providers.mock]\nname = "Mock"\nbase_url = "http://127.0.0.1:${mock.port}/v1"\nenv_key = "MOCK_KEY"\nwire_api = "responses"\n`);
      const failed = await runCodex(argv, { cwd: ws, env: { ...env, CODEX_HOME: badHome } });
      expect(failed.code).not.toBe(0);
      expect(failed.stderr + failed.stdout).toMatch(/required MCP servers failed to initialize/);
      expect(mock.requests.length).toBe(before);
    } finally {
      mock.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
