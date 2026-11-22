// B-1025: `harmony login --supabase-anon-key K` with the env pair set used to silently drop K
// (env's key was used instead). The login command now prints a stderr warning when the
// resolver's anon key diverges from the flag the user typed. These tests cover the warning
// path and the silent happy paths.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { Readable } from 'node:stream';
import { loginInput, readTokenFromStdin, registerAuthCommands } from './auth.js';

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

it('registers the new flag in its own saved field without rewriting old projects', async () => {
  await run(['login', '--token', 'synthetic-token', '--name', 'new-alias',
    '--supabase-url', 'https://synthetic.supabase.co', '--supabase-publishable-key', 'sb_publishable_synthetic']);
  const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  expect(stored.projects['new-alias']).toMatchObject({ supabasePublishableKey: 'sb_publishable_synthetic' });
  expect(stored.projects['new-alias'].supabaseAnonKey).toBeUndefined();
});

it('rejects conflicting flags before client creation without reporting either value', async () => {
  const callsBefore = supabaseMock.createAuthenticatedClient.mock.calls.length;
  await expect(run(['login', '--token', 'synthetic-token', '--name', 'conflict',
    '--supabase-url', 'https://synthetic.supabase.co', '--supabase-anon-key', 'synthetic-old',
    '--supabase-publishable-key', 'sb_publishable_synthetic'])).rejects.toThrow(ExitSentinel);
  expect(supabaseMock.createAuthenticatedClient.mock.calls.length).toBe(callsBefore);
  expect(errSpy.mock.calls.flat().join(' ')).toContain('--supabase-publishable-key');
  expect(errSpy.mock.calls.flat().join(' ')).not.toContain('synthetic-old');
  expect(errSpy.mock.calls.flat().join(' ')).not.toContain('sb_publishable_synthetic');
});

// B-1501: the non-activating login, and the commands that say which source is in force.
describe('B-1501 — login --no-activate, whoami, project list / switch', () => {
  beforeEach(() => {
    for (const v of ['HARMONY_API_TOKEN', 'HARMONY_PROJECT', 'HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY']) {
      vi.stubEnv(v, '');
      vi.stubEnv(`EVAL_${v}`, '');
    }
  });

  const stored = () => JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  const logged = () => logSpy.mock.calls.flat().join('\n');
  const errored = () => errSpy.mock.calls.flat().join('\n');

  it('login stores the project id and the URL it was checked against, and activates (as before)', async () => {
    await run(['login', '--token', 'synthetic-a', '--name', 'first']);
    expect(stored().activeProject).toBe('first');
    expect(stored().projects.first).toMatchObject({ projectId: 'proj-stub', verifiedUrl: 'https://eioxsunvhakmelhanmnn.supabase.co' });
  });

  it('login --no-activate stores without changing the active project, and names HARMONY_PROJECT', async () => {
    await run(['login', '--token', 'synthetic-a', '--name', 'first']);
    supabaseMock.getProject.mockResolvedValue({ name: 'Second One' });
    await run(['login', '--token', 'synthetic-a', '--no-activate']);
    expect(stored().activeProject).toBe('first');
    expect(logged()).toContain('the active project is unchanged');
    expect(logged()).toContain('HARMONY_PROJECT=first');
    expect(logged()).not.toContain('synthetic-a');
  });

  it('whoami names the source in force and never prints a token', async () => {
    await run(['login', '--token', 'synthetic-a', '--name', 'first']);
    logSpy.mockClear();
    await run(['whoami']);
    expect(logged()).toContain('Project: first');
    expect(logged()).toContain('the active project "first" (neither HARMONY_API_TOKEN nor HARMONY_PROJECT is set)');
    vi.stubEnv('HARMONY_API_TOKEN', 'synthetic-env');
    logSpy.mockClear();
    await run(['whoami']);
    expect(logged()).toContain('HARMONY_API_TOKEN in the environment (it wins over the active project "first")');
    expect(logged()).not.toContain('synthetic');
  });

  it('projects (and project list) says which source is in force, with one stderr line when the env overrides', async () => {
    await run(['login', '--token', 'synthetic-a', '--name', 'first']);
    vi.stubEnv('HARMONY_API_TOKEN', 'synthetic-env');
    logSpy.mockClear();
    errSpy.mockClear();
    await run(['projects']);
    expect(logged()).toContain('first');
    expect(logged()).toContain('In this shell: HARMONY_API_TOKEN in the environment');
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errored()).toContain('the environment overrides the active project "first"');

    const { registerProjectCommands } = await import('./project.js');
    const program = makeProgram();
    registerProjectCommands(program);
    logSpy.mockClear();
    await program.parseAsync(['project', 'list'], { from: 'user' });
    expect(logged()).toContain('In this shell: HARMONY_API_TOKEN in the environment');
  });

  it('project switch says when the environment keeps winning', async () => {
    await run(['login', '--token', 'synthetic-a', '--name', 'first']);
    const { saveProject } = await import('../config.js');
    saveProject({ name: 'second', token: 'synthetic-b', projectId: 'p2', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'first');
    const { registerProjectCommands } = await import('./project.js');
    const program = makeProgram();
    registerProjectCommands(program);
    errSpy.mockClear();
    await program.parseAsync(['project', 'switch', 'second'], { from: 'user' });
    expect(stored().activeProject).toBe('second');
    expect(errored()).toContain('HARMONY_PROJECT=first is set in this shell and wins over the active project');
  });
});

// B-1501: `harmony login --token-stdin`, so /harmony-setup never puts a token in an argv.
describe('B-1501 — login --token-stdin', () => {
  const original = loginInput.stdin;
  beforeEach(() => {
    for (const v of ['HARMONY_API_TOKEN', 'HARMONY_PROJECT', 'HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY']) vi.stubEnv(v, '');
  });
  afterEach(() => {
    loginInput.stdin = original;
  });
  const pipe = (text: string) => {
    loginInput.stdin = () => Readable.from([text]);
  };
  const stored = () => JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  const printed = () => [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()].join('\n');

  it('reads the token from stdin, trimming one trailing newline, and never echoes it', async () => {
    pipe('synthetic-stdin-token\n');
    await run(['login', '--token-stdin', '--name', 'piped', '--no-activate']);
    expect(stored().projects.piped.token).toBe('synthetic-stdin-token');
    expect(printed()).not.toContain('synthetic-stdin-token');
  });

  it('trims only one trailing newline', async () => {
    expect(await readTokenFromStdin(Readable.from(['abc\r\n']))).toBe('abc');
    expect(await readTokenFromStdin(Readable.from(['abc\n\n']))).toBe('abc\n');
  });

  it('--token and --token-stdin together are refused, storing nothing and printing neither', async () => {
    pipe('synthetic-stdin-token\n');
    await expect(run(['login', '--token', 'synthetic-arg-token', '--token-stdin', '--name', 'both'])).rejects.toThrow(ExitSentinel);
    expect(printed()).toContain('Pass either --token or --token-stdin, not both.');
    expect(printed()).not.toMatch(/synthetic-(stdin|arg)-token/);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
  });

  it('empty stdin is refused before any exchange', async () => {
    pipe('\n');
    const before = supabaseMock.createAuthenticatedClient.mock.calls.length;
    await expect(run(['login', '--token-stdin', '--name', 'empty'])).rejects.toThrow(ExitSentinel);
    expect(printed()).toContain('--token-stdin read no token from stdin.');
    expect(supabaseMock.createAuthenticatedClient.mock.calls.length).toBe(before);
  });

  it('neither flag is refused', async () => {
    await expect(run(['login', '--name', 'none'])).rejects.toThrow(ExitSentinel);
    expect(printed()).toContain('--token-stdin');
  });
});

// B-1501 fix round — the seat's review of the first PR.
describe('B-1501 fixes 3, 6, 9 and 2', () => {
  const original = { ...loginInput };
  beforeEach(() => {
    for (const v of ['HARMONY_API_TOKEN', 'HARMONY_PROJECT', 'HARMONY_SUPABASE_URL', 'HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY']) {
      vi.stubEnv(v, '');
      vi.stubEnv(`EVAL_${v}`, '');
    }
  });
  afterEach(() => {
    Object.assign(loginInput, original);
  });
  const stored = () => JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  const printed = () => [...logSpy.mock.calls.flat(), ...errSpy.mock.calls.flat()].join('\n');

  it('fix 3: --token-stdin at a terminal prompts with echo off and never reads plain stdin', async () => {
    const prompts: string[] = [];
    const stdinRead = vi.fn(() => Readable.from(['must-not-be-read\n']));
    Object.assign(loginInput, {
      isTTY: () => true,
      stdin: stdinRead,
      promptHidden: async (q: string) => {
        prompts.push(q);
        return 'synthetic-typed-token';
      },
    });
    await run(['login', '--token-stdin', '--name', 'typed', '--no-activate']);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('not shown');
    expect(stdinRead).not.toHaveBeenCalled();
    expect(stored().projects.typed.token).toBe('synthetic-typed-token');
    expect(printed()).not.toContain('synthetic-typed-token');
  });

  it('fix 3: --token-stdin from a pipe reads plain stdin and shows no prompt', async () => {
    const promptHidden = vi.fn(async () => 'wrong');
    Object.assign(loginInput, { isTTY: () => false, stdin: () => Readable.from(['synthetic-piped\n']), promptHidden });
    await run(['login', '--token-stdin', '--name', 'piped', '--no-activate']);
    expect(promptHidden).not.toHaveBeenCalled();
    expect(stored().projects.piped.token).toBe('synthetic-piped');
  });

  it('E: login over an entry saved before project ids prints one line naming the key and the project it now holds', async () => {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ activeProject: 'first', projects: { first: { name: 'first', token: 'synthetic-old' } } }));
    Object.assign(loginInput, { isTTY: () => false, stdin: () => Readable.from(['synthetic-old\n']) });
    await run(['login', '--token-stdin', '--name', 'first', '--no-activate']);
    const lines = printed().split('\n').filter((l) => l.includes('in place'));
    expect(lines).toEqual(['Updated the entry "first" in place: it was saved before project ids were recorded, and it now holds project proj-stub.']);
    expect(printed()).not.toContain('synthetic-old');
  });

  it('fix 6: login --no-activate into an empty store leaves no active project and says how to set one', async () => {
    Object.assign(loginInput, { isTTY: () => false, stdin: () => Readable.from(['synthetic-a\n']) });
    await run(['login', '--token-stdin', '--name', 'first', '--no-activate']);
    expect(stored().activeProject).toBeNull();
    expect(printed()).toContain('the active project is unchanged');
    expect(printed()).toContain('harmony project switch first');
  });

  it('fix 9: HARMONY_PROJECT=<key> whoami prints the address and whether it is the stored pair, never a key or token', async () => {
    const { saveProject } = await import('../config.js');
    saveProject({
      name: 'scratch', token: 'synthetic-scratch', projectId: 'p-s', verifiedUrl: 'https://scratch.example.supabase.co',
      supabaseUrl: 'https://scratch.example.supabase.co', supabaseAnonKey: 'scratch-public-key', activate: false,
    });
    saveProject({ name: 'plain', token: 'synthetic-plain', projectId: 'p-p', activate: false });
    vi.stubEnv('HARMONY_PROJECT', 'scratch');
    await run(['whoami']);
    expect(printed()).toContain('Supabase: https://scratch.example.supabase.co (the pair stored with the project)');
    logSpy.mockClear();
    vi.stubEnv('HARMONY_PROJECT', 'plain');
    await run(['whoami']);
    expect(printed()).toContain('Supabase: https://eioxsunvhakmelhanmnn.supabase.co (the built-in default; the project stores no pair)');
    expect(printed()).not.toMatch(/synthetic|scratch-public-key|prod-baked-anon-key/);
  });

  it('fix 2: project adopt-settings-token saves the file\'s token without printing it, keeps the file, and names the key', async () => {
    const { registerProjectCommands } = await import('./project.js');
    const file = path.join(tmpDir, 'settings.local.json');
    const original = JSON.stringify({ env: { HARMONY_API_TOKEN: 'synthetic-file-token', OTHER: 'x' } }, null, 2);
    fs.writeFileSync(file, original);
    const program = makeProgram();
    registerProjectCommands(program);
    await program.parseAsync(['project', 'adopt-settings-token', '--file', file], { from: 'user' });
    expect(stored().projects['env-project'].token).toBe('synthetic-file-token');
    expect(stored().activeProject).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(printed()).toContain('HARMONY_PROJECT=env-project');
    expect(printed()).not.toContain('synthetic-file-token');
  });

  it('fix 2: adopt-settings-token carries the file\'s own Supabase pair into the stored entry', async () => {
    const { registerProjectCommands } = await import('./project.js');
    const file = path.join(tmpDir, 'settings.local.json');
    fs.writeFileSync(file, JSON.stringify({ env: { HARMONY_API_TOKEN: 'synthetic-file-token', HARMONY_SUPABASE_URL: 'https://scratch.example.supabase.co', HARMONY_SUPABASE_ANON_KEY: 'scratch-public-key' } }));
    const program = makeProgram();
    registerProjectCommands(program);
    await program.parseAsync(['project', 'adopt-settings-token', '--file', file, '--name', 'scratch'], { from: 'user' });
    expect(stored().projects.scratch).toMatchObject({ supabaseUrl: 'https://scratch.example.supabase.co', supabaseAnonKey: 'scratch-public-key' });
  });

  it('fix 2: adopt-settings-token with no token in the file refuses, naming the file only', async () => {
    const { registerProjectCommands } = await import('./project.js');
    const file = path.join(tmpDir, 'settings.local.json');
    fs.writeFileSync(file, JSON.stringify({ env: {} }));
    const program = makeProgram();
    registerProjectCommands(program);
    await expect(program.parseAsync(['project', 'adopt-settings-token', '--file', file], { from: 'user' })).rejects.toThrow(ExitSentinel);
    expect(printed()).toContain(`${file} has no env.HARMONY_API_TOKEN`);
    expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(false);
  });
});
