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

import nodeFs from 'node:fs';
import path from 'node:path';

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
  /** Verify a token against Harmony and store it in the CLI store (the `harmony login` path). Returns the project name. */
  saveToken: (token: string) => Promise<string>;
  now: () => Date;
  pid: number;
  fs?: FsOps;
}

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

/** The helper Claude Code runs for each download. POSIX sh. It prints only the header on stdout; it never
 *  writes the token to a file or log and never prints it to stderr. Token order matches the setup's:
 *  HARMONY_API_TOKEN, then the active project's token in config.json beside the helper. */
export function helperScript(): string {
  return `#!/bin/sh
# Written by \`harmony download switch\`. Claude Code runs it to get the header for Harmony's plugin download.
# It prints {"Authorization":"Bearer <token>"} and nothing else. It holds no token: it reads HARMONY_API_TOKEN,
# or the active project's token in config.json beside it (where \`harmony login\` stores it).
t="\${HARMONY_API_TOKEN:-}"
if [ -z "$t" ]; then
  t=$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const p = c && c.activeProject && c.projects && c.projects[c.activeProject]; if (p && typeof p.token === "string") process.stdout.write(p.token); } catch (e) {}' "$(dirname "$0")/config.json" 2>/dev/null) || t=""
fi
if [ -z "$t" ]; then
  echo "harmony: no Harmony token found" >&2
  exit 1
fi
t=$(printf '%s' "$t" | tr -d '\\r\\n' | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g')
printf '{"Authorization":"Bearer %s"}' "$t"
`;
}

export class SwitchError extends Error {
  constructor(public readonly code: 1 | 2, message: string) {
    super(message);
  }
}

type TokenSource = 'env' | 'store';

/** Where a token is, without printing or returning it. The order the helper uses: env, then store. */
export function findToken(deps: Pick<SwitchDeps, 'env'>, paths: Paths, fs: FsOps): TokenSource | null {
  if (deps.env.HARMONY_API_TOKEN) return 'env';
  if (!fs.existsSync(paths.storePath)) return null;
  try {
    const c = JSON.parse(String(fs.readFileSync(paths.storePath, 'utf-8')));
    const p = c?.activeProject ? c?.projects?.[c.activeProject] : undefined;
    if (p && typeof p.token === 'string' && p.token.length > 0) return 'store';
  } catch {
    /* an unreadable store counts as no token */
  }
  return null;
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

function describeFailure(args: string[], r: ClaudeResult): string {
  const text = `${r.stdout}\n${r.stderr}`.trim().split('\n').filter((l) => l.trim() !== '').slice(-3).join(' / ');
  return `\`claude ${args.join(' ')}\` failed (exit ${r.code})${text ? `: ${text}` : ''}`;
}

async function runOrFail(deps: SwitchDeps, args: string[], tolerate?: RegExp): Promise<ClaudeResult & { tolerated: boolean }> {
  const r = await deps.runClaude(args);
  if (r.code === 0) return { ...r, tolerated: false };
  if (tolerate && tolerate.test(`${r.stdout}\n${r.stderr}`)) return { ...r, tolerated: true };
  throw new SwitchError(1, describeFailure(args, r));
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
  if (t.code !== 0) throw new SwitchError(1, describeFailure(plain, t));
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

async function ensureToken(paths: Paths, deps: SwitchDeps, fs: FsOps, dryRun: boolean): Promise<TokenSource | 'saved'> {
  const found = findToken(deps, paths, fs);
  if (found) return found;
  const projectFile = fs.existsSync(paths.projectLocalSettingsPath);
  if (projectFile && deps.isTTY && !dryRun) {
    const token = readProjectFileToken(paths, fs);
    if (token) {
      const answer = await deps.ask(
        'Found a Harmony token in this project\'s .claude/settings.local.json. Save this token to the harmony store (~/.harmony/config.json) so the download can use it? [y/N] ',
      );
      if (/^\s*y(es)?\s*$/i.test(answer)) {
        try {
          const name = await deps.saveToken(token);
          deps.out(`Saved the token to the harmony store (project "${name}", now active).`);
          return 'saved';
        } catch (e: any) {
          const msg = String(e?.message ?? e).split(token).join('<token>');
          throw new SwitchError(1, `the token could not be verified, so it was not saved: ${msg}`);
        }
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

async function doSwitch(opts: SwitchOptions, deps: SwitchDeps): Promise<number> {
  const fs = deps.fs ?? (nodeFs as unknown as FsOps);
  const base = normalizeBase(opts.base);
  const url = marketplaceUrl(base);
  const paths = resolvePaths(deps);
  const entry = desiredEntry(url, paths.helperPath);

  if (opts.dryRun) return dryRun(base, url, paths, entry, deps, fs);

  await ensureToken(paths, deps, fs, false);
  const settings = planSettings(paths, entry, fs);

  const helperWritten = writeHelper(paths, fs);
  deps.out(helperWritten ? `Wrote the helper ${paths.helperPath}` : `The helper ${paths.helperPath} is already in place.`);

  let backup: string | null = fs.existsSync(paths.backupPath) ? paths.backupPath : null;
  if (settings.merged) {
    fs.mkdirSync(paths.claudeDir, { recursive: true });
    if (settings.exists && !backup) {
      fs.copyFileSync(paths.settingsPath, paths.backupPath);
      backup = paths.backupPath;
      deps.out(`Saved your settings as ${paths.backupPath}`);
    }
    atomicWrite(paths.settingsPath, JSON.stringify(settings.merged, null, 2) + '\n', settings.mode ?? 0o600, deps.pid, fs);
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
          'Claude Code has not fetched the Harmony marketplace yet. The settings and helper are in place.',
          'Start Claude Code once (open it, wait for the prompt, then /exit), then run `harmony download switch` again.',
          'If it still fails, check your token works: run `harmony projects`, or check HARMONY_API_TOKEN is set.',
        ].join('\n'),
      );
      return 2;
    }
  }

  const install = await runOrFail(deps, ['plugin', 'install', INSTALL_ID], /already installed/i);
  deps.out(install.tolerated ? `${INSTALL_ID} is already installed.` : `Installed ${INSTALL_ID}.`);

  const disable = await runOrFail(
    deps,
    ['plugin', 'disable', TODAYS_ID, '--scope', 'user'],
    /already disabled|not installed|not found/i,
  );
  const disabledTodaysCopy = !disable.tolerated;
  deps.out(disabledTodaysCopy ? `Disabled today's copy (${TODAYS_ID}) for your user.` : `Today's copy (${TODAYS_ID}) was already disabled for your user (or is not installed).`);

  const projectEnables = projectEnablesTodaysCopy(paths, fs);
  if (projectEnables) deps.out(PROJECT_DISABLE_HINT);

  const record = {
    base,
    marketplace_url: url,
    helper_path: paths.helperPath,
    settings_path: paths.settingsPath,
    backup_path: backup,
    disabled_ycomplex_user_scope: disabledTodaysCopy,
    switched_at: deps.now().toISOString(),
  };
  fs.writeFileSync(paths.recordPath, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });

  deps.out('');
  deps.out(`Done: ${INSTALL_ID} is installed from ${url}.`);
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
  deps.out(`Token: found (${token === 'env' ? 'HARMONY_API_TOKEN' : 'the harmony store'}).`);
  return 0;
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

  const enable = await runOrFail(deps, ['plugin', 'enable', TODAYS_ID, '--scope', 'user'], /already enabled/i);
  deps.out(enable.tolerated ? `Today's copy (${TODAYS_ID}) was already enabled for your user.` : `Enabled today's copy (${TODAYS_ID}) for your user.`);

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
