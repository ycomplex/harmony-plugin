#!/usr/bin/env node
// B-992: the PreToolUse-hook process. Thin I/O shell around `src/hooks/pretooluse-gate.ts` — every
// decision lives there (and is unit-tested there); this file only supplies stdin, the filesystem,
// git, the confirm CLI read, the authenticated Supabase context, and the exit code.
//
// Invoked by `hooks/pretooluse-gate.sh`, which has ALREADY established that this repo carries a
// `.harmony/project.yml` manifest and that the raw stdin text mentions a boundary token (the fast
// path: neither condition holding means node is never even spawned).
//
// Usage: <stdin: the PreToolUse hook JSON> node dist/bin/pretooluse-gate.js <projectRoot>

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPreToolUseGate,
  gateEvidenceMarkerPath,
  parseOwnerRepoSlug,
  type GateEvidenceMarker,
} from '../hooks/pretooluse-gate.js';
import { loadProjectManifest } from '../config/project-manifest.js';
import { getAuthenticatedContext } from '../cli/auth.js';
import { resolveLegCostContext } from '../tools/leg-cost-record.js';
import { addComment } from '../tools/comments.js';

/** The confirm-before-deny CLI read (verify.before_ack) and the local git reads must never outlive
 *  the tool call's own patience — a hung subprocess fails OPEN (see pretooluse-gate.ts's header). */
const CLI_TIMEOUT_MS = 15_000;

/** The escape hatch's DB resolution (getAuthenticatedContext -> resolveTaskId -> addComment) is a
 *  network path with no subprocess-level timeout to lean on — race it against a plain timer instead,
 *  same bound, same fail-open intent. */
const NETWORK_TIMEOUT_MS = 15_000;

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const projectRoot = process.argv[2] || process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const harmonyCli = join(here, 'harmony.js');

async function main(): Promise<number> {
  return runPreToolUseGate({
    input: readStdin(),
    env: process.env,
    projectRoot,
    loadManifest: (root) => loadProjectManifest(root),
    resolveCurrentRepoSlug: () => {
      const raw = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return parseOwnerRepoSlug(raw);
    },
    resolveHeadSha: () =>
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: CLI_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    readMarker: (point) => {
      const raw = readFileSync(gateEvidenceMarkerPath(projectRoot, point), 'utf8');
      return JSON.parse(raw) as GateEvidenceMarker;
    },
    queryAwaitingReason: async (taskId) => {
      const out = execFileSync(
        process.execPath,
        [harmonyCli, '--json', 'tasks', 'get', taskId],
        { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(out) as { awaiting_human_reason?: string | null };
      return parsed.awaiting_human_reason ?? null;
    },
    getAuthenticatedContext: () =>
      withTimeout(getAuthenticatedContext(), NETWORK_TIMEOUT_MS, 'getAuthenticatedContext'),
    resolveTaskId: async (client, conductionId) => {
      const context = await withTimeout(
        resolveLegCostContext(client, conductionId),
        NETWORK_TIMEOUT_MS,
        'resolveTaskId',
      );
      return context?.task_id ?? null;
    },
    addComment: async (client, projectId, userId, taskId, content) => {
      await withTimeout(
        addComment(client, projectId, userId, { task_id: taskId, content }),
        NETWORK_TIMEOUT_MS,
        'addComment',
      );
    },
    log: (line) => process.stderr.write(`${line}\n`),
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `[harmony pretooluse-gate] failed unexpectedly (${err instanceof Error ? err.message : String(err)}) — allowing (fail-open).\n`,
    );
    process.exit(0);
  });
