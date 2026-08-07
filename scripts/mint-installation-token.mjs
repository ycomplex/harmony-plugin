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

import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';

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
 * Write the env-file so it is owner-read/write only, from the moment it exists.
 * Remove-then-create rather than a plain write: `writeFileSync`'s mode only applies when the file
 * is CREATED, so overwriting a pre-existing world-readable file would silently keep its old mode.
 */
export function writeEnvFile(path, content) {
  rmSync(path, { force: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // belt-and-braces against a permissive umask
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
  const args = { base: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') args.base = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.out) {
    throw new Error(
      'Usage: mint-installation-token.mjs --out <per-run env-file> [--base <static env-file>]',
    );
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { base, out } = parseArgs(argv);

  const appId = env.HARMONY_APP_ID;
  const installationId = env.HARMONY_APP_INSTALLATION_ID;
  if (!appId) throw new Error('HARMONY_APP_ID is required (the harmony-daemon App id)');
  if (!installationId) {
    throw new Error('HARMONY_APP_INSTALLATION_ID is required (the App installation to mint for)');
  }

  const jwt = buildJwt({ appId, privateKey: readPrivateKey(env) });
  const token = await mintInstallationToken({ jwt, installationId });

  const baseContent = base ? readFileSync(base, 'utf8') : '';
  writeEnvFile(out, composeEnvFile({ baseContent, token }));

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
