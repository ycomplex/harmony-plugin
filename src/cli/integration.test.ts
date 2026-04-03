import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../dist/bin/harmony.js');

describe('CLI smoke tests', () => {
  it('shows help with exit code 0', () => {
    const output = execFileSync('node', [CLI, '--help'], { encoding: 'utf-8' });
    expect(output).toContain('Harmony project management CLI');
    expect(output).toContain('tasks');
    expect(output).toContain('login');
  });

  it('shows version', () => {
    const output = execFileSync('node', [CLI, '--version'], { encoding: 'utf-8' });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
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
    try {
      execFileSync('node', [CLI, 'tasks', 'list'], {
        encoding: 'utf-8',
        env: { ...process.env, HARMONY_CONFIG_DIR: '/tmp/harmony-nonexistent' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('No active project');
    }
  });
});
