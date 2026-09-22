// B-1035: unit coverage for `harmony doctor auth-hook` — the pure, dependency-injected core
// (`runDoctorAuthHookCommand`) and its `--project-ref` default resolver (`resolveDefaultProjectRef`).
// No real network call is ever made — `fetchAuthConfig` is injected per gates.test.ts's own
// convention (see gates.ts's header for the rationale this file mirrors).

import { describe, it, expect } from 'vitest';
import {
  runDoctorAuthHookCommand,
  resolveDefaultProjectRef,
  type DoctorAuthHookDeps,
  type AuthConfigFetchResult,
} from './doctor.js';

const SECRET_TOKEN = 'sbp_super-secret-value-must-never-appear-anywhere';

function baseDeps(overrides: Partial<DoctorAuthHookDeps> = {}): DoctorAuthHookDeps & {
  logLines: string[];
  errorLines: string[];
} {
  const logLines: string[] = [];
  const errorLines: string[] = [];

  const deps: DoctorAuthHookDeps = {
    projectRefFlag: 'proj-ref-123',
    resolveDefaultProjectRef: () => null,
    accessToken: SECRET_TOKEN,
    fetchAuthConfig: async () => ({
      status: 200,
      body: {
        hook_custom_access_token_enabled: true,
        hook_custom_access_token_uri: 'pg-functions://postgres/public/custom_access_token_hook',
        hook_custom_access_token_secrets: 'do-not-read-me',
      },
    }),
    log: (line) => logLines.push(line),
    error: (line) => errorLines.push(line),
    ...overrides,
  };

  return { ...deps, logLines, errorLines };
}

describe('runDoctorAuthHookCommand — REGISTERED', () => {
  it('exits 0 when enabled=true and the uri resolves to public.custom_access_token_hook', async () => {
    const deps = baseDeps();
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('REGISTERED');
    expect(deps.logLines.join('\n')).toContain('proj-ref-123');
    expect(deps.errorLines).toHaveLength(0);
  });
});

describe('runDoctorAuthHookCommand — NOT REGISTERED (disabled)', () => {
  it('exits 1 when hook_custom_access_token_enabled is false', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => ({
        status: 200,
        body: {
          hook_custom_access_token_enabled: false,
          hook_custom_access_token_uri: null,
        },
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(1);
    expect(deps.errorLines.join('\n')).toContain('NOT REGISTERED');
    expect(deps.errorLines.join('\n')).toContain('proj-ref-123');
  });
});

describe('runDoctorAuthHookCommand — NOT REGISTERED (wrong function)', () => {
  it('exits 1 when enabled but the uri points at a different function', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => ({
        status: 200,
        body: {
          hook_custom_access_token_enabled: true,
          hook_custom_access_token_uri: 'pg-functions://postgres/public/some_other_hook',
        },
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(1);
    expect(deps.errorLines.join('\n')).toContain('NOT REGISTERED');
    expect(deps.errorLines.join('\n')).toContain('some_other_hook');
  });
});

describe('runDoctorAuthHookCommand — CANNOT DETERMINE: missing token', () => {
  it('exits 2 naming SUPABASE_ACCESS_TOKEN, without ever calling fetchAuthConfig', async () => {
    let called = false;
    const deps = baseDeps({
      accessToken: undefined,
      fetchAuthConfig: async () => {
        called = true;
        return { status: 200, body: {} };
      },
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(deps.errorLines.join('\n')).toContain('SUPABASE_ACCESS_TOKEN');
    expect(deps.errorLines.join('\n')).toContain('proj-ref-123');
  });
});

describe('runDoctorAuthHookCommand — CANNOT DETERMINE: HTTP 401/403', () => {
  it('exits 2 on 401', async () => {
    const deps = baseDeps({ fetchAuthConfig: async () => ({ status: 401 }) });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('401');
  });

  it('exits 2 on 403', async () => {
    const deps = baseDeps({ fetchAuthConfig: async () => ({ status: 403 }) });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('403');
  });
});

describe('runDoctorAuthHookCommand — CANNOT DETERMINE: HTTP 404 (wrong project)', () => {
  it('exits 2 and names the project not found', async () => {
    const deps = baseDeps({ fetchAuthConfig: async () => ({ status: 404 }) });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('404');
    expect(deps.errorLines.join('\n')).toContain('proj-ref-123');
  });
});

describe('runDoctorAuthHookCommand — CANNOT DETERMINE: network error', () => {
  it('exits 2 and includes the thrown error message when fetchAuthConfig rejects', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => {
        throw new Error('ECONNRESET: connection reset');
      },
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('ECONNRESET');
  });
});

describe('runDoctorAuthHookCommand — CANNOT DETERMINE: malformed/unrecognized payload', () => {
  it('exits 2 when the body is missing hook_custom_access_token_enabled entirely', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => ({ status: 200, body: { unrelated: true } }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('did not parse');
  });

  it('exits 2 when the body failed to parse as JSON at all (undefined)', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => ({ status: 200, body: undefined }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('did not parse');
  });

  it('exits 2 when enabled=true but the uri does not match any recognizable pg-functions shape', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async () => ({
        status: 200,
        body: {
          hook_custom_access_token_enabled: true,
          hook_custom_access_token_uri: 'not-a-recognized-uri-form',
        },
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('not-a-recognized-uri-form');
  });

  it('exits 2 when a non-200 status is returned that is not 401/403/404', async () => {
    const deps = baseDeps({ fetchAuthConfig: async () => ({ status: 500 }) });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(deps.errorLines.join('\n')).toContain('500');
  });
});

describe('runDoctorAuthHookCommand — --project-ref resolution', () => {
  it('required when omitted with no default available: exits 2, names the missing flag, never calls fetchAuthConfig', async () => {
    let called = false;
    const deps = baseDeps({
      projectRefFlag: undefined,
      resolveDefaultProjectRef: () => null,
      fetchAuthConfig: async () => {
        called = true;
        return { status: 200, body: {} };
      },
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(2);
    expect(called).toBe(false);
    expect(deps.errorLines.join('\n')).toContain('--project-ref');
  });

  it('uses the resolved default when --project-ref is omitted and a default IS available', async () => {
    let seenRef: string | undefined;
    const deps = baseDeps({
      projectRefFlag: undefined,
      resolveDefaultProjectRef: () => 'defaulted-ref-456',
      fetchAuthConfig: async (projectRef) => {
        seenRef = projectRef;
        return {
          status: 200,
          body: {
            hook_custom_access_token_enabled: true,
            hook_custom_access_token_uri: 'pg-functions://postgres/public/custom_access_token_hook',
          },
        };
      },
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(seenRef).toBe('defaulted-ref-456');
    expect(deps.logLines.join('\n')).toContain('defaulted-ref-456');
  });

  it('prefers an explicit --project-ref flag over the default resolver', async () => {
    let defaultResolverCalled = false;
    let seenRef: string | undefined;
    const deps = baseDeps({
      projectRefFlag: 'explicit-ref',
      resolveDefaultProjectRef: () => {
        defaultResolverCalled = true;
        return 'default-ref';
      },
      fetchAuthConfig: async (projectRef) => {
        seenRef = projectRef;
        return { status: 404 };
      },
    });
    await runDoctorAuthHookCommand(deps);
    expect(defaultResolverCalled).toBe(false);
    expect(seenRef).toBe('explicit-ref');
  });
});

describe('runDoctorAuthHookCommand — token value never observable', () => {
  it('never leaks the SUPABASE_ACCESS_TOKEN value into any log/error string, across every outcome', async () => {
    const captured: string[] = [];

    const scenarios: Array<Partial<DoctorAuthHookDeps>> = [
      // REGISTERED
      {},
      // NOT REGISTERED (disabled)
      {
        fetchAuthConfig: async () => ({
          status: 200,
          body: { hook_custom_access_token_enabled: false, hook_custom_access_token_uri: null },
        }),
      },
      // NOT REGISTERED (wrong function)
      {
        fetchAuthConfig: async () => ({
          status: 200,
          body: {
            hook_custom_access_token_enabled: true,
            hook_custom_access_token_uri: 'pg-functions://postgres/public/other_fn',
          },
        }),
      },
      // CANNOT DETERMINE: missing token
      { accessToken: undefined },
      // CANNOT DETERMINE: 401
      { fetchAuthConfig: async () => ({ status: 401 }) },
      // CANNOT DETERMINE: 403
      { fetchAuthConfig: async () => ({ status: 403 }) },
      // CANNOT DETERMINE: 404
      { fetchAuthConfig: async () => ({ status: 404 }) },
      // CANNOT DETERMINE: network error — deliberately echoes the token into the thrown error, to
      // prove the harness (not just well-behaved fetchAuthConfig implementations) would catch a leak.
      {
        fetchAuthConfig: async (_ref, accessToken) => {
          throw new Error(`network failure while using token ${accessToken}`);
        },
      },
      // CANNOT DETERMINE: malformed payload
      { fetchAuthConfig: async () => ({ status: 200, body: { nope: true } }) },
      // CANNOT DETERMINE: unrecognized uri shape
      {
        fetchAuthConfig: async () => ({
          status: 200,
          body: { hook_custom_access_token_enabled: true, hook_custom_access_token_uri: 'weird' },
        }),
      },
    ];

    for (const overrides of scenarios) {
      const deps = baseDeps(overrides);
      await runDoctorAuthHookCommand(deps);
      captured.push(...deps.logLines, ...deps.errorLines);
    }

    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(SECRET_TOKEN);
    }
    // The network-error scenario above deliberately threw a message CONTAINING the raw token, to
    // prove this isn't vacuous: runDoctorAuthHookCommand's redaction wrapper must have scrubbed it,
    // replacing it with the placeholder below — assert that placeholder actually shows up, so a
    // regression that silently drops the whole line (rather than redacting it) would still be caught.
    expect(captured.join('\n')).toContain('<redacted>');
  });
});

describe('resolveDefaultProjectRef', () => {
  it('prefers the active project supabaseUrl when present', () => {
    const ref = resolveDefaultProjectRef({
      activeProjectSupabaseUrl: 'https://active-project-ref.supabase.co',
      envSupabaseUrl: 'https://env-ref.supabase.co',
    });
    expect(ref).toBe('active-project-ref');
  });

  it('falls back to HARMONY_SUPABASE_URL when no active project url is set', () => {
    const ref = resolveDefaultProjectRef({ envSupabaseUrl: 'https://env-ref.supabase.co' });
    expect(ref).toBe('env-ref');
  });

  it('falls back to the hardcoded prod project ref when neither is set', () => {
    const ref = resolveDefaultProjectRef({});
    expect(ref).toBe('eioxsunvhakmelhanmnn');
  });

  it('returns null on an unparseable URL rather than throwing', () => {
    const ref = resolveDefaultProjectRef({ activeProjectSupabaseUrl: 'not a url' });
    expect(ref).toBeNull();
  });
});
