// B-1076: the filesystem half of the Codex adapter — `harmony agent render` (src/cli/commands/agent.ts)
// calls this from container/provision.sh, the same route B-1077 rewired for Claude's launch. The
// adapter (codex.ts) stays pure; this module is the only place that touches disk, and it keeps the
// credential discipline: the login-cache file is COPIED (fs.copyFileSync — the bytes never enter this
// process), its existence is checked with a stat, and its path — never its content — is all that is ever
// printed.
//
// Renders, under a dedicated worker CODEX_HOME and the workspace clone:
//   <codexHome>/config.toml        — the harmony MCP server (required = true), approval_policy, doc ceiling
//   <codexHome>/hooks.json         — B-1150: the canonical Harmony hooks (src/agents/hooks.ts), absolute
//                                    plugin root; run because the argv carries --dangerously-bypass-hook-trust
//   <workspace>/AGENTS.md          — ONE generated file: workspace + plugin + web CLAUDE.md + the overlay
//                                    (+ B-1150: each skill's `forbid:` classes as prose rules)
//   <workspace>/.agents/skills     — symlink to <plugin>/skills (Codex discovers .agents/skills)
//   <codexHome>/auth.json          — copy-in of the mounted login cache (mode 0600), when it is not
//                                    already at that path
// and excludes the two generated workspace paths from git status via .git/info/exclude.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { HARMONY_MCP_CONNECTION } from './contract.js';
import { capabilitiesFromSkillMd, parseCapabilities, type CapabilityClass } from './capabilities.js';
import { renderCodexHooks } from './hooks.js';
import {
  CODEX_AUTH_FILE_NAME,
  CODEX_SKILLS_LINK,
  CODEX_WORKER_OVERLAY,
  renderCodexSkillRules,
  GENERATED_AGENTS_HEADER,
  renderCodexAgentsMd,
  renderCodexConfig,
  verifyCodexAgentsMd,
  type InstructionSource,
} from './codex.js';

export interface CodexProvisionInput {
  /** The plugin checkout (container/provision.sh's PLUGIN_DIR). */
  pluginDir: string;
  /** The workspace clone Codex is rooted at (provision.sh's WORKDIR). */
  workspaceDir: string;
  /** The worker's CODEX_HOME. */
  codexHome: string;
  /** Path of the mounted login-cache file (HARMONY_CODEX_AUTH_FILE). */
  authFile: string;
  /** Extra repo paths (HARMONY_REPOS_JSON's `.path`s), whose CLAUDE.md is appended after plugin's. */
  extraRepoPaths?: readonly string[];
}

export interface CodexProvisionResult {
  configPath: string;
  hooksPath: string;
  agentsMdPath: string;
  agentsMdBytes: number;
  sources: string[];
  skillsLink: string;
  authInstalledAt: string;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The CLAUDE.md files that make up the worker's guidance, in deterministic order. */
export function collectInstructionSources(input: Pick<CodexProvisionInput, 'pluginDir' | 'workspaceDir' | 'extraRepoPaths'>): InstructionSource[] {
  const ws = resolve(input.workspaceDir);
  const plugin = resolve(input.pluginDir);
  const candidates: Array<{ label: string; path: string }> = [
    { label: 'workspace/CLAUDE.md', path: join(ws, 'CLAUDE.md') },
    { label: 'plugin/CLAUDE.md', path: join(plugin, 'CLAUDE.md') },
    { label: 'web/CLAUDE.md', path: join(ws, 'web', 'CLAUDE.md') },
  ];
  for (const p of input.extraRepoPaths ?? []) {
    const abs = resolve(p);
    candidates.push({ label: `${abs.replace(/^\/+/, '')}/CLAUDE.md`, path: join(abs, 'CLAUDE.md') });
  }
  const seen = new Set<string>();
  const out: InstructionSource[] = [];
  for (const c of candidates) {
    if (seen.has(c.path) || !isFile(c.path)) continue;
    seen.add(c.path);
    out.push({ label: c.label, content: readFileSync(c.path, 'utf8') });
  }
  return out;
}

/** Every skill's capability classes, read from <plugin>/skills/<name>/SKILL.md in name order. A skill with
 *  no `capabilities:` key is skipped; an invalid one throws (the caller refuses to start). */
export function collectSkillCapabilities(pluginDir: string): Array<{ name: string; classes: CapabilityClass[] }> {
  const root = join(resolve(pluginDir), 'skills');
  if (!existsSync(root)) return [];
  const out: Array<{ name: string; classes: CapabilityClass[] }> = [];
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name, 'SKILL.md');
    if (!isFile(file)) continue;
    const value = capabilitiesFromSkillMd(readFileSync(file, 'utf8'));
    if (value === undefined) continue;
    const parsed = parseCapabilities(value);
    if (!parsed.ok) throw new Error(`skills/${name}/SKILL.md capabilities: ${parsed.problems.join('; ')}`);
    out.push({ name, classes: parsed.classes });
  }
  return out;
}

/** The Codex overlay: the fixed worker overlay plus the skills' unenforced tool rules. */
export function codexOverlayFor(pluginDir: string): string {
  const rules = renderCodexSkillRules(collectSkillCapabilities(pluginDir));
  return rules ? `${CODEX_WORKER_OVERLAY.replace(/\s+$/, '')}\n\n${rules}` : CODEX_WORKER_OVERLAY;
}

function excludeFromGit(workspaceDir: string, entries: readonly string[]): void {
  const gitDir = join(workspaceDir, '.git');
  if (!existsSync(gitDir)) return;
  const infoDir = join(gitDir, 'info');
  mkdirSync(infoDir, { recursive: true });
  const excludePath = join(infoDir, 'exclude');
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const have = new Set(current.split('\n'));
  const missing = entries.filter((e) => !have.has(e));
  if (missing.length) appendFileSync(excludePath, (current === '' || current.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n');
}

function linkSkills(workspaceDir: string, pluginDir: string): string {
  const link = join(workspaceDir, CODEX_SKILLS_LINK);
  const target = join(resolve(pluginDir), 'skills');
  if (!existsSync(target)) throw new Error(`skills directory not found at ${target}`);
  mkdirSync(join(workspaceDir, '.agents'), { recursive: true });
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = null;
  }
  if (st) {
    if (!st.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink — refusing to replace a real skills directory`);
    if (readlinkSync(link) === target) return link;
    unlinkSync(link);
  }
  symlinkSync(target, link, 'dir');
  return link;
}

/** Install the login cache at <codexHome>/auth.json. Existence is a stat; the bytes are copied by the
 *  kernel-side copy and are never read into this process or printed. Mode 0600. */
function installAuth(authFile: string, codexHome: string): string {
  if (!isFile(authFile)) {
    throw new Error(`the Codex login-cache file is missing at ${authFile} (HARMONY_CODEX_AUTH_FILE) — mount it, see container/README.md "Codex credential runbook"`);
  }
  const dest = join(codexHome, CODEX_AUTH_FILE_NAME);
  if (resolve(authFile) !== resolve(dest)) {
    copyFileSync(authFile, dest);
  }
  chmodSync(dest, 0o600);
  return dest;
}

/** Render everything a Codex leg needs onto disk. Throws on any problem (the caller refuses to start). */
export function provisionCodex(input: CodexProvisionInput): CodexProvisionResult {
  const workspaceDir = resolve(input.workspaceDir);
  const codexHome = resolve(input.codexHome);

  const sources = collectInstructionSources(input);
  if (sources.length === 0) throw new Error(`no CLAUDE.md found under ${workspaceDir} / ${input.pluginDir} — nothing to build AGENTS.md from`);
  const agentsMd = renderCodexAgentsMd(sources, codexOverlayFor(input.pluginDir));
  const problems = verifyCodexAgentsMd(agentsMd, sources);
  if (problems.length) throw new Error(`AGENTS.md preflight failed: ${problems.join('; ')}`);

  const agentsMdPath = join(workspaceDir, 'AGENTS.md');
  if (existsSync(agentsMdPath) && !readFileSync(agentsMdPath, 'utf8').startsWith(GENERATED_AGENTS_HEADER)) {
    throw new Error(`${agentsMdPath} exists and is not a generated file — refusing to overwrite a repository's own AGENTS.md`);
  }

  mkdirSync(codexHome, { recursive: true });
  const config = renderCodexConfig(HARMONY_MCP_CONNECTION, { pluginRoot: resolve(input.pluginDir) });
  const configPath = join(codexHome, config.fileName);
  writeFileSync(configPath, config.content, { mode: 0o644 });
  const hooks = renderCodexHooks(resolve(input.pluginDir));
  const hooksPath = join(codexHome, hooks.fileName);
  writeFileSync(hooksPath, hooks.content, { mode: 0o644 });

  writeFileSync(agentsMdPath, agentsMd);
  const skillsLink = linkSkills(workspaceDir, input.pluginDir);
  excludeFromGit(workspaceDir, ['AGENTS.md', '.agents/']);

  const authInstalledAt = installAuth(input.authFile, codexHome);

  return {
    configPath,
    hooksPath,
    agentsMdPath,
    agentsMdBytes: Buffer.byteLength(agentsMd, 'utf8'),
    sources: sources.map((s) => s.label),
    skillsLink,
    authInstalledAt,
  };
}
