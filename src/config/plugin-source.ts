// Installation identity, independent of the board target and conductor channel.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface PluginSource {
  repository: string | null;
  clone_url: string | null;
  channel: 'prod' | 'staging' | 'local' | 'unknown';
  evidence: string;
}
export function runningPluginRoot(moduleUrl = import.meta.url, read = (p: string) => readFileSync(p, 'utf8')): string | null {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 8; i++) {
    try { if (JSON.parse(read(join(dir, '.claude-plugin/plugin.json'))).name === 'harmony-plugin') return dir; } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
export function resolvePluginSource(opts: {
  root?: string | null;
  home?: string;
  read?: (path: string) => string;
  canonical?: (path: string) => string;
} = {}): PluginSource {
  const read = opts.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const canonical = opts.canonical ?? realpathSync;
  const root = opts.root === undefined ? runningPluginRoot(import.meta.url, read) : opts.root;
  const result: PluginSource = { repository: null, clone_url: null, channel: 'unknown', evidence: 'no installation evidence' };
  if (!root) return result;
  const json = (p: string): any => { try { return JSON.parse(read(p)); } catch { return null; } };
  const manifest = json(join(root, '.claude-plugin/plugin.json'));
  if (manifest?.name !== 'harmony-plugin') return result;
  // Refuse credentials, query strings and non-GitHub remotes; never read .git/config.
  const match = typeof manifest.repository === 'string' && /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(manifest.repository);
  if (match) {
    result.repository = `${match[1]}/${match[2]}`;
    result.clone_url = `https://github.com/${result.repository}.git`;
  }
  const channels = new Set<PluginSource['channel']>();
  const evidence = new Set<string>();
  const pluginsDir = join(opts.home ?? homedir(), '.claude/plugins');
  const installed = json(join(pluginsDir, 'installed_plugins.json'));
  const marketplaces = json(join(pluginsDir, 'known_marketplaces.json'));
  if (installed?.plugins && typeof installed.plugins === 'object') {
    for (const [key, registrations] of Object.entries(installed.plugins)) {
      if (!key.startsWith('harmony-plugin@') || !Array.isArray(registrations)) continue;
      for (const entry of registrations) {
        if (typeof entry?.installPath !== 'string') continue;
        try { if (canonical(entry.installPath) !== canonical(root)) continue; } catch { continue; }
        const market = marketplaces?.[key.slice('harmony-plugin@'.length)];
        if (typeof market?.installLocation !== 'string') continue;
        const catalog = json(join(market.installLocation, '.claude-plugin/marketplace.json'));
        const sources = Array.isArray(catalog?.plugins) ? catalog.plugins.filter((p: any) => p?.name === 'harmony-plugin') : [];
        for (const plugin of sources) {
          if (plugin.source?.source !== 'github' || plugin.source.repo !== result.repository) continue;
          if (plugin.source.ref === 'prod' || plugin.source.ref === 'staging') {
            channels.add(plugin.source.ref); evidence.add('matching installation and marketplace source.ref');
          }
        }
      }
    }
  }
  // Read HEAD only, never remotes or the git configuration. A worktree's .git points to its own HEAD.
  try {
    let gitDir = join(root, '.git');
    try {
      const pointer = read(gitDir).trim();
      if (pointer.startsWith('gitdir: ')) gitDir = resolve(root, pointer.slice(8));
    } catch { /* ordinary .git directory */ }
    const head = read(join(gitDir, 'HEAD')).trim();
    if (head === 'ref: refs/heads/prod' || head === 'ref: refs/heads/staging') {
      channels.add(head.endsWith('/prod') ? 'prod' : 'staging'); evidence.add('running checkout branch');
    } else if (head.startsWith('ref: refs/heads/')) {
      channels.add('local'); evidence.add('running source checkout branch');
    }
  } catch { /* detached/cache installs need registration evidence */ }
  if (channels.size === 1) { result.channel = [...channels][0]; result.evidence = [...evidence].sort().join('; '); }
  else if (channels.size > 1) result.evidence = 'conflicting installation evidence';
  return result;
}
