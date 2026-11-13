// B-1478: one harness for container/entrypoint.sh and container/provision.sh, driven under bash with PATH stubs.
//
// Every stub (git, node, gh, claude) and every recorder script it plants (a cloned repo's container/provision.sh,
// the fake plugin dir's helper scripts) appends one trace record: the command, its argv and the environment
// variables a leg depends on. The trace is normalized (the temp root, mktemp names, the per-leg key and durations)
// so two runs of different scripts in different temp roots can be compared line for line.
//
// The scripts hard-code /workspace/workspace. The harness copies each script into its temp root with that prefix
// rewritten to <root>/workspace/workspace; the SAME rewrite is applied to a frozen fixture and to the live script, so
// a parity comparison compares like with like. Nothing is ever written under the real /workspace.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ENV_FILTER = '^(HARMONY_|GIT_|PLUGIN_|CLAUDE_|CODEX_|TICKET=|CONDUCTION_ID=|HOME=|PATH=|PWD=|CURL_)';

/** Shell snippet every stub and recorder sources inline: `__rec <label> <argv...>`. */
const REC = [
  '__rec() {',
  '  {',
  "    printf 'CMD %s' \"$1\"; shift",
  "    for a in \"$@\"; do printf '\\x1f%s' \"$a\"; done",
  "    printf '\\n'",
  `    env | LC_ALL=C sort | grep -E '${ENV_FILTER}' | sed 's/^/  ENV /'`,
  '  } >> "$HARNESS_TRACE"',
  '}',
].join('\n');

/** A script that only records how it was called (used for exec targets and helper scripts). */
export const RECORDER = ['#!/bin/bash', REC, '__rec "SCRIPT:$0" "$@"', 'exit "${HARNESS_RECORDER_EXIT:-0}"', ''].join('\n');

function stub(body: string[]): string {
  return ['#!/bin/bash', REC, ...body, ''].join('\n');
}

const GIT_STUB = stub([
  '__rec git "$@"',
  'dir=""',
  'if [ "${1:-}" = "-C" ]; then dir="$2"; shift 2; fi',
  'case "${1:-}" in',
  '  clone)',
  '    dest="${@: -1}"',
  '    mkdir -p "$dest/.git" "$dest/container"',
  '    cp "$HARNESS_ROOT/recorder.sh" "$dest/container/provision.sh"',
  '    chmod 755 "$dest/container/provision.sh" ;;',
  '  rev-parse)',
  '    case "$*" in',
  '      *--show-toplevel*) if [ -d "$dir/.git" ]; then (cd "$dir" && pwd -P); else exit 128; fi ;;',
  '      *) echo abc1234 ;;',
  '    esac ;;',
  'esac',
  'exit 0',
]);

const NODE_STUB = stub([
  '__rec node "$@"',
  'shift # the script path',
  'case "$*" in',
  "  '--json project info'*) printf '{\"environment\":{\"target\":\"%s\",\"plugin_version\":\"9.9.9\"}}' \"${HARMONY_STUB_TARGET:-prod}\" ;;",
  '  "agent binary"*) echo claude ;;',
  '  "agent check-credentials"*) echo oauth ;;',
  '  "agent resolve"*) echo claude-code ;;',
  "  \"agent argv\"*) printf 'claude\\0-p\\0stub-prompt\\0' ;;",
  '  "leg-cost resolve-gate"*) echo build ;;',
  '  "tasks comment"*) exit "${HARNESS_COMMENT_EXIT:-0}" ;;',
  'esac',
  'exit 0',
]);

const GH_STUB = stub(['cat >/dev/null', '__rec gh "$@"', 'exit 0']);
const CLAUDE_STUB = stub(['__rec claude "$@"', 'echo \'{"type":"result","result":"stub agent done"}\'', 'exit 0']);

/** The plugin-dir files provision.sh calls, each a recorder. */
const PLUGIN_HELPERS = [
  'scripts/setup-channel-env.sh',
  'container/activate-toolchain.sh',
  'container/install-playwright.sh',
  'container/git-guard/install.sh',
  'container/git-guard/dirty-check.sh',
];

export interface Harness {
  root: string;
  trace: string;
  bin: string;
  home: string;
  workspace: string;
  pluginDir: string;
  cleanup(): void;
}

export function makeHarness(prefix = 'b1478-'): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  for (const d of [bin, home, tmp, join(root, 'script')]) mkdirSync(d, { recursive: true });
  const write = (p: string, s: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, s, { mode: 0o755 });
  };
  write(join(root, 'recorder.sh'), RECORDER);
  write(join(bin, 'git'), GIT_STUB);
  write(join(bin, 'node'), NODE_STUB);
  write(join(bin, 'gh'), GH_STUB);
  write(join(bin, 'claude'), CLAUDE_STUB);
  const trace = join(root, 'trace.log');
  writeFileSync(trace, '');
  const workspace = join(root, 'workspace/workspace');
  return {
    root,
    trace,
    bin,
    home,
    workspace,
    pluginDir: join(workspace, 'plugin'),
    cleanup() {
      spawnSync('chmod', ['-R', 'u+w', root]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Plant a fake cloned plugin (a repo top level with recorder helpers) where provision.sh expects it. */
export function plantPluginDir(h: Harness, dir = h.pluginDir, opts: { gitRepo?: boolean } = {}): void {
  mkdirSync(join(dir, 'container/agents'), { recursive: true });
  if (opts.gitRepo !== false) mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'container/agents/harmony-build.md'), '# stub agent\n');
  for (const rel of PLUGIN_HELPERS) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), RECORDER, { mode: 0o755 });
  }
}

/** Copy a script into the harness with /workspace/workspace rewritten under the temp root. */
export function installScript(h: Harness, source: string, name: string): string {
  const text = readFileSync(source, 'utf8').split('/workspace/workspace').join(h.workspace);
  const out = join(h.root, 'script', name);
  writeFileSync(out, text, { mode: 0o755 });
  chmodSync(out, 0o755);
  return out;
}

export function baseEnv(h: Harness, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${h.bin}:/usr/bin:/bin`,
    HOME: h.home,
    TMPDIR: join(h.root, 'tmp'),
    LANG: 'C',
    HARNESS_TRACE: h.trace,
    HARNESS_ROOT: h.root,
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface ScriptResult {
  status: number | null;
  stdout: string;
  stderr: string;
  trace: string[];
}

export function runScript(h: Harness, script: string, args: string[], env: NodeJS.ProcessEnv): ScriptResult {
  const r = spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8', input: '', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, trace: readTrace(h) };
}

/** The async form, for a test that serves HTTP from this same process while the script runs. */
export function runScriptAsync(h: Harness, script: string, args: string[], env: NodeJS.ProcessEnv): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, trace: readTrace(h) });
    });
  });
}

export function readTrace(h: Harness): string[] {
  if (!existsSync(h.trace)) return [];
  return normalize(h, readFileSync(h.trace, 'utf8'));
}

export function normalize(h: Harness, text: string): string[] {
  const root = h.root;
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      let l = line;
      const repos = /^ {2}ENV HARMONY_REPOS_JSON=(.*)$/.exec(l);
      if (repos) l = `  ENV HARMONY_REPOS_JSON(decoded)=${Buffer.from(repos[1], 'base64').toString('utf8')}`;
      l = l.split(root).join('<ROOT>');
      l = l.replace(/<ROOT>\/tmp\/tmp\.[A-Za-z0-9]+/g, '<MKTEMP>');
      l = l.replace(/\d{8}T\d{6}Z-\d+-\d+/g, '<LEGKEY>');
      l = l.replace(/--duration-ms(.)\d+/g, '--duration-ms$1<N>'); // (.) is the \x1f argv separator
      return l;
    });
}

/** Commands only (no ENV lines) — a compact view for assertions about what ran. */
export function commands(trace: string[]): string[] {
  return trace.filter((l) => l.startsWith('CMD ')).map((l) => l.slice(4).split('\x1f').join(' '));
}

export function b64(s: string): string {
  return Buffer.from(s).toString('base64');
}
