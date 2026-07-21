import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveEnvironment } from './environment.js';

// A module URL with no .claude-plugin/plugin.json anywhere above it, so the
// version fallback bottoms out at null instead of finding this repo's manifest.
const NOWHERE_URL = 'file:///nonexistent-b488/a/b/c/module.js';

const tempDirs: string[] = [];
function makePluginRoot(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'b488-env-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
  return root;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('resolveEnvironment', () => {
  it('defaults to the prod Supabase project when HARMONY_SUPABASE_URL is unset', () => {
    const env = resolveEnvironment({}, NOWHERE_URL);
    expect(env.supabase_url).toBe('https://eioxsunvhakmelhanmnn.supabase.co');
    expect(env.supabase_project_ref).toBe('eioxsunvhakmelhanmnn');
    expect(env.target).toBe('prod');
  });

  it('maps the staging ref to target staging when HARMONY_SUPABASE_URL points there', () => {
    const env = resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://meqkdgncdzromunylyxf.supabase.co' },
      NOWHERE_URL,
    );
    expect(env.supabase_url).toBe('https://meqkdgncdzromunylyxf.supabase.co');
    expect(env.supabase_project_ref).toBe('meqkdgncdzromunylyxf');
    expect(env.target).toBe('staging');
  });

  it('maps an unrecognized URL to target custom with its ref extracted', () => {
    const env = resolveEnvironment(
      { HARMONY_SUPABASE_URL: 'https://somelocalproject.supabase.co' },
      NOWHERE_URL,
    );
    expect(env.supabase_project_ref).toBe('somelocalproject');
    expect(env.target).toBe('custom');
  });

  it('degrades a malformed URL to target custom with an empty ref (never throws)', () => {
    const env = resolveEnvironment({ HARMONY_SUPABASE_URL: 'not a url' }, NOWHERE_URL);
    expect(env.supabase_project_ref).toBe('');
    expect(env.target).toBe('custom');
    expect(env.plugin_version).toBeNull();
  });

  it('reads plugin_version from $CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json first', () => {
    const root = makePluginRoot('9.9.9');
    const env = resolveEnvironment({ CLAUDE_PLUGIN_ROOT: root }, NOWHERE_URL);
    expect(env.plugin_version).toBe('9.9.9');
  });

  it('falls back to the manifest relative to the running module (dist/index.js layout)', () => {
    const root = makePluginRoot('8.8.8');
    // Simulate the bundled entry point: <root>/dist/index.js, manifest one level up.
    const moduleUrl = pathToFileURL(join(root, 'dist', 'index.js')).href;
    const env = resolveEnvironment({}, moduleUrl);
    expect(env.plugin_version).toBe('8.8.8');
  });

  it('prefers CLAUDE_PLUGIN_ROOT over the module-relative manifest, but falls through when its manifest is unreadable', () => {
    const root = makePluginRoot('7.7.7');
    const moduleUrl = pathToFileURL(join(root, 'dist', 'bin', 'harmony.js')).href;
    // A bogus root must not mask the module-relative fallback (two levels up for dist/bin/*).
    const env = resolveEnvironment({ CLAUDE_PLUGIN_ROOT: '/nonexistent-b488-root' }, moduleUrl);
    expect(env.plugin_version).toBe('7.7.7');
  });

  it('returns plugin_version null when no manifest is reachable', () => {
    const env = resolveEnvironment({}, NOWHERE_URL);
    expect(env.plugin_version).toBeNull();
  });
});
