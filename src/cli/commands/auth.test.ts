// B-1025: `harmony login --supabase-anon-key K` with the env pair set used to silently drop K
// (env's key was used instead). The login command now prints a stderr warning when the
// resolver's anon key diverges from the flag the user typed. These tests cover the warning
// path and the silent happy paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { registerAuthCommands } from './auth.js';

// Mocks live at the top so the SUT imports them.
const supabaseMock = vi.hoisted(() => ({
  createAuthenticatedClient: vi.fn(),
  getProject: vi.fn(),
}));
vi.mock('../../supabase.js', () => supabaseMock);
vi.mock('../../tools/project.js', () => ({ getProject: supabaseMock.getProject }));
// Replace HarmonyAuth entirely. The SUT constructs `new HarmonyAuth(token, url, key)`, calls
// createAuthenticatedClient(auth) (a fail-fast probe that calls auth.getAccessToken()), then
// auth.getProjectId(). resolve-supabase-target.ts also imports DEFAULT_SUPABASE_URL and
// DEFAULT_SUPABASE_ANON_KEY from this module — exporting them keeps the resolver working.
const harmonyAuthMock = vi.hoisted(() => ({
  HarmonyAuth: class {
    getAccessToken = vi.fn(async () => 'stub-jwt');
    getProjectId = vi.fn(() => 'proj-stub');
    getUserId = vi.fn(() => 'user-stub');
  },
  DEFAULT_SUPABASE_URL: 'https://eioxsunvhakmelhanmnn.supabase.co',
  DEFAULT_SUPABASE_ANON_KEY: 'prod-baked-anon-key',
  TokenExchangeError: class extends Error {
    constructor(_e: string, public status: number, _b: unknown) {
      super(`Token exchange failed (${status})`);
    }
  },
}));
vi.mock('../../auth.js', () => harmonyAuthMock);

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerAuthCommands(program);
  return program;
}

const run = (argv: string[]) => makeProgram().parseAsync(argv, { from: 'user' });

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-login-test-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', tmpDir);
  // Env pair set so the "user passed --supabase-anon-key only" path triggers the override.
  vi.stubEnv('HARMONY_SUPABASE_URL', 'https://env-prod.supabase.co');
  vi.stubEnv('HARMONY_SUPABASE_ANON_KEY', 'env-prod-anon-key');
  supabaseMock.createAuthenticatedClient.mockResolvedValue({});
  supabaseMock.getProject.mockResolvedValue({ name: 'Env Project' });
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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('harmony login — B-1025 flag-override warning', () => {
  it('--supabase-anon-key K with env pair set prints a stderr warning that K was overridden', async () => {
    await run([
      'login',
      '--token',
      't1',
      '--name',
      'override-test',
      '--supabase-anon-key',
      'user-typed-key',
    ]);

    const warningCalls = errSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === 'string' && arg.includes('--supabase-anon-key was overridden'),
      ),
    );
    expect(warningCalls).toHaveLength(1);
    expect(warningCalls[0][0]).toMatch(/--supabase-anon-key was overridden by env/);
    expect(warningCalls[0][0]).toMatch(/Pass --supabase-url/);
  });

  it('both flags passed (matching what the resolver would have picked anyway): no warning', async () => {
    // The user passes both flags — the flag tier owns the pair, no override, no warning.
    await run([
      'login',
      '--token',
      't1',
      '--name',
      'paired-test',
      '--supabase-url',
      'https://env-prod.supabase.co',
      '--supabase-anon-key',
      'env-prod-anon-key',
    ]);

    const warningCalls = errSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('--supabase-anon-key was overridden'),
      ),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('no flags + env pair set: no warning (resolver picks env, flags are simply absent)', async () => {
    await run(['login', '--token', 't1', '--name', 'env-only']);

    const warningCalls = errSpy.mock.calls.filter((call) =>
      call.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('--supabase-anon-key was overridden'),
      ),
    );
    expect(warningCalls).toHaveLength(0);
  });

  it('--json mode suppresses the human warning (json consumers do not want prose on stderr)', async () => {
    await run([
      '--json',
      'login',
      '--token',
      't1',
      '--name',
      'override-test-json',
      '--supabase-anon-key',
      'user-typed-key',
    ]);

    const warningCalls = errSpy.mock.calls.filter((call) =>
      call.some(
        (arg) => typeof arg === 'string' && arg.includes('--supabase-anon-key was overridden'),
      ),
    );
    expect(warningCalls).toHaveLength(0);
  });
});
