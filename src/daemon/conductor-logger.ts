// B-1174: the conductor's one logger, two outputs.
//
//   stdout        TODAY'S EXACT TEXT LINES: `<ISO timestamp> <line>\n`, also appended best-effort to
//                 HARMONY_DAEMON_LOG (the text copy only). Only a REMOTE conductor
//                 (HARMONY_CONDUCTOR_REMOTE=1, set by its pod spec) writes JSON lines to stdout instead.
//   JSON file     ~/.harmony/logs/conductor.log (HARMONY_CONDUCTOR_LOG overrides; HARMONY_HOME honoured),
//                 one JSON object per line, rotated at 10 MB keeping 5. Written synchronously BEFORE the
//                 entry is queued for shipping, so shipping can never cost a local entry.
//
// Secrets: the VALUES of known secret env vars are replaced by their NAMES before either output.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogShipper, type LogEntry, type LogLevel, type LogShipper } from './log-shipper.js';

export type { LogLevel } from './log-shipper.js';

export const ROTATE_BYTES = 10 * 1024 * 1024;
export const ROTATE_KEEP = 5;

export interface LogIds {
  ticket?: string;
  conduction?: string;
  leg?: string;
}

// ---- redaction -------------------------------------------------------------------------------------

const SECRET_NAMES = [
  'HARMONY_API_TOKEN',
  'GIT_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_API_TOKEN',
  'CODEX_ACCESS_TOKEN',
  'HARMONY_SUPABASE_ANON_KEY',
];
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD)$/;
const MIN_SECRET_LENGTH = 8; // shorter values would mangle ordinary text

/** Replace every known secret env value in `text` with `[NAME]`. */
export function redact(text: string, env: NodeJS.ProcessEnv): string {
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (SECRET_NAMES.includes(name) || SECRET_NAME_PATTERN.test(name)) pairs.push([name, value]);
  }
  pairs.sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of pairs) if (out.includes(value)) out = out.split(value).join(`[${name}]`);
  return out;
}

// ---- rotating JSON-lines file ----------------------------------------------------------------------

export interface RotatingFileFs {
  appendFileSync: (path: string, data: string) => void;
  statSync: (path: string) => { size: number };
  renameSync: (from: string, to: string) => void;
  unlinkSync: (path: string) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string) => void;
}

const realFs: RotatingFileFs = {
  appendFileSync: (p, d) => appendFileSync(p, d),
  statSync: (p) => statSync(p),
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync: (p) => void mkdirSync(p, { recursive: true }),
};

export interface RotatingFile {
  append(line: string): void;
}

/** Best-effort append with size rotation: `path` -> `path.1` -> ... -> `path.<keep>`, oldest removed. */
export function createRotatingFile(path: string, opts: { maxBytes?: number; keep?: number; fs?: RotatingFileFs } = {}): RotatingFile {
  const fs = opts.fs ?? realFs;
  const maxBytes = opts.maxBytes ?? ROTATE_BYTES;
  const keep = opts.keep ?? ROTATE_KEEP;
  let size: number | undefined;

  const rotate = (): void => {
    try {
      if (fs.existsSync(`${path}.${keep}`)) fs.unlinkSync(`${path}.${keep}`);
      for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(`${path}.${i}`)) fs.renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      if (fs.existsSync(path)) fs.renameSync(path, `${path}.1`);
    } catch {
      // keep appending to the current file rather than lose the entry
    }
    size = 0;
  };

  return {
    append(line) {
      try {
        if (size === undefined) {
          try {
            fs.mkdirSync(dirname(path));
          } catch {
            // surfaces below if it matters
          }
          size = fs.existsSync(path) ? fs.statSync(path).size : 0;
        }
        const bytes = Buffer.byteLength(line, 'utf8');
        if (size > 0 && size + bytes > maxBytes) rotate();
        fs.appendFileSync(path, line);
        size += bytes;
      } catch {
        // a broken disk must never take the conductor down
      }
    },
  };
}

export function resolveConductorLogPath(env: NodeJS.ProcessEnv): string {
  return env.HARMONY_CONDUCTOR_LOG || join(env.HARMONY_HOME || join(homedir(), '.harmony'), 'logs', 'conductor.log');
}

// ---- the logger ------------------------------------------------------------------------------------

export interface ConductorLogger {
  /** Structured call: text line to stdout (unchanged), JSON entry to the file, then the shipping queue. */
  log(level: LogLevel, event: string, message: string, ids?: LogIds): void;
  /** Adapter for string-only call sites; the stdout text is exactly what the old `log(line)` wrote. */
  line(text: string): void;
  /** Like line(), but does not append to HARMONY_DAEMON_LOG (the pre-config boot lines never did). */
  bootLine(text: string): void;
  setProjectKey(key: string | undefined): void;
  stop(): void;
}

export interface ConductorLoggerDeps {
  env: NodeJS.ProcessEnv;
  writeStdout: (s: string) => void;
  /** Live: HARMONY_DAEMON_LOG path (known only after config loads). */
  getTextLogPath?: () => string | undefined;
  appendText?: (path: string, s: string) => void;
  jsonFile: RotatingFile;
  shipper?: LogShipper;
  now?: () => Date;
}

const LEADING_TICKET = /^([A-Za-z][A-Za-z0-9]*-\d+)\b/;
const CONDUCTION_ID = /\bconduction ([0-9a-f]{8}-[0-9a-f-]{27})/;

/** Best-effort level for a legacy string line. */
function levelOf(text: string): LogLevel {
  return /\b(fail(ed|ure)?|error|exiting 1|could not|cannot)\b/i.test(text) ? 'warn' : 'info';
}

export function createConductorLogger(deps: ConductorLoggerDeps): ConductorLogger {
  const now = deps.now ?? (() => new Date());
  const remote = deps.env.HARMONY_CONDUCTOR_REMOTE === '1';
  const appendText = deps.appendText ?? ((p, s) => appendFileSync(p, s));
  let projectKey: string | undefined;

  const emit = (level: LogLevel, event: string, rawMessage: string, ids: LogIds | undefined, textFile: boolean): void => {
    const message = redact(rawMessage, deps.env);
    const ts = now().toISOString();
    const entry: LogEntry = {
      ts,
      level,
      event,
      message,
      ...(ids?.ticket ? { ticket: ids.ticket } : {}),
      ...(ids?.conduction ? { conduction: ids.conduction } : {}),
      ...(ids?.leg ? { leg: ids.leg } : {}),
      ...(projectKey ? { project: projectKey } : {}),
    };
    const json = `${JSON.stringify(entry)}\n`;
    const stamped = `${ts} ${message}\n`;
    deps.writeStdout(remote ? json : stamped);
    if (textFile) {
      const p = deps.getTextLogPath?.();
      if (p) {
        try {
          appendText(p, stamped);
        } catch {
          // The text copy is best-effort; stdout is the primary sink.
        }
      }
    }
    deps.jsonFile.append(json);
    try {
      deps.shipper?.enqueue(entry);
    } catch {
      // shipping can never affect the conductor
    }
  };

  const adapt = (text: string, textFile: boolean): void => {
    const ids: LogIds = {};
    const t = LEADING_TICKET.exec(text);
    if (t) ids.ticket = t[1];
    const c = CONDUCTION_ID.exec(text);
    if (c) ids.conduction = c[1];
    emit(levelOf(text), 'daemon', text, ids, textFile);
  };

  return {
    log: (level, event, message, ids) => emit(level, event, message, ids, true),
    line: (text) => adapt(text, true),
    bootLine: (text) => adapt(text, false),
    setProjectKey(key) {
      projectKey = key;
    },
    stop() {
      deps.shipper?.stop();
    },
  };
}

// ---- daemon wiring ---------------------------------------------------------------------------------

export interface DaemonLoggerOptions {
  env: NodeJS.ProcessEnv;
  getTextLogPath: () => string | undefined;
  /** Live config getters; the runtime does not exist yet when the logger is built. */
  getRuntime: () => { getGcpProject?(): string | undefined; getLogShipping(): boolean | undefined; getGcloudAccount?(): string | undefined } | undefined;
}

export function createDaemonLogger(opts: DaemonLoggerOptions): ConductorLogger {
  const ref: { logger?: ConductorLogger } = {};
  let projectKey: string | undefined;
  const shipper = createLogShipper({
    getProject: () => opts.getRuntime()?.getGcpProject?.(),
    getLogShipping: () => opts.getRuntime()?.getLogShipping(),
    getAccount: () => opts.getRuntime()?.getGcloudAccount?.(),
    getProjectKey: () => projectKey,
    logLocal: (level, event, message) => ref.logger?.log(level, event, message),
  });
  const logger = createConductorLogger({
    env: opts.env,
    writeStdout: (s) => void process.stdout.write(s),
    getTextLogPath: opts.getTextLogPath,
    jsonFile: createRotatingFile(resolveConductorLogPath(opts.env)),
    shipper,
  });
  ref.logger = logger;
  shipper.start();
  const base = logger;
  return {
    ...base,
    setProjectKey(key) {
      projectKey = key;
      base.setProjectKey(key);
    },
  };
}
