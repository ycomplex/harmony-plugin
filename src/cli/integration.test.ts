import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CLI = path.resolve(ROOT, 'dist/bin/harmony.js');
const temporaryRoots: string[] = [];

function installedCopy(version: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'harmony-cli-version-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, 'dist/bin'), { recursive: true });
  mkdirSync(path.join(root, '.claude-plugin'));
  copyFileSync(CLI, path.join(root, 'dist/bin/harmony.js'));
  writeFileSync(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ version }));
  return root;
}

describe('CLI smoke tests', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf-8' });
  });
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it('shows help with exit code 0', () => {
    const output = execFileSync('node', [CLI, '--help'], { encoding: 'utf-8' });
    expect(output).toContain('Harmony project management CLI');
    expect(output).toContain('tasks');
    expect(output).toContain('login');
  });

  it('shows the checkout plugin version, including the development marker on main', () => {
    const output = execFileSync('node', [CLI, '--version'], { encoding: 'utf-8' });
    const manifest = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf-8'));
    expect(output.trim()).toBe(manifest.version);
  });

  it.each(['0.0.0-dev', '0.16.0', '0.16.1'])('reads installed version %s at runtime without node_modules', (version) => {
    const root = installedCopy(version);
    const cli = path.join(root, 'dist/bin/harmony.js');
    // A stale package version must never win over the release manifest.
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.14.70' }));
    const options = { cwd: tmpdir(), encoding: 'utf-8' as const, env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT } };
    expect(execFileSync('node', [cli, '--version'], options).trim()).toBe(version);
    // Marketplace copies need neither package metadata nor installed dependencies.
    rmSync(path.join(root, 'package.json'));
    expect(execFileSync('node', [cli, '--version'], options).trim()).toBe(version);
  });

  it('reports the pointed-to plugin version through the PATH wrapper from another directory', () => {
    const root = installedCopy('0.16.0');
    const bin = path.join(root, 'bin');
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: root,
      HARMONY_HOME: path.join(root, 'harmony-home'),
      HARMONY_BIN_DIR: bin,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    execFileSync('sh', [path.join(ROOT, 'hooks/link-cli.sh')], { env, encoding: 'utf-8' });
    // The executable's own manifest must win over an unrelated environment root.
    env.CLAUDE_PLUGIN_ROOT = ROOT;
    expect(execFileSync('harmony', ['--version'], { env, cwd: tmpdir(), encoding: 'utf-8' }).trim()).toBe('0.16.0');
  });

  it('shows tasks subcommand help', () => {
    const output = execFileSync('node', [CLI, 'tasks', '--help'], { encoding: 'utf-8' });
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('query');
  });

  it('errors without auth when running a command', () => {
    // B-1070: strip HARMONY_API_TOKEN (and its EVAL_ twin) too — getAuthenticatedContext() now
    // falls back to it when no active project is configured, so a real "no auth at all" repro
    // needs both absent, not just the config dir.
    const env = { ...process.env, HARMONY_CONFIG_DIR: '/tmp/harmony-nonexistent' };
    delete env.HARMONY_API_TOKEN;
    delete env.EVAL_HARMONY_API_TOKEN;
    try {
      execFileSync('node', [CLI, 'tasks', 'list'], {
        encoding: 'utf-8',
        env,
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('No active project');
    }
  });
});
