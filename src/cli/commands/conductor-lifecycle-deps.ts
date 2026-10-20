// B-1171: the side-effect surface of `harmony conductor start|stop|restart|status`, as ONE injectable
// object. The cores in conductor-lifecycle.ts / conductor-preflight.ts take it, so every behaviour is tested
// with fakes; only `defaultLifecycleDeps()` below touches the real machine (ps, launchctl, signals, the board).

import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { parsePsOutput, type ProcessEntry } from '../../daemon/conductor-process.js';
import type { BoardRow } from '../../daemon/conductor-board.js';
import { listActiveConductions } from './conductions.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Inherit stdio (a sudo password prompt). Output is then not captured. */
  interactive?: boolean;
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export interface LifecycleDeps {
  /** The CLI process's own environment. */
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  uid: number;
  username: string;
  home: string;
  /** The checkout this CLI runs from (dist/bin/harmony.js is two levels below it). */
  cliPluginDir: string;
  hostname(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Never throws: a missing binary is code 127. */
  exec(file: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  listProcesses(): Promise<ProcessEntry[]>;
  cwdOf(pid: number): Promise<string | null>;
  /** `0` probes. Returns whether the process exists (and, for SIGTERM, was signalled). */
  signal(pid: number, signal: 'SIGTERM' | 0): boolean;
  /** Start a command detached (own session, stdout+stderr appended to logPath); returns its pid. */
  spawnDetached(file: string, args: string[], opts: { logPath: string; env: Record<string, string | undefined>; cwd?: string }): number;
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  writeFileSync(path: string, text: string, mode: number): void;
  mkdirSync(path: string): void;
  rmSync(path: string): void;
  /** Active conductions on the board, read with the conductor's own token (from `env`). */
  readBoard(env: Record<string, string | undefined>): Promise<BoardRow[]>;
}

export function defaultLifecycleDeps(): LifecycleDeps {
  const exec: LifecycleDeps['exec'] = (file, args, opts = {}) =>
    new Promise<ExecResult>((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (r: ExecResult) => {
        if (!settled) {
          settled = true;
          resolvePromise(r);
        }
      };
      try {
        const child = spawn(file, args, {
          stdio: opts.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
          cwd: opts.cwd,
        });
        child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
        child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', (err: NodeJS.ErrnoException) => done({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || err.message }));
        child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
      } catch (err) {
        done({ code: 127, stdout, stderr: err instanceof Error ? err.message : String(err) });
      }
    });

  return {
    env: process.env,
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    username: (() => {
      try {
        return userInfo().username;
      } catch {
        return process.env.USER ?? '';
      }
    })(),
    home: homedir(),
    cliPluginDir: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    hostname: () => hostname(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exec,
    listProcesses: async () => {
      const r = await exec('ps', ['-axo', 'pid=,args=']);
      return r.code === 0 ? parsePsOutput(r.stdout) : [];
    },
    cwdOf: async (pid) => {
      try {
        return readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // not Linux: lsof prints "n<path>" for the cwd descriptor
      }
      const r = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
      const line = r.stdout.split('\n').find((l) => l.startsWith('n'));
      return r.code === 0 && line ? line.slice(1) : null;
    },
    signal: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    spawnDetached: (file, args, o) => {
      mkdirSync(dirname(o.logPath), { recursive: true });
      const fd = openSync(o.logPath, 'a');
      try {
        const child = spawn(file, args, {
          detached: true,
          stdio: ['ignore', fd, fd],
          env: { ...process.env, ...o.env } as NodeJS.ProcessEnv,
          cwd: o.cwd,
        });
        child.unref();
        if (child.pid === undefined) throw new Error(`could not start ${file}`);
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },
    existsSync,
    readFileSync: (p) => readFileSync(p, 'utf8'),
    writeFileSync: (p, text, mode) => {
      writeFileSync(p, text, { mode });
      chmodSync(p, mode);
    },
    mkdirSync: (p) => {
      mkdirSync(p, { recursive: true });
    },
    rmSync: (p) => rmSync(p, { force: true }),
    readBoard: async (env) => {
      const token = env.HARMONY_API_TOKEN;
      if (!token) throw new Error('HARMONY_API_TOKEN is not set');
      const auth = new HarmonyAuth(token);
      const client = await createAuthenticatedClient(auth);
      return listActiveConductions(client, auth.getProjectId());
    },
  };
}
