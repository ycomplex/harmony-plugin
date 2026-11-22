import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveSupabaseTarget } from './resolve-supabase-target.js';

export interface ProjectConfig {
  name: string;
  token: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabasePublishableKey?: string;
  /** B-1501: the Harmony project id the token exchange returned when this entry was saved. Entries
   *  saved before B-1501 have none and are read as they always were. */
  projectId?: string;
  /** B-1501: the Supabase URL the token was exchanged against when it was saved. Not used to pick a
   *  pair (the stored flags above do that, B-1025); used to refuse sending this token to a different
   *  backend under HARMONY_PROJECT (src/config/project-resolution.ts). */
  verifiedUrl?: string;
}

export interface HarmonyConfig {
  activeProject: string | null;
  projects: Record<string, ProjectConfig>;
  /** B-1501: the stored project whose token the download helper sends (`harmony download token
   *  use|set`). Pinning never changes activeProject. */
  downloadProject?: string;
}

export function getConfigDir(): string {
  return process.env.HARMONY_CONFIG_DIR ?? path.join(os.homedir(), '.harmony');
}

export function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): HarmonyConfig {
  const file = getConfigFile();
  if (!fs.existsSync(file)) {
    return { activeProject: null, projects: {} };
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<HarmonyConfig> | null;
  // B-1501: read an entry written by any earlier version tolerantly (no projectId, no pin).
  return {
    ...(parsed ?? {}),
    activeProject: parsed?.activeProject ?? null,
    projects: parsed?.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
  };
}

/** B-1501: written atomically — a temp file in the same directory (mode 600), fsynced, then renamed
 *  over config.json — so a reader (the download helper, another CLI) never sees an empty or
 *  half-written file. */
export function saveConfig(config: HarmonyConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'config.json');
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeSync(fd, JSON.stringify(config, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export function addProject(
  name: string,
  token: string,
  opts?: { supabaseUrl?: string; supabaseAnonKey?: string; supabasePublishableKey?: string },
): void {
  const config = loadConfig();
  config.projects[name] = { name, token, ...opts };
  config.activeProject = name;
  saveConfig(config);
}

export interface SaveProjectInput {
  /** The key to store under: the slug of the project's name, or `--name`. */
  name: string;
  token: string;
  projectId?: string;
  verifiedUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabasePublishableKey?: string;
  /** true when the person chose the key (`--name`); then an entry for the same project under
   *  another key is not reused. */
  explicitName?: boolean;
  /** `harmony login` activates (as before B-1501); install, token set and setup do not. A
   *  non-activating save NEVER sets activeProject, even when there is none (the seat's ruling on
   *  B-1501): the person runs `harmony project switch <name>` if they want one. */
  activate: boolean;
}

export interface SaveProjectResult {
  /** The key the token is stored under — what HARMONY_PROJECT names. */
  key: string;
  /** Set when the wanted key held a DIFFERENT project, which was left untouched. */
  collidedWith?: string;
  activated: boolean;
}

function trimUrl(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

/** The backend a stored entry was (or would be) exchanged against: the URL it was checked against
 *  when saved, else its own stored pair's URL, else what a no-flag call resolves to now (the
 *  environment, then the built-in default). null when that cannot be resolved. */
function backendOf(p: ProjectConfig): string | null {
  if (p.verifiedUrl) return trimUrl(p.verifiedUrl);
  if (p.supabaseUrl) return trimUrl(p.supabaseUrl);
  try {
    return trimUrl(resolveSupabaseTarget({ flags: {}, project: undefined }).url);
  } catch {
    return null;
  }
}

/** Is `existing` (stored under `key`) the same Harmony project as the one being saved? Ids decide
 *  when both carry one: only a known, DIFFERENT id is a collision. An entry saved before B-1501
 *  carries none: it is the same project when it holds the same token, or — a token rotation — when
 *  it is stored under the very key being saved and its backend is the one the new token was just
 *  checked against (fix 4). Anything else it cannot identify is left alone. */
function sameProject(existing: ProjectConfig, key: string, input: SaveProjectInput): boolean {
  if (existing.projectId && input.projectId) return existing.projectId === input.projectId;
  if (!input.projectId) return true;
  if (existing.token === input.token) return true;
  if (key !== input.name || !input.verifiedUrl) return false;
  return backendOf(existing) === trimUrl(input.verifiedUrl);
}

/**
 * B-1501: store a verified token keyed by its project. A save never overwrites a different
 * project's entry: when the wanted key is taken by another project the token is stored under
 * `<name>-<first 8 of the project id>` (then `-2`, `-3`, ...), and `collidedWith` says so.
 */
export function saveProject(input: SaveProjectInput): SaveProjectResult {
  const config = loadConfig();
  let key = input.name;
  if (!input.explicitName && input.projectId) {
    const byId = Object.keys(config.projects).find((k) => config.projects[k]?.projectId === input.projectId);
    if (byId) key = byId;
  }
  let collidedWith: string | undefined;
  const existing = config.projects[key];
  if (existing && !sameProject(existing, key, input)) {
    collidedWith = key;
    const base = input.projectId ? `${input.name}-${input.projectId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}` : `${input.name}-2`;
    key = base;
    for (let n = 2; config.projects[key] && !sameProject(config.projects[key], key, input); n++) key = `${base}-${n}`;
  }
  const previous = config.projects[key];
  const entry: ProjectConfig = { name: key, token: input.token };
  const flagsGiven = input.supabaseUrl !== undefined || input.supabaseAnonKey !== undefined || input.supabasePublishableKey !== undefined;
  // Fix 4: a save with no Supabase flags over the same project keeps the pair it was stored with.
  const pair = flagsGiven ? input : (previous ?? {});
  if (pair.supabaseUrl !== undefined) entry.supabaseUrl = pair.supabaseUrl;
  if (pair.supabaseAnonKey !== undefined) entry.supabaseAnonKey = pair.supabaseAnonKey;
  if (pair.supabasePublishableKey !== undefined) entry.supabasePublishableKey = pair.supabasePublishableKey;
  if (input.projectId) entry.projectId = input.projectId;
  if (input.verifiedUrl) entry.verifiedUrl = input.verifiedUrl;
  config.projects[key] = entry;
  const activated = input.activate;
  if (activated) config.activeProject = key;
  saveConfig(config);
  return { key, collidedWith, activated };
}

export function removeProject(name: string): void {
  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Project "${name}" not found in config.`);
  }
  delete config.projects[name];
  if (config.activeProject === name) {
    const remaining = Object.keys(config.projects);
    config.activeProject = remaining.length > 0 ? remaining[0] : null;
  }
  saveConfig(config);
}

export function switchProject(name: string): void {
  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Project "${name}" not found in config. Run \`harmony login\` first.`);
  }
  config.activeProject = name;
  saveConfig(config);
}

export function getActiveProject(): ProjectConfig {
  const config = loadConfig();
  if (!config.activeProject || !config.projects[config.activeProject]) {
    throw new Error('No active project. Run `harmony login` to add one.');
  }
  return config.projects[config.activeProject];
}

export function listProjects(): Array<{ name: string; active: boolean; download: boolean }> {
  const config = loadConfig();
  return Object.keys(config.projects).map((name) => ({
    name,
    active: name === config.activeProject,
    download: name === config.downloadProject,
  }));
}
