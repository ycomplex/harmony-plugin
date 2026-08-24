#!/usr/bin/env node
// B-718: cross-conduction resume discovery for the LOCAL DOCKER launch profile — the host-side half
// of "resume-and-reconcile", sibling to scripts/mint-installation-token.mjs (same zero-dependency,
// no-build design point: the container clones this repo and runs committed dist with no npm
// install, and this script itself runs on the LAUNCHER HOST, before any container exists, so it
// can't depend on a build step either).
//
// WHY THIS EXISTS AS A SEPARATE HOST-SIDE STEP. Both launch profiles already resume WITHIN one
// conduction for free: every leg of the SAME conduction_id mounts/symlinks the identical
// {ticket}/{conduction_id}/projects directory (daemon-profile.example.json's `launch` template;
// container/entrypoint.sh's cloud-profile symlink block), so a prior leg's session file already
// physically sits where the next leg's `claude` process looks — container/provision.sh's own
// same-conduction discovery (glob $HOME/.claude/projects/*/*.jsonl) handles that case with no host
// involvement at all. The gap this script closes is CROSS-conduction: after a park + re-conduct, the
// new conduction gets a fresh, EMPTY {ticket}/{new-conduction-id}/ directory, so the prior
// conduction's session now lives in a SIBLING directory the next leg's container never mounts. The
// cloud profile can bridge that gap in-container (container/entrypoint.sh already runs after the
// gcsfuse mount is live, spanning every conduction of every ticket) — but the local docker profile's
// `docker run` only ever bind-mounts THIS leg's own conduction_id-scoped host directories, so there
// is no in-container vantage point that can see a sibling conduction's directory. Discovery must
// therefore happen HERE, on the host, BEFORE `docker run`, with the result injected into the same
// per-leg env-file (`run.env`) GIT_TOKEN and the run-config seam already ride (B-732 / B-846).
//
// Best-effort by design, matching AC5's resume-is-best-effort property one layer up: ANY failure
// here (a malformed run-config file, an unreadable conductions root, a corrupt sibling session
// file's stat call) is caught and logged to stderr, never thrown — this script must NEVER block
// `docker run` from proceeding. Omitting `--resume` (this script's silent no-op default) is always
// safe; that is exactly the existing cold-start path.

import { existsSync, readdirSync, statSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Mirrors src/config/run-config.ts's isSessionResumeEnabled — duplicated, not imported, for the
 *  same zero-dependency/no-build reason mint-installation-token.mjs's own header documents (this
 *  script runs on the launcher host with no guarantee `dist/` was ever built there). Never throws:
 *  a malformed run-config file just reads as "disabled" (best-effort, see module header). */
export function isSessionResumeEnabledFromFile(runConfigFilePath, { existsImpl = existsSync, readImpl = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!runConfigFilePath || !existsImpl(runConfigFilePath)) return false;
  try {
    const parsed = JSON.parse(readImpl(runConfigFilePath));
    return parsed?.session_resume?.enabled === true;
  } catch {
    return false;
  }
}

/** Has the CURRENT (just-`mkdir -p`'d, about-to-launch) conduction's own projects dir already got a
 *  session file? If so, this is a same-conduction (multi-leg) case — container/provision.sh's own
 *  in-container discovery already handles it, so this script must NOT also inject a (possibly
 *  different, older) sibling session and conflict with it. Never throws (best-effort). */
export function currentConductionHasSession(currentProjectsDir, { existsImpl = existsSync, readdirImpl = readdirSync } = {}) {
  try {
    if (!existsImpl(currentProjectsDir)) return false;
    for (const slugDir of readdirImpl(currentProjectsDir)) {
      const slugPath = join(currentProjectsDir, slugDir);
      let entries;
      try {
        entries = readdirImpl(slugPath);
      } catch {
        continue;
      }
      if (entries.some((f) => f.endsWith('.jsonl'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Walk `<conductionsRoot>/<ticket>/*\/projects/*\/*.jsonl`, excluding `excludeConductionId`'s own
 *  subtree, and return the newest-by-mtime session id (the .jsonl basename, minus extension) — or
 *  null when none is found. Never throws: any per-entry stat/readdir failure is skipped, not fatal
 *  (a sibling conduction directory racing a concurrent reap, permissions, etc.). */
export function findNewestSiblingSessionId(
  conductionsRoot,
  ticket,
  excludeConductionId,
  { existsImpl = existsSync, readdirImpl = readdirSync, statImpl = statSync } = {},
) {
  const ticketDir = join(conductionsRoot, ticket);
  if (!existsImpl(ticketDir)) return null;

  let newest = null; // { sessionId, mtimeMs }
  let conductionDirs;
  try {
    conductionDirs = readdirImpl(ticketDir);
  } catch {
    return null;
  }
  for (const conductionDir of conductionDirs) {
    if (conductionDir === excludeConductionId) continue;
    const projectsDir = join(ticketDir, conductionDir, 'projects');
    if (!existsImpl(projectsDir)) continue;
    let slugDirs;
    try {
      slugDirs = readdirImpl(projectsDir);
    } catch {
      continue;
    }
    for (const slugDir of slugDirs) {
      const slugPath = join(projectsDir, slugDir);
      let files;
      try {
        files = readdirImpl(slugPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(slugPath, file);
        let mtimeMs;
        try {
          mtimeMs = statImpl(filePath).mtimeMs;
        } catch {
          continue;
        }
        if (!newest || mtimeMs > newest.mtimeMs) {
          newest = { sessionId: file.slice(0, -'.jsonl'.length), mtimeMs };
        }
      }
    }
  }
  return newest?.sessionId ?? null;
}

/** The env-file line this script's whole purpose is to produce — appended (never replacing any
 *  existing content), matching mint-installation-token.mjs's own additive per-line convention for
 *  this same run.env file. */
export function composeResumeFlagsLine(sessionId) {
  return sessionId ? `CLAUDE_HEADLESS_FLAGS=--resume ${sessionId}\n` : '';
}

function parseArgs(argv) {
  const args = {
    conductionsRoot: undefined,
    ticket: undefined,
    conductionId: undefined,
    runConfigFile: undefined,
    envFile: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--conductions-root') args.conductionsRoot = argv[++i];
    else if (argv[i] === '--ticket') args.ticket = argv[++i];
    else if (argv[i] === '--conduction-id') args.conductionId = argv[++i];
    else if (argv[i] === '--run-config-file') args.runConfigFile = argv[++i];
    else if (argv[i] === '--env-file') args.envFile = argv[++i];
  }
  const missing = ['conductionsRoot', 'ticket', 'conductionId', 'runConfigFile', 'envFile'].filter(
    (k) => !args[k],
  );
  if (missing.length > 0) {
    throw new Error(
      'Usage: resume-discovery.mjs --conductions-root <dir> --ticket <ticket> ' +
        '--conduction-id <uuid> --run-config-file <path> --env-file <per-leg run.env path>',
    );
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const { conductionsRoot, ticket, conductionId, runConfigFile, envFile } = parseArgs(argv);

  // Best-effort, top to bottom (module header): any unexpected failure below degrades to "found
  // nothing, inject nothing" rather than blocking `docker run`.
  try {
    if (!isSessionResumeEnabledFromFile(runConfigFile)) return;

    const currentProjectsDir = join(conductionsRoot, ticket, conductionId, 'projects');
    if (currentConductionHasSession(currentProjectsDir)) {
      // Same-conduction case — container/provision.sh's own in-container discovery already covers
      // this leg; nothing for this host-side cross-conduction step to add.
      return;
    }

    const sessionId = findNewestSiblingSessionId(conductionsRoot, ticket, conductionId);
    const line = composeResumeFlagsLine(sessionId);
    if (line) appendFileSync(envFile, line);
  } catch (err) {
    process.stderr.write(
      `resume-discovery: best-effort cross-conduction resume lookup failed, proceeding cold — ${err.message}\n`,
    );
  }
}

// Run only when invoked directly, so the pure helpers above stay importable by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // Mirrors the try/catch inside main() — this outer catch only guards parseArgs' own throw
    // (missing required args), which SHOULD fail loud (a template wiring bug), unlike the
    // best-effort discovery logic above.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
