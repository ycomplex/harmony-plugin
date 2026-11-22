// B-1501: the shared project resolver, on both surfaces. Every case hands the resolver its own env and
// config, so nothing reads the runner's environment or a real ~/.harmony.
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  MCP_MISSING_MESSAGE,
  describeSource,
  overrideNotice,
  resolveProject,
  ProjectResolutionError,
} from './project-resolution.js';
import { resolveMcpAuth } from '../mcp-auth.js';
import type { HarmonyConfig } from '../cli/config.js';

const cfg = (over: Partial<HarmonyConfig> = {}): HarmonyConfig => ({
  activeProject: 'active-one',
  projects: {
    'active-one': { name: 'active-one', token: 'tok-active' },
    invented: { name: 'invented', token: 'tok-invented', projectId: 'proj-inv', supabaseUrl: 'https://inv.example.supabase.co', supabaseAnonKey: 'inv-key' },
  },
  ...over,
});
const load = (c: HarmonyConfig) => () => c;

describe('resolveProject: (a) HARMONY_API_TOKEN', () => {
  it('cli: the env token wins over the active project, with the env pair, and is marked as overriding', () => {
    const r = resolveProject({ surface: 'cli', env: { HARMONY_API_TOKEN: 'tok-env', HARMONY_PROJECT: 'invented' }, loadConfig: load(cfg()) });
    expect(r.source).toBe('env-token');
    expect(r.token).toBe('tok-env');
    expect(r.target?.source).toBe('default');
    expect(r.overridesActive).toBe(true);
    expect(overrideNotice(r)).toContain('not the active project "active-one"');
    expect(describeSource(r)).toBe('HARMONY_API_TOKEN in the environment (it wins over the active project "active-one")');
  });

  it('mcp: the env token, the pair left to HarmonyAuth (read per call, as before), config never read', () => {
    const loader = vi.fn(() => cfg());
    const r = resolveProject({ surface: 'mcp', env: { HARMONY_API_TOKEN: 'tok-env' }, loadConfig: loader });
    expect(r.source).toBe('env-token');
    expect(r.target).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('the EVAL_ twin still works (B-1036)', () => {
    expect(resolveProject({ surface: 'mcp', env: { EVAL_HARMONY_API_TOKEN: 'tok-eval' } }).token).toBe('tok-eval');
  });
});

describe('resolveProject: (b) HARMONY_PROJECT', () => {
  for (const surface of ['cli', 'mcp'] as const) {
    it(`${surface}: the stored entry's token and its own stored pair, with its saved project id to confirm`, () => {
      const r = resolveProject({ surface, env: { HARMONY_PROJECT: 'invented' }, loadConfig: load(cfg()) });
      expect(r.source).toBe('harmony-project');
      expect(r.token).toBe('tok-invented');
      expect(r.target).toEqual({ url: 'https://inv.example.supabase.co', anonKey: 'inv-key', source: 'project' });
      expect(r.expectedProjectId).toBe('proj-inv');
    });

    it(`${surface}: an unknown name is refused, listing the stored names`, () => {
      expect(() => resolveProject({ surface, env: { HARMONY_PROJECT: 'nope' }, loadConfig: load(cfg()) })).toThrow(
        /HARMONY_PROJECT=nope names no project stored .*\(stored: active-one, invented\)/,
      );
    });

    it(`${surface}: HARMONY_SUPABASE_URL contradicting the stored URL is refused, naming both URLs`, () => {
      expect(() =>
        resolveProject({ surface, env: { HARMONY_PROJECT: 'invented', HARMONY_SUPABASE_URL: 'https://other.example.supabase.co' }, loadConfig: load(cfg()) }),
      ).toThrow('HARMONY_PROJECT=invented is stored for https://inv.example.supabase.co but HARMONY_SUPABASE_URL says https://other.example.supabase.co');
    });

    it(`${surface}: HARMONY_SUPABASE_ANON_KEY or HARMONY_SUPABASE_PUBLISHABLE_KEY contradicting the stored key is refused, no key printed`, () => {
      for (const v of ['HARMONY_SUPABASE_ANON_KEY', 'HARMONY_SUPABASE_PUBLISHABLE_KEY']) {
        let msg = '';
        try {
          resolveProject({ surface, env: { HARMONY_PROJECT: 'invented', [v]: 'different-key' }, loadConfig: load(cfg()) });
        } catch (e) {
          msg = (e as Error).message;
          expect(e).toBeInstanceOf(ProjectResolutionError);
        }
        expect(msg).toContain(v);
        expect(msg).not.toContain('different-key');
        expect(msg).not.toContain('inv-key');
      }
    });
  }

  it('an entry with no stored pair uses the env pair when it matches the backend it was saved against', () => {
    const c = cfg({ projects: { s: { name: 's', token: 't', verifiedUrl: 'https://stg.example.supabase.co' } } });
    const r = resolveProject({ surface: 'cli', env: { HARMONY_PROJECT: 's', HARMONY_SUPABASE_URL: 'https://stg.example.supabase.co', HARMONY_SUPABASE_ANON_KEY: 'k' }, loadConfig: load(c) });
    expect(r.target).toEqual({ url: 'https://stg.example.supabase.co', anonKey: 'k', source: 'env' });
  });

  it('an entry saved before B-1501 (no projectId, no verifiedUrl) is read tolerantly', () => {
    const c = cfg({ projects: { old: { name: 'old', token: 't' } } });
    const r = resolveProject({ surface: 'cli', env: { HARMONY_PROJECT: 'old' }, loadConfig: load(c) });
    expect(r.token).toBe('t');
    expect(r.expectedProjectId).toBeUndefined();
  });

  it('HARMONY_PROJECT naming the active project is no override', () => {
    const r = resolveProject({ surface: 'cli', env: { HARMONY_PROJECT: 'active-one' }, loadConfig: load(cfg()) });
    expect(r.overridesActive).toBe(false);
    expect(overrideNotice(r)).toBeNull();
  });
});

describe('resolveProject: (c) the active project', () => {
  it('cli: with neither variable, the active project as before', () => {
    const r = resolveProject({ surface: 'cli', env: {}, loadConfig: load(cfg()) });
    expect(r.source).toBe('active-project');
    expect(r.token).toBe('tok-active');
    expect(r.overridesActive).toBe(false);
    expect(describeSource(r)).toContain('the active project "active-one"');
  });

  it('cli: no active project keeps the old message', () => {
    expect(() => resolveProject({ surface: 'cli', env: {}, loadConfig: load({ activeProject: null, projects: {} }) })).toThrow(
      'No active project. Run `harmony login` to add one.',
    );
  });

  it('cli: projects stored but none active: names `harmony project switch <name>` and the stored names only', () => {
    const c = cfg({ activeProject: null });
    let msg = '';
    try {
      resolveProject({ surface: 'cli', env: {}, loadConfig: load(c) });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('harmony project switch <name>');
    expect(msg).toContain('active-one, invented');
    expect(msg).not.toContain('harmony login');
    expect(msg).not.toContain('tok-');
  });

  it('mcp: never falls to the active project; the old message, naming HARMONY_PROJECT', () => {
    expect(() => resolveProject({ surface: 'mcp', env: {}, loadConfig: load(cfg()) })).toThrow(MCP_MISSING_MESSAGE);
    expect(MCP_MISSING_MESSAGE).toMatch(/^HARMONY_API_TOKEN environment variable is required/);
    expect(MCP_MISSING_MESSAGE).toContain('HARMONY_PROJECT');
  });
});

describe('resolveMcpAuth (the MCP server start-up)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('HARMONY_PROJECT: exchanges the stored token against the stored pair', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `h.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.s`, expires_in: 3600, project_id: 'proj-inv' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { auth } = resolveMcpAuth({ HARMONY_PROJECT: 'invented' }, load(cfg()));
    await auth.getAccessToken();
    expect(auth.getProjectId()).toBe('proj-inv');
    expect(fetchMock.mock.calls[0][0]).toBe('https://inv.example.supabase.co/functions/v1/auth-token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).token).toBe('tok-invented');
  });

  it('HARMONY_PROJECT whose token reaches another project is refused at the exchange, naming both', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: `h.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.s`, expires_in: 3600, project_id: 'proj-x' }),
    }));
    const { auth } = resolveMcpAuth({ HARMONY_PROJECT: 'invented' }, load(cfg()));
    await expect(auth.getAccessToken()).rejects.toThrow('HARMONY_PROJECT=invented was saved for project proj-inv, but its token now reaches project proj-x');
  });

  it('the env token: the pair stays the environment\'s, read per call', () => {
    const { auth } = resolveMcpAuth({ HARMONY_API_TOKEN: 'tok-env' }, load(cfg()));
    expect(auth.getSupabaseUrl()).toBeTypeOf('string');
  });

  it('neither: throws the start-up message', () => {
    expect(() => resolveMcpAuth({}, load(cfg()))).toThrow(MCP_MISSING_MESSAGE);
  });
});
