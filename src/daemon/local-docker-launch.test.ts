// B-1076: the local-docker profile's launch moved from an inline template into
// container/docker-worker-launch.sh. EXECUTED, not read: the frozen pre-B-1076 template
// (local-docker-legacy-launch.ts) and the new profile template are each rendered with the daemon's own
// renderTemplate and run by bash against the SAME stub `node` / `docker`, which record argv one argument
// per line. A Claude run must produce the identical mint, resume-discovery and `docker run` argv, and the
// same exit code; a Codex run adds exactly the login-cache mount, the sessions mount and the PATH env var,
// skips the Claude-only resume discovery, and refuses on a missing cache or a metered variable.
// The adapter probe is NOT stubbed: `node -e` calls are handed to the real node, so detection is real.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from './config.js';
import { LEGACY_LOCAL_DOCKER_LAUNCH } from './local-docker-legacy-launch.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const profile = JSON.parse(readFileSync(join(REPO, 'container/daemon-profile.example.json'), 'utf8')) as { launch: string; required_tools: Record<string, string[]> };

const BASH = (() => {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const CID = 'cond-b1076-1';
const TICKET = 'B-1076';
const SENTINEL = 'CODEX-AUTH-SENTINEL-local-docker-9f8e7d';
const CODEX_RC = Buffer.from('{"agent":{"adapter":"codex"}}').toString('base64');

interface World {
  dir: string;
  bin: string;
  logs: string;
  home: string;
  runDir: string;
}

function makeWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'b1076-local-docker-'));
  const w: World = { dir, bin: join(dir, 'bin'), logs: join(dir, 'logs'), home: join(dir, 'home'), runDir: join(dir, 'home', '.harmony-conductions', TICKET, CID) };
  for (const d of [w.bin, w.logs, w.home]) mkdirSync(d, { recursive: true });
  const stub = (name: string, lines: string[]) => writeFileSync(join(w.bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });
  stub('node', [
    `if [ "$1" = "-e" ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
    '{ printf \'%s\\n\' "$@"; echo "--END--"; } >> "$STUB_LOGS/node.log"',
    'case "$*" in',
    '  *mint-installation-token.mjs*)',
    '    out=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done',
    '    printf \'GIT_TOKEN=ghs_stub\\n\' > "$out"; printf \'{}\' > "$(dirname "$out")/run-config.json" ;;',
    'esac',
  ]);
  stub('docker', ['{ printf \'%s\\n\' "$@"; echo "--END--"; } >> "$STUB_LOGS/docker.log"', 'exit "${STUB_DOCKER_EXIT:-0}"']);
  return w;
}

function calls(w: World, name: string): string[][] {
  const p = join(w.logs, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('--END--\n')
    .filter((c) => c.length > 0)
    .map((c) => c.replace(/\n$/, '').split('\n'));
}

function runTemplate(w: World, template: string, vars: { run_config_json: string; model: string; worker_image: string }, env: Record<string, string> = {}) {
  const rendered = renderTemplate(template, { conduction_id: CID, ticket: TICKET, ...vars });
  const r = spawnSync('bash', ['-c', rendered], {
    encoding: 'utf8',
    env: { PATH: `${w.bin}:${process.env.PATH}`, HOME: w.home, HARMONY_PLUGIN_DIR: REPO, STUB_LOGS: w.logs, ...env },
  });
  return { status: r.status, stderr: r.stderr };
}

const CLAUDE_VARS = { run_config_json: 'e30=', model: 'claude-sonnet-5', worker_image: 'harmony-build-env' };

describe('daemon-profile.example.json (local-docker) — the launch is the wrapper', () => {
  it('points launch at container/docker-worker-launch.sh with every placeholder the old template used', () => {
    expect(profile.launch).toBe(`bash "$HARMONY_PLUGIN_DIR/container/docker-worker-launch.sh" {conduction_id} {ticket} '{run_config_json}' '{model}' '{worker_image}'`);
    for (const ph of ['{conduction_id}', '{ticket}', '{run_config_json}', '{model}', '{worker_image}']) expect(LEGACY_LOCAL_DOCKER_LAUNCH).toContain(ph);
    expect(profile.required_tools.launch).toEqual(['bash', 'node', 'docker']);
  });
});

describe.skipIf(!BASH)('docker-worker-launch.sh — Claude parity with the pre-B-1076 inline template (EXECUTED)', () => {
  it.each([
    ['a model and the default image', CLAUDE_VARS],
    ['an EMPTY model (the template always passed --model \'\')', { ...CLAUDE_VARS, model: '' }],
    ['an override image and a real run-config', { run_config_json: Buffer.from('{"session_resume":{"enabled":true}}').toString('base64'), model: 'claude-opus-5', worker_image: 'us-central1-docker.pkg.dev/acme/w/env:v3' }],
  ])('%s: identical mint, resume-discovery and docker run argv', (_l, vars) => {
    const legacy = makeWorld();
    const wrapper = makeWorld();
    expect(runTemplate(legacy, LEGACY_LOCAL_DOCKER_LAUNCH, vars).status).toBe(0);
    expect(runTemplate(wrapper, profile.launch, vars).status).toBe(0);
    const rel = (w: World, c: string[][]) => JSON.stringify(c).split(w.home).join('<HOME>');
    expect(calls(legacy, 'docker.log')).toHaveLength(1);
    expect(calls(legacy, 'node.log')).toHaveLength(2);
    expect(rel(wrapper, calls(wrapper, 'node.log'))).toBe(rel(legacy, calls(legacy, 'node.log')));
    expect(rel(wrapper, calls(wrapper, 'docker.log'))).toBe(rel(legacy, calls(legacy, 'docker.log')));
    for (const d of ['projects', 'logs']) expect(statSync(join(wrapper.runDir, d)).isDirectory()).toBe(true);
    expect(existsSync(join(wrapper.runDir, 'codex-sessions'))).toBe(false);
  });

  it('the worker\'s exit code passes through exactly as before', () => {
    const legacy = makeWorld();
    const wrapper = makeWorld();
    expect(runTemplate(legacy, LEGACY_LOCAL_DOCKER_LAUNCH, CLAUDE_VARS, { STUB_DOCKER_EXIT: '3' }).status).toBe(3);
    expect(runTemplate(wrapper, profile.launch, CLAUDE_VARS, { STUB_DOCKER_EXIT: '3' }).status).toBe(3);
  });

  it('a Claude run is untouched even when a login cache exists: no codex mount, env var or sessions dir', () => {
    const w = makeWorld();
    const auth = join(w.dir, 'auth.json');
    writeFileSync(auth, SENTINEL, { mode: 0o600 });
    expect(runTemplate(w, profile.launch, CLAUDE_VARS, { HARMONY_CODEX_AUTH_SRC: auth }).status).toBe(0);
    const argv = calls(w, 'docker.log')[0].join('\n');
    expect(argv).not.toContain('codex');
    expect(argv).not.toContain('HARMONY_CODEX_AUTH_FILE');
  });
});

describe.skipIf(!BASH)('docker-worker-launch.sh — the Codex adapter (B-1076, EXECUTED)', () => {
  const CODEX_VARS = { run_config_json: CODEX_RC, model: '', worker_image: 'harmony-build-env' };
  function withAuth(w: World): string {
    const p = join(w.dir, 'codex-automation', 'auth.json');
    mkdirSync(join(w.dir, 'codex-automation'), { recursive: true });
    writeFileSync(p, `{"tokens":{"refresh_token":"${SENTINEL}"}}`, { mode: 0o600 });
    return p;
  }

  it('mounts the login cache read-only and a per-conduction sessions dir, sets the PATH var, and skips resume discovery', () => {
    const w = makeWorld();
    const auth = withAuth(w);
    expect(runTemplate(w, profile.launch, CODEX_VARS, { HARMONY_CODEX_AUTH_SRC: auth }).status).toBe(0);
    const argv = calls(w, 'docker.log')[0];
    const joined = argv.join('\n');
    expect(joined).toContain(`-v\n${join(w.runDir, 'codex-sessions')}:/home/worker/.codex/sessions`);
    expect(joined).toContain(`-v\n${auth}:/home/worker/.codex-auth-src/auth.json:ro`);
    expect(joined).toContain('-e\nHARMONY_CODEX_AUTH_FILE=/home/worker/.codex-auth-src/auth.json');
    // everything the Claude launch mounts is still there, and the image + mode are still last
    expect(joined).toContain(`${join(w.runDir, 'projects')}:/home/worker/.claude/projects`);
    expect(joined).toContain(`${join(w.runDir, 'run-config.json')}:/home/worker/.claude/run-config.json:ro`);
    expect(argv.slice(-3)).toEqual(['harmony-build-env', 'headless', `/harmony-plugin:harmony-conduct ${TICKET} --one-shot`]);
    expect(statSync(join(w.runDir, 'codex-sessions')).isDirectory()).toBe(true);
    const node = calls(w, 'node.log');
    expect(node).toHaveLength(1);
    expect(node[0].join(' ')).toContain('mint-installation-token.mjs');
    for (const name of ['docker.log', 'node.log']) expect(readFileSync(join(w.logs, name), 'utf8')).not.toContain(SENTINEL);
  });

  it('the default login-cache location is $HOME/.harmony/codex-automation/auth.json', () => {
    const w = makeWorld();
    mkdirSync(join(w.home, '.harmony', 'codex-automation'), { recursive: true });
    writeFileSync(join(w.home, '.harmony', 'codex-automation', 'auth.json'), SENTINEL, { mode: 0o600 });
    expect(runTemplate(w, profile.launch, CODEX_VARS).status).toBe(0);
    expect(calls(w, 'docker.log')[0].join('\n')).toContain(`${join(w.home, '.harmony', 'codex-automation', 'auth.json')}:/home/worker/.codex-auth-src/auth.json:ro`);
  });

  it('REFUSES — before minting or running anything — when the login cache is missing', () => {
    const w = makeWorld();
    const r = runTemplate(w, profile.launch, CODEX_VARS, { HARMONY_CODEX_AUTH_SRC: join(w.dir, 'absent.json') });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Refusing to start');
    expect(r.stderr).toContain('login-cache file is missing');
    expect(calls(w, 'node.log')).toEqual([]);
    expect(calls(w, 'docker.log')).toEqual([]);
  });

  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'])('REFUSES when %s is set (no metered fallback), without echoing it', (name) => {
    const w = makeWorld();
    const r = runTemplate(w, profile.launch, CODEX_VARS, { HARMONY_CODEX_AUTH_SRC: withAuth(w), [name]: 'sk-not-echoed-123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(name);
    expect(r.stderr).not.toContain('sk-not-echoed');
    expect(calls(w, 'docker.log')).toEqual([]);
  });

  it('a metered variable does NOT block a Claude run (the refusal is Codex-only)', () => {
    const w = makeWorld();
    expect(runTemplate(w, profile.launch, CLAUDE_VARS, { OPENAI_API_KEY: 'sk-x' }).status).toBe(0);
  });
});
