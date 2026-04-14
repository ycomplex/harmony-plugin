import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
function getConfigDir() {
    return process.env.HARMONY_CONFIG_DIR ?? path.join(os.homedir(), '.harmony');
}
function getConfigFile() {
    return path.join(getConfigDir(), 'config.json');
}
export function loadConfig() {
    const file = getConfigFile();
    if (!fs.existsSync(file)) {
        return { activeProject: null, projects: {} };
    }
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
}
export function saveConfig(config) {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}
export function addProject(name, token, opts) {
    const config = loadConfig();
    config.projects[name] = { name, token, ...opts };
    config.activeProject = name;
    saveConfig(config);
}
export function removeProject(name) {
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
export function switchProject(name) {
    const config = loadConfig();
    if (!config.projects[name]) {
        throw new Error(`Project "${name}" not found in config. Run \`harmony login\` first.`);
    }
    config.activeProject = name;
    saveConfig(config);
}
export function getActiveProject() {
    const config = loadConfig();
    if (!config.activeProject || !config.projects[config.activeProject]) {
        throw new Error('No active project. Run `harmony login` to add one.');
    }
    return config.projects[config.activeProject];
}
export function listProjects() {
    const config = loadConfig();
    return Object.keys(config.projects).map((name) => ({
        name,
        active: name === config.activeProject,
    }));
}
//# sourceMappingURL=config.js.map