// B-1035: `harmony doctor auth-hook` — a read-only operator CLI check for whether the actor-claim
// custom access-token hook (`public.custom_access_token_hook`, from B-978) is registered on a given
// Supabase project.
//
// B-1300 extends the SAME command with a second half: whether the invitation-only before-user-created
// hook (`public.before_user_created_hook`, from B-1298) is registered AND whether the function it
// points at actually exists. The before-user-created half NEVER changes the process exit code — the
// access-token half alone keeps the 0/1/2 contract below, so automation that already keys on it is
// untouched. A mismatch on the before-user-created half is a loud, greppable WARN, not an exit.
//
// WHY THE MANAGEMENT API, NOT THE DB: GoTrue's auth config (whether the hook is enabled, and which
// function it points at) is PLATFORM state, not database state — it is not readable from Postgres at
// all. A DB-only check (e.g. "does the function exist in pg_proc") would be a FALSE GREEN: the
// function can exist and simply not be wired up as the active hook. So this command calls the
// Supabase Management API (`GET /v1/projects/<ref>/config/auth`) with an operator's own personal
// access token, exactly as `supabase` CLI itself would.
//
// THE PROBE (function existence) IS A SECOND INJECTED FETCH, same credential. Registration and
// function existence live in two different systems: registration is GoTrue platform config (the
// Management API read above), existence is Postgres catalog state. The probe reaches Postgres through
// the Management API's SQL query endpoint (`POST /v1/projects/<ref>/database/query`) under the SAME
// SUPABASE_ACCESS_TOKEN — no database connection string ever enters this CLI. It runs the exact
// `to_regprocedure('public.before_user_created_hook(jsonb)')` existence query B-1298's rollout runbook
// has the founder run by hand; this command automates that check rather than inventing a new one.
// The two production fetches (auth config + probe) fire in PARALLEL in `registerDoctorCommands`
// below — the probe's outcome only degrades the before-user-created half (to CANNOT DETERMINE), never
// the access-token half.
//
// PURE CORE + THIN CLI WRAPPER, mirroring gates.ts's own split (see that file's header for the
// rationale): `runDoctorAuthHookCommand` takes every side effect as an injected dependency — the
// default-project-ref resolver, the access token, and the two fetch calls — so the whole decision
// tree (the access-token half's REGISTERED / NOT REGISTERED / CANNOT DETERMINE, plus the
// before-user-created half's REGISTERED+function exists / either mismatch WARN / CANNOT DETERMINE) is
// unit-testable with ZERO real network activity. Production wiring (the real `fetch`, the real
// env/config reads) lives ONLY in `registerDoctorCommands` below.
//
// THE TOKEN VALUE IS NEVER OBSERVABLE. `SUPABASE_ACCESS_TOKEN` (the Supabase CLI's own env var — an
// operator's personal access token) is read once, passed opaquely into the injected fetch calls, and
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
//
// B-1300 NOTE: the before-user-created Management-API field names (`HOOK_BUC_ENABLED_KEY`/
// `HOOK_BUC_URI_KEY` below) follow the established `hook_<name>_enabled/_uri` naming pattern and are
// confirmed by the Supabase Management API's published auth-config schema (verified at the build
// gate). The whole-command live read against a real project (both halves together) remains a named
// seat/founder step on this command's release brief.

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

/** The result of one call to the Management API's SQL query endpoint
 *  (`POST /v1/projects/<ref>/database/query`) — the before-user-created function-existence probe.
 *  `body` is the parsed JSON response — `undefined` when it could not be parsed as JSON, exactly as
 *  `AuthConfigFetchResult.body`. */
export interface FunctionExistenceFetchResult {
  status: number;
  body?: unknown;
}

export type FetchFunctionExistence = (
  projectRef: string,
  accessToken: string,
) => Promise<FunctionExistenceFetchResult>;

/** The Management API auth-config field names for the before-user-created hook, as NAMED CONSTANTS
 *  (see the B-1300 scope note in this file's header). Expected values, following the
 *  `hook_<name>_enabled` / `hook_<name>_uri` pattern the access-token hook already uses; the live
 *  read that confirms them is a named seat/founder step, not something this build could run. */
const HOOK_BUC_ENABLED_KEY = 'hook_before_user_created_enabled';
const HOOK_BUC_URI_KEY = 'hook_before_user_created_uri';

/** Everything `runDoctorAuthHookCommand` touches outside itself — injected so the whole decision
 *  tree is unit-testable without a real network call, a real `~/.harmony/config.json`, or a real
 *  `SUPABASE_ACCESS_TOKEN`. Mirrors GatesRunDeps's (src/cli/commands/gates.ts) convention: production
 *  wiring lives ONLY in `registerDoctorCommands`. */
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
  /** OPTIONAL (B-1300): the before-user-created function-existence probe. When omitted the whole
   *  before-user-created half is skipped and the command behaves byte-for-byte as the B-1035
   *  access-token-only check. May reject (network error) or return a non-200 — either way the
   *  before-user-created half degrades to CANNOT DETERMINE and NEVER changes the exit code. */
  fetchFunctionExistence?: FetchFunctionExistence;
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

/** B-1300 — the before-user-created half's outcome. `registration` classifies GoTrue platform state
 *  (enabled + which function the uri points at); `functionExists` classifies Postgres catalog state
 *  (the probe). Either side can be CANNOT DETERMINE independently — a registered hook whose uri is an
 *  unexpected shape still lets the probe answer existence, and a probe failure never hides a
 *  registration answer. */
type BucRegistration = 'registered' | 'not-registered' | 'cannot-determine';
type BucFunctionExists = 'exists' | 'missing' | 'cannot-determine';

/** The before-user-created half, pure I/O aside from its injected probe. Prints its own lines via the
 *  SAME redacting `log`/`error` wrappers the access-token half uses (the token never reaches them).
 *  Returns NOTHING: this half has no exit code of its own — the access-token half alone drives the
 *  process 0/1/2 contract (the ratified exit contract). A mismatch here is a loud, greppable WARN. */
async function reportBeforeUserCreatedHalf(
  body: Record<string, unknown>,
  deps: DoctorAuthHookDeps,
  projectRef: string,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<void> {
  // --- Registration (GoTrue platform config), read off the SAME auth-config body the access-token
  // --- half already fetched. A missing/non-boolean enabled key is a CANNOT DETERMINE for THIS half,
  // --- never a thrown error and never an influence on the access-token half's outcome.
  const rawEnabled = body[HOOK_BUC_ENABLED_KEY];
  const rawUri = body[HOOK_BUC_URI_KEY];
  const uri = typeof rawUri === 'string' ? rawUri : undefined;
  const uriDisplay = uri ?? '<none>';

  let registration: BucRegistration;
  let registrationDetail: string;
  if (typeof rawEnabled !== 'boolean') {
    registration = 'cannot-determine';
    registrationDetail =
      `${HOOK_BUC_ENABLED_KEY} is missing or not a boolean in the auth-config response ` +
      `(expected ${HOOK_BUC_ENABLED_KEY} per the Management API auth-config schema).`;
  } else if (!rawEnabled) {
    registration = 'not-registered';
    registrationDetail = `${HOOK_BUC_ENABLED_KEY}=false, ${HOOK_BUC_URI_KEY}=${uriDisplay}`;
  } else {
    const match = uri ? PG_FUNCTIONS_URI.exec(uri) : null;
    if (match && match[1] === 'public' && match[2] === 'before_user_created_hook') {
      registration = 'registered';
      registrationDetail =
        `${HOOK_BUC_ENABLED_KEY}=true, ${HOOK_BUC_URI_KEY}=${uri} resolves to ` +
        'public.before_user_created_hook';
    } else {
      registration = 'cannot-determine';
      registrationDetail =
        `${HOOK_BUC_ENABLED_KEY}=true but ${HOOK_BUC_URI_KEY}=${uriDisplay} does not resolve to ` +
        'public.before_user_created_hook';
    }
  }

  // --- Function existence (Postgres catalog state) via the injected probe. A missing dep, a thrown
  // --- network error, a non-2xx, or an unparseable body each degrade to CANNOT DETERMINE — the probe
  // --- never fails the run and never touches the access-token half. The Management API's SQL query
  // --- endpoint answers 201 (not 200) on success, so success is any 2xx.
  let functionExists: BucFunctionExists = 'cannot-determine';
  let functionExistsDetail = '';
  if (deps.fetchFunctionExistence) {
    try {
      const probe = await deps.fetchFunctionExistence(projectRef, deps.accessToken as string);
      if (probe.status >= 200 && probe.status < 300) {
        const parsed = parseRegprocedureExists(probe.body);
        functionExists = parsed === null ? 'cannot-determine' : parsed ? 'exists' : 'missing';
      } else {
        functionExistsDetail = ` (probe HTTP ${probe.status})`;
      }
    } catch {
      functionExists = 'cannot-determine';
    }
  }

  // --- Report, in the access-token half's own shape: a REGISTERED/enabled state with the hook uri,
  // --- or not-registered; a function-exists or function-missing state; and a loud, greppable WARN
  // --- naming the hook and the mismatch direction when the two systems disagree.
  if (registration === 'registered') {
    log(
      `harmony doctor auth-hook: before-user-created hook REGISTERED (project ${projectRef}) — ` +
        registrationDetail,
    );
  } else if (registration === 'not-registered') {
    log(
      `harmony doctor auth-hook: before-user-created hook NOT REGISTERED (project ${projectRef}) — ` +
        registrationDetail,
    );
  } else {
    log(
      `harmony doctor auth-hook: before-user-created hook CANNOT DETERMINE (project ${projectRef}) — ` +
        registrationDetail,
    );
  }

  if (functionExists === 'exists') {
    log(
      `harmony doctor auth-hook: before-user-created function public.before_user_created_hook(jsonb) ` +
        `EXISTS (project ${projectRef}).`,
    );
  } else if (functionExists === 'missing') {
    log(
      `harmony doctor auth-hook: before-user-created function public.before_user_created_hook(jsonb) ` +
        `MISSING (project ${projectRef}).`,
    );
  } else {
    log(
      `harmony doctor auth-hook: before-user-created function existence CANNOT DETERMINE ` +
        `(project ${projectRef})${functionExistsDetail}.`,
    );
  }

  // --- The two mismatch directions the ticket exists to catch. Both are WARNs, never exit codes.
  if (registration === 'registered' && functionExists === 'missing') {
    error(
      `WARN harmony doctor auth-hook: BEFORE-USER-CREATED MISMATCH (project ${projectRef}) — the ` +
        'hook is REGISTERED but its backing function public.before_user_created_hook(jsonb) is ' +
        'MISSING from the database. A registered hook pointing at a missing function FAILS EVERY ' +
        'sign-up on this project. Fix: re-apply the migration that creates the function, or disable ' +
        'the hook at Supabase Dashboard -> Authentication -> Hooks.',
    );
  } else if (registration === 'not-registered' && functionExists === 'exists') {
    error(
      `WARN harmony doctor auth-hook: BEFORE-USER-CREATED MISMATCH (project ${projectRef}) — the ` +
        'backing function public.before_user_created_hook(jsonb) EXISTS in the database but the ' +
        'hook is NOT REGISTERED, so sign-up is silently left open. Fix: register the hook at ' +
        'Supabase Dashboard -> Authentication -> Hooks (Before User Created -> Postgres -> ' +
        'public.before_user_created_hook -> Enable).',
    );
  }
}

/** Reads the `to_regprocedure('public.before_user_created_hook(jsonb)')` answer out of the Management
 *  API SQL query endpoint's response. The endpoint returns rows as a JSON array; the single row's
 *  single column is the regprocedure value (rendered as its text form, e.g.
 *  `"before_user_created_hook(jsonb)"`) when the function exists, or JSON `null` when it does not.
 *  Returns `true` (exists) / `false` (missing) / `null` (the body did not parse into that shape — a
 *  CANNOT DETERMINE, never a guess). Tolerates the column landing under any single key. */
function parseRegprocedureExists(body: unknown): boolean | null {
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  const row = body[0];
  if (typeof row !== 'object' || row === null) {
    return null;
  }
  const values = Object.values(row as Record<string, unknown>);
  if (values.length !== 1) {
    return null;
  }
  const value = values[0];
  if (value === null) {
    return false;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  return null;
}

/** The whole three-way decision tree, pure I/O aside from its injected deps. Returns the PROCESS
 *  EXIT CODE: 0 = REGISTERED, 1 = NOT REGISTERED, 2 = CANNOT DETERMINE.
 *
 *  THE EXIT CODE COMES FROM THE ACCESS-TOKEN HALF ALONE (B-1300's ratified contract). The
 *  before-user-created half runs after the access-token half's outcome is computed, prints its own
 *  lines, and can WARN — but it returns nothing and the value below is returned unchanged, so a
 *  before-user-created state can never leak into automation that keys on today's 0/1/2.
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

  // B-1300: the access-token half's outcome is computed into `exitCode` (NOT returned early), so the
  // before-user-created half can run in every case where the auth-config fetch succeeded — including
  // the access-token NOT REGISTERED (1) and CANNOT DETERMINE (2, unrecognized-uri) outcomes. The
  // value is returned unchanged at the end: the exit contract is the access-token half's alone.
  let exitCode: number;

  if (!enabled) {
    error(
      `harmony doctor auth-hook: NOT REGISTERED (project ${projectRef}) — ` +
        `hook_custom_access_token_enabled=false, hook_custom_access_token_uri=${uriDisplay}. Fix: ` +
        'register the hook at Supabase Dashboard -> Authentication -> Hooks, or via the Management API.',
    );
    exitCode = 1;
  } else {
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
      exitCode = 2;
    } else {
      const [, schema, fn] = match;
      if (schema === 'public' && fn === 'custom_access_token_hook') {
        log(
          `harmony doctor auth-hook: REGISTERED (project ${projectRef}) — ` +
            `hook_custom_access_token_enabled=true, hook_custom_access_token_uri=${uri} resolves to ` +
            'public.custom_access_token_hook.',
        );
        exitCode = 0;
      } else {
        error(
          `harmony doctor auth-hook: NOT REGISTERED (project ${projectRef}) — ` +
            `hook_custom_access_token_enabled=true but hook_custom_access_token_uri=${uri} points at ` +
            `${schema}.${fn}, not public.custom_access_token_hook. Fix: register the hook at Supabase ` +
            'Dashboard -> Authentication -> Hooks, or via the Management API.',
        );
        exitCode = 1;
      }
    }
  }

  // B-1300 — the before-user-created half. Runs AFTER the access-token half (which prints first and
  // unchanged), appended after it in the same run. It prints and warns but returns nothing; the
  // access-token half's exitCode is returned untouched below. Only ever reached when the auth-config
  // fetch succeeded, so `body` here is the parsed object with a valid boolean access-token field.
  // Skipped ENTIRELY when no `fetchFunctionExistence` probe is injected — in that shape the run is
  // byte-for-byte the B-1035 access-token-only output (the AC cec2d88d contract).
  if (deps.fetchFunctionExistence) {
    await reportBeforeUserCreatedHalf(body as Record<string, unknown>, deps, projectRef, log, error);
  }

  return exitCode;
}

export function registerDoctorCommands(program: Command): void {
  const doctor = program
    .command('doctor')
    .description('Read-only operator diagnostics (no board writes, no plugin-tracked state).');

  doctor
    .command('auth-hook')
    .description(
      'Report whether the actor-claim custom access-token hook (public.custom_access_token_hook, ' +
        'B-978) AND the invitation-only before-user-created hook (public.before_user_created_hook, ' +
        'B-1298) are registered on a Supabase project, and whether the before-user-created backing ' +
        'function exists — reading the Supabase Management API (GoTrue auth config is platform ' +
        'state, not DB state — a DB-only check would be a false green). Registration comes from ' +
        'GET /v1/projects/<ref>/config/auth; the before-user-created function-existence probe runs ' +
        'the same to_regprocedure existence query the founder runs by hand, through POST ' +
        '/v1/projects/<ref>/database/query under the same SUPABASE_ACCESS_TOKEN (the Supabase CLI\'s ' +
        'own personal-access-token env var, auth:read scope). One run prints the access-token half ' +
        'first and unchanged, then the before-user-created half; a mismatch on the ' +
        'before-user-created half is a loud WARN and NEVER changes the exit code. --project-ref ' +
        "defaults to the Supabase project this CLI session is already configured against (active " +
        "`harmony login` project's Supabase URL, else HARMONY_SUPABASE_URL, else the hardcoded prod " +
        'project every session targets absent an override) when omitted — pass it explicitly to ' +
        'check a different project. Exit 0 = access-token hook registered, 1 = access-token hook ' +
        'not registered, 2 = cannot determine the access-token hook (the before-user-created half ' +
        'adds no exit outcome of its own).',
    )
    .option(
      '--project-ref <ref>',
      "Supabase project ref to check (defaults to this CLI session's configured project; see description above)",
    )
    .action(async (opts: { projectRef?: string }) => {
      const accessToken = process.env.SUPABASE_ACCESS_TOKEN;

      const fetchAuthConfig: FetchAuthConfig = async (projectRef, token) => {
        const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        return { status: res.status, body };
      };

      const fetchFunctionExistence: FetchFunctionExistence = async (projectRef, token) => {
        const res = await fetch(
          `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              query: "SELECT to_regprocedure('public.before_user_created_hook(jsonb)')",
              read_only: true,
            }),
          },
        );
        let body: unknown;
        try {
          body = await res.json();
        } catch {
          body = undefined;
        }
        return { status: res.status, body };
      };

      // B-1300: fire the auth-config fetch and the function-existence probe CONCURRENTLY, per the
      // accepted plan. `runDoctorAuthHookCommand` calls the injected `fetchAuthConfig` first, so we
      // start BOTH fetches there and memoize the probe promise; the injected
      // `fetchFunctionExistence` (called later, when the before-user-created half runs) returns the
      // memoized promise rather than firing a second request. The memo is scoped to THIS action
      // invocation (a `let` captured in the closure) — never module state — so one `auth-hook` run
      // fires exactly one probe and nothing leaks across invocations. The memoized probe promise
      // never rejects: a network failure is caught here and degraded to an HTTP-0 result, which the
      // before-user-created half reports as CANNOT DETERMINE — it never reaches the access-token
      // half. The probe is only fired when a token is present (it is pointless without one); with
      // no token the core's own missing-token branch runs first and the memo is never read.
      let probeMemo: Promise<FunctionExistenceFetchResult> | undefined;
      const deps: DoctorAuthHookDeps = {
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
        accessToken,
        fetchAuthConfig: (projectRef, token) => {
          const configPromise = fetchAuthConfig(projectRef, token);
          if (token) {
            probeMemo = fetchFunctionExistence(projectRef, token).catch(
              (): FunctionExistenceFetchResult => ({ status: 0, body: undefined }),
            );
          }
          return configPromise;
        },
        fetchFunctionExistence: () =>
          probeMemo ?? Promise.resolve({ status: 0, body: undefined }),
        log: (line) => console.log(line),
        error: (line) => console.error(line),
      };

      const exitCode = await runDoctorAuthHookCommand(deps);
      process.exit(exitCode);
    });
}
