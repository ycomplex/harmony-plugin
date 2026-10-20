#!/usr/bin/env node
// B-732: mint a harmony-daemon GitHub App installation token and compose the per-run env-file
// the worker container is launched with.
//
// WHY THIS RUNS OUTSIDE THE CONTAINER. The container's entrypoint needs a credential to CLONE the
// plugin repo, but this script lives IN that repo — minting inside provision.sh would leave the
// clone authenticating as something else, putting two credentials in play and splitting the very
// identity B-732 exists to unify. So the launcher mints, and the container just receives a token.
//
// WHY IT WRITES THE FILE ITSELF. The token must never reach the host process table. Passing it as
// `docker run -e GIT_TOKEN=ghs_…` is readable by anything running as the launching user, and even
// `echo "GIT_TOKEN=$(mint)"` risks shell/argv exposure. This script writes a mode-0600 env-file
// directly and prints only the PATH, so the secret never crosses a command line.
//
// Zero runtime dependencies by design: Node's built-in crypto signs the RS256 JWT and the global
// fetch exchanges it. The container clones this repo and runs committed dist with no npm install,
// so a new dependency here would be real friction.
//
// B-800 AC5 (documented per-deployment fact, not a code migration): HARMONY_APP_ID,
// HARMONY_APP_INSTALLATION_ID and HARMONY_APP_PRIVATE_KEY_PATH below are the launcher-host's
// GitHub App identity, conceptually launcher.github_app.{app_id,installation_id,private_key_path}
// in ~/.harmony/deployment.json (src/config/deployment-config.ts) going forward — this script's
// actual read path stays these three env vars, deliberately NOT importing the TS-built
// deployment-config loader here: doing so would require a build step (or a hand-duplicated
// parser) in a script whose whole design point is zero-dependency, no-build simplicity. Set them
// on the launcher host from your deployment config's launcher.github_app section.
//
// B-800 item 2: `--base <file>`'s CONTENT, however, IS wired to the deployment config now — when
// one exists at the resolved path, its `env` section (flattened to KEY=value lines) supplies the
// base content composeEnvFile substitutes GIT_TOKEN into, taking precedence over `--base <file>`.
// Still zero-dependency: a plain `JSON.parse(readFileSync(...))` here, never the compiled
// src/config/deployment-config.js loader — same reasoning as the AC5 note above.

import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';

/** GitHub caps an App JWT at 10 minutes; 9 leaves headroom without hugging the limit. */
const JWT_LIFETIME_SECONDS = 540;
/** Backdate `iat` to absorb clock skew between this host and GitHub, per GitHub's own guidance. */
const JWT_CLOCK_SKEW_SECONDS = 60;

const b64url = (input) => Buffer.from(input).toString('base64url');

/**
 * Build the RS256 App JWT GitHub exchanges for an installation token.
 * Pure and injectable-clock so the claim shape is unit-testable without minting anything real.
 */
export function buildJwt({ appId, privateKey, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!appId) throw new Error('appId is required to build the App JWT');
  if (!privateKey) throw new Error('privateKey is required to build the App JWT');

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: String(appId),
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`;
}

/**
 * Compose the per-run env-file: the launcher's base env-file with the minted token substituted in.
 *
 * The base file ALREADY carries a GIT_TOKEN — the founder PAT the container used before B-732. We
 * STRIP it rather than appending after it, because relying on `--env-file` duplicate-key precedence
 * would make bot authorship depend on parser behaviour. If the stale PAT ever won, a worker run
 * would produce a founder-authored PR that merges through the bypass — precisely the fail-open this
 * ticket exists to close. Stripping makes the outcome independent of Docker's parsing order.
 */
export function composeEnvFile({ baseContent, token }) {
  if (!token) throw new Error('token is required to compose the env-file');

  const kept = baseContent
    .split('\n')
    .filter((line) => !/^\s*GIT_TOKEN\s*=/.test(line))
    .join('\n')
    .replace(/\n+$/, '');

  return `${kept ? `${kept}\n` : ''}GIT_TOKEN=${token}\n`;
}

/**
 * Resolve the deployment config file path: an explicit configPath > HARMONY_DEPLOYMENT_CONFIG >
 * the single-deployment default ~/.harmony/deployment.json. Duplicates
 * src/config/deployment-config.ts's resolveDeploymentConfigPath precedence exactly (NOT imported —
 * see the header comment's zero-dependency constraint).
 */
export function resolveDeploymentConfigPath({ configPath, env = process.env } = {}) {
  if (configPath) return configPath;
  if (env.HARMONY_DEPLOYMENT_CONFIG) return env.HARMONY_DEPLOYMENT_CONFIG;
  return join(homedir(), '.harmony', 'deployment.json');
}

/**
 * Flatten a deployment config's `env` section ({ KEY: "value", ... }) into the `KEY=value\n` line
 * shape composeEnvFile already expects as baseContent — the same shape a flat env file has.
 * Skips null/undefined values (a key present but unset in the config). Returns '' for an absent or
 * empty `env` section.
 */
export function flattenEnvSection(envSection) {
  if (!envSection || typeof envSection !== 'object') return '';
  const lines = Object.entries(envSection)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

/**
 * Serialize a deployment config's `repos` section (B-814: the ordered repo-set list, see
 * src/config/deployment-config.ts's RepoEntrySchema) into a single `HARMONY_REPOS_JSON=<value>\n`
 * line, in the same KEY=value shape flattenEnvSection produces — merged alongside it so
 * container/entrypoint.sh reaches the SAME channel every other deployment-config value does,
 * rather than a separate ad hoc one (the constraint this ticket was accepted under).
 *
 * The value is base64-encoded JSON, not raw JSON: this one var also has to survive
 * container/cloud-worker-launch.sh's write_exec_env_file(), which embeds it in a `KEY: "value"`
 * YAML line — raw JSON's embedded double quotes would break that naive printf-quoting. Base64's
 * alphabet (A-Za-z0-9+/=) is safe to embed unescaped in either shape, so entrypoint.sh decodes the
 * SAME way regardless of which path (local or cloud) produced it.
 *
 * Returns '' for an absent, empty, or non-array `repos` section — same absent-section-is-a-no-op
 * convention as flattenEnvSection.
 */
export function serializeReposSection(reposSection) {
  if (!Array.isArray(reposSection) || reposSection.length === 0) return '';
  const encoded = Buffer.from(JSON.stringify(reposSection), 'utf8').toString('base64');
  return `HARMONY_REPOS_JSON=${encoded}\n`;
}

/** B-1183: how long one `harmony config get` may run before the mint script gives up on it. */
const CONFIG_GET_TIMEOUT_MS = 20_000;

/**
 * B-1183: read one top-level section (`env`, `repos`) of the MERGED deployment config through
 * `node $HARMONY_PLUGIN_DIR/dist/bin/harmony.js config get <key>` — the same channel the launch
 * scripts use, so a host whose config lives in .harmony/conductor.json + the host file (no
 * deployment.json) still hands its legs their env. Zero-dependency: a child process, not an import.
 *
 * Returns { status: 'ok', stdout } | { status: 'unset' } (the CLI's clean "not configured" exit 1) |
 * { status: 'failed', reason, unavailable? } (CLI missing, timeout, crash, any other exit, empty output). It never
 * throws: the caller decides what a failure means.
 */
export function runConfigGet(key, { env = process.env, configPath, spawnImpl = spawnSync, existsImpl = existsSync } = {}) {
  const pluginDir = env.HARMONY_PLUGIN_DIR;
  if (!pluginDir) return { status: 'failed', unavailable: true, reason: 'HARMONY_PLUGIN_DIR is not set' };
  const cli = join(pluginDir, 'dist', 'bin', 'harmony.js');
  if (!existsImpl(cli)) return { status: 'failed', unavailable: true, reason: `${cli} does not exist` };
  const timeout = Number(env.HARMONY_CONFIG_GET_TIMEOUT_MS) > 0 ? Number(env.HARMONY_CONFIG_GET_TIMEOUT_MS) : CONFIG_GET_TIMEOUT_MS;
  const r = spawnImpl(process.execPath, [cli, 'config', 'get', key, ...(configPath ? ['--config', configPath] : [])], {
    env,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    return { status: 'failed', reason: r.error.code === 'ETIMEDOUT' ? `timed out after ${timeout}ms` : `could not run (${r.error.message})` };
  }
  if (r.status === null) return { status: 'failed', reason: `killed by ${r.signal ?? 'a signal'}` };
  if (r.status === 1 && /is not set in|no deployment config found/.test(r.stderr ?? '')) return { status: 'unset' };
  if (r.status !== 0) return { status: 'failed', reason: `exited ${r.status}` };
  if (!(r.stdout ?? '').trim()) return { status: 'failed', reason: 'printed nothing' };
  return { status: 'ok', stdout: r.stdout };
}

const isEmptySection = (v) =>
  v === undefined || v === null || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);

/** `KEY` of a `KEY=value` env line, or undefined for a blank/comment line. */
const lineKey = (line) => /^\s*([^=\s#][^=\s]*)\s*=/.exec(line)?.[1];

/**
 * Overlay the merged env (key -> value) on `KEY=value` lines: a key already present is replaced IN
 * PLACE, a new one is appended. Keeping the carrier's own order and its keys the loader does not know
 * is what makes a legacy host's env-file byte-identical to what it was before B-1183.
 */
function overlayEnv(carrierLines, mergedEnv) {
  const lines = [...carrierLines];
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined || value === null) continue;
    const at = lines.findIndex((l) => lineKey(l) === key);
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return lines;
}

/** The keys src/config/deployment-config.ts's RepoEntrySchema knows; any other key the loader strips. */
const REPO_ENTRY_KEYS = ['url', 'ref', 'path', 'meta_repo_role', 'is_plugin'];

/** True when the merged repos list says the same thing as the file's: same length, and each file entry,
 *  cut down to the keys the loader keeps, equals the merged entry. (The loader re-orders keys and strips
 *  unknown ones, so a plain string compare would call a legacy file "different".) */
function sameRepos(fileRepos, mergedRepos) {
  if (!Array.isArray(fileRepos) || !Array.isArray(mergedRepos) || fileRepos.length !== mergedRepos.length) return false;
  return mergedRepos.every((m, i) => {
    const f = fileRepos[i];
    if (!f || typeof f !== 'object' || !m || typeof m !== 'object') return false;
    return (
      Object.keys(m).every((k) => JSON.stringify(f[k]) === JSON.stringify(m[k])) &&
      Object.keys(f).every((k) => k in m || !REPO_ENTRY_KEYS.includes(k))
    );
  });
}

/**
 * Resolve the base env-file CONTENT for composeEnvFile.
 *
 * B-1183: the env and repos come from the MERGED config (`harmony config get env` / `repos`, see
 * runConfigGet) — project file < host file < deployment.json, the same view the launch scripts have —
 * so a host that has no deployment.json at all still launches legs with its HARMONY_TARGET, repos, etc.
 * When the CLI is unusable (missing, timeout, non-zero exit, empty output) AND deployment.json exists,
 * its raw `env`/`repos` sections are used instead and the problem is logged ONCE on stderr: a leg is never
 * launched with a silently smaller env. deployment.json is also the byte-order carrier: its own key
 * order, and any key the loader would strip, survive, with the merged values overlaid on top.
 *
 * B-800 (unchanged): a deployment config that EXISTS but is malformed JSON throws. With neither a
 * deployment config nor a usable merged config, `--base <file>` is read as before (most machines
 * today); when only the merged config exists, that file's lines are the carrier.
 *
 * `existsImpl`/`readImpl`/`cliImpl`/`log` are injectable so this is unit-testable without touching the
 * real filesystem or spawning a CLI (mirrors src/config/deployment-config.test.ts's fakeFs style).
 */
export function resolveBaseContent({
  base,
  configPath,
  env = process.env,
  existsImpl = existsSync,
  readImpl = (p) => readFileSync(p, 'utf8'),
  cliImpl = (key) => runConfigGet(key, { env, configPath }),
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  const resolvedConfigPath = resolveDeploymentConfigPath({ configPath, env });
  let parsed;
  if (existsImpl(resolvedConfigPath)) {
    let raw;
    try {
      raw = readImpl(resolvedConfigPath);
    } catch (err) {
      throw new Error(`could not read deployment config at ${resolvedConfigPath}: ${err.message}`, {
        cause: err,
      });
    }
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `deployment config at ${resolvedConfigPath} is not valid JSON: ${err.message}`,
        { cause: err },
      );
    }
  }

  // One section from the merged config: { value } when usable, { problem } when not, {} when the CLI
  // cleanly says it is not configured.
  const problems = [];
  let loud = false; // a failure worth reporting even with no deployment.json to fall back on
  const fromCli = (key) => {
    const r = cliImpl(key);
    if (r.status === 'unset') {
      // The CLI only says "unset" for a file that has no such section; if ours has one, they disagree.
      if (parsed && !isEmptySection(parsed[key])) problems.push(`\`config get ${key}\` said it is not set`);
      return {};
    }
    if (r.status !== 'ok') {
      problems.push(`\`config get ${key}\` ${r.reason}`);
      if (!r.unavailable) loud = true;
      return {};
    }
    let value;
    try {
      value = JSON.parse(r.stdout);
    } catch {
      problems.push(`\`config get ${key}\` printed something that is not JSON`);
      loud = true;
      return {};
    }
    if (isEmptySection(value) && parsed && !isEmptySection(parsed[key])) {
      problems.push(`\`config get ${key}\` came back empty`);
      return {};
    }
    return { value };
  };
  const mergedEnv = fromCli('env').value;
  const mergedRepos = fromCli('repos').value;
  if (problems.length > 0 && (parsed || loud)) {
    log(
      `mint-installation-token: ${problems.join('; ')}; ${parsed ? `using ${resolvedConfigPath} directly` : 'no deployment config to fall back on'}`,
    );
  }

  if (!parsed && mergedEnv === undefined && mergedRepos === undefined) {
    // No deployment config and nothing merged — fall back to --base <file>, unchanged behavior.
    return base ? readImpl(base) : '';
  }

  const carrier = parsed
    ? Object.entries(parsed.env && typeof parsed.env === 'object' ? parsed.env : {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${value}`)
    : base && existsImpl(base)
      ? readImpl(base).split('\n').filter(Boolean)
      : [];
  const envLines = overlayEnv(carrier, isEmptySection(mergedEnv) ? {} : mergedEnv);
  const envPart = envLines.length ? `${envLines.join('\n')}\n` : '';
  const repos = mergedRepos !== undefined && !(parsed && sameRepos(parsed.repos, mergedRepos)) ? mergedRepos : parsed?.repos;
  return `${envPart}${serializeReposSection(repos)}`;
}

/**
 * Write the env-file so it is owner-read/write only, from the moment it exists.
 * Remove-then-create rather than a plain write: `writeFileSync`'s mode only applies when the file
 * is CREATED, so overwriting a pre-existing world-readable file would silently keep its old mode.
 */
export function writeEnvFile(path, content) {
  rmSync(path, { force: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // belt-and-braces against a permissive umask
}

/**
 * B-846: the run-config plumbing seam's launcher-side half.
 *
 * These small pure functions compose the lines/paths mint-installation-token.mjs's `main()`
 * appends to the SAME per-run env-file GIT_TOKEN already rides — never a new file/channel, except
 * for the run-config JSON payload itself when a container-side mount path is also given (see
 * runConfigFilePathFor below), which reuses writeEnvFile's mode-0600 write, same as the env-file
 * itself. See src/config/run-config.ts for the worker-side accessor these lines feed.
 *
 * B-743: normalizeRunConfigJson (below) is the shared base64-vs-raw detector both delivery forms
 * route through, so this file never assumes which shape `--run-config` arrived in.
 */

/** 'HARMONY_CONDUCTION_ID=<id>\n', or '' when no conduction id was given — always appended when
 *  present, independent of whether --run-config was also given. */
export function composeConductionIdLine(conductionId) {
  return conductionId ? `HARMONY_CONDUCTION_ID=${conductionId}\n` : '';
}

/** B-772: 'HARMONY_MODEL=<model>\n', or '' when no model was resolved — mirrors
 *  composeConductionIdLine's own always-appended-when-present convention exactly. The value here
 *  arrives ALREADY fully resolved (src/daemon/scheduler.ts's templateVars -> modelFor ->
 *  src/config/run-config.ts's getModelForGate, the three-level per-gate/per-run/pinned-default
 *  fallback) — this script never re-derives or re-validates it, it only carries the resolved
 *  string across the process boundary into the worker's env, the same courier role it already
 *  plays for HARMONY_CONDUCTION_ID. */
export function composeModelLine(model) {
  return model ? `HARMONY_MODEL=${model}\n` : '';
}

/** B-963: 'GIT_TOKEN_EXPIRES_AT=<ISO>\n', or '' when no expiry was reported — mirrors
 *  composeConductionIdLine/composeModelLine's own always-appended-when-present convention. This is
 *  how a worker leg learns its own credential horizon: the GitHub access_tokens response carries
 *  `expires_at` already (an ISO-8601 string, ~1h out); nothing previously read it. The value rides
 *  the SAME per-run env-file GIT_TOKEN already does — never a new channel — so every launch profile
 *  (cloud, local docker, docker-host) carries it for free. It is a timestamp, not a secret. */
export function composeTokenExpiryLine(expiresAt) {
  return expiresAt ? `GIT_TOKEN_EXPIRES_AT=${expiresAt}\n` : '';
}

/** B-1020: 'HARMONY_LEG=<n>\n', or '' when no leg was given — mirrors composeModelLine's own
 *  always-appended-when-present convention exactly. The value here arrives from either an explicit
 *  --leg flag or (the conductor-driven path) this process's own inherited HARMONY_LEG env var —
 *  src/daemon/scheduler.ts's fireLaunch sets it as a per-call `env` option on the runCommand that
 *  spawns this script, and Node's exec() inherits that env into everything it spawns, so this
 *  script never has to re-derive the leg number itself. */
export function composeLegLine(leg) {
  return leg ? `HARMONY_LEG=${leg}\n` : '';
}

/**
 * B-743: normalize a run-config JSON payload that may arrive as EITHER raw JSON text or
 * base64-encoded JSON text, into raw JSON text. Before this ticket, `--run-config`'s value was
 * always raw JSON (src/daemon/scheduler.ts's runConfigJsonFor JSON.stringify'd it and nothing
 * else touched the wire between there and here). B-743 moves that encoding UPSTREAM into
 * scheduler.ts itself (the fix for the single-quote-in-note throw this ticket removes), so the
 * conductor-driven path now hands this script ALREADY-base64 input — but a manual invocation, an
 * older test, or container/cloud-worker-launch.sh's own DEFAULT_RUN_CONFIG='{}' fallback can still
 * hand it raw JSON. Both compose functions below normalize through this ONE detector rather than
 * assuming either shape, so neither can double-encode (base64-of-base64) or write undecoded
 * base64 into the mounted-file delivery form (whose reader, src/config/run-config.ts's
 * getRunConfig, JSON.parses the file directly with NO base64 step).
 *
 * Detection: valid JSON as-is wins (raw) — tried first because raw is byte-identical to itself,
 * the safer default. Only when that fails is the input tried as base64; the DECODED text must
 * itself be valid JSON before it's trusted, so a plain non-JSON, non-base64 string still throws
 * loudly rather than silently degrading. Throws when neither reading produces valid JSON — a
 * malformed run-config payload must fail the mint script, not launch a worker with silently
 * dropped operator input.
 */
export function normalizeRunConfigJson(input) {
  try {
    JSON.parse(input);
    return input;
  } catch {
    // Not raw JSON — fall through to the base64 attempt below.
  }
  let decoded;
  try {
    decoded = Buffer.from(input, 'base64').toString('utf8');
    JSON.parse(decoded);
  } catch {
    throw new Error(
      `--run-config value is neither valid JSON nor base64-encoded JSON: ${input}`,
    );
  }
  return decoded;
}

/** 'HARMONY_RUN_CONFIG_JSON=<base64 of the JSON>\n', or '' when no run-config JSON was given.
 *  Base64, not raw JSON — the same reason serializeReposSection base64-encodes HARMONY_REPOS_JSON:
 *  this line also has to survive container/cloud-worker-launch.sh's YAML embedding on the cloud
 *  path, where raw JSON's embedded double quotes would break naive printf-quoting. Used for the
 *  INLINE delivery form (cloud profile: no --run-config-path given). B-743: normalizes through
 *  normalizeRunConfigJson first, so an ALREADY-base64 input (the conductor-driven path, post
 *  scheduler.ts's upstream encode) is decoded back to raw JSON and re-encoded ONCE — never
 *  double-encoded — while a still-raw input (older/manual callers) is encoded exactly as before. */
export function composeRunConfigInlineLine(runConfigJson) {
  if (!runConfigJson) return '';
  const raw = normalizeRunConfigJson(runConfigJson);
  const encoded = Buffer.from(raw, 'utf8').toString('base64');
  return `HARMONY_RUN_CONFIG_JSON=${encoded}\n`;
}

/** 'HARMONY_RUN_CONFIG_PATH=<container-side path>\n', or '' when no run-config path was given.
 *  Used for the MOUNTED-FILE delivery form (local docker profile) — the path itself is the only
 *  thing that rides the env-file; the JSON content rides the mounted file at that path (written by
 *  main() below, via normalizeRunConfigJson — see that function's own B-743 comment), never
 *  interpolated into the launch command or argv. */
export function composeRunConfigPathLine(runConfigPath) {
  return runConfigPath ? `HARMONY_RUN_CONFIG_PATH=${runConfigPath}\n` : '';
}

/** The run-config file's host-side path: a sibling `run-config.json` next to --out's own file, in
 *  the same (already per-conduction-namespaced) directory — so it shares --out's directory-exists
 *  guarantee without this script needing its own mkdir. */
export function runConfigFilePathFor(outPath) {
  return join(dirname(outPath), 'run-config.json');
}

/** Exchange the App JWT for a ~1h installation token. Also returns the token's own expiry when
 *  GitHub reports one (B-963). */
export async function mintInstallationToken({ jwt, installationId, fetchImpl = fetch }) {
  const response = await fetchImpl(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    // Never echo the response body blindly — it can carry request context. Status + GitHub's
    // message field is enough to diagnose (401 = bad key/app id, 404 = wrong installation id).
    let message = '';
    try {
      message = (await response.json())?.message ?? '';
    } catch {
      /* non-JSON error body — status alone will have to do */
    }
    throw new Error(
      `Minting the installation token failed: HTTP ${response.status}${message ? ` — ${message}` : ''}`,
    );
  }

  const { token, expires_at } = await response.json();
  if (!token) throw new Error('GitHub returned no token in the access_tokens response');
  return { token, expires_at: expires_at ?? null };
}

function readPrivateKey(env) {
  const inline = env.HARMONY_APP_PRIVATE_KEY;
  const path = env.HARMONY_APP_PRIVATE_KEY_PATH;
  if (path) return readFileSync(path, 'utf8');
  if (inline) return inline.includes('\\n') ? inline.replace(/\\n/g, '\n') : inline;
  throw new Error(
    'Set HARMONY_APP_PRIVATE_KEY_PATH (preferred) or HARMONY_APP_PRIVATE_KEY to the harmony-daemon App private key',
  );
}

function parseArgs(argv) {
  const args = {
    base: undefined,
    out: undefined,
    config: undefined,
    conductionId: undefined,
    runConfig: undefined,
    runConfigPath: undefined,
    model: undefined,
    leg: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--conduction-id') args.conductionId = argv[++i];
    else if (argv[i] === '--run-config') args.runConfig = argv[++i];
    else if (argv[i] === '--run-config-path') args.runConfigPath = argv[++i];
    else if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--leg') args.leg = argv[++i];
  }
  if (!args.out) {
    throw new Error(
      'Usage: mint-installation-token.mjs --out <per-run env-file> [--base <static env-file>] ' +
        '[--config <deployment-config path>] [--conduction-id <uuid>] ' +
        "[--run-config <json-string>] [--run-config-path <container-side path>] " +
        '[--model <resolved model alias>] [--leg <n>]',
    );
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const { base, out, config, conductionId, runConfig, runConfigPath, model, leg } = parseArgs(argv);
  // B-1020: --leg wins when given; otherwise fall back to this process's own inherited HARMONY_LEG
  // env var — how fireLaunch's per-call `env` option (scheduler.ts) reaches this script, since it
  // runs as a child process spawned from the same exec() chain.
  const resolvedLeg = leg ?? env.HARMONY_LEG;

  const appId = env.HARMONY_APP_ID;
  const installationId = env.HARMONY_APP_INSTALLATION_ID;
  if (!appId) throw new Error('HARMONY_APP_ID is required (the harmony-daemon App id)');
  if (!installationId) {
    throw new Error('HARMONY_APP_INSTALLATION_ID is required (the App installation to mint for)');
  }

  const jwt = buildJwt({ appId, privateKey: readPrivateKey(env) });
  const { token, expires_at } = await mintInstallationToken({ jwt, installationId });

  // B-800: the deployment config's `env` section wins over --base when present; see
  // resolveBaseContent's own doc comment for the full precedence + malformed-JSON behavior.
  const baseContent = resolveBaseContent({ base, configPath: config, env, ...deps });
  let envFileContent = composeEnvFile({ baseContent, token });

  // B-846: run-config seam. --run-config omitted entirely -> neither line below is appended,
  // preserving today's behavior byte-for-byte for any caller that doesn't pass it. Given
  // --run-config, --run-config-path selects the delivery form: WITH a path, the JSON content is
  // written to its own mode-0600 sibling file (never argv/shell-interpolated) and only the PATH
  // rides the env-file; WITHOUT one, the JSON content itself rides the env-file inline (base64).
  // B-743: the file write normalizes through normalizeRunConfigJson first — the mounted-file
  // reader (src/config/run-config.ts's getRunConfig, path form) JSON.parses the file directly with
  // NO base64 step, so this file must always hold RAW JSON regardless of whether --run-config
  // arrived raw (older/manual callers) or already-base64 (the conductor-driven path, post
  // scheduler.ts's upstream encode).
  if (runConfig && runConfigPath) {
    const runConfigFilePath = runConfigFilePathFor(out);
    writeEnvFile(runConfigFilePath, normalizeRunConfigJson(runConfig));
    envFileContent += composeRunConfigPathLine(runConfigPath);
  } else if (runConfig) {
    envFileContent += composeRunConfigInlineLine(runConfig);
  }
  envFileContent += composeConductionIdLine(conductionId);
  // B-772: same always-appended-when-present convention as composeConductionIdLine above.
  envFileContent += composeModelLine(model);
  // B-963: same convention — the leg's own credential horizon, read from the mint response.
  envFileContent += composeTokenExpiryLine(expires_at);
  // B-1020: same always-appended-when-present convention as composeConductionIdLine/composeModelLine
  // above.
  envFileContent += composeLegLine(resolvedLeg);

  writeEnvFile(out, envFileContent);

  // Print the PATH, never the token — this line lands in conductor logs.
  process.stdout.write(`${out}\n`);
}

// Run only when invoked directly, so the pure helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
