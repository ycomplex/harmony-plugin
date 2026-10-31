/** B-1025: the Supabase pair resolver.
 *
 *  The cases mirror the 13-case prototype de-risked at the design gate (Accepted technical
 *  decision 05e68b29): six success cases + four refusal cases + three edge cases. Every test
 *  passes an explicit `env` so the ambient `HARMONY_SUPABASE_URL` of this container (set to the
 *  prod URL by the worker runtime) never bleeds into a case that should see "nothing". */
import { describe, it, expect } from 'vitest';
import {
  resolveSupabaseTarget,
  MissingAnonKeyError,
  type SupabaseTargetFlags,
  type SupabaseTargetProject,
} from './resolve-supabase-target.js';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from '../auth.js';

const FLAG_URL = 'https://flag.supabase.co';
const FLAG_KEY = 'flag-anon-key';
const PROJECT_URL = 'https://project.supabase.co';
const PROJECT_KEY = 'project-anon-key';
const ENV_URL = 'https://env.supabase.co';
const ENV_KEY = 'env-anon-key';
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('resolveSupabaseTarget — B-1025', () => {
  it('1. flag pair (URL + key) → resolves to flags', () => {
    const flags: SupabaseTargetFlags = { url: FLAG_URL, anonKey: FLAG_KEY };
    expect(
      resolveSupabaseTarget({ flags, project: { supabaseUrl: PROJECT_URL, supabaseAnonKey: PROJECT_KEY }, env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY } }),
    ).toEqual({ url: FLAG_URL, anonKey: FLAG_KEY, source: 'flags' });
  });

  it('2. flag URL-only (no key) → MissingAnonKeyError(source=flags)', () => {
    const flags: SupabaseTargetFlags = { url: FLAG_URL };
    expect(() => resolveSupabaseTarget({ flags, env: EMPTY_ENV })).toThrow(MissingAnonKeyError);
    try {
      resolveSupabaseTarget({ flags, env: EMPTY_ENV });
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnonKeyError);
      const e = err as MissingAnonKeyError;
      expect(e.source).toBe('flags');
      expect(e.url).toBe(FLAG_URL);
      expect(e.message).toContain(FLAG_URL);
      expect(e.message).toContain('--supabase-url');
      expect(e.message).toContain('--supabase-anon-key');
    }
  });

  it('3. project pair (URL + key) → resolves to project', () => {
    const project: SupabaseTargetProject = { supabaseUrl: PROJECT_URL, supabaseAnonKey: PROJECT_KEY };
    expect(
      resolveSupabaseTarget({ project, env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY } }),
    ).toEqual({ url: PROJECT_URL, anonKey: PROJECT_KEY, source: 'project' });
  });

  it('4. project URL-only (no key) → MissingAnonKeyError(source=project)', () => {
    const project: SupabaseTargetProject = { supabaseUrl: PROJECT_URL };
    try {
      resolveSupabaseTarget({ project, env: EMPTY_ENV });
      expect.fail('expected MissingAnonKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnonKeyError);
      const e = err as MissingAnonKeyError;
      expect(e.source).toBe('project');
      expect(e.url).toBe(PROJECT_URL);
      expect(e.message).toContain("active project's stored Supabase settings");
      expect(e.message).toContain('harmony login');
    }
  });

  it('5. env pair (URL + key) → resolves to env', () => {
    expect(
      resolveSupabaseTarget({
        env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY },
      }),
    ).toEqual({ url: ENV_URL, anonKey: ENV_KEY, source: 'env' });
  });

  it('6. env URL-only with a CUSTOM URL (no key) → MissingAnonKeyError(source=env)', () => {
    // The realistic case behind the design's refusal: a staging URL with no key beside it.
    try {
      resolveSupabaseTarget({ env: { HARMONY_SUPABASE_URL: ENV_URL } });
      expect.fail('expected MissingAnonKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnonKeyError);
      const e = err as MissingAnonKeyError;
      expect(e.source).toBe('env');
      expect(e.url).toBe(ENV_URL);
      expect(e.message).toContain('HARMONY_SUPABASE_URL');
      expect(e.message).toContain('HARMONY_SUPABASE_ANON_KEY');
    }
  });

  it('7. project-beats-env precedence (both name a URL+key) → resolves to project', () => {
    const project: SupabaseTargetProject = { supabaseUrl: PROJECT_URL, supabaseAnonKey: PROJECT_KEY };
    expect(
      resolveSupabaseTarget({
        project,
        env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY },
      }),
    ).toEqual({ url: PROJECT_URL, anonKey: PROJECT_KEY, source: 'project' });
  });

  it('8. flags-beat-project precedence (both name a URL+key) → resolves to flags', () => {
    const project: SupabaseTargetProject = { supabaseUrl: PROJECT_URL, supabaseAnonKey: PROJECT_KEY };
    expect(
      resolveSupabaseTarget({
        flags: { url: FLAG_URL, anonKey: FLAG_KEY },
        project,
        env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY },
      }),
    ).toEqual({ url: FLAG_URL, anonKey: FLAG_KEY, source: 'flags' });
  });

  it('9. project-with-no-URL-lets-env-win (project names only a key, env names URL+key) → resolves to env', () => {
    // A source naming only a key does not claim the URL — it is skipped when a later source names one.
    const project: SupabaseTargetProject = { supabaseAnonKey: 'project-key-alone' };
    expect(
      resolveSupabaseTarget({
        project,
        env: { HARMONY_SUPABASE_URL: ENV_URL, HARMONY_SUPABASE_ANON_KEY: ENV_KEY },
      }),
    ).toEqual({ url: ENV_URL, anonKey: ENV_KEY, source: 'env' });
  });

  it('10. default-only (no source names a URL) → built-in default pair, source=default', () => {
    expect(resolveSupabaseTarget({ env: EMPTY_ENV })).toEqual({
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      source: 'default',
    });
  });

  it('11. flag key-only → default URL + flag key (acceptance criterion c2da57c6)', () => {
    // `harmony login --supabase-anon-key <key>` with no environment and no URL must use the key.
    const flags: SupabaseTargetFlags = { anonKey: FLAG_KEY };
    expect(resolveSupabaseTarget({ flags, env: EMPTY_ENV })).toEqual({
      url: DEFAULT_SUPABASE_URL,
      anonKey: FLAG_KEY,
      source: 'default',
    });
  });

  it('12. one-pair rule (flag URL-only + env key present) → MissingAnonKeyError(source=flags), env key not stolen', () => {
    // The flag URL owns the pair; the env key is from a DIFFERENT source and must not be paired
    // with the flag URL — that's the cross-pairing the refusal exists to prevent.
    const flags: SupabaseTargetFlags = { url: FLAG_URL };
    try {
      resolveSupabaseTarget({
        flags,
        env: { HARMONY_SUPABASE_ANON_KEY: ENV_KEY },
      });
      expect.fail('expected MissingAnonKeyError');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingAnonKeyError);
      const e = err as MissingAnonKeyError;
      expect(e.source).toBe('flags');
      expect(e.url).toBe(FLAG_URL);
      expect(e.message).not.toContain(ENV_KEY);
    }
  });

  it('13. env URL equals the built-in default (no key) → default key pairs with the default URL (carve-out)', () => {
    // container/provision.sh's prod target exports HARMONY_SUPABASE_URL=<prod URL> and relies on
    // the baked default key. The default URL and default key are one inseparable pair — naming the
    // default URL is naming the default pair. Without this carve-out every CLI call in a
    // prod-target worker container would be refused.
    expect(
      resolveSupabaseTarget({
        env: { HARMONY_SUPABASE_URL: DEFAULT_SUPABASE_URL },
      }),
    ).toEqual({
      url: DEFAULT_SUPABASE_URL,
      anonKey: DEFAULT_SUPABASE_ANON_KEY,
      source: 'env',
    });
  });
});
