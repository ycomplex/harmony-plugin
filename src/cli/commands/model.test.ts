// B-772 round 2: unit coverage for `harmony model ...` — the node subprocess accessor
// container/provision.sh and container/entrypoint.sh call into to read the alias allowlist / the
// context-budget table / the handoff-file contract src/config/run-config.ts owns.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerModelCommands } from './model.js';
import { PINNED_DEFAULT_MODEL_BY_PROFILE } from '../../config/run-config.js';

// B-892: resolve-gate now takes a best-effort trip through getAuthenticatedContext to re-read
// conductions.run_config at the gate boundary. Mocked so these tests never touch a network/config
// file — every OTHER subcommand in this file is unaffected (none of them authenticates), and
// resolve-gate itself only reaches this mock when HARMONY_CONDUCTION_ID is set.
const authMock = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn() }));
vi.mock('../auth.js', () => authMock);

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerModelCommands(program);
  return program;
}

const run = (argv: string[]) => makeProgram().parseAsync(argv, { from: 'user' });

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
const tempDirs: string[] = [];

function tempHandoffPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'b772-cli-model-'));
  tempDirs.push(dir);
  return join(dir, 'model-handoff-request.json');
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
});

afterEach(() => {
  authMock.getAuthenticatedContext.mockReset();
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('harmony model check-alias <alias>', () => {
  it('prints "true" and exits 0 for an allowlisted alias', async () => {
    await expect(run(['model', 'check-alias', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('true');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints "false" and exits 1 for an unrecognized alias', async () => {
    await expect(run(['model', 'check-alias', 'not-a-real-model'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('false');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('harmony model context-budget <alias>', () => {
  it('prints a positive byte count for a tabled alias', async () => {
    await run(['model', 'context-budget', 'claude-sonnet-5']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = Number(logSpy.mock.calls[0][0]);
    expect(printed).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('never fails on an unrecognized alias — prints the conservative fallback instead', async () => {
    await run(['model', 'context-budget', 'some-future-alias']);
    const printed = Number(logSpy.mock.calls[0][0]);
    expect(printed).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('harmony model running-model', () => {
  it('prints HARMONY_MODEL when set', async () => {
    vi.stubEnv('HARMONY_MODEL', 'claude-opus-5');
    await run(['model', 'running-model']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints an empty string (not an error) when HARMONY_MODEL is unset', async () => {
    vi.stubEnv('HARMONY_MODEL', '');
    await run(['model', 'running-model']);
    expect(logSpy).toHaveBeenCalledWith('');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('harmony model resolve-gate <workflow-state>', () => {
  it('falls back to the pinned per-profile default when no run_config env is set', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', '');
    vi.stubEnv('HARMONY_SUPABASE_URL', '');
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('honors an explicit per-gate override from HARMONY_RUN_CONFIG_JSON', async () => {
    const payload = Buffer.from(
      JSON.stringify({ model: { per_gate: { build: 'claude-opus-5' } } }),
    ).toString('base64');
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', payload);
    // 'Planned' -> gate 'build' (src/daemon/gate-phase.ts GATE_BY_WORKFLOW_STATE)
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('honors --activity being passed through (forward-compat; does not currently discriminate)', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', '');
    await run(['model', 'resolve-gate', 'Decomposed', '--activity', 'designing-ux-ui']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('degrades to the empty run_config (never throws/crashes) on malformed HARMONY_RUN_CONFIG_JSON', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', Buffer.from('not valid json').toString('base64'));
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('harmony model request-switch / read-handoff / clear-handoff', () => {
  it('request-switch writes a handoff file for an allowlisted alias', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-opus-5']);
    expect(existsSync(handoffPath)).toBe(true);
    expect(JSON.parse(readFileSync(handoffPath, 'utf8'))).toEqual({ requested_model: 'claude-opus-5' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('request-switch refuses (exit 1, no file written) for an unrecognized alias', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await expect(run(['model', 'request-switch', 'not-a-real-model'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(handoffPath)).toBe(false);
  });

  it('read-handoff prints the pending alias and exits 0 when a request is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-haiku-4-5-20251001']);
    await run(['model', 'read-handoff']);
    expect(logSpy).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it('read-handoff exits 1 with no stdout when no request is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await expect(run(['model', 'read-handoff'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('clear-handoff deletes a pending request', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-sonnet-5']);
    expect(existsSync(handoffPath)).toBe(true);
    await run(['model', 'clear-handoff']);
    expect(existsSync(handoffPath)).toBe(false);
  });

  it('clear-handoff is idempotent — never exits non-zero when nothing is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'clear-handoff']);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// B-892: resolve-gate resolves the WANTED model from the LIVE conduction row, launch env as
// fallback. `running-model` is deliberately untouched — it reports what THIS process is actually
// running, which is the correct baseline for step 1d's comparison.
// =================================================================================================

/** Stands in for the one call shape getConduction makes. */
function fakeConductionClient(
  result: { data: unknown; error: unknown } | 'throws',
): SupabaseClient {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.maybeSingle = async () => {
    if (result === 'throws') throw new Error('transport exploded');
    return result;
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

const conductionRow = (run_config: unknown) => ({
  data: { id: 'cond-892', task_id: 't-1', status: 'active', run_config },
  error: null,
});

function stubAuthWith(result: { data: unknown; error: unknown } | 'throws'): void {
  authMock.getAuthenticatedContext.mockResolvedValue({
    client: fakeConductionClient(result),
    projectId: 'proj-1',
    userId: 'user-1',
  });
}

// The frozen launch-env payload every test below contrasts the row against: 'Planned' -> gate
// 'build' (src/daemon/gate-phase.ts), pinned to opus by the LAUNCH env.
const ENV_MODEL_PAYLOAD = Buffer.from(
  JSON.stringify({ model: { per_gate: { build: 'claude-opus-5' } } }),
).toString('base64');

function stubConductedEnv(): void {
  vi.stubEnv('HARMONY_CONDUCTION_ID', 'cond-892');
  vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
  vi.stubEnv('HARMONY_RUN_CONFIG_JSON', ENV_MODEL_PAYLOAD);
  vi.stubEnv('HARMONY_SUPABASE_URL', '');
}

describe('B-892 harmony model resolve-gate — gate-boundary re-read of conductions.run_config', () => {
  it("prefers the LIVE row's model over the frozen launch env", async () => {
    stubConductedEnv();
    stubAuthWith(conductionRow({ model: { per_gate: { build: 'claude-haiku-4-5-20251001' } } }));
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it("honors a row-level run-wide default over the launch env's per-gate pin", async () => {
    stubConductedEnv();
    stubAuthWith(conductionRow({ model: { default: 'claude-haiku-4-5-20251001' } }));
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-haiku-4-5-20251001');
  });

  it('falls back to the launch env when the row is missing', async () => {
    stubConductedEnv();
    stubAuthWith({ data: null, error: null });
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
    expect(errSpy).toHaveBeenCalled();
  });

  it('falls back to the launch env when the row query errors', async () => {
    stubConductedEnv();
    stubAuthWith({ data: null, error: { message: 'permission denied' } });
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('falls back to the launch env (never throws) when the row payload is MALFORMED', async () => {
    stubConductedEnv();
    stubAuthWith(conductionRow({ model: 'not-an-object' }));
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('falls back to the launch env (never throws) when authentication is unavailable', async () => {
    stubConductedEnv();
    authMock.getAuthenticatedContext.mockRejectedValue(
      new Error('No active project. Run `harmony login` to add one.'),
    );
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('never authenticates at all when there is no HARMONY_CONDUCTION_ID (unchanged from before)', async () => {
    vi.stubEnv('HARMONY_CONDUCTION_ID', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', ENV_MODEL_PAYLOAD);
    await run(['model', 'resolve-gate', 'Planned']);
    expect(authMock.getAuthenticatedContext).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('running-model still reports HARMONY_MODEL, never the row (the switch comparison baseline)', async () => {
    stubConductedEnv();
    vi.stubEnv('HARMONY_MODEL', 'claude-opus-5');
    stubAuthWith(conductionRow({ model: { per_gate: { build: 'claude-haiku-4-5-20251001' } } }));
    await run(['model', 'running-model']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
    expect(authMock.getAuthenticatedContext).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// B-881: check-alias / context-budget / request-switch / list-aliases all now take a best-effort
// live trip through the model_catalog table (via getAuthenticatedContext, mocked above) before
// falling back to MODEL_CATALOG_FALLBACK. Once the catalog IS reachable it is ALWAYS authoritative
// — never blended with the fallback list — so a live catalog that omits a fallback-only alias
// (or includes one the fallback list has never heard of) must be reflected exactly.
// =================================================================================================

/** Stands in for the one call shape fetchModelCatalog makes:
 *  `client.from('model_catalog').select(cols).eq('active', true)`. */
function fakeCatalogClient(result: { data: unknown; error: unknown } | 'throws'): SupabaseClient {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => {
    if (result === 'throws') return Promise.reject(new Error('transport exploded'));
    return Promise.resolve(result);
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

function stubCatalogWith(result: { data: unknown; error: unknown } | 'throws'): void {
  authMock.getAuthenticatedContext.mockResolvedValue({
    client: fakeCatalogClient(result),
    projectId: 'proj-1',
    userId: 'user-1',
  });
}

const liveOnlyRow = {
  alias: 'live-only-alias',
  label: 'Live Only Alias',
  context_budget_bytes: 4242,
  active: true,
  verified_at: '2026-09-01T00:00:00Z',
};

describe('B-881 harmony model check-alias/context-budget/request-switch/list-aliases — live catalog', () => {
  it('check-alias consults the LIVE catalog and accepts an alias absent from the embedded fallback', async () => {
    stubCatalogWith({ data: [liveOnlyRow], error: null });
    await expect(run(['model', 'check-alias', 'live-only-alias'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('true');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("check-alias rejects a FALLBACK-only alias once the live catalog is reachable — the catalog is ALWAYS authoritative when reachable", async () => {
    stubCatalogWith({ data: [liveOnlyRow], error: null });
    await expect(run(['model', 'check-alias', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('false');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('check-alias degrades to the embedded fallback (never throws) when the catalog is unreachable', async () => {
    authMock.getAuthenticatedContext.mockRejectedValue(new Error('No active project.'));
    await expect(run(['model', 'check-alias', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('true');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("B-881 TABLE-ABSENT TOLERANCE: check-alias degrades cleanly (never throws) when model_catalog does not exist yet on this environment", async () => {
    stubCatalogWith({
      data: null,
      error: { message: 'relation "public.model_catalog" does not exist', code: '42P01' },
    });
    await expect(run(['model', 'check-alias', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('true');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("context-budget prints the LIVE budget for an alias absent from the embedded fallback", async () => {
    stubCatalogWith({ data: [liveOnlyRow], error: null });
    await run(['model', 'context-budget', 'live-only-alias']);
    expect(logSpy).toHaveBeenCalledWith('4242');
  });

  it('request-switch succeeds for a LIVE-catalog-only alias', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    stubCatalogWith({ data: [liveOnlyRow], error: null });
    await run(['model', 'request-switch', 'live-only-alias']);
    expect(existsSync(handoffPath)).toBe(true);
    expect(JSON.parse(readFileSync(handoffPath, 'utf8'))).toEqual({ requested_model: 'live-only-alias' });
  });

  it('request-switch refuses (exit 1, no file written) for a FALLBACK-only alias once the live catalog is reachable, naming the live catalog in its error', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    stubCatalogWith({ data: [liveOnlyRow], error: null });
    await expect(run(['model', 'request-switch', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(handoffPath)).toBe(false);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain('live-only-alias');
  });

  it('list-aliases prints the LIVE catalog aliases when reachable', async () => {
    stubCatalogWith({ data: [liveOnlyRow, { ...liveOnlyRow, alias: 'another-live-alias' }], error: null });
    await run(['model', 'list-aliases']);
    expect(logSpy).toHaveBeenNthCalledWith(1, 'live-only-alias');
    expect(logSpy).toHaveBeenNthCalledWith(2, 'another-live-alias');
  });

  it('list-aliases prints the embedded fallback aliases when the catalog is unreachable, and never throws', async () => {
    authMock.getAuthenticatedContext.mockRejectedValue(new Error('No active project.'));
    await run(['model', 'list-aliases']);
    expect(logSpy).toHaveBeenCalledWith('claude-sonnet-5');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
