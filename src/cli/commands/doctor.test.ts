// B-1035: unit coverage for `harmony doctor auth-hook` — the pure, dependency-injected core
// (`runDoctorAuthHookCommand`) and its `--project-ref` default resolver (`resolveDefaultProjectRef`).
// No real network call is ever made — `fetchAuthConfig` is injected per gates.test.ts's own
// convention (see gates.ts's header for the rationale this file mirrors).
//
// B-1300 adds the before-user-created half: its registration classification (off the SAME injected
// auth-config body), its injected function-existence probe, both mismatch WARN directions, and the
// ratified exit contract — the before-user-created half NEVER changes the process exit code, which
// stays the access-token half's 0/1/2 alone. `fetchFunctionExistence` is injected exactly like
// `fetchAuthConfig`; still zero real network.

import { describe, it, expect } from 'vitest';
import {
  runDoctorAuthHookCommand,
  resolveDefaultProjectRef,
  type DoctorAuthHookDeps,
  type AuthConfigFetchResult,
  type FunctionExistenceFetchResult,
} from './doctor.js';

const SECRET_TOKEN = 'sbp_super-secret-value-must-never-appear-anywhere';

/** The B-1298 before-user-created hook fields, as the expected Management API keys (mirroring the
 *  naming pattern the access-token hook uses). The parsing under test reads these names. */
const BUC_ENABLED = 'hook_before_user_created_enabled';
const BUC_URI = 'hook_before_user_created_uri';
const BUC_GOOD_URI = 'pg-functions://postgres/public/before_user_created_hook';

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

/** An auth-config body where the access-token half resolves REGISTERED, plus caller-supplied
 *  before-user-created fields. */
function accessTokenRegisteredBody(buc: Record<string, unknown>): Record<string, unknown> {
  return {
    hook_custom_access_token_enabled: true,
    hook_custom_access_token_uri: 'pg-functions://postgres/public/custom_access_token_hook',
    ...buc,
  };
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

// ---------------------------------------------------------------------------
// B-1300 — the before-user-created half. Registration is read off the SAME
// auth-config body; function existence comes from the injected probe. The
// before-user-created half NEVER changes the exit code.
// ---------------------------------------------------------------------------

describe('runDoctorAuthHookCommand — B-1300 before-user-created: probe never consulted in early-exit branches', () => {
  const earlyExitScenarios: Array<[string, Partial<DoctorAuthHookDeps>]> = [
    ['missing token', { accessToken: undefined }],
    ['HTTP 401', { fetchAuthConfig: async () => ({ status: 401 }) }],
    ['HTTP 404', { fetchAuthConfig: async () => ({ status: 404 }) }],
    [
      'network error',
      {
        fetchAuthConfig: async () => {
          throw new Error('boom');
        },
      },
    ],
    [
      'malformed payload (access-token field not boolean)',
      { fetchAuthConfig: async () => ({ status: 200, body: { unrelated: true } }) },
    ],
  ];

  for (const [name, overrides] of earlyExitScenarios) {
    it(`never calls the probe on ${name}, and no before-user-created lines print`, async () => {
      let probeCalled = false;
      const deps = baseDeps({
        ...overrides,
        fetchFunctionExistence: async () => {
          probeCalled = true;
          return { status: 201, body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }] };
        },
      });
      await runDoctorAuthHookCommand(deps);
      expect(probeCalled).toBe(false);
      expect(deps.logLines.join('\n') + deps.errorLines.join('\n')).not.toContain(
        'before-user-created',
      );
    });
  }
});

describe('runDoctorAuthHookCommand — B-1300 before-user-created: registration classification', () => {
  const bucRegistered = { [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI };

  it('reports REGISTERED + function EXISTS when registered and the probe finds the function', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody(bucRegistered),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('before-user-created hook REGISTERED');
    expect(deps.logLines.join('\n')).toContain(
      'before-user-created function public.before_user_created_hook(jsonb) EXISTS',
    );
    expect(deps.errorLines).toHaveLength(0);
  });

  it('treats the Management API SQL endpoint\'s 201 (not 200) as the probe success shape', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody(bucRegistered),
      }),
      // POST /v1/projects/<ref>/database/query answers 201 Created on success.
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain(
      'before-user-created function public.before_user_created_hook(jsonb) EXISTS',
    );
    expect(deps.logLines.join('\n')).not.toContain('CANNOT DETERMINE');
    expect(deps.errorLines).toHaveLength(0);
  });

  it('reports NOT REGISTERED + function MISSING when enabled=false and the probe returns null', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({ [BUC_ENABLED]: false, [BUC_URI]: null }),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: null }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('before-user-created hook NOT REGISTERED');
    expect(deps.logLines.join('\n')).toContain('MISSING');
    expect(deps.errorLines).toHaveLength(0);
  });

  it('reports registration CANNOT DETERMINE when the enabled key is missing', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({}),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('before-user-created hook CANNOT DETERMINE');
    expect(deps.errorLines).toHaveLength(0);
  });

  it('reports registration CANNOT DETERMINE when enabled=true but the uri points at the wrong function', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({
          [BUC_ENABLED]: true,
          [BUC_URI]: 'pg-functions://postgres/public/some_other_hook',
        }),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('before-user-created hook CANNOT DETERMINE');
  });
});

describe('runDoctorAuthHookCommand — B-1300 before-user-created: both mismatch directions WARN loudly, exit unchanged', () => {
  it('WARNs registered-but-function-missing (fails every sign-up) and still exits from the access-token half (0)', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({ [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI }),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: null }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    const warn = deps.errorLines.join('\n');
    expect(warn).toContain('WARN');
    expect(warn).toContain('BEFORE-USER-CREATED MISMATCH');
    expect(warn).toContain('MISSING');
    expect(warn).toContain('FAILS EVERY');
  });

  it('WARNs function-exists-but-hook-off (sign-up left open) and still exits from the access-token half (0)', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({ [BUC_ENABLED]: false, [BUC_URI]: null }),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    const warn = deps.errorLines.join('\n');
    expect(warn).toContain('WARN');
    expect(warn).toContain('BEFORE-USER-CREATED MISMATCH');
    expect(warn).toContain('NOT REGISTERED');
    expect(warn).toContain('silently left open');
  });

  it('a before-user-created mismatch does not rescue an access-token NOT REGISTERED (exit stays 1)', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: {
          hook_custom_access_token_enabled: false,
          hook_custom_access_token_uri: null,
          [BUC_ENABLED]: true,
          [BUC_URI]: BUC_GOOD_URI,
        },
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: null }],
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(1);
    expect(deps.errorLines.join('\n')).toContain('NOT REGISTERED');
    // The before-user-created half still ran (its mismatch WARN printed) even though the
    // access-token half resolved NOT REGISTERED — but the exit code is the access-token half's 1.
    expect(deps.errorLines.join('\n')).toContain('BEFORE-USER-CREATED MISMATCH');
  });
});

describe('runDoctorAuthHookCommand — B-1300 before-user-created: probe failure degrades to CANNOT DETERMINE, never a crash, never an exit change', () => {
  const bucRegistered = { [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI };

  it('probe rejects (network error) → existence CANNOT DETERMINE, registration still reported, exit 0', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody(bucRegistered),
      }),
      fetchFunctionExistence: async () => {
        throw new Error('probe network down');
      },
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('before-user-created hook REGISTERED');
    expect(deps.logLines.join('\n')).toContain('function existence CANNOT DETERMINE');
    // A registration-known + existence-unknown state is NOT a mismatch — no WARN.
    expect(deps.errorLines).toHaveLength(0);
  });

  it('probe non-200 → existence CANNOT DETERMINE, exit 0', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody(bucRegistered),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 500,
        body: undefined,
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('function existence CANNOT DETERMINE');
    expect(deps.errorLines).toHaveLength(0);
  });

  it('probe body in an unparseable shape → existence CANNOT DETERMINE, exit 0', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody(bucRegistered),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: { not: 'an-array-of-rows' },
      }),
    });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    expect(deps.logLines.join('\n')).toContain('function existence CANNOT DETERMINE');
    expect(deps.errorLines).toHaveLength(0);
  });

  it('omitted probe dep → the whole before-user-created half is skipped and the access-token half is byte-identical to the B-1035 single-hook output', async () => {
    const deps = baseDeps({ fetchFunctionExistence: undefined });
    const code = await runDoctorAuthHookCommand(deps);
    expect(code).toBe(0);
    // Byte-exact: the single access-token REGISTERED line and nothing else (the B-1035 output).
    expect(deps.logLines).toEqual([
      'harmony doctor auth-hook: REGISTERED (project proj-ref-123) — ' +
        'hook_custom_access_token_enabled=true, ' +
        'hook_custom_access_token_uri=pg-functions://postgres/public/custom_access_token_hook ' +
        'resolves to public.custom_access_token_hook.',
    ]);
    expect(deps.errorLines).toEqual([]);
  });
});

describe('runDoctorAuthHookCommand — B-1300 before-user-created: ordering and exit-contract guarantee', () => {
  it('prints the access-token half FIRST (unchanged) then the before-user-created half, in one run', async () => {
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({ [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI }),
      }),
      fetchFunctionExistence: async (): Promise<FunctionExistenceFetchResult> => ({
        status: 201,
        body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }],
      }),
    });
    await runDoctorAuthHookCommand(deps);
    const all = [...deps.logLines, ...deps.errorLines].join('\n');
    const accessTokenIdx = all.indexOf('custom_access_token_hook');
    const bucIdx = all.indexOf('before-user-created hook REGISTERED');
    expect(accessTokenIdx).toBeGreaterThanOrEqual(0);
    expect(bucIdx).toBeGreaterThan(accessTokenIdx);
  });

  it('the access-token exit code is identical whether the before-user-created half is registered, mismatched, or indeterminate', async () => {
    const scenarios: Array<{
      buc: Record<string, unknown>;
      probe: FunctionExistenceFetchResult;
    }> = [
      {
        buc: { [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI },
        probe: { status: 201, body: [{ to_regprocedure: 'before_user_created_hook(jsonb)' }] },
      },
      {
        buc: { [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI },
        probe: { status: 201, body: [{ to_regprocedure: null }] },
      },
      { buc: {}, probe: { status: 500, body: undefined } },
    ];
    for (const { buc, probe } of scenarios) {
      const deps = baseDeps({
        fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
          status: 200,
          body: accessTokenRegisteredBody(buc),
        }),
        fetchFunctionExistence: async () => probe,
      });
      const code = await runDoctorAuthHookCommand(deps);
      // Access-token half is REGISTERED in every scenario; the before-user-created state must never
      // move the exit off the access-token half's 0.
      expect(code).toBe(0);
    }
  });

  it('the before-user-created half never leaks the token even when the probe echoes it into a thrown error', async () => {
    const captured: string[] = [];
    const deps = baseDeps({
      fetchAuthConfig: async (): Promise<AuthConfigFetchResult> => ({
        status: 200,
        body: accessTokenRegisteredBody({ [BUC_ENABLED]: true, [BUC_URI]: BUC_GOOD_URI }),
      }),
      fetchFunctionExistence: async (_ref, accessToken) => {
        throw new Error(`probe blew up with token ${accessToken}`);
      },
    });
    await runDoctorAuthHookCommand(deps);
    captured.push(...deps.logLines, ...deps.errorLines);
    expect(captured.length).toBeGreaterThan(0);
    for (const line of captured) {
      expect(line).not.toContain(SECRET_TOKEN);
    }
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
