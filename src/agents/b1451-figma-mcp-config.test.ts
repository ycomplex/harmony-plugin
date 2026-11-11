// B-1451: the Claude launch line loads the private Figma config with --mcp-config, only when it exists;
// provision.sh keeps Figma non-fatal, installs the push guard, detaches the plugin checkout and
// refuses a dirty one once, before the first agent launch.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeAdapter } from './claude-code.js';
import { figmaMcpConfigArg } from '../cli/commands/agent.js';

const PROVISION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'container', 'provision.sh'),
  'utf8',
);

describe('B-1451 --mcp-config', () => {
  it('appends --mcp-config <path> when given a path', () => {
    const argv = claudeCodeAdapter.headless.buildArgv({ pluginDir: '/p', prompt: 'hi', mcpConfigPath: '/h/.harmony/figma-mcp.json' });
    expect(argv.slice(-2)).toEqual(['--mcp-config', '/h/.harmony/figma-mcp.json']);
  });
  it('adds nothing without a path', () => {
    expect(claudeCodeAdapter.headless.buildArgv({ pluginDir: '/p', prompt: 'hi' })).not.toContain('--mcp-config');
  });
  it('passes the env path only when the file exists', () => {
    const env = { HARMONY_FIGMA_MCP_CONFIG: '/h/f.json' };
    expect(figmaMcpConfigArg(env, () => true)).toEqual({ mcpConfigPath: '/h/f.json' });
    expect(figmaMcpConfigArg(env, () => false)).toEqual({});
    expect(figmaMcpConfigArg({}, () => true)).toEqual({});
  });
});

describe('B-1451 provision.sh contract', () => {
  it('install-worker is non-fatal and exports the config path only when written', () => {
    expect(PROVISION).not.toMatch(/figma install-worker[^\n]*\|\| exit 1/);
    expect(PROVISION).toMatch(/figma install-worker[^\n]*\|\|\n\s*echo "B-1451: figma install-worker failed/);
    expect(PROVISION).toMatch(/if \[ -s "\$B1451_FIGMA_MCP_CONFIG" \]; then\n\s*export HARMONY_FIGMA_MCP_CONFIG=/);
  });
  it('installs the guard, detaches and deletes protected local branches before the launch loop', () => {
    // Before the B-718 marker: the contract suites extract and run the region after it against a
    // real checkout, so nothing that detaches or deletes branches may sit inside it.
    const loop = PROVISION.indexOf('# --- B-718: same-conduction resume discovery');
    const install = PROVISION.lastIndexOf('container/git-guard/install.sh" "$HOME/.harmony/git-guard" "$HOME/bin" "$PLUGIN_DIR"', loop);
    const detach = PROVISION.indexOf('git -C "$PLUGIN_DIR" checkout -q --detach');
    const del = PROVISION.indexOf('for b1451_branch in staging prod main; do');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(detach);
    expect(detach).toBeLessThan(del);
    expect(del).toBeLessThan(loop);
  });
  it('runs the dirty check exactly once, before the first agent launch', () => {
    const matches = PROVISION.match(/git-guard\/dirty-check\.sh/g) ?? [];
    expect(matches).toHaveLength(1);
    const check = PROVISION.indexOf('git-guard/dirty-check.sh" "$PLUGIN_DIR" || exit 1');
    const loop = PROVISION.indexOf('# --- B-718: same-conduction resume discovery');
    const firstLaunch = PROVISION.indexOf('_agent_argv "$RESUME_SESSION_ID"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(loop);
    expect(loop).toBeLessThan(firstLaunch);
  });
  it('never sets a global core.hooksPath', () => {
    expect(PROVISION).not.toMatch(/config --global core\.hooksPath/);
  });
});
