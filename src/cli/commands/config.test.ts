import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerConfigCommands } from './config.js';

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerConfigCommands(program);
  return program;
}

const run = (argv: string[]) => makeProgram().parseAsync(argv, { from: 'user' });

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
const tempDirs: string[] = [];

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'b800-cli-config-'));
  tempDirs.push(dir);
  const path = join(dir, 'deployment.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('harmony config get <json-path>', () => {
  it('prints a string value at the given dot-path', async () => {
    const configPath = writeConfig({ launcher: { supabase: { url: 'https://example.supabase.co' } } });

    await run(['config', 'get', 'launcher.supabase.url', '--config', configPath]);

    expect(logSpy).toHaveBeenCalledWith('https://example.supabase.co');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('JSON-encodes an object/array value', async () => {
    const configPath = writeConfig({ launcher: { supabase_refs: { abc123: 'staging' } } });

    await run(['config', 'get', 'launcher.supabase_refs', '--config', configPath]);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ abc123: 'staging' }));
  });

  it('exits non-zero with a clear stderr message when the config file is absent', async () => {
    await expect(
      run(['config', 'get', 'launcher.supabase.url', '--config', '/nonexistent-b800/deployment.json']),
    ).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/no deployment config found/i);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero with a clear stderr message when the path resolves to undefined', async () => {
    const configPath = writeConfig({ launcher: { plugin_dir: '/x' } });

    await expect(
      run(['config', 'get', 'launcher.supabase.url', '--config', configPath]),
    ).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/is not set/i);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exits non-zero with a clear stderr message when the config file is malformed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'b800-cli-config-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'deployment.json');
    writeFileSync(configPath, '{ not valid json');

    await expect(
      run(['config', 'get', 'launcher.supabase.url', '--config', configPath]),
    ).rejects.toThrow(ExitSentinel);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/not valid JSON/i);
  });
});
