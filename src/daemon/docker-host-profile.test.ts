// B-708: the "Docker host" launch profile — its example profile, its three wrapper scripts, the
// host's idle check, and provision.sh's engine-start block — EXECUTED for real.
//
// Same discipline as src/daemon/profile-contract.test.ts (whose file this would otherwise have
// grown further): the real scripts are run from disk with stub executables first on PATH, never a
// hand-retyped copy and never a regex over their text alone. The stubs here go one step further
// than recording argv, because the thing most likely to be wrong in an SSH wrapper is QUOTING:
//
//   * the stub `ssh` does what real ssh does with a command — joins its arguments with spaces and
//     hands the result to a shell — against a throwaway "remote home";
//   * the stub `docker` that shell then finds records each invocation's argv ONE ARGUMENT PER LINE,
//     so "the prompt arrived as a single argument" is an assertion, not a hope.
//
// What this deliberately does NOT prove: a real SSH session, a real privileged container, or a real
// engine start. The engine layer is asserted against a real image by
// container/docker-engine/contract.sh (CI's container-base job); the end-to-end run on a real host
// is the proof-run recorded in container/README.md.

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeploymentConfigSchema } from '../config/deployment-config.js';
import { renderTemplate } from './config.js';

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../../${rel}`, import.meta.url));
}

const exampleProfilePath = repoPath('container/daemon-profile.docker-host.example.json');
const cloudProfilePath = repoPath('container/daemon-profile.cloud.example.json');
const launchScriptPath = repoPath('container/docker-host-worker-launch.sh');
const reapScriptPath = repoPath('container/docker-host-worker-reap.sh');
const probeScriptPath = repoPath('container/docker-host-worker-probe.sh');
const idleScriptPath = repoPath('container/docker-host/idle.sh');
const provisionPath = repoPath('container/provision.sh');

// Capability probe, keyed strictly on what this host can run (never on an expected outcome) — the
// same rule as profile-contract.test.ts's SUBPROCESS_CAPABLE. These scripts need only bash.
function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const BASH_AVAILABLE = bashAvailable();

const TOKEN = 'ghs_B708SECRETTOKENMUSTNOTLEAK';
const CONDUCTION_ID = 'cond-b708-1';
const TICKET = 'B-708';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The example profile.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('daemon-profile.docker-host.example.json', () => {
  const profile = JSON.parse(readFileSync(exampleProfilePath, 'utf8')) as {
    launch: string;
    reap: string;
    probe: string;
    maxConcurrentWorkers: number;
    docker_host: { ssh_target: string; wake?: string; wake_timeout_s?: number };
    required_tools: { launch: string[]; reap: string[]; probe: string[] };
    requires_app_mint: boolean;
    schema_version: number;
  };

  it('parses against the deployment-config schema as a named profile, docker_host block included', () => {
    const parsed = DeploymentConfigSchema.parse({ profiles: { 'docker-host': profile } });
    expect(parsed.profiles?.['docker-host'].docker_host).toEqual(profile.docker_host);
    expect(profile.docker_host.ssh_target.length).toBeGreaterThan(0);
    expect(profile.docker_host.wake).toBeTruthy();
  });

  it('points launch / reap / probe at the three dedicated wrappers — nothing inline', () => {
    expect(profile.launch).toContain('bash "$HARMONY_PLUGIN_DIR/container/docker-host-worker-launch.sh"');
    expect(profile.reap).toContain('bash "$HARMONY_PLUGIN_DIR/container/docker-host-worker-reap.sh"');
    expect(profile.probe).toContain('bash "$HARMONY_PLUGIN_DIR/container/docker-host-worker-probe.sh"');
    expect(profile.launch).not.toContain('docker run');
    for (const script of [launchScriptPath, reapScriptPath, probeScriptPath]) {
      expect(readFileSync(script, 'utf8').length).toBeGreaterThan(0);
    }
  });

  it('uses the SAME placeholders, in the same positions, as the cloud example profile', () => {
    const cloud = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as { launch: string; reap: string; probe: string };
    const tail = (tpl: string) => tpl.slice(tpl.indexOf('.sh"') + '.sh"'.length);
    expect(tail(profile.launch)).toBe(tail(cloud.launch));
    expect(tail(profile.reap)).toBe(tail(cloud.reap));
    expect(tail(profile.probe)).toBe(tail(cloud.probe));
  });

  it('every template renders with the daemon\'s own renderTemplate (no placeholder it does not know)', () => {
    const vars = { conduction_id: CONDUCTION_ID, ticket: TICKET, run_config_json: 'e30=', model: 'some-model' };
    expect(renderTemplate(profile.launch, vars)).toContain(`${CONDUCTION_ID} ${TICKET} 'e30=' 'some-model'`);
    expect(renderTemplate(profile.reap, vars)).toContain(`${CONDUCTION_ID} ${TICKET}`);
    expect(renderTemplate(profile.probe, vars)).toContain(`${CONDUCTION_ID} ${TICKET}`);
  });

  it('declares its tools, the App mint, ONE worker at a time, and the current schema_version', () => {
    expect(profile.required_tools).toEqual({
      launch: ['bash', 'node', 'ssh'],
      reap: ['bash', 'ssh'],
      probe: ['bash', 'ssh'],
    });
    expect(profile.requires_app_mint).toBe(true);
    expect(profile.maxConcurrentWorkers).toBe(1);
    const cloud = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as { schema_version: number };
    expect(profile.schema_version).toBe(cloud.schema_version);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The stub world the three wrappers run in.
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface World {
  dir: string;
  bin: string;
  logs: string;
  localHome: string;
  remoteHome: string;
  pluginDir: string;
  localRunDir: string;
  remoteRunDir: string;
}

interface WorldOptions {
  /** Bash spliced into the stub ssh AFTER it has logged the call and BEFORE it runs the remote
   *  command. Sees $target and $remote. `exit 255` here is "the connection failed". */
  sshBody?: string;
  /** Bash spliced into the stub docker after it has logged its argv. `exit N` here ends the call. */
  dockerBody?: string;
}

const RESUME_SCRIPT_BODY = '// stand-in for scripts/resume-discovery.mjs — B-708 test\n';
const RUN_CONFIG_BODY = '{"session_resume":{"enabled":true}}';

function makeWorld(opts: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), 'b708-docker-host-'));
  const world: World = {
    dir,
    bin: join(dir, 'bin'),
    logs: join(dir, 'logs'),
    localHome: join(dir, 'home'),
    remoteHome: join(dir, 'remote-home'),
    pluginDir: join(dir, 'plugin'),
    localRunDir: join(dir, 'home', '.harmony-conductions', TICKET, CONDUCTION_ID),
    remoteRunDir: join(dir, 'remote-home', '.harmony-conductions', TICKET, CONDUCTION_ID),
  };
  for (const d of [world.bin, world.logs, world.localHome, world.remoteHome]) mkdirSync(d, { recursive: true });
  mkdirSync(join(world.pluginDir, 'dist', 'bin'), { recursive: true });
  mkdirSync(join(world.pluginDir, 'scripts'), { recursive: true });
  writeFileSync(join(world.pluginDir, 'dist', 'bin', 'harmony.js'), '// stub target\n');
  writeFileSync(join(world.pluginDir, 'scripts', 'mint-installation-token.mjs'), '// stub target\n');
  writeFileSync(join(world.pluginDir, 'scripts', 'resume-discovery.mjs'), RESUME_SCRIPT_BODY);

  const stub = (name: string, lines: string[]) =>
    writeFileSync(join(world.bin, name), ['#!/usr/bin/env bash', ...lines, ''].join('\n'), { mode: 0o755 });

  // ssh: log, then behave like ssh — join the command words with spaces, run them in a shell, in
  // the "remote" home.
  stub('ssh', [
    'printf \'%s\\n\' "$*" >> "$STUB_LOGS/ssh-argv.log"',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o|-i|-p) shift 2 ;;',
    '    -*) shift ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'target="$1"; shift',
    'remote="$*"',
    'printf \'%s\\t%s\\n\' "$target" "$remote" >> "$STUB_LOGS/ssh.log"',
    'echo "ssh $remote" >> "$STUB_LOGS/order.log"',
    opts.sshBody ?? '',
    'HOME="$STUB_REMOTE_HOME" exec sh -c "$remote"',
  ]);

  // docker (found by the "remote" shell): argv one argument per line, then a few canned behaviours.
  stub('docker', [
    '{ printf \'%s\\n\' "$@"; echo "--END--"; } >> "$STUB_LOGS/docker.log"',
    opts.dockerBody ?? '',
    'case "$1" in',
    '  run)',
    '    case " $* " in',
    '      *" --privileged "*)',
    '        prev=""',
    '        for a in "$@"; do',
    '          [ "$prev" = "--env-file" ] && cp "$a" "$STUB_LOGS/env-file-at-run"',
    '          prev="$a"',
    '        done',
    '        exit "${STUB_WORKER_EXIT:-0}" ;;',
    '      *" --entrypoint sh "*) cat > "$STUB_LOGS/resume-stdin"; exit "${STUB_RESUME_EXIT:-0}" ;;',
    '      *) exit 0 ;;',
    '    esac ;;',
    '  wait) echo "${STUB_WAIT_PRINTS:-0}" ;;',
    '  *) exit 0 ;;',
    'esac',
  ]);

  // node: `harmony config get <key>` answered from STUB_CFG_* env, and the mint script.
  stub('node', [
    'printf \'%s\\n\' "$*" >> "$STUB_LOGS/node.log"',
    'case "$*" in',
    '  *"config get "*)',
    '    key="${@: -1}"; v=""',
    '    case "$key" in',
    '      profiles.docker-host.docker_host.ssh_target) v="${STUB_CFG_SSH_TARGET:-}" ;;',
    '      profiles.docker-host.docker_host.wake) v="${STUB_CFG_WAKE:-}" ;;',
    '      profiles.docker-host.docker_host.wake_timeout_s) v="${STUB_CFG_WAKE_TIMEOUT_S:-}" ;;',
    '      profiles.other.docker_host.ssh_target) v="${STUB_CFG_OTHER_SSH_TARGET:-}" ;;',
    '      worker_image) v="${STUB_CFG_IMAGE:-}" ;;',
    '    esac',
    '    [ -n "$v" ] || exit 1',
    '    printf \'%s\\n\' "$v" ;;',
    '  *mint-installation-token.mjs*)',
    '    echo "mint" >> "$STUB_LOGS/order.log"',
    '    out=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--out" ] && out="$a"; prev="$a"; done',
    `    printf 'HARMONY_API_TOKEN=base\\nGIT_TOKEN=%s\\n' '${TOKEN}' > "$out"`,
    `    printf '%s' '${RUN_CONFIG_BODY}' > "$(dirname "$out")/run-config.json"`,
    '    echo "$out" ;;',
    'esac',
  ]);

  // sleep: a no-op, so the wake poll and the wait retry do not cost wall-clock time.
  stub('sleep', ['echo "sleep $*" >> "$STUB_LOGS/sleep.log"', 'exit 0']);

  return world;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(world: World, script: string, args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    // A MINIMAL environment on purpose: nothing from the developer's own shell (a real
    // HARMONY_DOCKER_HOST_SSH, a real deployment config) may leak into these runs.
    env: {
      PATH: `${world.bin}:${process.env.PATH}`,
      HOME: world.localHome,
      HARMONY_PLUGIN_DIR: world.pluginDir,
      STUB_LOGS: world.logs,
      STUB_REMOTE_HOME: world.remoteHome,
      STUB_CFG_SSH_TARGET: 'harmony@docker-host.test',
      STUB_CFG_IMAGE: 'harmony-build-env-docker',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function log(world: World, name: string): string {
  const path = join(world.logs, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Every stub-docker invocation, each as its real argv array. */
function dockerCalls(world: World): string[][] {
  return log(world, 'docker.log')
    .split('--END--\n')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.replace(/\n$/, '').split('\n'));
}

function launch(world: World, env: Record<string, string> = {}, args: string[] = [CONDUCTION_ID, TICKET, 'e30=', 'some-model']) {
  return run(world, launchScriptPath, args, env);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Launch.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASH_AVAILABLE)('docker-host-worker-launch.sh (EXECUTED against stub ssh / docker / node)', () => {
  it('refuses, with a clear message and before doing anything, when no SSH target is configured', () => {
    const world = makeWorld();
    const result = launch(world, { STUB_CFG_SSH_TARGET: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no Docker host is configured');
    expect(result.stderr).toContain('HARMONY_DOCKER_HOST_SSH');
    expect(result.stderr).toContain('profiles.docker-host.docker_host.ssh_target');
    expect(log(world, 'ssh.log')).toBe('');
    expect(log(world, 'node.log')).not.toContain('mint-installation-token');
  });

  it('refuses a conduction id or ticket that is not a plain id (it becomes a path and a container name on the host)', () => {
    const world = makeWorld();
    const result = launch(world, {}, ['cond; rm -rf x', TICKET]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing conduction id');
    expect(log(world, 'ssh.log')).toBe('');
  });

  it('runs the wake command FIRST (exit status ignored), waits for SSH, and only then mints', () => {
    // The host is "off" until the wake command has run; the wake command itself exits non-zero, as
    // "start" on an already-running machine does on some providers.
    const world = makeWorld({ sshBody: '[ -f "$STUB_LOGS/awake" ] || exit 255' });
    const result = launch(world, {
      STUB_CFG_WAKE: 'echo wake >> "$STUB_LOGS/order.log"; touch "$STUB_LOGS/awake"; exit 7',
    });
    expect(result.status).toBe(0);
    const order = log(world, 'order.log').trim().split('\n');
    expect(order[0]).toBe('wake');
    expect(order[1]).toBe('ssh true');
    const mintAt = order.indexOf('mint');
    expect(mintAt).toBeGreaterThan(1);
    // Nothing but the reachability check happened on the host before the token existed.
    expect(order.slice(1, mintAt).every((line) => line === 'ssh true')).toBe(true);
  });

  it('RE-RUNS the wake command while SSH stays down — a host caught mid-shutdown refuses the first start', () => {
    // The first wake is refused (the host is still stopping); only the SECOND one brings it up.
    const world = makeWorld({ sshBody: '[ -f "$STUB_LOGS/awake" ] || exit 255' });
    const result = launch(world, {
      HARMONY_DOCKER_HOST_WAKE_RETRY_S: '0',
      STUB_CFG_WAKE:
        'echo wake >> "$STUB_LOGS/order.log"; n=$(grep -c "^wake$" "$STUB_LOGS/order.log"); [ "$n" -ge 2 ] && touch "$STUB_LOGS/awake"; exit 0',
    });
    expect(result.status).toBe(0);
    const wakes = log(world, 'order.log').split('\n').filter((l) => l === 'wake');
    expect(wakes.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a SETUP step whose connection drops — a freshly woken host answers once and then flaps', () => {
    // ssh call 1 (the wait loop's `true`) connects; call 2 (the first setup step) fails to connect;
    // every later call connects. The launch must ride through it, not exit 255.
    const world = makeWorld({
      sshBody:
        'n=$(cat "$STUB_LOGS/ssh-count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_LOGS/ssh-count"; [ "$n" -ne 2 ] || exit 255',
    });
    const result = launch(world);
    expect(result.status).toBe(0);
    expect(existsSync(join(world.remoteRunDir, 'projects'))).toBe(true);
  });

  it('gives up with a clear message, minting nothing, when the host never answers within the wake timeout', () => {
    const world = makeWorld({ sshBody: 'exit 255' });
    const result = launch(world, { HARMONY_DOCKER_HOST_WAKE_TIMEOUT_S: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not answer SSH within 1s');
    expect(log(world, 'node.log')).not.toContain('mint-installation-token');
  });

  it('env overrides win over the deployment config (target, wake, profile name, extra ssh options)', () => {
    const world = makeWorld();
    const result = launch(world, {
      HARMONY_DOCKER_HOST_SSH: 'override@elsewhere',
      HARMONY_DOCKER_HOST_WAKE: 'echo env-wake >> "$STUB_LOGS/order.log"',
      STUB_CFG_WAKE: 'echo config-wake >> "$STUB_LOGS/order.log"',
      HARMONY_DOCKER_HOST_SSH_OPTS: '-i /keys/harmony-host -o StrictHostKeyChecking=accept-new',
    });
    expect(result.status).toBe(0);
    expect(log(world, 'order.log')).toContain('env-wake');
    expect(log(world, 'order.log')).not.toContain('config-wake');
    const targets = new Set(log(world, 'ssh.log').trim().split('\n').map((line) => line.split('\t')[0]));
    expect([...targets]).toEqual(['override@elsewhere']);
    const firstArgv = log(world, 'ssh-argv.log').split('\n')[0];
    expect(firstArgv).toContain(
      '-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -i /keys/harmony-host -o StrictHostKeyChecking=accept-new override@elsewhere',
    );

    const named = makeWorld();
    const namedResult = launch(named, {
      HARMONY_DOCKER_HOST_PROFILE: 'other',
      STUB_CFG_SSH_TARGET: '',
      STUB_CFG_OTHER_SSH_TARGET: 'other@host',
    });
    expect(namedResult.status).toBe(0);
    expect(log(named, 'ssh.log').split('\t')[0]).toBe('other@host');
  });

  it('mints LOCALLY with the local profile\'s exact arguments', () => {
    const world = makeWorld();
    expect(launch(world).status).toBe(0);
    const mint = log(world, 'node.log').split('\n').find((line) => line.includes('mint-installation-token.mjs'));
    expect(mint).toBe(
      `${world.pluginDir}/scripts/mint-installation-token.mjs --base ${world.localHome}/.harmony-container.env ` +
        `--out ${world.localRunDir}/run.env --conduction-id ${CONDUCTION_ID} --model some-model ` +
        '--run-config e30= --run-config-path /home/worker/.claude/run-config.json',
    );
    // …and no --model at all when the daemon resolved none, with the run-config defaulting to {}.
    const bare = makeWorld();
    expect(launch(bare, {}, [CONDUCTION_ID, TICKET]).status).toBe(0);
    const bareMint = log(bare, 'node.log').split('\n').find((line) => line.includes('mint-installation-token.mjs'));
    expect(bareMint).not.toContain('--model');
    expect(bareMint).toContain('--run-config {} --run-config-path');
  });

  it('ships both per-run files through ssh STDIN — the token is never in any argv — and stamps the host', () => {
    const world = makeWorld();
    const result = launch(world);
    expect(result.status).toBe(0);

    // The worker really saw the minted env-file (copied aside by the stub at `docker run` time)…
    expect(log(world, 'env-file-at-run')).toBe(`HARMONY_API_TOKEN=base\nGIT_TOKEN=${TOKEN}\n`);
    // …the run-config arrived byte-for-byte…
    expect(readFileSync(join(world.remoteRunDir, 'run-config.json'), 'utf8')).toBe(RUN_CONFIG_BODY);
    // …and the token appears in NO command line, local or remote, nor in this wrapper's own output.
    for (const name of ['ssh-argv.log', 'ssh.log', 'docker.log', 'node.log']) {
      expect(log(world, name)).not.toContain(TOKEN);
    }
    expect(result.stdout + result.stderr).not.toContain(TOKEN);

    // The files were written by `umask 077; cat > …` — private to the SSH user.
    const remoteCommands = log(world, 'ssh.log');
    expect(remoteCommands).toContain(`umask 077; cat > "$HOME/.harmony-conductions/${TICKET}/${CONDUCTION_ID}/run.env"`);
    expect(statSync(join(world.remoteRunDir, 'run-config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(world.remoteRunDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(world.remoteHome, '.harmony-conductions')).mode & 0o777).toBe(0o700);

    // Both idle-script stamps, and the two transcript directories.
    expect(existsSync(join(world.remoteHome, '.harmony-conductions', '.last-launch'))).toBe(true);
    expect(existsSync(join(world.remoteHome, '.harmony-conductions', '.engine-volumes', TICKET))).toBe(true);
    expect(existsSync(join(world.remoteRunDir, 'projects'))).toBe(true);
    expect(existsSync(join(world.remoteRunDir, 'logs'))).toBe(true);
  });

  it('runs resume discovery ON THE HOST, in the worker image, as root, with the script piped over stdin', () => {
    const world = makeWorld();
    expect(launch(world).status).toBe(0);
    const call = dockerCalls(world).find((argv) => argv.includes('--entrypoint') && argv[argv.indexOf('--entrypoint') + 1] === 'sh');
    expect(call).toBeDefined();
    const root = join(world.remoteHome, '.harmony-conductions');
    expect(call).toEqual([
      'run', '--rm', '-i', '--user', '0', '--entrypoint', 'sh',
      '-v', `${root}:/c`,
      'harmony-build-env-docker',
      '-c', 'cat > /tmp/resume-discovery.mjs && exec node /tmp/resume-discovery.mjs "$@"',
      'resume-discovery',
      '--conductions-root', '/c',
      '--ticket', TICKET,
      '--conduction-id', CONDUCTION_ID,
      '--run-config-file', `/c/${TICKET}/${CONDUCTION_ID}/run-config.json`,
      '--env-file', `/c/${TICKET}/${CONDUCTION_ID}/run.env`,
    ]);
    expect(log(world, 'resume-stdin')).toBe(RESUME_SCRIPT_BODY);
  });

  it('treats a failed resume discovery as best-effort: logged, ignored, the worker still runs', () => {
    const world = makeWorld();
    const result = launch(world, { STUB_RESUME_EXIT: '1' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('resume discovery failed on the host — ignored');
    expect(dockerCalls(world).some((argv) => argv.includes('--privileged'))).toBe(true);
  });

  it('chowns what the worker must write through the IMAGE as root — and leaves run.env alone', () => {
    const world = makeWorld();
    expect(launch(world).status).toBe(0);
    const call = dockerCalls(world).find((argv) => argv.includes('chown'));
    expect(call).toEqual([
      'run', '--rm', '--user', '0', '--entrypoint', 'chown',
      '-v', `${world.remoteRunDir}:/r`,
      'harmony-build-env-docker',
      '-R', 'worker:worker', '/r/projects', '/r/logs', '/r/run-config.json',
    ]);
  });

  it('runs the worker PRIVILEGED, without --rm, with the per-ticket engine volume, the right name, and the prompt as ONE argument', () => {
    const world = makeWorld();
    expect(launch(world).status).toBe(0);
    const call = dockerCalls(world).find((argv) => argv.includes('--privileged'));
    expect(call).toEqual([
      'run', '--privileged',
      '--name', `harmony-worker-${CONDUCTION_ID}`,
      '-v', `harmony-engine-${TICKET}:/var/lib/docker`,
      '-v', `${world.remoteRunDir}/projects:/home/worker/.claude/projects`,
      '-v', `${world.remoteRunDir}/logs:/home/worker/.claude/logs`,
      '-v', `${world.remoteRunDir}/run-config.json:/home/worker/.claude/run-config.json:ro`,
      '--env-file', `${world.remoteRunDir}/run.env`,
      'harmony-build-env-docker',
      'headless',
      `/harmony-plugin:harmony-conduct ${TICKET} --one-shot`,
    ]);
    expect(call).not.toContain('--rm');
  });

  it('uses the deployment\'s worker_image as-is, and falls back to the schema default name with no config', () => {
    const custom = makeWorld();
    expect(launch(custom, { STUB_CFG_IMAGE: 'registry.example/acme/build-env:1.2' }).status).toBe(0);
    expect(dockerCalls(custom).find((argv) => argv.includes('--privileged'))).toContain('registry.example/acme/build-env:1.2');

    const none = makeWorld();
    expect(launch(none, { STUB_CFG_IMAGE: '', HARMONY_DOCKER_HOST_SSH: 'h' }).status).toBe(0);
    expect(dockerCalls(none).find((argv) => argv.includes('--privileged'))).toContain('harmony-build-env');
  });

  it('on exit, ALWAYS removes the host\'s run.env and the stopped container — and collapses the worker\'s code to 0 / 1', () => {
    const ok = makeWorld();
    expect(launch(ok).status).toBe(0);
    expect(existsSync(join(ok.remoteRunDir, 'run.env'))).toBe(false);
    expect(dockerCalls(ok).at(-1)).toEqual(['rm', `harmony-worker-${CONDUCTION_ID}`]);

    const failed = makeWorld();
    const result = launch(failed, { STUB_WORKER_EXIT: '7' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`worker harmony-worker-${CONDUCTION_ID} exited 7`);
    expect(existsSync(join(failed.remoteRunDir, 'run.env'))).toBe(false);
    expect(dockerCalls(failed).at(-1)).toEqual(['rm', `harmony-worker-${CONDUCTION_ID}`]);
  });

  describe('a dropped SSH session (ssh exit 255) is not the worker\'s result', () => {
    const dropRun = 'case "$remote" in *"docker run --privileged"*) exit 255 ;; esac';

    it('falls back to `docker wait` and exits 0 when the container exited 0', () => {
      const world = makeWorld({ sshBody: dropRun });
      const result = launch(world, { STUB_WAIT_PRINTS: '0' });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('SSH session to harmony@docker-host.test was lost');
      expect(dockerCalls(world)).toContainEqual(['wait', `harmony-worker-${CONDUCTION_ID}`]);
    });

    it('uses the code `docker wait` prints — a non-zero worker exit is still a failure', () => {
      const world = makeWorld({ sshBody: dropRun });
      const result = launch(world, { STUB_WAIT_PRINTS: '3' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exited 3');
    });

    it('keeps retrying `docker wait` while the host stays unreachable, then uses its answer', () => {
      const world = makeWorld({
        sshBody: [
          dropRun,
          'case "$remote" in *"docker wait"*)',
          '  n=$(cat "$STUB_LOGS/wait-attempts" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_LOGS/wait-attempts"',
          '  [ "$n" -ge 3 ] || exit 255 ;;',
          'esac',
        ].join('\n'),
      });
      const result = launch(world, { STUB_WAIT_PRINTS: '0' });
      expect(result.status).toBe(0);
      expect(log(world, 'wait-attempts').trim()).toBe('3');
      expect(log(world, 'sleep.log').trim().split('\n')).toEqual(['sleep 15', 'sleep 15']);
    });

    it('exits 1 when the host stays unreachable past the retry budget', () => {
      const world = makeWorld({
        sshBody: [dropRun, 'case "$remote" in *"docker wait"*) exit 255 ;; esac'].join('\n'),
      });
      const result = launch(world, { HARMONY_DOCKER_HOST_WAIT_BUDGET_S: '30' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('stayed unreachable for 30s');
    });

    it('exits 1 when the host answers but the container cannot be found', () => {
      const world = makeWorld({
        sshBody: dropRun,
        dockerBody:
          'if [ "$1" = wait ]; then echo "Error response from daemon: No such container: $2" >&2; exit 1; fi',
      });
      const result = launch(world);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`could not find harmony-worker-${CONDUCTION_ID} on the host`);
      expect(result.stderr).toContain('No such container');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Reap + probe.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASH_AVAILABLE)('docker-host-worker-reap.sh: the three-way exit-code contract (EXECUTED)', () => {
  function reap(opts: WorldOptions, env: Record<string, string> = {}) {
    const world = makeWorld(opts);
    mkdirSync(world.localRunDir, { recursive: true });
    writeFileSync(join(world.localRunDir, 'run.env'), `GIT_TOKEN=${TOKEN}\n`);
    writeFileSync(join(world.localRunDir, 'run-config.json'), '{}');
    mkdirSync(world.remoteRunDir, { recursive: true });
    writeFileSync(join(world.remoteRunDir, 'run.env'), `GIT_TOKEN=${TOKEN}\n`);
    const result = run(world, reapScriptPath, [CONDUCTION_ID, TICKET], env);
    return { world, result };
  }

  function expectLocalFilesGone(world: World) {
    expect(existsSync(join(world.localRunDir, 'run.env'))).toBe(false);
    expect(existsSync(join(world.localRunDir, 'run-config.json'))).toBe(false);
  }

  it('exits 0 when a container was removed, force-removing it BY NAME, and cleans both sides\' run.env', () => {
    const { world, result } = reap({ dockerBody: 'if [ "$1" = ps ]; then echo 3f2a9c1b7d5e; exit 0; fi' });
    expect(result.status).toBe(0);
    expect(dockerCalls(world)).toContainEqual(['rm', '-f', `harmony-worker-${CONDUCTION_ID}`]);
    expectLocalFilesGone(world);
    expect(existsSync(join(world.remoteRunDir, 'run.env'))).toBe(false);
  });

  it('exits 3 on "No such container" with a non-zero docker exit (older Docker)', () => {
    const { world, result } = reap({
      dockerBody:
        'if [ "$1" = ps ]; then echo 3f2a9c1b7d5e; exit 0; fi; if [ "$1" = rm ]; then echo "Error response from daemon: No such container: $3" >&2; exit 1; fi',
    });
    expect(result.status).toBe(3);
    expectLocalFilesGone(world);
  });

  it('exits 3 on "No such container" even when docker itself exits 0 (current Docker\'s `rm -f` on an absent container)', () => {
    const { result } = reap({
      dockerBody:
        'if [ "$1" = ps ]; then echo 3f2a9c1b7d5e; exit 0; fi; if [ "$1" = rm ]; then echo "Error response from daemon: No such container: $3" >&2; exit 0; fi',
    });
    expect(result.status).toBe(3);
  });

  it('exits 3 when the host has NO such container, without calling `rm` — Docker 29 prints nothing and exits 0 for `rm -f` on an absent container', () => {
    const { world, result } = reap({ dockerBody: 'if [ "$1" = ps ]; then exit 0; fi' });
    expect(result.status).toBe(3);
    expect(dockerCalls(world).some((c) => c[0] === 'rm')).toBe(false);
    expectLocalFilesGone(world);
  });

  it('falls through to `rm -f` and reports its error when the existence check itself fails (engine down)', () => {
    const { result } = reap({
      dockerBody: 'if [ "$1" = ps ]; then exit 1; fi; if [ "$1" = rm ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot connect to the Docker daemon');
  });

  it('exits 1 and prints the captured output on any other error — not swallowed into 0 or 3', () => {
    const { world, result } = reap({
      dockerBody:
        'if [ "$1" = ps ]; then echo 3f2a9c1b7d5e; exit 0; fi; if [ "$1" = rm ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot connect to the Docker daemon');
    expectLocalFilesGone(world);
  });

  it('exits 3 for an UNREACHABLE host — a host that is off has no worker — and still cleans the local files', () => {
    const { world, result } = reap({ sshBody: 'echo "ssh: connect to host: Operation timed out" >&2; exit 255' });
    expect(result.status).toBe(3);
    expectLocalFilesGone(world);
  });

  it('exits 1 with a clear message when no SSH target is configured (never a silent "nothing to reap")', () => {
    const { world, result } = reap({}, { STUB_CFG_SSH_TARGET: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no Docker host is configured');
    expectLocalFilesGone(world);
  });
});

describe.skipIf(!BASH_AVAILABLE)('docker-host-worker-probe.sh (EXECUTED)', () => {
  function probe(opts: WorldOptions) {
    const world = makeWorld(opts);
    return { world, result: run(world, probeScriptPath, [CONDUCTION_ID, TICKET]) };
  }

  it('exits 0 when the worker container is running, asking with an ANCHORED name filter', () => {
    const { world, result } = probe({ dockerBody: 'if [ "$1" = ps ]; then echo 3f2a9c1b7d5e; exit 0; fi' });
    expect(result.status).toBe(0);
    expect(dockerCalls(world)).toEqual([
      ['ps', '--filter', `name=^harmony-worker-${CONDUCTION_ID}$`, '--filter', 'status=running', '-q'],
    ]);
  });

  it('exits 1 when nothing is running', () => {
    expect(probe({ dockerBody: 'if [ "$1" = ps ]; then exit 0; fi' }).result.status).toBe(1);
  });

  it('exits 1 — not running, never an error — when the host is unreachable', () => {
    expect(probe({ sshBody: 'exit 255' }).result.status).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The host's idle check.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASH_AVAILABLE)('docker-host/idle.sh (EXECUTED — no Docker, no systemd)', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const MIN = 60;
  const DAY = 86400;

  interface IdleSetup {
    /** Seconds ago the launch stamp was last touched; omit for "no stamp at all". */
    stampAgeS?: number;
    uptimeS: number;
    workerRunning?: boolean;
    /** ticket -> seconds ago its engine-volume stamp was touched. */
    volumeStamps?: Record<string, number>;
    /** Tickets whose volume `docker volume rm` refuses (still in use). */
    volumesInUse?: string[];
    defaultsFile?: string;
    env?: Record<string, string>;
  }

  function runIdle(setup: IdleSetup) {
    const dir = mkdtempSync(join(tmpdir(), 'b708-idle-'));
    const home = join(dir, 'home');
    const root = join(home, '.harmony-conductions');
    const stamps = join(root, '.engine-volumes');
    mkdirSync(stamps, { recursive: true });
    const stamp = join(root, '.last-launch');
    if (setup.stampAgeS !== undefined) {
      writeFileSync(stamp, '');
      utimesSync(stamp, NOW - setup.stampAgeS, NOW - setup.stampAgeS);
    }
    for (const [ticket, ageS] of Object.entries(setup.volumeStamps ?? {})) {
      writeFileSync(join(stamps, ticket), '');
      utimesSync(join(stamps, ticket), NOW - ageS, NOW - ageS);
    }
    const dockerLog = join(dir, 'docker.log');
    const docker = join(dir, 'docker');
    writeFileSync(
      docker,
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> '${dockerLog}'`,
        'case "$1 $2" in',
        `  "ps --filter") ${setup.workerRunning ? 'echo 3f2a9c1b7d5e' : ':'} ;;`,
        '  "volume rm")',
        `    case " ${(setup.volumesInUse ?? []).map((t) => `harmony-engine-${t}`).join(' ')} " in`,
        '      *" $3 "*) echo "Error response from daemon: volume is in use" >&2; exit 1 ;;',
        '    esac ;;',
        '  "volume inspect") exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    if (setup.defaultsFile !== undefined) writeFileSync(join(dir, 'defaults'), setup.defaultsFile);
    const slept = join(dir, 'slept');
    const result = spawnSync('bash', [idleScriptPath], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HARMONY_IDLE_DEFAULTS: join(dir, 'defaults'),
        HARMONY_IDLE_HOME: home,
        HARMONY_IDLE_NOW: String(NOW),
        HARMONY_IDLE_UPTIME_S: String(setup.uptimeS),
        HARMONY_IDLE_DOCKER: docker,
        HARMONY_HOST_USER: userInfo().username,
        SLEEP_CMD: `touch '${slept}'`,
        ...setup.env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      slept: existsSync(slept),
      dockerLog: existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : '',
      stamp,
      stampNames: readdirSync(stamps).sort(),
    };
  }

  it('powers off when BOTH the launch stamp and the uptime are older than the limit', () => {
    const result = runIdle({ stampAgeS: 120 * MIN, uptimeS: 120 * MIN });
    expect(result.status).toBe(0);
    expect(result.slept).toBe(true);
    expect(result.stdout).toContain('idle for 120 minutes (limit 30)');
  });

  it('does NOT power off a freshly woken host: an old stamp but a short uptime', () => {
    // The stamp is as old as the last launch; the launch that woke the host has not arrived yet.
    const result = runIdle({ stampAgeS: 3 * DAY, uptimeS: 10 * MIN });
    expect(result.status).toBe(0);
    expect(result.slept).toBe(false);
  });

  it('does NOT power off when a launch happened recently, however long the host has been up', () => {
    expect(runIdle({ stampAgeS: 5 * MIN, uptimeS: 3 * DAY }).slept).toBe(false);
  });

  it('sits exactly on the limit: 29 idle minutes stays up, 30 powers off', () => {
    expect(runIdle({ stampAgeS: 29 * MIN + 59, uptimeS: DAY }).slept).toBe(false);
    expect(runIdle({ stampAgeS: 30 * MIN, uptimeS: DAY }).slept).toBe(true);
  });

  it('with no launch stamp at all, counts from boot', () => {
    expect(runIdle({ uptimeS: 10 * MIN }).slept).toBe(false);
    expect(runIdle({ uptimeS: 120 * MIN }).slept).toBe(true);
  });

  it('NEVER powers off while a worker is running — and refreshes the launch stamp instead', () => {
    const result = runIdle({ stampAgeS: 3 * DAY, uptimeS: 3 * DAY, workerRunning: true });
    expect(result.status).toBe(0);
    expect(result.slept).toBe(false);
    expect(result.dockerLog).toContain('ps --filter name=^harmony-worker- --filter status=running -q');
    expect(result.dockerLog).not.toContain('volume rm');
    // Touched "now" (the real clock), so the idle clock restarts when the worker stops.
    expect(statSync(result.stamp).mtimeMs / 1000).toBeGreaterThan(NOW - 60);
  });

  it('before powering off, removes ONLY the engine volumes whose ticket stamp is older than PRUNE_DAYS', () => {
    const result = runIdle({
      stampAgeS: 120 * MIN,
      uptimeS: 120 * MIN,
      volumeStamps: { 'B-OLD': 10 * DAY, 'B-RECENT': 1 * DAY },
    });
    expect(result.slept).toBe(true);
    expect(result.dockerLog).toContain('volume rm harmony-engine-B-OLD');
    expect(result.dockerLog).not.toContain('harmony-engine-B-RECENT');
    expect(result.stampNames).toEqual(['B-RECENT']);
  });

  it('a volume still in use is left (its stamp too) and the host still powers off', () => {
    const result = runIdle({
      stampAgeS: 120 * MIN,
      uptimeS: 120 * MIN,
      volumeStamps: { 'B-BUSY': 10 * DAY },
      volumesInUse: ['B-BUSY'],
    });
    expect(result.status).toBe(0);
    expect(result.slept).toBe(true);
    expect(result.stampNames).toEqual(['B-BUSY']);
  });

  it('does not prune when it is not going to power off', () => {
    const result = runIdle({ stampAgeS: 5 * MIN, uptimeS: DAY, volumeStamps: { 'B-OLD': 10 * DAY } });
    expect(result.slept).toBe(false);
    expect(result.dockerLog).not.toContain('volume rm');
  });

  it('reads IDLE_MINUTES / PRUNE_DAYS from the defaults file, and the environment wins over it', () => {
    const fromFile = runIdle({
      stampAgeS: 10 * MIN,
      uptimeS: DAY,
      volumeStamps: { 'B-TWO-DAYS': 2 * DAY },
      defaultsFile: 'IDLE_MINUTES=5\nPRUNE_DAYS=1\nSLEEP_CMD="exit 9"\n',
    });
    // IDLE_MINUTES=5 and PRUNE_DAYS=1 came from the file; SLEEP_CMD came from the environment.
    expect(fromFile.slept).toBe(true);
    expect(fromFile.dockerLog).toContain('volume rm harmony-engine-B-TWO-DAYS');

    const envWins = runIdle({
      stampAgeS: 10 * MIN,
      uptimeS: DAY,
      defaultsFile: 'IDLE_MINUTES=5\n',
      env: { IDLE_MINUTES: '60' },
    });
    expect(envWins.slept).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// provision.sh's engine-start block.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!BASH_AVAILABLE)('provision.sh: B-708 container-runtime block (EXTRACTED and EXECUTED)', () => {
  const provisionScript = readFileSync(provisionPath, 'utf8');
  const START_SCRIPT = '/usr/local/bin/harmony-start-dockerd';

  function extractBlock(): string {
    const start = provisionScript.indexOf('# --- B-708: ');
    const end = provisionScript.indexOf('# --- end B-708 ', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return provisionScript.slice(start, end);
  }

  /** Runs the real block with the start script's fixed path re-pointed into a temp dir (the only
   *  edit — the path is root-owned on a real image), and stub `sudo` / `docker` on PATH.
   *  `startScript: null` = the image without the engine layer. */
  function runBlock(startScript: string | null) {
    const dir = mkdtempSync(join(tmpdir(), 'b708-provision-'));
    const home = join(dir, 'home');
    const bin = join(dir, 'bin');
    mkdirSync(home);
    mkdirSync(bin);
    const startPath = join(dir, 'harmony-start-dockerd');
    if (startScript !== null) writeFileSync(startPath, `#!/bin/sh\n${startScript}\n`, { mode: 0o755 });
    // sudo -n <cmd>: record the argv, then run it.
    writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash\necho "$*" >> '${join(dir, 'sudo.log')}'\nshift\nexec "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\necho "Docker version 99.0.0, build b708"\n', { mode: 0o755 });

    const block = extractBlock();
    expect(block).toContain(START_SCRIPT);
    const harness = join(dir, 'harness.sh');
    writeFileSync(
      harness,
      ['#!/usr/bin/env bash', 'set -euo pipefail', block.split(START_SCRIPT).join(startPath), 'echo "LEG CONTINUES"', ''].join('\n'),
    );
    chmodSync(harness, 0o700);
    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      cwd: home,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      homeEntries: readdirSync(home),
      sudoLog: existsSync(join(dir, 'sudo.log')) ? readFileSync(join(dir, 'sudo.log'), 'utf8') : '',
      startPath,
    };
  }

  it('does NOTHING AT ALL when the start script is absent: no output, no file, no sudo', () => {
    const result = runBlock(null);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LEG CONTINUES\n');
    expect(result.stderr).toBe('');
    expect(result.homeEntries).toEqual([]);
    expect(result.sudoLog).toBe('');
  });

  it('starts the engine through `sudo -n` and prints ONE ready line when it comes up', () => {
    const result = runBlock('exit 0');
    expect(result.status).toBe(0);
    expect(result.sudoLog).toBe(`-n ${result.startPath}\n`);
    expect(result.stdout).toBe(
      'provision.sh: container runtime ready (Docker version 99.0.0, build b708)\nLEG CONTINUES\n',
    );
    expect(result.stderr).toBe('');
  });

  it('is NON-FATAL: a failed start warns on stderr and the leg continues', () => {
    const result = runBlock('echo "harmony-start-dockerd: dockerd exited" >&2; exit 1');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('LEG CONTINUES\n');
    expect(result.stderr).toContain('WARNING — the container runtime is not available in this leg');
    expect(result.stderr).toContain('the engine did not start; the worker is probably not privileged');
  });

  it('sits AFTER the toolchain activation and BEFORE the mode hand-off, and names the real baked path', () => {
    const toolchainAt = provisionScript.indexOf('# --- B-929: per-repo toolchain activation');
    const blockAt = provisionScript.indexOf('# --- B-708: ');
    const handOffAt = provisionScript.indexOf('# --- Hand off.');
    expect(toolchainAt).toBeGreaterThan(0);
    expect(blockAt).toBeGreaterThan(toolchainAt);
    expect(handOffAt).toBeGreaterThan(blockAt);
    // The path provision.sh tests and the path the engine image bakes are the same string.
    const engineDockerfile = readFileSync(repoPath('container/docker-engine/Dockerfile'), 'utf8');
    expect(engineDockerfile).toContain(`COPY start-dockerd.sh ${START_SCRIPT}`);
    expect(engineDockerfile).toContain(`worker ALL=(root) NOPASSWD: ${START_SCRIPT}`);
  });
});
