// B-692 Phase 2: the conduction record's shared-core accessors + the CANONICAL status axis.
//
// A conduction outlives any session — it is the durable record of one conducted run's mode, lease,
// and status, persisted in `public.conductions` (harmony-web Phase-1 migration, B-692). The table
// carries a PARTIAL UNIQUE INDEX allowing at most ONE `status='active'` row per task, which makes
// `createConduction`'s atomic insert-or-fail the LEASE-ACQUISITION PRIMITIVE: winning the insert IS
// acquiring the run; losing it (the unique violation, surfaced as the typed
// ActiveConductionExistsError) means another holder already owns the run.
//
// These are IN-PROCESS shared-core functions — brand-neutral, consumed by the future conductor
// daemon exactly as src/bin/poll.ts consumes getTask (a plain function call over an authenticated
// Supabase client). Deliberately NOT registered as MCP tools and NOT wired into src/cli/commands/:
// the module is exported through the src/tools barrel only.

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// The canonical status axis.
//
// Consumers must NEVER hand-write terminal/live checks (the B-580 completion-
// predicate bug class) — membership and the predicates below are the single
// naming for what each status means for ownership.
// ---------------------------------------------------------------------------

/** The conduction status vocabulary. Partitioned — every status is in exactly ONE of the three
 *  axis sets below (live / human-owned / terminal). */
export type ConductionStatus = 'active' | 'parked' | 'completed' | 'cancelled';

/** LIVE — daemon-owned, in flight: a worker owns the run and is (or should be) heartbeating.
 *  One of the three sets partitioning the ConductionStatus vocabulary. */
export const CONDUCTION_LIVE_STATUSES = ['active'] as const;

/** HUMAN-OWNED — parked awaiting a human: the daemon has released the run and nothing advances
 *  until a human acts. One of the three sets partitioning the ConductionStatus vocabulary. */
export const CONDUCTION_HUMAN_OWNED_STATUSES = ['parked'] as const;

/** TERMINAL — closed: the run finished (`completed`) or was called off (`cancelled`); the record
 *  is history and can never go live again. One of the three sets partitioning the
 *  ConductionStatus vocabulary. */
export const CONDUCTION_TERMINAL_STATUSES = ['completed', 'cancelled'] as const;

/** Every conduction status, derived from the three axis sets. `satisfies` asserts at build time
 *  that no set smuggles in a non-vocabulary member; `_AxisCoversVocabulary` below asserts the
 *  converse (no vocabulary member is missing from every set). Disjointness — each status in
 *  exactly ONE set — is asserted by the colocated partition test. */
export const CONDUCTION_STATUSES = [
  ...CONDUCTION_LIVE_STATUSES,
  ...CONDUCTION_HUMAN_OWNED_STATUSES,
  ...CONDUCTION_TERMINAL_STATUSES,
] as const satisfies readonly ConductionStatus[];

// Build-time exhaustiveness: if a ConductionStatus member is missing from every axis set, the
// derived union no longer covers the declared union and this assignment fails `tsc`.
type _AxisCoversVocabulary = [ConductionStatus] extends [(typeof CONDUCTION_STATUSES)[number]]
  ? true
  : never;
const _axisCoversVocabulary: _AxisCoversVocabulary = true;
void _axisCoversVocabulary;

/** Is the conduction daemon-owned and in flight? (status ∈ CONDUCTION_LIVE_STATUSES) */
export function isConductionLive(status: string): status is (typeof CONDUCTION_LIVE_STATUSES)[number] {
  return (CONDUCTION_LIVE_STATUSES as readonly string[]).includes(status);
}

/** Is the conduction parked awaiting a human? (status ∈ CONDUCTION_HUMAN_OWNED_STATUSES) */
export function isConductionHumanOwned(
  status: string,
): status is (typeof CONDUCTION_HUMAN_OWNED_STATUSES)[number] {
  return (CONDUCTION_HUMAN_OWNED_STATUSES as readonly string[]).includes(status);
}

/** Is the conduction closed for good? (status ∈ CONDUCTION_TERMINAL_STATUSES) */
export function isConductionTerminal(
  status: string,
): status is (typeof CONDUCTION_TERMINAL_STATUSES)[number] {
  return (CONDUCTION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// The conduction record row.
// ---------------------------------------------------------------------------

export interface ConductionRecord {
  id: string;
  task_id: string;
  status: ConductionStatus;
  /** Run mode — 'controlled' is the only mode in v1. */
  mode: string;
  lease_holder: string | null;
  lease_acquired_at: string | null;
  last_heartbeat_at: string | null;
  retry_count: number;
  worker_kind: string | null;
  worker_ref: string | null;
  last_worker_exit_code: number | null;
  last_worker_exit_class: string | null;
  current_pr_ref: string | null;
  started_at: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const CONDUCTION_COLS =
  'id, task_id, status, mode, lease_holder, lease_acquired_at, last_heartbeat_at, retry_count, ' +
  'worker_kind, worker_ref, last_worker_exit_code, last_worker_exit_class, current_pr_ref, ' +
  'started_at, created_by, created_at, updated_at';

// ---------------------------------------------------------------------------
// createConduction — the atomic lease-acquisition primitive.
// ---------------------------------------------------------------------------

/** Losing the create race — a second active conduction for the same task. Distinguishable from
 *  every other failure (instanceof / `code`) because losing the atomic insert-or-fail is the
 *  EXPECTED signal that another holder already owns the run, not an operational error. */
export class ActiveConductionExistsError extends Error {
  readonly code = 'active-conduction-exists';
  readonly task_id: string;
  constructor(taskId: string, cause?: string) {
    super(
      `an active conduction already exists for task ${taskId} — the atomic insert IS the ` +
        `lease-acquisition primitive, so losing it means another holder owns the run` +
        (cause ? ` (${cause})` : ''),
    );
    this.name = 'ActiveConductionExistsError';
    this.task_id = taskId;
  }
}

/** Postgres unique_violation (23505) — the partial unique index (one active conduction per task)
 *  rejecting a second active insert. Message fallback covers a client that drops the code. */
const isUniqueViolation = (error: { code?: string; message?: string }): boolean =>
  error.code === '23505' || /duplicate key value violates unique constraint/i.test(error.message ?? '');

export interface CreateConductionArgs {
  /** The task the run conducts (UUID — the daemon deals in resolved ids). */
  task_id: string;
  /** Run mode; defaults to 'controlled' (the only mode in v1). */
  mode?: string;
  lease_holder?: string;
  worker_kind?: string;
  worker_ref?: string;
  created_by?: string;
}

/** Insert a new 'active' conduction — the ATOMIC lease-acquisition primitive (see module header).
 *  Throws the typed ActiveConductionExistsError when the task already has an active conduction
 *  (the unique-violation loss); any other failure throws a plain loud Error. When a lease_holder
 *  is named at create, lease_acquired_at is stamped in the same atomic write (client-side, house
 *  idiom — the row's updated_at trigger carries the authoritative DB clock). */
export async function createConduction(
  client: SupabaseClient,
  args: CreateConductionArgs,
): Promise<ConductionRecord> {
  if (!args.task_id) throw new Error('task_id is required');

  const row: Record<string, unknown> = {
    task_id: args.task_id,
    status: 'active',
    mode: args.mode ?? 'controlled',
    lease_holder: args.lease_holder ?? null,
    worker_kind: args.worker_kind ?? null,
    worker_ref: args.worker_ref ?? null,
    created_by: args.created_by ?? null,
  };
  if (args.lease_holder) row.lease_acquired_at = new Date().toISOString();

  const { data, error } = await client
    .from('conductions')
    .insert(row)
    .select(CONDUCTION_COLS)
    .single();
  if (error) {
    if (isUniqueViolation(error)) throw new ActiveConductionExistsError(args.task_id, error.message);
    throw new Error(error.message);
  }
  return data as unknown as ConductionRecord;
}

// ---------------------------------------------------------------------------
// getConduction / getActiveConduction
// ---------------------------------------------------------------------------

/** Fetch one conduction by id, or null when it does not exist. Throws on error. */
export async function getConduction(
  client: SupabaseClient,
  id: string,
): Promise<ConductionRecord | null> {
  if (!id) throw new Error('id is required');
  const { data, error } = await client
    .from('conductions')
    .select(CONDUCTION_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ConductionRecord) ?? null;
}

/** The task's ONE active conduction (unique — partial unique index), or null when the task has no
 *  live run. Throws on error. */
export async function getActiveConduction(
  client: SupabaseClient,
  taskId: string,
): Promise<ConductionRecord | null> {
  if (!taskId) throw new Error('task_id is required');
  const { data, error } = await client
    .from('conductions')
    .select(CONDUCTION_COLS)
    .eq('task_id', taskId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as ConductionRecord) ?? null;
}

// ---------------------------------------------------------------------------
// updateConduction
// ---------------------------------------------------------------------------

/** The only fields a patch may touch. Identity (id, task_id) and provenance (started_at,
 *  created_by, created_at) are IMMUTABLE after create; updated_at belongs to the DB trigger. */
export const CONDUCTION_PATCHABLE_FIELDS = [
  'status',
  'lease_holder',
  'lease_acquired_at',
  'last_heartbeat_at',
  'retry_count',
  'worker_kind',
  'worker_ref',
  'last_worker_exit_code',
  'last_worker_exit_class',
  'current_pr_ref',
] as const;

export type ConductionPatch = Partial<
  Pick<ConductionRecord, (typeof CONDUCTION_PATCHABLE_FIELDS)[number]>
>;

/** Patch a conduction. REJECTS (loudly, before any write) a patch naming any non-patchable field
 *  — silently dropping an attempted `task_id`/`started_at` rewrite would mask a caller bug on the
 *  lease substrate — and validates `status` against the canonical vocabulary. Throws when the row
 *  does not exist. */
export async function updateConduction(
  client: SupabaseClient,
  id: string,
  patch: ConductionPatch,
): Promise<ConductionRecord> {
  if (!id) throw new Error('id is required');

  const keys = Object.keys(patch ?? {});
  if (keys.length === 0) {
    throw new Error(`patch must contain at least one of: ${CONDUCTION_PATCHABLE_FIELDS.join(', ')}`);
  }
  const rejected = keys.filter(
    (k) => !(CONDUCTION_PATCHABLE_FIELDS as readonly string[]).includes(k),
  );
  if (rejected.length > 0) {
    throw new Error(
      `non-patchable field(s): ${rejected.join(', ')} — a conduction patch may only touch: ` +
        CONDUCTION_PATCHABLE_FIELDS.join(', '),
    );
  }
  if ('status' in patch && !(CONDUCTION_STATUSES as readonly string[]).includes(patch.status as string)) {
    throw new Error(`status must be one of: ${CONDUCTION_STATUSES.join(', ')}`);
  }

  const { data, error } = await client
    .from('conductions')
    .update(patch)
    .eq('id', id)
    .select(CONDUCTION_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as ConductionRecord;
}
