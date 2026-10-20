// B-1174: `harmony conductor logs --since <duration> [--source local|cloud] [--limit n]`.
//
// Reads the conductor's local JSON-lines file (src/daemon/conductor-logger.ts) when it is present and the
// source is not forced; otherwise Cloud Logging through `gcloud logging read`. Every side effect (fs,
// gcloud, clock) is injected so the reader is unit-testable. Attached to the EXISTING `conductor` command
// group created by registerConductorCommands, so it must be registered after that.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { Command } from 'commander';
import { loadConductorConfigSync } from '../../config/conductor-config.js';
import { resolveConductorLogPath, ROTATE_KEEP } from '../../daemon/conductor-logger.js';

export const LOG_NAME = 'harmony-conductor';
export const DEFAULT_LIMIT = 200;

export interface GcloudResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConductorLogsDeps {
  env: NodeJS.ProcessEnv;
  now: () => number;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  runGcloud: (args: string[]) => Promise<GcloudResult>;
  /** The merged gcp.project when no --project/env names one. Never throws. */
  configuredProject?: () => string | undefined;
}

export function defaultLogsDeps(): ConductorLogsDeps {
  return {
    env: process.env,
    now: Date.now,
    existsSync: fsExistsSync,
    readFileSync: (p) => fsReadFileSync(p, 'utf8'),
    runGcloud: (args) =>
      new Promise((resolve) => {
        execFile('gcloud', args, { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? err?.message ?? '') });
        });
      }),
    configuredProject: () => {
      try {
        return loadConductorConfigSync({ env: process.env })?.merged.gcp?.project;
      } catch {
        return undefined;
      }
    },
  };
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30m" | "1h" | "2d" | "45s" -> milliseconds, or null when malformed. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)([smhd])$/.exec(text.trim());
  if (!m) return null;
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  return ms > 0 ? ms : null;
}

export interface ReadOptions {
  since: string;
  source?: 'local' | 'cloud';
  limit?: number;
  project?: string;
}

export interface LogsResult {
  exitCode: number;
  lines: string[];
  errLines: string[];
  source?: 'local' | 'cloud';
}

interface Row {
  ts: string;
  level: string;
  event: string;
  ticket?: string;
  message: string;
}

/** The documented Cloud Logging filter (docs/conductor-config.md). */
export function cloudFilter(project: string, sinceIso: string): string {
  return `logName="projects/${project}/logs/${LOG_NAME}" AND timestamp>="${sinceIso}"`;
}

export function formatRow(r: Row): string {
  return [r.ts, r.level.toUpperCase().padEnd(7), r.event, r.ticket ?? '-', r.message].join(' ');
}

function readLocal(deps: ConductorLogsDeps, path: string, sinceMs: number): Row[] {
  const rows: Row[] = [];
  // Oldest rotated file first so the merged order is chronological.
  for (let i = ROTATE_KEEP; i >= 0; i--) {
    const file = i === 0 ? path : `${path}.${i}`;
    if (!deps.existsSync(file)) continue;
    let text: string;
    try {
      text = deps.readFileSync(file);
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw.trim()) continue;
      try {
        const o = JSON.parse(raw) as Partial<Row>;
        if (typeof o.ts !== 'string' || Date.parse(o.ts) < sinceMs) continue;
        rows.push({ ts: o.ts, level: String(o.level ?? 'info'), event: String(o.event ?? ''), ticket: o.ticket, message: String(o.message ?? '') });
      } catch {
        // a torn trailing line from a crash: skip it
      }
    }
  }
  return rows;
}

export async function runConductorLogs(deps: ConductorLogsDeps, opts: ReadOptions): Promise<LogsResult> {
  const spanMs = parseDuration(opts.since);
  if (spanMs === null) return { exitCode: 2, lines: [], errLines: [`--since must look like 30m, 1h or 2d (got "${opts.since}")`] };
  const limit = opts.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) return { exitCode: 2, lines: [], errLines: ['--limit must be a positive integer'] };
  const sinceMs = deps.now() - spanMs;
  const localPath = resolveConductorLogPath(deps.env);

  const useLocal = opts.source === 'local' || (opts.source === undefined && deps.existsSync(localPath));
  if (useLocal) {
    if (!deps.existsSync(localPath)) return { exitCode: 1, lines: [], errLines: [`no local conductor log at ${localPath}`] };
    const rows = readLocal(deps, localPath, sinceMs).slice(-limit);
    return { exitCode: 0, lines: rows.map(formatRow), errLines: [], source: 'local' };
  }

  const project = opts.project || deps.env.CLOUDSDK_CORE_PROJECT || deps.configuredProject?.();
  if (!project) {
    return { exitCode: 1, lines: [], errLines: ['no GCP project: pass --project, set gcp.project in .harmony/conductor.json, or export CLOUDSDK_CORE_PROJECT'] };
  }
  const filter = cloudFilter(project, new Date(sinceMs).toISOString());
  const r = await deps.runGcloud(['logging', 'read', filter, `--project=${project}`, '--format=json', `--limit=${limit}`, '--order=desc']);
  if (r.code !== 0) return { exitCode: 1, lines: [], errLines: [`gcloud logging read failed: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`] };
  let parsed: unknown;
  try {
    parsed = r.stdout.trim() ? JSON.parse(r.stdout) : [];
  } catch {
    return { exitCode: 1, lines: [], errLines: ['gcloud logging read returned output that is not JSON'] };
  }
  const rows: Row[] = (Array.isArray(parsed) ? parsed : [])
    .map((e: Record<string, unknown>) => {
      const p = (e.jsonPayload ?? {}) as Record<string, unknown>;
      return {
        ts: String(e.timestamp ?? ''),
        level: String(e.severity ?? 'INFO').replace('WARNING', 'warn').toLowerCase(),
        event: String(p.event ?? ''),
        ticket: typeof p.ticket === 'string' ? p.ticket : undefined,
        message: String(p.message ?? e.textPayload ?? ''),
      };
    })
    .reverse(); // desc -> chronological
  return { exitCode: 0, lines: rows.map(formatRow), errLines: [], source: 'cloud' };
}

export function registerConductorLogsCommand(program: Command, makeDeps: () => ConductorLogsDeps = defaultLogsDeps): void {
  const conductor = program.commands.find((c) => c.name() === 'conductor') ?? program.command('conductor').description('Conductor operations');
  conductor
    .command('logs')
    .description('Read the conductor daemon log (local JSON-lines file, else Cloud Logging via gcloud)')
    .requiredOption('--since <duration>', 'How far back: 30m, 1h, 2d')
    .option('--source <source>', 'local | cloud (default: local when the file exists)')
    .option('--limit <n>', `Maximum lines (default ${DEFAULT_LIMIT})`)
    .option('--project <id>', 'GCP project for --source cloud (default: gcp.project from the conductor config)')
    .action(async (o: { since: string; source?: string; limit?: string; project?: string }) => {
      if (o.source !== undefined && o.source !== 'local' && o.source !== 'cloud') {
        console.error('--source must be local or cloud');
        process.exitCode = 2;
        return;
      }
      const res = await runConductorLogs(makeDeps(), {
        since: o.since,
        source: o.source as 'local' | 'cloud' | undefined,
        limit: o.limit === undefined ? undefined : Number(o.limit),
        project: o.project,
      });
      for (const l of res.lines) console.log(l);
      for (const l of res.errLines) console.error(l);
      process.exitCode = res.exitCode;
    });
}
