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

/**
 * Resolve the base env-file CONTENT for composeEnvFile. B-800: when a deployment config file
 * exists at the resolved path, its `env` section WINS over `--base <file>` — the deployment
 * config is the new source of truth for the worker base env. Falls back to reading `--base <file>`
 * UNCHANGED when no deployment config exists at the resolved path (most machines today —
 * graceful degradation, same convention as src/config/deployment-config.ts's own loader). A
 * deployment config that EXISTS but is malformed JSON throws — a typo in a file you meant to be
 * read must never fail silently.
 *
 * `existsImpl`/`readImpl` are injectable so this is unit-testable without touching the real
 * filesystem (mirrors src/config/deployment-config.test.ts's fakeFs style).
 */
export function resolveBaseContent({
  base,
  configPath,
  env = process.env,
  existsImpl = existsSync,
  readImpl = (p) => readFileSync(p, 'utf8'),
}) {
  const resolvedConfigPath = resolveDeploymentConfigPath({ configPath, env });
  if (existsImpl(resolvedConfigPath)) {
    let raw;
    try {
      raw = readImpl(resolvedConfigPath);
    } catch (err) {
      throw new Error(`could not read deployment config at ${resolvedConfigPath}: ${err.message}`, {
        cause: err,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `deployment config at ${resolvedConfigPath} is not valid JSON: ${err.message}`,
        { cause: err },
      );
    }
    return `${flattenEnvSection(parsed.env)}${serializeReposSection(parsed.repos)}`;
  }
  // No deployment config at the resolved path — fall back to --base <file>, unchanged behavior.
  return base ? readImpl(base) : '';
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
 * These four small pure functions compose the lines/paths mint-installation-token.mjs's `main()`
 * appends to the SAME per-run env-file GIT_TOKEN already rides — never a new file/channel, except
 * for the run-config JSON payload itself when a container-side mount path is also given (see
 * runConfigFilePathFor below), which reuses writeEnvFile's mode-0600 write, same as the env-file
 * itself. See src/config/run-config.ts for the worker-side accessor these lines feed.
 */

/** 'HARMONY_CONDUCTION_ID=<id>\n', or '' when no conduction id was given — always appended when
 *  present, independent of whether --run-config was also given. */
export function composeConductionIdLine(conductionId) {
  return conductionId ? `HARMONY_CONDUCTION_ID=${conductionId}\n` : '';
}

/** 'HARMONY_RUN_CONFIG_JSON=<base64 of the JSON>\n', or '' when no run-config JSON was given.
 *  Base64, not raw JSON — the same reason serializeReposSection base64-encodes HARMONY_REPOS_JSON:
 *  this line also has to survive container/cloud-worker-launch.sh's YAML embedding on the cloud
 *  path, where raw JSON's embedded double quotes would break naive printf-quoting. Used for the
 *  INLINE delivery form (cloud profile: no --run-config-path given). */
export function composeRunConfigInlineLine(runConfigJson) {
  if (!runConfigJson) return '';
  const encoded = Buffer.from(runConfigJson, 'utf8').toString('base64');
  return `HARMONY_RUN_CONFIG_JSON=${encoded}\n`;
}

/** 'HARMONY_RUN_CONFIG_PATH=<container-side path>\n', or '' when no run-config path was given.
 *  Used for the MOUNTED-FILE delivery form (local docker profile) — the path itself is the only
 *  thing that rides the env-file; the JSON content rides the mounted file at that path, never
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

/** Exchange the App JWT for a ~1h installation token. */
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

  const { token } = await response.json();
  if (!token) throw new Error('GitHub returned no token in the access_tokens response');
  return token;
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
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--conduction-id') args.conductionId = argv[++i];
    else if (argv[i] === '--run-config') args.runConfig = argv[++i];
    else if (argv[i] === '--run-config-path') args.runConfigPath = argv[++i];
  }
  if (!args.out) {
    throw new Error(
      'Usage: mint-installation-token.mjs --out <per-run env-file> [--base <static env-file>] ' +
        '[--config <deployment-config path>] [--conduction-id <uuid>] ' +
        "[--run-config <json-string>] [--run-config-path <container-side path>]",
    );
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { base, out, config, conductionId, runConfig, runConfigPath } = parseArgs(argv);

  const appId = env.HARMONY_APP_ID;
  const installationId = env.HARMONY_APP_INSTALLATION_ID;
  if (!appId) throw new Error('HARMONY_APP_ID is required (the harmony-daemon App id)');
  if (!installationId) {
    throw new Error('HARMONY_APP_INSTALLATION_ID is required (the App installation to mint for)');
  }

  const jwt = buildJwt({ appId, privateKey: readPrivateKey(env) });
  const token = await mintInstallationToken({ jwt, installationId });

  // B-800: the deployment config's `env` section wins over --base when present; see
  // resolveBaseContent's own doc comment for the full precedence + malformed-JSON behavior.
  const baseContent = resolveBaseContent({ base, configPath: config, env });
  let envFileContent = composeEnvFile({ baseContent, token });

  // B-846: run-config seam. --run-config omitted entirely -> neither line below is appended,
  // preserving today's behavior byte-for-byte for any caller that doesn't pass it. Given
  // --run-config, --run-config-path selects the delivery form: WITH a path, the JSON content is
  // written to its own mode-0600 sibling file (never argv/shell-interpolated) and only the PATH
  // rides the env-file; WITHOUT one, the JSON content itself rides the env-file inline (base64).
  if (runConfig && runConfigPath) {
    const runConfigFilePath = runConfigFilePathFor(out);
    writeEnvFile(runConfigFilePath, runConfig);
    envFileContent += composeRunConfigPathLine(runConfigPath);
  } else if (runConfig) {
    envFileContent += composeRunConfigInlineLine(runConfig);
  }
  envFileContent += composeConductionIdLine(conductionId);

  writeEnvFile(out, envFileContent);

  // Print the PATH, never the token — this line lands in daemon logs.
  process.stdout.write(`${out}\n`);
}

// Run only when invoked directly, so the pure helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
