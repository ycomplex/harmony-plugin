// B-1171: which running process IS this project's conductor on this machine?
//
// The conductor is `node <plugin checkout>/dist/bin/daemon.js [--config X] [--profile Y]`. "This project's"
// means: the script it runs is THIS checkout's dist/bin/daemon.js (a second checkout's daemon is not ours),
// and, when the caller names a config path, a process started with a DIFFERENT --config is not ours either.
// It must never match the ticket-disk sweep job, a `harmony` CLI invocation (including `harmony conductor
// stop`, whose argv merely MENTIONS daemon.js in no position that counts), or the launcher shell script
// that execs into node (the launcher is replaced by node, so it never shows up as a second process).
//
// Pure over a process list (pid, command line). The command line is split on whitespace honouring simple
// quotes; a plugin checkout path containing spaces is therefore not supported by the matcher (documented
// in docs/conductor-lifecycle.md).

import { basename, isAbsolute, join, resolve } from 'node:path';

export interface ProcessEntry {
  pid: number;
  /** The full command line as `ps -o args=` prints it. */
  args: string;
}

export interface ConductorProcess {
  pid: number;
  argv: string[];
  script: string;
  config?: string;
  profile?: string;
}

/** Parse `ps -axo pid=,args=` output. Unparseable lines are skipped. */
export function parsePsOutput(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), args: m[2] });
  }
  return out;
}

/** Whitespace split with single/double quotes and backslash-escaped spaces honoured. */
export function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < args.length && args[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (/\s/.test(c)) {
      if (has || cur) tokens.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) tokens.push(cur);
  return tokens;
}

const isNode = (exe: string): boolean => /^(node|nodejs)(\d+(\.\d+)*)?$/.test(basename(exe));

/** The script a `node ...` command line runs: the first argument that is not an option. Node options that
 *  take a separate value (`--require x`, `-r x`, `--import x`) are skipped together with their value. */
function scriptOf(argv: string[]): { script: string; rest: string[] } | null {
  if (argv.length < 2 || !isNode(argv[0])) return null;
  const valued = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-e', '--eval', '-p', '--print']);
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    i += valued.has(argv[i]) ? 2 : 1;
  }
  if (i >= argv.length) return null;
  return { script: argv[i], rest: argv.slice(i + 1) };
}

function flagValue(rest: string[], flag: string): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === flag) return rest[i + 1];
    if (rest[i].startsWith(`${flag}=`)) return rest[i].slice(flag.length + 1);
  }
  return undefined;
}

/** Processes that run a script named dist/bin/daemon.js, whichever checkout. Used to find the ones whose
 *  relative script path needs the process's working directory before it can be compared. */
export function daemonCandidates(procs: ProcessEntry[]): ConductorProcess[] {
  const out: ConductorProcess[] = [];
  for (const p of procs) {
    if (p.args.includes('<defunct>')) continue;
    const argv = tokenizeArgs(p.args);
    const s = scriptOf(argv);
    if (!s) continue;
    if (!/(^|\/)dist\/bin\/daemon\.js$/.test(s.script)) continue;
    out.push({ pid: p.pid, argv, script: s.script, config: flagValue(s.rest, '--config'), profile: flagValue(s.rest, '--profile') });
  }
  return out;
}

export interface MatchOptions {
  /** This checkout's root: the match is `<pluginDir>/dist/bin/daemon.js`. */
  pluginDir: string;
  /** When given, a process started with a different --config is excluded (a process with none is kept:
   *  it runs on the default). */
  configPath?: string;
  /** Working directory by pid, used to resolve a RELATIVE script path (a hand-started `node dist/bin/daemon.js`).
   *  Without it a relative script cannot be attributed to a checkout and is not matched. */
  cwdByPid?: ReadonlyMap<number, string>;
}

export function matchConductors(procs: ProcessEntry[], opts: MatchOptions): ConductorProcess[] {
  const want = resolve(join(opts.pluginDir, 'dist', 'bin', 'daemon.js'));
  const out: ConductorProcess[] = [];
  for (const c of daemonCandidates(procs)) {
    let script: string;
    if (isAbsolute(c.script)) script = resolve(c.script);
    else {
      const cwd = opts.cwdByPid?.get(c.pid);
      if (!cwd) continue;
      script = resolve(cwd, c.script);
    }
    if (script !== want) continue;
    if (opts.configPath && c.config !== undefined && resolve(c.config) !== resolve(opts.configPath)) continue;
    out.push({ ...c, script });
  }
  return out;
}

/** True when the process list holds a daemon candidate whose relative script still needs a cwd. */
export function needsCwd(procs: ProcessEntry[]): number[] {
  return daemonCandidates(procs).filter((c) => !isAbsolute(c.script)).map((c) => c.pid);
}
