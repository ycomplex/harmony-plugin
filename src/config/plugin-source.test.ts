import { describe, expect, it } from 'vitest';
import { resolvePluginSource, runningPluginRoot } from './plugin-source.js';
import { runDoctor } from '../cli/commands/conductor-config.js';
const root = '/installed/plugin';
function fixture(ref?: string, head?: string) {
  const files: Record<string, string> = {
    [`${root}/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'harmony-plugin', repository: 'https://github.com/ycomplex/harmony-plugin' }),
  };
  if (ref) {
    files['/home/operator/.claude/plugins/installed_plugins.json'] = JSON.stringify({ plugins: { 'harmony-plugin@ycomplex': [{ installPath: root }] } });
    files['/home/operator/.claude/plugins/known_marketplaces.json'] = JSON.stringify({ ycomplex: { installLocation: '/market' } });
    files['/market/.claude-plugin/marketplace.json'] = JSON.stringify({ plugins: [{ name: 'harmony-plugin', source: { source: 'github', repo: 'ycomplex/harmony-plugin', ref } }] });
  }
  if (head) files[`${root}/.git/HEAD`] = `ref: refs/heads/${head}`;
  const reads: string[] = [];
  const read = (p: string) => { reads.push(p); if (!(p in files)) throw new Error('missing'); return files[p]; };
  const resolve = () => resolvePluginSource({ root, home: '/home/operator', read, canonical: (p) => p });
  return { files, reads, read, resolve };
}
describe('installed plugin source', () => {
  it.each(['prod', 'staging'] as const)('uses matching registration source.ref %s', (channel) => {
    expect(fixture(channel).resolve()).toEqual({ repository: 'ycomplex/harmony-plugin', clone_url: 'https://github.com/ycomplex/harmony-plugin.git', channel, evidence: 'matching installation and marketplace source.ref' });
  });
  it.each(['prod', 'staging', 'main', 'feat/B-1433'])('uses same checkout HEAD %s', (head) => {
    expect(fixture(undefined, head).resolve().channel).toBe(['prod', 'staging'].includes(head) ? head : 'local');
  });
  it('does not mistake a different installed version for this one', () => {
    const h = fixture('prod');
    h.files['/home/operator/.claude/plugins/installed_plugins.json'] = JSON.stringify({ plugins: { 'harmony-plugin@ycomplex': [{ installPath: '/another/plugin' }] } });
    expect(h.resolve().channel).toBe('unknown');
  });
  it('refuses conflicting or missing evidence', () => {
    expect(fixture('prod', 'staging').resolve()).toMatchObject({ channel: 'unknown', evidence: 'conflicting installation evidence' });
    expect(fixture().resolve().channel).toBe('unknown');
    expect(fixture('main').resolve().channel).toBe('unknown');
  });
  it('requires the manifest repository to match the marketplace source', () => {
    const h = fixture('prod');
    h.files['/market/.claude-plugin/marketplace.json'] = JSON.stringify({ plugins: [{ name: 'harmony-plugin', source: { source: 'github', repo: 'other/repo', ref: 'prod' } }] });
    expect(h.resolve().channel).toBe('unknown');
  });
  it('never accepts credentials or reads git remotes, login or host files', () => {
    const h = fixture('prod', 'main');
    h.files[`${root}/.claude-plugin/plugin.json`] = JSON.stringify({ name: 'harmony-plugin', repository: 'https://secret@github.com/owner/repo' });
    expect(h.resolve().clone_url).toBeNull();
    expect(h.reads.every((p) => /plugin.json$|installed_plugins.json$|known_marketplaces.json$|marketplace.json$|\.git$|\/HEAD$/.test(p))).toBe(true);
  });
  it('follows a worktree gitdir to its HEAD only', () => {
    const h = fixture(); h.files[`${root}/.git`] = 'gitdir: /repo/.git/worktrees/check';
    h.files['/repo/.git/worktrees/check/HEAD'] = 'ref: refs/heads/main';
    expect(h.resolve().channel).toBe('local');
  });
  it('locates a bundled or source module from its own ancestry, never cwd/env', () => {
    const h = fixture();
    expect(runningPluginRoot(`file://${root}/dist/bin/harmony.js`, h.read)).toBe(root);
    expect(runningPluginRoot(`file://${root}/src/config/plugin-source.ts`, h.read)).toBe(root);
  });
  it('adds plugin facts without changing doctor config exit semantics', () => {
    const plugin = fixture('prod').resolve();
    const result = runDoctor({ env: { HOME: '/none', HARMONY_HOME: '/none' }, existsSync: () => false, readFileSync: () => { throw new Error('absent'); }, pluginSource: () => plugin });
    expect(result.data.plugin).toEqual(plugin);
    expect(result.lines).toContain('Plugin repository: ycomplex/harmony-plugin');
    expect(result.lines).toContain('Plugin channel: prod');
    expect(result.exitCode).toBe(0);
  });
});
