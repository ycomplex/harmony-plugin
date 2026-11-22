// B-1479: `harmony download switch` — move a machine that runs today's plugin copy
// (`harmony-plugin@ycomplex`) onto Harmony's gated download (`harmony-plugin@harmony`).
//
// Everything that touches the outside world is injected (`SwitchDeps`): the environment, the home
// directory, the current directory, whether a person is at a terminal, the question, the `claude`
// runner, the in-process token login and the few fs calls the atomic settings write needs. The CLI
// wiring (src/cli/commands/download.ts) supplies the real ones; the tests supply stubs.
//
// What it changes, in order (docs/switch-to-gated-download.md is the customer-facing account):
//   1. the helper `${HARMONY_CONFIG_DIR:-~/.harmony}/download-headers.sh` (mode 700), which prints the
//      Authorization header Claude Code sends to the download — it reads the token, it never holds one;
//   2. the `harmony` entry under `extraKnownMarketplaces` in Claude Code's user settings, after saving
//      the original beside it as `settings.json.before-harmony-download`, written atomically;
//   3. Claude Code's own state, through `claude` commands: one headless session start from an empty
//      temporary directory (it fetches the declared marketplace and sends no model request — see
//      START_ARGS), the install, and disabling today's copy for the user;
//   4. a record of the above in `download-switch.json` (never the token).
//
// Exit codes: 0 done; 1 refused or failed (the message names which); 2 the person has to act first.
//
// B-1501 adds the download PIN and the first install:
//   - config.json's top-level `downloadProject` names the stored project whose token the helper sends.
//     With a pin the helper consults nothing else (not HARMONY_API_TOKEN, not the active project); with
//     none (a machine that ran the 0.17.66 switch) it keeps the old order. Pinning never changes
//     activeProject.
//   - `harmony download token use <project>` / `token set` pin a stored / a new token, after checking it
//     against the download (GET <base>/prod/marketplace.json with the token; the fetch is injected).
//   - `harmony download install` is the first install on a bare machine (the public installer runs it,
//     the token on stdin): check the token, save it without activating, pin it, then the switch's steps.
//   - `harmony download switch` now always leaves a pinned helper behind (it pins the active project,
//     or asks which stored project on a terminal); only --undo leaves none.

import nodeFs from 'node:fs';
import path from 'node:path';
import { scrubTokenShapes } from './token-shapes.js';

export const DEFAULT_BASE = 'https://plugin.harmony.ad';
export const MARKETPLACE_NAME = 'harmony';
export const INSTALL_ID = 'harmony-plugin@harmony';
export const TODAYS_ID = 'harmony-plugin@ycomplex';
export const HELPER_FILE = 'download-headers.sh';
export const RECORD_FILE = 'download-switch.json';
export const BACKUP_SUFFIX = '.before-harmony-download';

/** The headless session start that makes Claude Code fetch a declared-but-never-fetched marketplace.
 *
 *  Measured on Claude Code 2.1.329 (B-1479 spike, local HTTPS fixture plus a local stand-in for the
 *  model API with a made-up key): a print-mode session whose input is stream-json and whose stdin is
 *  closed starts, fetches the declared marketplace (one authorised GET of marketplace.json), and exits
 *  0 without ever sending a `/v1/messages` request — no user message is ever read. `claude -p hi` and
 *  `claude -p --max-turns 0 hi` fetch it too but each send a model request; `--version`, `mcp list`,
 *  `doctor`, `auth status`, `plugin list`, `plugin validate`, `plugin marketplace update` fetch nothing. */
export const START_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

export const PIN_FIX = 'Run `harmony download token use <project>` (a project already stored) or `harmony download token set` (a new token).';

export const NO_TOKEN_HELP = [
  'Harmony needs your API token where the download can read it. Do one of these, then run `harmony download switch` again:',
  '  harmony login --token <your token>        (stores it in ~/.harmony/config.json)',
  '  or set HARMONY_API_TOKEN in your shell profile (for example ~/.zshrc or ~/.bashrc) and open a new terminal.',
];

export const PROJECT_DISABLE_HINT =
  "This project's own settings enable today's copy. In this project run: claude plugin disable harmony-plugin@ycomplex --scope project — and do not commit the change it makes to .claude/settings.json.";

export interface ClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ClaudeRunner = (args: string[], opts?: { cwd?: string }) => Promise<ClaudeResult>;

/** The fs calls the settings write and the helper write make. Defaults to node:fs; a test can wrap it. */
export interface FsOps {
  existsSync: typeof nodeFs.existsSync;
  readFileSync: typeof nodeFs.readFileSync;
  statSync: typeof nodeFs.statSync;
  mkdirSync: typeof nodeFs.mkdirSync;
  chmodSync: typeof nodeFs.chmodSync;
  copyFileSync: typeof nodeFs.copyFileSync;
  openSync: typeof nodeFs.openSync;
  writeSync: typeof nodeFs.writeSync;
  fsyncSync: typeof nodeFs.fsyncSync;
  closeSync: typeof nodeFs.closeSync;
  renameSync: typeof nodeFs.renameSync;
  rmSync: typeof nodeFs.rmSync;
  writeFileSync: typeof nodeFs.writeFileSync;
  mkdtempSync: typeof nodeFs.mkdtempSync;
  /** Optional: defaults to node:fs. Used to write THROUGH a symlinked settings.json or config.json. */
  realpathSync?: typeof nodeFs.realpathSync;
}

/** The file a write to `p` must land in: `p`'s real path when it is (or sits under) a symlink, so the
 *  link is never replaced by a plain file (B-1501 fix 7); `p` itself when it does not exist yet. */
export function writeTarget(p: string, fs: FsOps): string {
  try {
    return (fs.realpathSync ?? nodeFs.realpathSync)(p);
  } catch {
    return p;
  }
}

export interface SwitchDeps {
  env: NodeJS.ProcessEnv;
  homedir: string;
  cwd: string;
  tmpdir: string;
  /** true only when both stdin and stdout are a terminal — a person is there to answer. */
  isTTY: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  ask: (question: string) => Promise<string>;
  runClaude: ClaudeRunner;
  /** Verify a token against Harmony and store it in the CLI store WITHOUT activating it (B-1501).
   *  Returns the stored key, and the key it collided with when a different project held that name. */
  saveToken: (token: string) => Promise<SavedToken>;
  /** GET for the download check (B-1501). Defaults to the global fetch; tests always inject a stub. */
  fetch?: FetchLike;
  /** Read a new token: stdin, or a hidden prompt at a terminal (B-1501). Never echoes it. */
  readToken?: () => Promise<string>;
  now: () => Date;
  pid: number;
  fs?: FsOps;
}

export interface SavedToken {
  key: string;
  collidedWith?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; redirect: 'manual'; signal?: AbortSignal }) => Promise<{ status: number }>;

export interface SwitchOptions {
  undo?: boolean;
  dryRun?: boolean;
  base?: string;
}

export interface Paths {
  harmonyDir: string;
  helperPath: string;
  recordPath: string;
  storePath: string;
  claudeDir: string;
  settingsPath: string;
  backupPath: string;
  projectSettingsPath: string;
  projectLocalSettingsPath: string;
}

export function resolvePaths(deps: Pick<SwitchDeps, 'env' | 'homedir' | 'cwd'>): Paths {
  const harmonyDir = path.resolve(deps.cwd, deps.env.HARMONY_CONFIG_DIR || path.join(deps.homedir, '.harmony'));
  const claudeDir = path.resolve(deps.cwd, deps.env.CLAUDE_CONFIG_DIR || path.join(deps.homedir, '.claude'));
  const settingsPath = path.join(claudeDir, 'settings.json');
  return {
    harmonyDir,
    helperPath: path.join(harmonyDir, HELPER_FILE),
    recordPath: path.join(harmonyDir, RECORD_FILE),
    storePath: path.join(harmonyDir, 'config.json'),
    claudeDir,
    settingsPath,
    backupPath: settingsPath + BACKUP_SUFFIX,
    projectSettingsPath: path.join(deps.cwd, '.claude', 'settings.json'),
    projectLocalSettingsPath: path.join(deps.cwd, '.claude', 'settings.local.json'),
  };
}

export function normalizeBase(base: string | undefined): string {
  const b = (base ?? DEFAULT_BASE).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(b)) {
    throw new SwitchError(1, `--base must be an https:// address (got "${b}").`);
  }
  return b;
}

export function marketplaceUrl(base: string): string {
  return `${base}/prod/marketplace.json`;
}

export function desiredEntry(url: string, helperPath: string): Record<string, unknown> {
  return { source: { source: 'url', url, headersHelper: helperPath }, autoUpdate: true };
}

/** The helper's node part, run as `node -e <this> <config.json>`. It prints the whole header, or a
 *  message on stderr and exit 1. It contains no single quote (it sits inside a single-quoted sh word). */
const HELPER_JS = [
  'const fs = require("fs"); const f = process.argv[1];',
  'const fix = "Run `harmony download token use <project>` or `harmony download token set`.";',
  'const fail = (m) => { process.stderr.write("harmony: " + m + " " + fix + "\\n"); process.exit(1); };',
  // B-1501 fix 5: fail CLOSED. Only an ABSENT file (or one that parses with no pin) means "no pin";
  // a file that exists but cannot be read, or is empty / half-written / not JSON, stops here, so a
  // pinned machine never falls back to HARMONY_API_TOKEN because of a bad read.
  'let raw = null; try { raw = fs.readFileSync(f, "utf8"); } catch (e) { if (!e || e.code !== "ENOENT") fail(f + " exists but cannot be read (" + ((e && e.code) || "error") + "), so whether a token is pinned is unknown; nothing was sent. Fix its permissions (it should be yours, mode 600)."); }',
  'let c = null; if (raw !== null) { try { c = JSON.parse(raw); } catch (e) { fail(f + " is empty or not valid JSON (it may be half-written), so whether a token is pinned is unknown; nothing was sent. Try again in a moment; if it stays broken, repair the file."); } }',
  'const ps = c && c.projects && typeof c.projects === "object" ? c.projects : {};',
  'const has = (p) => p && typeof p.token === "string" && p.token.length > 0;',
  'const pin = c && typeof c.downloadProject === "string" && c.downloadProject ? c.downloadProject : null;',
  'let t = "";',
  'if (pin) { if (!has(ps[pin])) fail("the download is pinned to project \\"" + pin + "\\", but " + f + " holds no token for it."); t = ps[pin].token; }',
  'else { t = process.env.HARMONY_API_TOKEN || ""; if (!t && c && c.activeProject && has(ps[c.activeProject])) t = ps[c.activeProject].token; if (!t) fail("no Harmony token found."); }',
  'process.stdout.write(JSON.stringify({ Authorization: "Bearer " + t.replace(/[\\r\\n]/g, "") }));',
].join('\n');

/** The helper Claude Code runs for each download. POSIX sh. It prints only the header on stdout; it never
 *  writes the token to a file or log and never prints it to stderr. It holds no token: it reads config.json
 *  beside it. B-1501: when config.json pins a download project (`downloadProject`), that project's token is
 *  sent and nothing else is consulted; with no pin (a machine switched before B-1501) the order is the old
 *  one, HARMONY_API_TOKEN then the active project. Without node on PATH it can only serve an unpinned
 *  machine from HARMONY_API_TOKEN, and otherwise says that node is missing. */
export function helperScript(): string {
  return [
    '#!/bin/sh',
    "# Written by `harmony download`. Claude Code runs it to get the header for Harmony's plugin download.",
    '# It prints {"Authorization":"Bearer <token>"} and nothing else. It holds no token: it reads config.json beside it',
    '# (where `harmony` stores tokens). A pinned download project (downloadProject) is the only source when set;',
    '# otherwise HARMONY_API_TOKEN, then the active project. Change the pin: harmony download token use|set.',
    'c="$(dirname "$0")/config.json"',
    'if command -v node >/dev/null 2>&1; then',
    `  exec node -e '${HELPER_JS}' "$c"`,
    'fi',
    // Fix 5, without node: an unreadable, empty or visibly truncated file stops too (fail closed).
    'if [ -e "$c" ]; then',
    '  if [ ! -r "$c" ] || [ ! -s "$c" ]; then',
    '    echo "harmony: $c exists but cannot be read or is empty, so whether a token is pinned is unknown; nothing was sent. Fix the file, then run: claude plugin marketplace update harmony" >&2',
    '    exit 1',
    '  fi',
    `  last=$(tr -d ' \\t\\r\\n' < "$c" | sed -e 's/^.*\\(.\\)$/\\1/')`,
    '  if [ "$last" != "}" ]; then',
    '    echo "harmony: $c looks half-written (it does not end in }), so whether a token is pinned is unknown; nothing was sent. Try again in a moment, then run: claude plugin marketplace update harmony" >&2',
    '    exit 1',
    '  fi',
    'fi',
    'if [ -f "$c" ] && grep -q \'"downloadProject"\' "$c"; then',
    '  echo "harmony: node is not on the PATH Claude Code gave this helper, so it cannot read the pinned token in $c. Make node available in your login shell, then run: claude plugin marketplace update harmony" >&2',
    '  exit 1',
    'fi',
    't="${HARMONY_API_TOKEN:-}"',
    'if [ -z "$t" ]; then',
    '  echo "harmony: no Harmony token found, and node is not on PATH to read $c. Make node available in your login shell, then run: claude plugin marketplace update harmony" >&2',
    '  exit 1',
    'fi',
    `t=$(printf '%s' "$t" | tr -d '\\r\\n' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')`,
    `printf '{"Authorization":"Bearer %s"}' "$t"`,
    '',
  ].join('\n');
}

export class SwitchError extends Error {
  constructor(public readonly code: 1 | 2, message: string) {
    super(message);
  }
}

type TokenSource = 'pin' | 'env' | 'store';

/** The parts of config.json the download reads. Tokens are read only to be handed on, never printed. */
export interface StoreShape {
  activeProject?: string | null;
  projects?: Record<string, { token?: unknown } | undefined>;
  downloadProject?: string;
}

/** config.json beside the helper; null when it is absent or unreadable. */
export function readStore(paths: Paths, fs: FsOps): StoreShape | null {
  if (!fs.existsSync(paths.storePath)) return null;
  try {
    const c = JSON.parse(String(fs.readFileSync(paths.storePath, 'utf-8')));
    return isPlainObject(c) ? (c as StoreShape) : null;
  } catch {
    return null;
  }
}

function hasToken(c: StoreShape | null, key: string | null | undefined): key is string {
  if (!c || !key) return false;
  const t = c.projects?.[key]?.token;
  return typeof t === 'string' && t.length > 0;
}

/** The stored keys that hold a token. Names only. */
export function storedProjects(c: StoreShape | null): string[] {
  return Object.keys(c?.projects ?? {}).filter((k) => hasToken(c, k));
}

/** Where a token is, without printing or returning it: a usable pin first, then the unpinned helper's
 *  order (env, then the active project in the store), then any stored project. */
export function findToken(deps: Pick<SwitchDeps, 'env'>, paths: Paths, fs: FsOps): TokenSource | null {
  const c = readStore(paths, fs);
  if (hasToken(c, c?.downloadProject)) return 'pin';
  if (deps.env.HARMONY_API_TOKEN) return 'env';
  if (hasToken(c, c?.activeProject)) return 'store';
  // A stored project that is not active can still be pinned (the switch asks which).
  if (storedProjects(c).length > 0) return 'store';
  return null;
}

export type HelperSource =
  | { kind: 'pinned'; key: string; usable: boolean }
  | { kind: 'env' }
  | { kind: 'active'; key: string }
  | { kind: 'none' };

/** What the helper written by this version would send, as names only. `env` is the environment the
 *  helper itself would see: Claude Code's, which is usually the login shell's. */
export function helperSource(env: NodeJS.ProcessEnv, paths: Paths, fs: FsOps): HelperSource {
  const c = readStore(paths, fs);
  if (c?.downloadProject) return { kind: 'pinned', key: c.downloadProject, usable: hasToken(c, c.downloadProject) };
  if (env.HARMONY_API_TOKEN) return { kind: 'env' };
  if (hasToken(c, c?.activeProject)) return { kind: 'active', key: c!.activeProject as string };
  return { kind: 'none' };
}

/** Pin the download to a stored project: config.json's `downloadProject`, written atomically at mode 600.
 *  activeProject and every entry are left exactly as they are. */
export function pinDownloadProject(paths: Paths, key: string, pid: number, fs: FsOps): void {
  let raw: string;
  try {
    raw = String(fs.readFileSync(paths.storePath, 'utf-8'));
  } catch {
    throw new SwitchError(1, `${paths.storePath} does not exist, so there is no stored project "${key}" to pin.`);
  }
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    throw new SwitchError(1, `${paths.storePath} is not valid JSON. Nothing was changed.`);
  }
  if (!isPlainObject(c) || !hasToken(c as StoreShape, key)) {
    throw new SwitchError(1, `${paths.storePath} holds no token for project "${key}". Nothing was changed.`);
  }
  const next = { ...c, downloadProject: key };
  atomicWrite(writeTarget(paths.storePath, fs), JSON.stringify(next, null, 2) + '\n', 0o600, pid, fs);
}

/** Check a token against the download itself: GET <base>/prod/marketplace.json with it, expecting 200.
 *  The token goes only into the Authorization header; no message ever carries it. */
export async function verifyDownloadToken(base: string, token: string, fetchImpl?: FetchLike): Promise<void> {
  const url = marketplaceUrl(base);
  const f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  let status: number;
  try {
    const r = await f(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    status = r.status;
  } catch (e: any) {
    const msg = String(e?.message ?? e).split(token).join('<token>');
    throw new SwitchError(1, `could not reach ${url} to check the token (${msg}). Nothing was changed.`);
  }
  if (status === 200) return;
  if (status === 401 || status === 403) {
    throw new SwitchError(
      1,
      `the download refused this token (HTTP ${status} from ${url}). Check it is a current Harmony API token (Project Settings → Connect AI). Nothing was changed.`,
    );
  }
  throw new SwitchError(1, `the download answered HTTP ${status} from ${url}, not 200. Nothing was changed.`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Order-insensitive deep equality for JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

export interface SettingsPlan {
  exists: boolean;
  /** the merged object to write, or null when the entry is already there as wanted. */
  merged: Record<string, unknown> | null;
  mode: number | null;
}

/** Read and check user settings; compute the merge. Throws SwitchError(1) on invalid JSON or a differing entry. */
export function planSettings(paths: Paths, entry: Record<string, unknown>, fs: FsOps): SettingsPlan {
  if (!fs.existsSync(paths.settingsPath)) {
    return { exists: false, merged: { extraKnownMarketplaces: { [MARKETPLACE_NAME]: entry } }, mode: null };
  }
  const raw = String(fs.readFileSync(paths.settingsPath, 'utf-8'));
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new SwitchError(1, `${paths.settingsPath} is not valid JSON. Nothing was changed. Fix the file (or move it aside), then run again.`);
  }
  if (!isPlainObject(parsed)) {
    throw new SwitchError(1, `${paths.settingsPath} does not hold a JSON object. Nothing was changed.`);
  }
  const mode = fs.statSync(paths.settingsPath).mode & 0o777;
  const ekm = parsed.extraKnownMarketplaces;
  if (ekm !== undefined && !isPlainObject(ekm)) {
    throw new SwitchError(1, `extraKnownMarketplaces in ${paths.settingsPath} is not an object. Nothing was changed.`);
  }
  const current = ekm?.[MARKETPLACE_NAME];
  if (current !== undefined) {
    if (jsonEqual(current, entry)) return { exists: true, merged: null, mode };
    throw new SwitchError(
      1,
      `${paths.settingsPath} already declares a different "${MARKETPLACE_NAME}" marketplace. Claude Code ignores an edited entry, so nothing was changed. Run \`harmony download switch --undo\` first, then run the switch again.`,
    );
  }
  return {
    exists: true,
    merged: { ...parsed, extraKnownMarketplaces: { ...(ekm ?? {}), [MARKETPLACE_NAME]: entry } },
    mode,
  };
}

/** Write `content` to `target` atomically: a temp file in the same directory, fsync, rename over. */
export function atomicWrite(target: string, content: string, mode: number, pid: number, fs: FsOps): void {
  const tmp = `${target}.tmp-${pid}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write the helper; a no-op (beyond fixing modes) when it is already identical. Returns whether it wrote. */
export function writeHelper(paths: Paths, fs: FsOps): boolean {
  fs.mkdirSync(paths.harmonyDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.harmonyDir, 0o700);
  const content = helperScript();
  if (fs.existsSync(paths.helperPath) && String(fs.readFileSync(paths.helperPath, 'utf-8')) === content) {
    if ((fs.statSync(paths.helperPath).mode & 0o777) !== 0o700) fs.chmodSync(paths.helperPath, 0o700);
    return false;
  }
  fs.writeFileSync(paths.helperPath, content, { mode: 0o700 });
  fs.chmodSync(paths.helperPath, 0o700);
  return true;
}

function readJsonOrNull(file: string, fs: FsOps): unknown {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf-8')));
  } catch {
    return null;
  }
}

/** Does the current directory's own (shared) project settings file enable today's copy? Never edits it. */
export function projectEnablesTodaysCopy(paths: Paths, fs: FsOps): boolean {
  return projectTodaysCopySetting(paths, fs) === true;
}

/** The project settings' own `enabledPlugins` value for today's copy (true, false or undefined). */
function projectTodaysCopySetting(paths: Paths, fs: FsOps): unknown {
  if (path.resolve(paths.projectSettingsPath) === path.resolve(paths.settingsPath)) return undefined;
  if (!fs.existsSync(paths.projectSettingsPath)) return undefined;
  const s = readJsonOrNull(paths.projectSettingsPath, fs) as any;
  return s?.enabledPlugins?.[TODAYS_ID];
}

/** Read the token /harmony-setup put in this project's settings.local.json. Only ever called with a person present. */
function readProjectFileToken(paths: Paths, fs: FsOps): string | null {
  const s = readJsonOrNull(paths.projectLocalSettingsPath, fs) as any;
  const t = s?.env?.HARMONY_API_TOKEN;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/** Remove every known secret and every token-shaped string (src/tools/token-shapes.ts) from text that
 *  came from outside, such as `claude`'s own output, before it is printed (B-1501 fix 10c). */
export function redactOutput(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('<token>');
  return scrubTokenShapes(out);
}

function describeFailure(args: string[], r: ClaudeResult, secrets: Array<string | undefined> = []): string {
  const text = `${r.stdout}\n${r.stderr}`.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' / ');
  return `\`claude ${args.join(' ')}\` failed (exit ${r.code})${text ? `: ${redactOutput(text, secrets)}` : ''}`;
}

async function runOrFail(deps: SwitchDeps, args: string[], tolerate?: RegExp): Promise<ClaudeResult & { tolerated: boolean }> {
  const r = await deps.runClaude(args);
  if (r.code === 0) return { ...r, tolerated: false };
  if (tolerate && tolerate.test(`${r.stdout}\n${r.stderr}`)) return { ...r, tolerated: true };
  throw new SwitchError(1, describeFailure(args, r, [deps.env.HARMONY_API_TOKEN]));
}

/** Is the `harmony` marketplace known to Claude Code (fetched at least once)? */
export async function marketplaceKnown(deps: SwitchDeps): Promise<boolean> {
  const args = ['plugin', 'marketplace', 'list', '--json'];
  const r = await deps.runClaude(args);
  if (r.code === 0) {
    try {
      const list = JSON.parse(r.stdout);
      if (Array.isArray(list)) return list.some((m) => m?.name === MARKETPLACE_NAME);
    } catch {
      /* fall through to the text form */
    }
  }
  const plain = ['plugin', 'marketplace', 'list'];
  const t = await deps.runClaude(plain);
  if (t.code !== 0) throw new SwitchError(1, describeFailure(plain, t, [deps.env.HARMONY_API_TOKEN]));
  return new RegExp(`(^|\\s)${MARKETPLACE_NAME}\\s*$`, 'm').test(t.stdout);
}

/** One headless session start from an empty temporary directory, removed afterwards. */
export async function startOnce(deps: SwitchDeps, fs: FsOps): Promise<ClaudeResult> {
  const dir = fs.mkdtempSync(path.join(deps.tmpdir, 'harmony-download-start-'));
  try {
    return await deps.runClaude(START_ARGS, { cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function runDownloadSwitch(opts: SwitchOptions, deps: SwitchDeps): Promise<number> {
  try {
    return opts.undo ? await undo(opts, deps) : await doSwitch(opts, deps);
  } catch (e) {
    if (e instanceof SwitchError) {
      deps.err(`harmony download switch: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

function redact(e: any, token: string): string {
  return String(e?.message ?? e).split(token).join('<token>');
}

function describeSaved(saved: SavedToken, paths: Paths, fs: FsOps): string[] {
  const lines = [`Saved the token in ${paths.storePath} as project "${saved.key}".`];
  if (saved.collidedWith) {
    lines.push(`A different project is already stored as "${saved.collidedWith}" and was left as it is. In a project's settings, name this one HARMONY_PROJECT=${saved.key}.`);
  }
  // B-1501 fix 6: this save never sets the active project; say how, when there is none.
  if (!hasToken(readStore(paths, fs), readStore(paths, fs)?.activeProject)) {
    lines.push(`No project is active for terminal commands outside a session. To use this one there, run: harmony project switch ${saved.key}`);
  }
  return lines;
}

async function ensureToken(paths: Paths, deps: SwitchDeps, fs: FsOps, dryRun: boolean): Promise<SavedToken | null> {
  const found = findToken(deps, paths, fs);
  if (found) return null;
  const projectFile = fs.existsSync(paths.projectLocalSettingsPath);
  if (projectFile && deps.isTTY && !dryRun) {
    const token = readProjectFileToken(paths, fs);
    if (token) {
      const answer = await deps.ask(
        'Found a Harmony token in this project\'s .claude/settings.local.json. Save this token to the harmony store (~/.harmony/config.json) so the download can use it? [y/N] ',
      );
      if (/^\s*y(es)?\s*$/i.test(answer)) {
        let saved: SavedToken;
        try {
          saved = await deps.saveToken(token);
        } catch (e: any) {
          throw new SwitchError(1, `the token could not be verified, so it was not saved: ${redact(e, token)}`);
        }
        for (const l of describeSaved(saved, paths, fs)) deps.out(l);
        return saved;
      }
    }
  }
  const lines = ['no Harmony token found (HARMONY_API_TOKEN is not set and the harmony store has no active project).'];
  if (projectFile && (!deps.isTTY || dryRun)) {
    lines.push(
      dryRun
        ? "This project's .claude/settings.local.json may hold one; a real run in a terminal offers to save it."
        : "This project's .claude/settings.local.json may hold one, but it is only offered when a person runs this in a terminal.",
    );
  }
  throw new SwitchError(2, [...lines, ...NO_TOKEN_HELP].join('\n'));
}

export const ENV_ONLY_HELP =
  'The download now reads ONE pinned token from ~/.harmony/config.json, and no project is stored there (HARMONY_API_TOKEN alone cannot be pinned). ' +
  'Run `harmony download token set` (it reads the token, checks it, saves it and pins it), then run this again.';

type PinPlan =
  | { kind: 'keep'; key: string }
  | { kind: 'active'; key: string; dangling?: string }
  | { kind: 'ask'; choices: string[]; dangling?: string }
  | { kind: 'offer-env'; dangling?: string }
  | { kind: 'stop'; message: string };

/** What the switch will pin. Pure: reads config.json only. */
function planPin(paths: Paths, deps: Pick<SwitchDeps, 'env' | 'isTTY'>, fs: FsOps): PinPlan {
  const c = readStore(paths, fs);
  const pin = c?.downloadProject;
  if (hasToken(c, pin)) return { kind: 'keep', key: pin };
  const dangling = pin || undefined;
  if (hasToken(c, c?.activeProject)) return { kind: 'active', key: c!.activeProject as string, dangling };
  const choices = storedProjects(c);
  if (choices.length > 0) {
    if (deps.isTTY) return { kind: 'ask', choices, dangling };
    return { kind: 'stop', message: `no project is pinned for the download and there is no active project to pin. ${PIN_FIX}` };
  }
  if (deps.env.HARMONY_API_TOKEN && deps.isTTY) return { kind: 'offer-env', dangling };
  return { kind: 'stop', message: ENV_ONLY_HELP };
}

/** Leave config.json pinned (B-1501): keep a usable pin, else pin the active project, else ask on a terminal. */
async function ensurePin(paths: Paths, deps: SwitchDeps, fs: FsOps, saved: SavedToken | null): Promise<string> {
  if (saved) {
    pinDownloadProject(paths, saved.key, deps.pid, fs);
    deps.out(`Pinned the download to project "${saved.key}" (downloadProject in ${paths.storePath}; the active project is unchanged).`);
    return saved.key;
  }
  const plan = planPin(paths, deps, fs);
  if (plan.kind === 'stop') throw new SwitchError(2, plan.message);
  if (plan.kind === 'keep') {
    deps.out(`The download stays pinned to project "${plan.key}".`);
    return plan.key;
  }
  if (plan.dangling) deps.out(`The download was pinned to "${plan.dangling}", which ${paths.storePath} no longer holds a token for.`);
  let key: string;
  if (plan.kind === 'active') {
    key = plan.key;
  } else if (plan.kind === 'ask') {
    const list = plan.choices.map((k, i) => `  ${i + 1}. ${k}`).join('\n');
    const answer = (await deps.ask(`Which stored project's token should the plugin download use?\n${list}\nNumber or name: `)).trim();
    const n = Number(answer);
    const picked = Number.isInteger(n) && n >= 1 && n <= plan.choices.length ? plan.choices[n - 1] : plan.choices.find((k) => k === answer);
    if (!picked) throw new SwitchError(2, `"${answer}" is not one of the stored projects. Nothing was pinned. ${PIN_FIX}`);
    key = picked;
  } else {
    const answer = await deps.ask(
      'The download needs its own copy of your token. Save HARMONY_API_TOKEN to the harmony store (~/.harmony/config.json) and pin it for the download? [y/N] ',
    );
    if (!/^\s*y(es)?\s*$/i.test(answer)) throw new SwitchError(2, ENV_ONLY_HELP);
    const token = deps.env.HARMONY_API_TOKEN as string;
    let s: SavedToken;
    try {
      s = await deps.saveToken(token);
    } catch (e: any) {
      throw new SwitchError(1, `the token could not be verified, so it was not saved: ${redact(e, token)}`);
    }
    for (const l of describeSaved(s, paths, fs)) deps.out(l);
    key = s.key;
  }
  pinDownloadProject(paths, key, deps.pid, fs);
  deps.out(`Pinned the download to project "${key}" (downloadProject in ${paths.storePath}; the active project is unchanged).`);
  return key;
}

async function doSwitch(opts: SwitchOptions, deps: SwitchDeps): Promise<number> {
  const fs = deps.fs ?? (nodeFs as unknown as FsOps);
  const base = normalizeBase(opts.base);
  const url = marketplaceUrl(base);
  const paths = resolvePaths(deps);
  const entry = desiredEntry(url, paths.helperPath);

  if (opts.dryRun) return dryRun(base, url, paths, entry, deps, fs);

  const saved = await ensureToken(paths, deps, fs, false);
  // A pre-check only: refuse a broken settings file before anything is pinned. applySteps reads and
  // plans it again immediately before writing (fix 7).
  planSettings(paths, entry, fs);
  const pinned = await ensurePin(paths, deps, fs, saved);
  return applySteps({ base, url, paths, entry, pinned, mode: 'switch' }, deps, fs);
}

/** The switch's steps after the token is pinned: helper, settings, Claude Code's own state, record. */
async function applySteps(
  ctx: { base: string; url: string; paths: Paths; entry: Record<string, unknown>; pinned: string; mode: 'switch' | 'install' },
  deps: SwitchDeps,
  fs: FsOps,
): Promise<number> {
  const { base, url, paths } = ctx;
  const helperWritten = writeHelper(paths, fs);
  deps.out(helperWritten ? `Wrote the helper ${paths.helperPath}` : `The helper ${paths.helperPath} is already in place.`);

  // B-1501 fix 7: read and plan settings.json again HERE, immediately before the write, so an edit made
  // while the token was being read (another Claude Code, an editor) is merged, not overwritten.
  const settings = planSettings(paths, ctx.entry, fs);
  let backup: string | null = fs.existsSync(paths.backupPath) ? paths.backupPath : null;
  if (settings.merged) {
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    if (settings.exists && !backup) {
      fs.copyFileSync(paths.settingsPath, paths.backupPath);
      backup = paths.backupPath;
      deps.out(`Saved your settings as ${paths.backupPath}`);
    }
    // A symlinked settings.json (dotfiles) is written THROUGH: its target gets the entry, the link stays.
    atomicWrite(writeTarget(paths.settingsPath, fs), JSON.stringify(settings.merged, null, 2) + '\n', settings.mode ?? 0o600, deps.pid, fs);
    deps.out(`Added the "${MARKETPLACE_NAME}" marketplace to ${paths.settingsPath}`);
  } else {
    deps.out(`${paths.settingsPath} already declares the "${MARKETPLACE_NAME}" marketplace.`);
  }

  if (!(await marketplaceKnown(deps))) {
    deps.out('Fetching the marketplace (one Claude Code start with no prompt, in an empty temporary directory)...');
    await startOnce(deps, fs);
    if (!(await marketplaceKnown(deps))) {
      deps.err(
        [
          'Claude Code has not fetched the Harmony marketplace yet. The settings and helper are in place, and your token is pinned.',
          'Start Claude Code once (open it, wait for the prompt, then /exit), then run `harmony download switch` again.',
          'If it still fails, check your token works: run `harmony download status`, then `harmony download token use <project>` or `harmony download token set`.',
        ].join('\n'),
      );
      return 2;
    }
  }

  const install = await runOrFail(deps, ['plugin', 'install', INSTALL_ID], /already installed/i);
  deps.out(install.tolerated ? `${INSTALL_ID} is already installed.` : `Installed ${INSTALL_ID}.`);

  let disabledTodaysCopy: boolean;
  const disableArgs = ['plugin', 'disable', TODAYS_ID, '--scope', 'user'];
  if (ctx.mode === 'install') {
    // A bare machine has no copy of today's plugin; any failure here is only a note.
    const r = await deps.runClaude(disableArgs);
    disabledTodaysCopy = r.code === 0;
    deps.out(disabledTodaysCopy ? `Disabled today's copy (${TODAYS_ID}) for your user.` : `Today's copy (${TODAYS_ID}) is not installed for your user; nothing to disable.`);
  } else {
    const disable = await runOrFail(deps, disableArgs, /already disabled|not installed|not found/i);
    disabledTodaysCopy = !disable.tolerated;
    deps.out(disabledTodaysCopy ? `Disabled today's copy (${TODAYS_ID}) for your user.` : `Today's copy (${TODAYS_ID}) was already disabled for your user (or is not installed).`);
  }

  const projectEnables = projectEnablesTodaysCopy(paths, fs);
  if (projectEnables) deps.out(PROJECT_DISABLE_HINT);

  const record = {
    base,
    marketplace_url: url,
    helper_path: paths.helperPath,
    settings_path: paths.settingsPath,
    backup_path: backup,
    disabled_ycomplex_user_scope: disabledTodaysCopy,
    download_project: ctx.pinned,
    via: ctx.mode,
    switched_at: deps.now().toISOString(),
  };
  fs.writeFileSync(paths.recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });

  deps.out('');
  deps.out(`Done: ${INSTALL_ID} is installed from ${url}, using project "${ctx.pinned}"'s token.`);
  deps.out('Check it: `claude plugin list` shows harmony-plugin@harmony enabled. In a FRESH Claude Code session (not /reload-plugins), run `harmony --version`.');
  deps.out(backup ? `Your original settings are saved at ${backup}` : 'There was no settings file before, so there is no backup.');
  deps.out('To go back: harmony download switch --undo');
  return 0;
}

function dryRun(base: string, url: string, paths: Paths, entry: Record<string, unknown>, deps: SwitchDeps, fs: FsOps): number {
  deps.out('Dry run: nothing is changed and no claude command is run.');
  deps.out(`Download: ${base}`);
  deps.out(`Would write the helper ${paths.helperPath} (mode 700); it reads your token, it holds none.`);
  let settingsProblem: SwitchError | null = null;
  try {
    const s = planSettings(paths, entry, fs);
    if (s.merged) {
      if (s.exists && !fs.existsSync(paths.backupPath)) deps.out(`Would save ${paths.settingsPath} as ${paths.backupPath}`);
      deps.out(`Would add to ${paths.settingsPath}:`);
      deps.out(JSON.stringify({ extraKnownMarketplaces: { [MARKETPLACE_NAME]: entry } }, null, 2));
    } else {
      deps.out(`${paths.settingsPath} already declares the "${MARKETPLACE_NAME}" marketplace; it would not change.`);
    }
  } catch (e) {
    if (!(e instanceof SwitchError)) throw e;
    settingsProblem = e;
  }
  deps.out('Would run, unless the marketplace is already known:');
  deps.out(`  claude ${START_ARGS.join(' ')}   (from an empty temporary directory, stdin closed: fetches the marketplace, sends no prompt)`);
  deps.out('Would run:');
  deps.out(`  claude plugin install ${INSTALL_ID}`);
  deps.out(`  claude plugin disable ${TODAYS_ID} --scope user`);
  deps.out(`Would record what it did in ${paths.recordPath}`);
  if (projectEnablesTodaysCopy(paths, fs)) deps.out(PROJECT_DISABLE_HINT);

  if (settingsProblem) {
    deps.err(`harmony download switch: ${settingsProblem.message}`);
    return settingsProblem.code;
  }
  const token = findToken(deps, paths, fs);
  if (!token) {
    const lines = ['no Harmony token found, so a real run would stop here.'];
    if (fs.existsSync(paths.projectLocalSettingsPath)) {
      lines.push("This project's .claude/settings.local.json may hold one; a real run in a terminal offers to save it.");
    }
    deps.err(`harmony download switch: ${[...lines, ...NO_TOKEN_HELP].join('\n')}`);
    return 2;
  }
  const plan = planPin(paths, deps, fs);
  switch (plan.kind) {
    case 'keep':
      deps.out(`Token: the download stays pinned to project "${plan.key}".`);
      return 0;
    case 'active':
      deps.out(`Token: would pin the download to the active project "${plan.key}" (the active project is unchanged).`);
      return 0;
    case 'ask':
      deps.out(`Token: would ask which stored project to pin (${plan.choices.join(', ')}).`);
      return 0;
    case 'offer-env':
      deps.out('Token: would offer to save HARMONY_API_TOKEN to the harmony store and pin it.');
      return 0;
    case 'stop':
      deps.err(`harmony download switch: a real run would stop here: ${plan.message}`);
      return 2;
  }
}

async function undo(opts: SwitchOptions, deps: SwitchDeps): Promise<number> {
  const fs = deps.fs ?? (nodeFs as unknown as FsOps);
  const paths = resolvePaths(deps);
  // A project that enables today's copy in its own settings (true), or where the person disabled it at
  // project scope as the switch told them to (false): remind them to enable it there again.
  const projectNamesTodaysCopy = projectTodaysCopySetting(paths, fs) !== undefined;

  if (opts.dryRun) {
    deps.out('Dry run: nothing is changed and no claude command is run.');
    deps.out(`Would run: claude plugin marketplace remove ${MARKETPLACE_NAME}   (also uninstalls ${INSTALL_ID} and removes the settings entry)`);
    deps.out(`Would run: claude plugin enable ${TODAYS_ID} --scope user`);
    deps.out(`Would delete ${paths.helperPath} and ${paths.recordPath}; would keep your token store and ${paths.backupPath}`);
    return 0;
  }

  const remove = await runOrFail(deps, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME], /not found/i);
  deps.out(remove.tolerated ? `The "${MARKETPLACE_NAME}" marketplace was already removed.` : `Removed the "${MARKETPLACE_NAME}" marketplace and ${INSTALL_ID}.`);

  // B-1501: a machine installed with `harmony download install` never had today's copy; that is fine.
  const enable = await runOrFail(deps, ['plugin', 'enable', TODAYS_ID, '--scope', 'user'], /already enabled|not installed|not found/i);
  deps.out(enable.tolerated ? `Today's copy (${TODAYS_ID}) was already enabled for your user (or is not installed).` : `Enabled today's copy (${TODAYS_ID}) for your user.`);

  fs.rmSync(paths.helperPath, { force: true });
  fs.rmSync(paths.recordPath, { force: true });
  deps.out(`Deleted ${paths.helperPath} and ${paths.recordPath}.`);

  const s = fs.existsSync(paths.settingsPath) ? (readJsonOrNull(paths.settingsPath, fs) as any) : null;
  if (s?.extraKnownMarketplaces?.[MARKETPLACE_NAME] !== undefined) {
    deps.err(
      `Note: ${paths.settingsPath} still declares the "${MARKETPLACE_NAME}" marketplace. Remove that entry by hand: while it is there, the next session fetches the marketplace again.`,
    );
  }
  if (projectNamesTodaysCopy) {
    deps.out(`If you disabled today's copy in this project, enable it again here: claude plugin enable ${TODAYS_ID} --scope project`);
  }
  if (fs.existsSync(paths.backupPath)) deps.out(`Your settings backup is kept at ${paths.backupPath}`);
  deps.out('Start a fresh Claude Code session to use today\'s copy again.');
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// B-1501: the pin commands, the status and the first install.
// ---------------------------------------------------------------------------------------------------

async function withErrors(label: string, deps: SwitchDeps, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof SwitchError) {
      deps.err(`harmony download ${label}: ${e.message}`);
      return e.code;
    }
    throw e;
  }
}

async function readNewToken(deps: SwitchDeps): Promise<string> {
  if (!deps.readToken) throw new SwitchError(1, 'no way to read a token here.');
  const token = (await deps.readToken()).trim();
  if (!token) throw new SwitchError(1, 'no token was given. Nothing was changed.');
  if (/\s/.test(token)) throw new SwitchError(1, 'the token has spaces or several lines in it. Give the one token, on one line. Nothing was changed.');
  return token;
}

async function saveNew(token: string, deps: SwitchDeps, paths: Paths, fs: FsOps): Promise<SavedToken> {
  let saved: SavedToken;
  try {
    saved = await deps.saveToken(token);
  } catch (e: any) {
    throw new SwitchError(1, `Harmony did not accept the token, so it was not saved: ${redact(e, token)}`);
  }
  for (const l of describeSaved(saved, paths, fs)) deps.out(l);
  return saved;
}

function settingsDeclareHarmony(paths: Paths, fs: FsOps): boolean {
  const s = fs.existsSync(paths.settingsPath) ? (readJsonOrNull(paths.settingsPath, fs) as any) : null;
  return s?.extraKnownMarketplaces?.[MARKETPLACE_NAME] !== undefined;
}

function afterPin(paths: Paths, key: string, deps: SwitchDeps, fs: FsOps): number {
  pinDownloadProject(paths, key, deps.pid, fs);
  const wrote = writeHelper(paths, fs);
  deps.out(`The plugin download now uses project "${key}"'s token (downloadProject in ${paths.storePath}). The active project is unchanged.`);
  deps.out(wrote ? `Wrote the helper ${paths.helperPath}` : `The helper ${paths.helperPath} is already in place.`);
  if (!settingsDeclareHarmony(paths, fs)) {
    deps.out('The download is not set up in Claude Code on this machine yet: run `harmony download install` (a new machine) or `harmony download switch` (today\'s copy installed).');
  }
  return 0;
}

/** `harmony download token use <project>`: pin an already-stored project, after the download accepts its token. */
export async function runDownloadTokenUse(project: string, opts: { base?: string }, deps: SwitchDeps): Promise<number> {
  return withErrors('token use', deps, async () => {
    const fs = deps.fs ?? (nodeFs as unknown as FsOps);
    const base = normalizeBase(opts.base);
    const paths = resolvePaths(deps);
    const c = readStore(paths, fs);
    if (!hasToken(c, project)) {
      const stored = storedProjects(c);
      throw new SwitchError(
        1,
        `"${project}" is not a project stored in ${paths.storePath}${stored.length ? ` (stored: ${stored.join(', ')})` : ' (none is stored)'}. Save a new token with \`harmony download token set\`.`,
      );
    }
    await verifyDownloadToken(base, c!.projects![project]!.token as string, deps.fetch);
    deps.out(`The download accepted project "${project}"'s token.`);
    return afterPin(paths, project, deps, fs);
  });
}

/** `harmony download token set`: read a new token, check it with the download and Harmony, save it without
 *  activating, and pin it. */
export async function runDownloadTokenSet(opts: { base?: string }, deps: SwitchDeps): Promise<number> {
  return withErrors('token set', deps, async () => {
    const fs = deps.fs ?? (nodeFs as unknown as FsOps);
    const base = normalizeBase(opts.base);
    const paths = resolvePaths(deps);
    const token = await readNewToken(deps);
    await verifyDownloadToken(base, token, deps.fetch);
    deps.out('The download accepted the token.');
    const saved = await saveNew(token, deps, paths, fs);
    return afterPin(paths, saved.key, deps, fs);
  });
}

/** `harmony download status`: which project is pinned and which source the helper will use. Names only. */
export function runDownloadStatus(deps: SwitchDeps): number {
  const fs = deps.fs ?? (nodeFs as unknown as FsOps);
  const paths = resolvePaths(deps);
  const c = readStore(paths, fs);
  deps.out(`Token store: ${paths.storePath}${c ? '' : ' (absent or unreadable)'}`);
  deps.out(`Pinned download project: ${c?.downloadProject ? `"${c.downloadProject}"${hasToken(c, c.downloadProject) ? '' : ' (NOT stored with a token)'}` : 'none'}`);
  deps.out(`Active project: ${hasToken(c, c?.activeProject) ? `"${c!.activeProject}"` : 'none'}`);
  let helper = 'absent';
  if (fs.existsSync(paths.helperPath)) {
    helper = String(fs.readFileSync(paths.helperPath, 'utf-8')) === helperScript() ? 'current' : 'an older version (run `harmony download token use <project>` to rewrite it)';
  }
  deps.out(`Helper: ${paths.helperPath} (${helper})`);
  deps.out(`Claude Code settings: ${settingsDeclareHarmony(paths, fs) ? `declare the "${MARKETPLACE_NAME}" marketplace` : `do not declare the "${MARKETPLACE_NAME}" marketplace`} (${paths.settingsPath})`);
  const src = helperSource(deps.env, paths, fs);
  const line =
    src.kind === 'pinned'
      ? src.usable
        ? `the pinned project "${src.key}" (nothing else is consulted)`
        : `nothing: it is pinned to "${src.key}", which holds no token, so the download fails. ${PIN_FIX}`
      : src.kind === 'env'
        ? 'HARMONY_API_TOKEN, if Claude Code sees it as this shell does (no project is pinned)'
        : src.kind === 'active'
          ? `the active project "${src.key}" (no project is pinned, and HARMONY_API_TOKEN is not set here)`
          : `nothing: no project is pinned and no token is found. ${PIN_FIX}`;
  deps.out(`The helper will send: ${line}`);
  if (src.kind !== 'pinned') deps.out(`Recommended: pin one token with \`harmony download token use <project>\`.`);
  return src.kind === 'none' || (src.kind === 'pinned' && !src.usable) ? 1 : 0;
}

export interface InstallOptions {
  base?: string;
  dryRun?: boolean;
}

/** `harmony download install`: the first install on a bare machine. The public installer runs it with the
 *  token on stdin. Order: check the settings file, read the token, check it with the download, save it
 *  (never activating over an existing active project), pin it, then the switch's steps. The token is held
 *  in memory only, is never printed, never put in a child's argv, and is written only to config.json. */
export async function runDownloadInstall(opts: InstallOptions, deps: SwitchDeps): Promise<number> {
  return withErrors('install', deps, async () => {
    const fs = deps.fs ?? (nodeFs as unknown as FsOps);
    const base = normalizeBase(opts.base);
    const url = marketplaceUrl(base);
    const paths = resolvePaths(deps);
    const entry = desiredEntry(url, paths.helperPath);

    if (opts.dryRun) {
      deps.out('Dry run: no token is read, nothing is changed and no claude command is run.');
      deps.out(`Download: ${base}`);
      deps.out(`Would read your Harmony API token (stdin, or a hidden prompt), check it with GET ${url}, and save it in ${paths.storePath} (mode 600).`);
      deps.out(`Would pin it for the download (downloadProject) and write the helper ${paths.helperPath} (mode 700).`);
      const s = planSettings(paths, entry, fs);
      deps.out(s.merged ? `Would add the "${MARKETPLACE_NAME}" marketplace to ${paths.settingsPath}${s.exists ? `, after saving it as ${paths.backupPath}` : ''}.` : `${paths.settingsPath} already declares the "${MARKETPLACE_NAME}" marketplace.`);
      deps.out(`Would run: claude ${START_ARGS.join(' ')} (from an empty temporary directory), claude plugin install ${INSTALL_ID}, claude plugin disable ${TODAYS_ID} --scope user (a failure there is fine).`);
      return 0;
    }

    // A pre-check only (refuse a broken settings file before a token is read); applySteps re-reads it.
    planSettings(paths, entry, fs);
    const token = await readNewToken(deps);
    try {
      await verifyDownloadToken(base, token, deps.fetch);
      deps.out('The download accepted the token.');
      const saved = await saveNew(token, deps, paths, fs);
      pinDownloadProject(paths, saved.key, deps.pid, fs);
      deps.out(`Pinned the download to project "${saved.key}" (downloadProject in ${paths.storePath}).`);
      return await applySteps({ base, url, paths, entry, pinned: saved.key, mode: 'install' }, deps, fs);
    } catch (e) {
      // Fix 10c: the token just read never reaches a printed message, whatever echoed it.
      if (e instanceof SwitchError) throw new SwitchError(e.code, e.message.split(token).join('<token>'));
      throw e;
    }
  });
}
