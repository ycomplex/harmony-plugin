import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ProjectConfig {
  name: string;
  token: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface HarmonyConfig {
  activeProject: string | null;
  projects: Record<string, ProjectConfig>;
}

function getConfigDir(): string {
  return process.env.HARMONY_CONFIG_DIR ?? path.join(os.homedir(), '.harmony');
}

function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): HarmonyConfig {
  const file = getConfigFile();
  if (!fs.existsSync(file)) {
    return { activeProject: null, projects: {} };
  }
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw) as HarmonyConfig;
}

export function saveConfig(config: HarmonyConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

export function addProject(
  name: string,
  token: string,
  opts?: { supabaseUrl?: string; supabaseAnonKey?: string },
): void {
  const config = loadConfig();
  config.projects[name] = { name, token, ...opts };
  config.activeProject = name;
  saveConfig(config);
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

export function listProjects(): Array<{ name: string; active: boolean }> {
  const config = loadConfig();
  return Object.keys(config.projects).map((name) => ({
    name,
    active: name === config.activeProject,
  }));
}
