// B-1035: `harmony doctor auth-hook` — a read-only operator CLI check for whether the actor-claim
// custom access-token hook (`public.custom_access_token_hook`, from B-978) is registered on a given
// Supabase project.
//
// WHY THE MANAGEMENT API, NOT THE DB: GoTrue's auth config (whether the hook is enabled, and which
// function it points at) is PLATFORM state, not database state — it is not readable from Postgres at
// all. A DB-only check (e.g. "does the function exist in pg_proc") would be a FALSE GREEN: the
// function can exist and simply not be wired up as the active hook. So this command calls the
// Supabase Management API (`GET /v1/projects/<ref>/config/auth`) with an operator's own personal
// access token, exactly as `supabase` CLI itself would.
//
// PURE CORE + THIN CLI WRAPPER, mirroring gates.ts's own split (see that file's header for the
// rationale): `runDoctorAuthHookCommand` takes every side effect as an injected dependency — the
// default-project-ref resolver, the access token, and the fetch call itself — so the whole three-way
// decision tree (REGISTERED / NOT REGISTERED / CANNOT DETERMINE) is unit-testable with ZERO real
// network activity. Production wiring (the real `fetch`, the real env/config reads) lives ONLY in
// `registerDoctorCommands` below.
//
// THE TOKEN VALUE IS NEVER OBSERVABLE. `SUPABASE_ACCESS_TOKEN` (the Supabase CLI's own env var — an
// operator's personal access token) is read once, passed opaquely into the injected fetch call, and
// otherwise touched by NOTHING in this file: never logged, never printed, never interpolated into an
// error string. Only its presence/absence is ever surfaced. Likewise `hook_custom_access_token_secrets`
// (present on a successful read) is a field this file NEVER reads — it may carry a secret.
//
// This is CLI-only, by design (see the ticket): an operator-only diagnostic, deliberately kept out of
// the shared MCP+CLI `src/tools/` surface that `plugin/skills/` and the MCP server both consume.
//
// SCOPE NOTE: the exact live `hook_custom_access_token_uri` form Supabase returns for a registered
// Postgres hook has not been confirmed against a real project as of this writing (no
// `SUPABASE_ACCESS_TOKEN` in this build's environment) — see the CANNOT DETERMINE branch below for
// the deliberate, honest fallback when an observed uri doesn't cleanly match the documented
// `pg-functions://postgres/<schema>/<function>` shape. Confirming the live value is explicitly
// deferred to a human running this command at the ticket's verify gate.

import { Command } from 'commander';
import { getActiveProject } from '../config.js';
import { DEFAULT_SUPABASE_URL } from '../../tools/environment.js';

/** The result of one call to the Supabase Management API's `GET /v1/projects/<ref>/config/auth`.
 *  `body` is the parsed JSON response — `undefined` when the response body could not be parsed as
 *  JSON (production wiring degrades a `res.json()` throw to `undefined` here, rather than letting it
 *  escape as a second kind of failure the core would need to distinguish from a network error). */
export interface AuthConfigFetchResult {
  status: number;
  body?: unknown;
}

export type FetchAuthConfig = (
  projectRef: string,
  accessToken: string,
) => Promise<AuthConfigFetchResult>;

/** Everything `runDoctorAuthHookCommand` touches outside itself — injected so the whole three-way
 *  outcome (REGISTERED / NOT REGISTERED / CANNOT DETERMINE) is unit-testable without a real network
 *  call, a real `~/.harmony/config.json`, or a real `SUPABASE_ACCESS_TOKEN`. Mirrors GatesRunDeps's
 *  (src/cli/commands/gates.ts) convention: production wiring lives ONLY in `registerDoctorCommands`. */
export interface DoctorAuthHookDeps {
  /** The raw `--project-ref` CLI flag, if given. `undefined` when omitted (the default-resolution
   *  path below is then tried). */
  projectRefFlag: string | undefined;
  /** Attempts to default the project ref from the Supabase project this CLI session is ALREADY
   *  configured against — see `resolveDefaultProjectRef` below for the precedence. Called ONLY when
   *  `projectRefFlag` is `undefined`. Returns `null` when no default is available (no active
   *  `harmony login` project with a custom Supabase URL, and no `HARMONY_SUPABASE_URL` override —
   *  note this can still resolve to the hardcoded prod ref, the same "no override ⇒ prod" default
   *  every other command in this CLI already uses; see that function's own doc for why that is a
   *  precedented default rather than a guess). */
  resolveDefaultProjectRef: () => string | null;
  /** `process.env.SUPABASE_ACCESS_TOKEN` — the Supabase CLI's own personal-access-token env var.
   *  `undefined` when unset. NEVER logged/printed by this file; only used opaquely as a bearer
   *  credential handed to `fetchAuthConfig`. */
  accessToken: string | undefined;
  /** Calls the Supabase Management API. The pure core never does a real `fetch` — production wires
   *  the real one in `registerDoctorCommands`, exactly like `gates.ts`'s
   *  `getAuthenticatedContext`/`runStep` injection. May reject (network error); the core catches that
   *  and reports it as CANNOT DETERMINE. */
  fetchAuthConfig: FetchAuthConfig;
  log: (line: string) => void;
  error: (line: string) => void;
}

const PG_FUNCTIONS_URI = /^pg-functions:\/\/postgres\/([^/]+)\/([^/]+)$/;

/** Attempts to default `--project-ref` from the Supabase project this CLI session is ALREADY
 *  configured against, using the SAME precedence `src/tools/environment.ts`'s `resolveEnvironment`
 *  uses for `get_project`'s own `supabase_project_ref` — and the same one `getAuthenticatedContext`
 *  (src/cli/auth.ts) applies before every other authenticated CLI call: an active `harmony login`
 *  project's own `supabaseUrl` first (if one was set at login), else the `HARMONY_SUPABASE_URL`
 *  override, else the hardcoded prod project every session in this codebase targets absent either —
 *  see `src/supabase.ts`'s own identical fallback. Reusing this (rather than inventing a new
 *  resolution just for this command) is the "clean, precedented way to default it" the ticket asks
 *  for: it is not a guess, it is literally which project every other `harmony` command would talk to
 *  right now, in this environment, with no flag given.
 *
 *  Pure: takes the already-resolved inputs rather than reading files/env itself, so it's directly
 *  unit-testable without a real `~/.harmony/config.json`. */
export function resolveDefaultProjectRef(input: {
  activeProjectSupabaseUrl?: string;
  envSupabaseUrl?: string;
}): string | null {
  const url = input.activeProjectSupabaseUrl ?? input.envSupabaseUrl ?? DEFAULT_SUPABASE_URL;
  try {
    const ref = new URL(url).hostname.split('.')[0];
    return ref ? ref : null;
  } catch {
    return null;
  }
}

function errMessage(err: unknown): string {
  return (err as { message?: string } | undefined)?.message ?? String(err);
}

/** The whole three-way decision tree, pure I/O aside from its injected deps. Returns the PROCESS
 *  EXIT CODE: 0 = REGISTERED, 1 = NOT REGISTERED, 2 = CANNOT DETERMINE.
 *
 *  STRUCTURAL TOKEN-SAFETY NET: every line goes through `log`/`error` wrappers that scrub the raw
 *  `accessToken` substring (if present) before it ever reaches `deps.log`/`deps.error` — not just
 *  per-branch discipline. This holds even if an injected `fetchAuthConfig` misbehaves and lets the
 *  token value leak into a thrown error's `.message` (e.g. a library that echoes request headers on
 *  failure); this file's own construction is deliberately what makes the value unobservable, not the
 *  good behavior of its dependencies. */
export async function runDoctorAuthHookCommand(deps: DoctorAuthHookDeps): Promise<number> {
  const token = deps.accessToken;
  const redact = (line: string): string => (token ? line.split(token).join('<redacted>') : line);
  const log = (line: string): void => deps.log(redact(line));
  const error = (line: string): void => deps.error(redact(line));

  const projectRef = deps.projectRefFlag ?? deps.resolveDefaultProjectRef() ?? undefined;
  if (!projectRef) {
    error(
      'harmony doctor auth-hook: CANNOT DETERMINE — no --project-ref given and no default project ' +
        'could be resolved (no active `harmony login` project, and HARMONY_SUPABASE_URL is unset). ' +
        'Pass --project-ref <ref> explicitly; this command never guesses which project to check.',
    );
    return 2;
  }

  if (!deps.accessToken) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — SUPABASE_ACCESS_TOKEN is ` +
        'not set. Set it to a Supabase personal access token with the auth:read (auth_config_read) ' +
        'scope (see https://supabase.com/dashboard/account/tokens).',
    );
    return 2;
  }

  let result: AuthConfigFetchResult;
  try {
    result = await deps.fetchAuthConfig(projectRef, deps.accessToken);
  } catch (err: unknown) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — network error calling ` +
        `the Supabase Management API: ${errMessage(err)}`,
    );
    return 2;
  }

  if (result.status === 401 || result.status === 403) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — HTTP ${result.status} ` +
        'from the Supabase Management API. SUPABASE_ACCESS_TOKEN is invalid or lacks the auth:read ' +
        '(auth_config_read) scope.',
    );
    return 2;
  }

  if (result.status === 404) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — HTTP 404 from the ` +
        'Supabase Management API: project not found. Check --project-ref.',
    );
    return 2;
  }

  if (result.status !== 200) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — unexpected HTTP ` +
        `${result.status} from the Supabase Management API.`,
    );
    return 2;
  }

  const body = result.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).hook_custom_access_token_enabled !== 'boolean'
  ) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — the response did not ` +
        'parse into the expected shape (missing or non-boolean hook_custom_access_token_enabled).',
    );
    return 2;
  }

  const enabled = (body as Record<string, unknown>).hook_custom_access_token_enabled as boolean;
  const rawUri = (body as Record<string, unknown>).hook_custom_access_token_uri;
  const uri = typeof rawUri === 'string' ? rawUri : undefined;
  const uriDisplay = uri ?? '<none>';

  if (!enabled) {
    error(
      `harmony doctor auth-hook: NOT REGISTERED (project ${projectRef}) — ` +
        `hook_custom_access_token_enabled=false, hook_custom_access_token_uri=${uriDisplay}. Fix: ` +
        'register the hook at Supabase Dashboard -> Authentication -> Hooks, or via the Management API.',
    );
    return 1;
  }

  // enabled === true: classify the uri. Postgres-hook URIs from Supabase are documented as
  // `pg-functions://postgres/<schema>/<function>` — match against exactly that shape. If the
  // observed uri does not cleanly match ANY recognizable pg-functions shape, do NOT force a match:
  // fall through to CANNOT DETERMINE, naming the raw observed values (see this file's header — the
  // exact live uri form is a known open item, not a bug).
  const match = uri ? PG_FUNCTIONS_URI.exec(uri) : null;
  if (!match) {
    error(
      `harmony doctor auth-hook: CANNOT DETERMINE (project ${projectRef}) — ` +
        `hook_custom_access_token_enabled=true but hook_custom_access_token_uri=${uriDisplay} does ` +
        'not match any recognizable pg-functions://postgres/<schema>/<function> shape.',
    );
    return 2;
  }

  const [, schema, fn] = match;
  if (schema === 'public' && fn === 'custom_access_token_hook') {
    log(
      `harmony doctor auth-hook: REGISTERED (project ${projectRef}) — ` +
        `hook_custom_access_token_enabled=true, hook_custom_access_token_uri=${uri} resolves to ` +
        'public.custom_access_token_hook.',
    );
    return 0;
  }

  error(
    `harmony doctor auth-hook: NOT REGISTERED (project ${projectRef}) — ` +
      `hook_custom_access_token_enabled=true but hook_custom_access_token_uri=${uri} points at ` +
      `${schema}.${fn}, not public.custom_access_token_hook. Fix: register the hook at Supabase ` +
      'Dashboard -> Authentication -> Hooks, or via the Management API.',
  );
  return 1;
}

export function registerDoctorCommands(program: Command): void {
  const doctor = program
    .command('doctor')
    .description('Read-only operator diagnostics (no board writes, no plugin-tracked state).');

  doctor
    .command('auth-hook')
    .description(
      'Report whether the actor-claim custom access-token hook (public.custom_access_token_hook, ' +
        'B-978) is registered on a Supabase project, by reading the Supabase Management API (GoTrue ' +
        "auth config is platform state, not DB state — a DB-only check would be a false green). " +
        'Requires SUPABASE_ACCESS_TOKEN (the Supabase CLI\'s own personal-access-token env var) with ' +
        'the auth:read (auth_config_read) scope. --project-ref defaults to the Supabase project this ' +
        "CLI session is already configured against (active `harmony login` project's Supabase URL, " +
        'else HARMONY_SUPABASE_URL, else the hardcoded prod project every session targets absent an ' +
        'override) when omitted — pass it explicitly to check a different project. ' +
        'Exit 0 = registered, 1 = not registered, 2 = cannot determine.',
    )
    .option(
      '--project-ref <ref>',
      "Supabase project ref to check (defaults to this CLI session's configured project; see description above)",
    )
    .action(async (opts: { projectRef?: string }) => {
      const exitCode = await runDoctorAuthHookCommand({
        projectRefFlag: opts.projectRef,
        resolveDefaultProjectRef: () => {
          let activeProjectSupabaseUrl: string | undefined;
          try {
            activeProjectSupabaseUrl = getActiveProject().supabaseUrl;
          } catch {
            activeProjectSupabaseUrl = undefined;
          }
          return resolveDefaultProjectRef({
            activeProjectSupabaseUrl,
            envSupabaseUrl: process.env.HARMONY_SUPABASE_URL,
          });
        },
        accessToken: process.env.SUPABASE_ACCESS_TOKEN,
        fetchAuthConfig: async (projectRef, accessToken) => {
          const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            body = undefined;
          }
          return { status: res.status, body };
        },
        log: (line) => console.log(line),
        error: (line) => console.error(line),
      });
      process.exit(exitCode);
    });
}
