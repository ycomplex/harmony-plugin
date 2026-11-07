/**
 * `harmony watch` board reader (B-1422).
 *
 * One reader per watch process. Per poll it makes:
 *   - ONE `tasks` select for the watched ids,
 *   - ONE `conductions` select for the same ids (latest row per task),
 *   - `getTask(view:'meta')` ONLY for tickets whose `updated_at` moved since the previous read, or
 *     that are awaiting a human (for `active_brief_iteration`, `active_exchange`).
 *
 * `last_leg_ended_at` may be missing on an older board (B-1040 / B-383). The conductions select is
 * then retried without it and the snapshot is marked `legEndKnown: false`; the classifier falls
 * back to "a pause held unchanged for 90 s is ready".
 *
 * The visual id (`B-1422`) is not a column: it is `${projects.key}-${task_number}`. The project key
 * and name are read once.
 *
 * A milestone scope must name a milestone OF THIS PROJECT: a uuid with no row, or with another
 * project's row, is a ScopeError, as is a name with no match. A real milestone with no tickets
 * resolves to an empty list; it is not an error.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { CONDUCTION_LIVE_STATUSES, isMissingLastLegEndedAtColumn } from '../tools/conduction-record.js';
import { getTask } from '../tools/tasks.js';
import type { WatchScope } from './seat-files.js';

/** The conduction slice a watch needs. `last_leg_ended_at` is `undefined` when the column is missing. */
export interface ConductionSlice {
  id: string;
  status: string;
  leg_started_at: string | null;
  last_leg_ended_at?: string | null;
  last_worker_exit_class: string | null;
}

/** What `getTask(view:'meta')` adds that the plain tasks select cannot. */
export interface TicketMeta {
  active_brief_iteration: number | null;
  active_exchange: { exchange_id?: string; status?: string; round?: number } | null;
}

export interface TicketSnapshot {
  id: string;
  key: string;
  task_number: number;
  title: string;
  workflow_state: string | null;
  awaiting_human_input: boolean;
  awaiting_human_reason: string | null;
  awaiting_human_ref: unknown;
  updated_at: string;
  archived: boolean;
  milestone_id: string | null;
  /** `field_values.waiting_on` (B-1157), null when absent. */
  waiting_on: unknown;
  conduction: ConductionSlice | null;
  /** Null until a meta read has succeeded for this ticket. */
  meta: TicketMeta | null;
}

export interface BoardSnapshot {
  tickets: TicketSnapshot[];
  /** False when the board has no `conductions.last_leg_ended_at` column. */
  legEndKnown: boolean;
}

/** A comment line that may carry a SEAT-START / SEAT-STANDDOWN marker. */
export interface MarkerComment {
  task_id: string;
  content: string;
  created_at: string;
}

/** A scope that cannot be resolved for a reason a retry will not fix (bad key prefix, unknown milestone). */
export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

/** The active project as the board names it. */
export interface ProjectInfo {
  key: string;
  name: string;
}

/** A resolved milestone of the active project. `name` is null when the board gave none. */
export interface MilestoneInfo {
  id: string;
  name: string | null;
}

export interface BoardReader {
  projectKey(): Promise<string>;
  /** The project's key and name (one select, cached with the key). */
  projectInfo(): Promise<ProjectInfo>;
  /** The milestone a `--milestone <id|name>` names, in this project; a ScopeError otherwise. */
  resolveMilestone(idOrName: string): Promise<MilestoneInfo>;
  /** Task uuids in the scope, re-resolved on every call. */
  resolveScope(scope: WatchScope): Promise<string[]>;
  readSnapshot(taskIds: string[]): Promise<BoardSnapshot>;
  /** Comments on these tickets that mention a seat marker (one select). */
  listMarkerComments(taskIds: string[]): Promise<MarkerComment[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d+)$/;

/** Parse `B-1422` / `1422` into `{ prefix, number }`, or null when it is not a ticket key. */
export function parseTicketKey(key: string): { prefix: string | null; number: number } | null {
  const m = KEY_RE.exec(String(key).trim());
  if (!m) return null;
  return { prefix: m[1] ?? null, number: Number(m[2]) };
}

const TASK_COLS =
  'id, task_number, title, workflow_state, awaiting_human_input, awaiting_human_reason, awaiting_human_ref, ' +
  'updated_at, field_values, archived, milestone_id';
const COND_COLS_BASE = 'id, task_id, status, leg_started_at, last_worker_exit_class, created_at';
const COND_COLS = `${COND_COLS_BASE}, last_leg_ended_at`;

function throwIf(error: unknown): void {
  if (error) throw error;
}

export interface BoardReaderDeps {
  /** Injected for tests; defaults to the shared core's `getTask`. */
  getTaskMeta?: (taskId: string) => Promise<unknown>;
}

export function createBoardReader(client: SupabaseClient, projectId: string, deps: BoardReaderDeps = {}): BoardReader {
  const getTaskMeta = deps.getTaskMeta ?? ((taskId: string) => getTask(client, projectId, { task_id: taskId, view: 'meta' }));
  let info: ProjectInfo | null = null;
  const milestones = new Map<string, MilestoneInfo>();
  const seenUpdatedAt = new Map<string, string>();
  const metaCache = new Map<string, TicketMeta>();
  // Once the column is known to be missing, stop asking for it.
  let legEndColumn = true;

  async function projectInfo(): Promise<ProjectInfo> {
    if (info !== null) return info;
    const { data, error } = await client.from('projects').select('key, name').eq('id', projectId).single();
    throwIf(error);
    const row = (data as { key?: unknown; name?: unknown } | null) ?? null;
    const k = row?.key;
    if (typeof k !== 'string' || !k) throw new Error('project has no key');
    info = { key: k, name: typeof row?.name === 'string' && row.name ? row.name : k };
    return info;
  }

  async function projectKey(): Promise<string> {
    return (await projectInfo()).key;
  }

  async function resolveMilestone(idOrName: string): Promise<MilestoneInfo> {
    const cached = milestones.get(idOrName);
    if (cached) return cached;
    const pk = await projectKey();
    let resolved: MilestoneInfo;
    if (UUID.test(idOrName)) {
      // By id: the row must exist AND belong to this project. RLS may hide another project's row
      // entirely; either way the answer is the same refusal.
      const { data, error } = await client.from('milestones').select('id, name, project_id').eq('id', idOrName);
      throwIf(error);
      const rows = (data as Array<{ id: string; name?: unknown; project_id?: unknown }> | null) ?? [];
      const row = rows[0];
      if (!row || row.project_id !== projectId) {
        throw new ScopeError(`milestone ${idOrName} is not in project ${pk}`);
      }
      resolved = { id: row.id, name: typeof row.name === 'string' ? row.name : null };
    } else {
      const { data, error } = await client.from('milestones').select('id, name').eq('project_id', projectId).eq('name', idOrName);
      throwIf(error);
      const rows = (data as Array<{ id: string; name?: unknown }> | null) ?? [];
      if (rows.length === 0) throw new ScopeError(`no milestone named ${JSON.stringify(idOrName)} in project ${pk}`);
      if (rows.length > 1) throw new ScopeError(`milestone name ${JSON.stringify(idOrName)} is ambiguous in project ${pk}; pass its id`);
      resolved = { id: rows[0].id, name: typeof rows[0].name === 'string' ? rows[0].name : idOrName };
    }
    milestones.set(idOrName, resolved);
    return resolved;
  }

  async function resolveScope(scope: WatchScope): Promise<string[]> {
    switch (scope.kind) {
      case 'keys': {
        const pk = await projectKey();
        const numbers: number[] = [];
        for (const k of scope.keys) {
          const parsed = parseTicketKey(k);
          if (!parsed) throw new ScopeError(`not a ticket key: ${JSON.stringify(k)}`);
          if (parsed.prefix !== null && parsed.prefix.toUpperCase() !== pk.toUpperCase()) {
            throw new ScopeError(`ticket ${k} is not in project ${pk}`);
          }
          numbers.push(parsed.number);
        }
        const { data, error } = await client
          .from('tasks')
          .select('id, task_number')
          .eq('project_id', projectId)
          .in('task_number', [...new Set(numbers)]);
        throwIf(error);
        return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      }
      case 'milestone': {
        const mid = (await resolveMilestone(scope.id)).id;
        const { data, error } = await client
          .from('tasks')
          .select('id')
          .eq('project_id', projectId)
          .eq('milestone_id', mid)
          .eq('archived', false);
        throwIf(error);
        return ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
      }
      case 'conductions': {
        const { data, error } = await client
          .from('conductions')
          .select('task_id')
          .in('status', [...CONDUCTION_LIVE_STATUSES]);
        throwIf(error);
        return [...new Set(((data as Array<{ task_id: string }> | null) ?? []).map((r) => r.task_id))];
      }
      default:
        throw new ScopeError('unknown scope');
    }
  }

  async function readConductions(ids: string[]): Promise<{ rows: Array<Record<string, unknown>>; legEndKnown: boolean }> {
    if (legEndColumn) {
      const { data, error } = await client
        .from('conductions')
        .select(COND_COLS)
        .in('task_id', ids)
        .order('created_at', { ascending: false });
      if (!error) return { rows: (data as unknown as Array<Record<string, unknown>>) ?? [], legEndKnown: true };
      if (!isMissingLastLegEndedAtColumn(error as { code?: string; message?: string })) throw error;
      legEndColumn = false;
    }
    const { data, error } = await client
      .from('conductions')
      .select(COND_COLS_BASE)
      .in('task_id', ids)
      .order('created_at', { ascending: false });
    throwIf(error);
    return { rows: (data as unknown as Array<Record<string, unknown>>) ?? [], legEndKnown: false };
  }

  async function readSnapshot(taskIds: string[]): Promise<BoardSnapshot> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) return { tickets: [], legEndKnown: legEndColumn };
    const pk = await projectKey();
    const { data, error } = await client.from('tasks').select(TASK_COLS).in('id', ids).eq('project_id', projectId);
    throwIf(error);
    const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
    const cond = await readConductions(ids);

    const latest = new Map<string, ConductionSlice>();
    for (const r of cond.rows) {
      const tid = String(r.task_id);
      if (latest.has(tid)) continue; // ordered newest first
      const slice: ConductionSlice = {
        id: String(r.id),
        status: String(r.status),
        leg_started_at: (r.leg_started_at as string | null) ?? null,
        last_worker_exit_class: (r.last_worker_exit_class as string | null) ?? null,
      };
      if (cond.legEndKnown) slice.last_leg_ended_at = (r.last_leg_ended_at as string | null) ?? null;
      latest.set(tid, slice);
    }

    const tickets: TicketSnapshot[] = rows.map((r) => {
      const fv = (r.field_values as Record<string, unknown> | null) ?? null;
      return {
        id: String(r.id),
        key: `${pk}-${r.task_number}`,
        task_number: Number(r.task_number),
        title: String(r.title ?? ''),
        workflow_state: (r.workflow_state as string | null) ?? null,
        awaiting_human_input: r.awaiting_human_input === true,
        awaiting_human_reason: (r.awaiting_human_reason as string | null) ?? null,
        awaiting_human_ref: r.awaiting_human_ref ?? null,
        updated_at: String(r.updated_at),
        archived: r.archived === true,
        milestone_id: (r.milestone_id as string | null) ?? null,
        waiting_on: fv?.waiting_on ?? null,
        conduction: latest.get(String(r.id)) ?? null,
        meta: metaCache.get(String(r.id)) ?? null,
      };
    });

    const needMeta = tickets.filter((t) => t.awaiting_human_input || seenUpdatedAt.get(t.id) !== t.updated_at);
    await Promise.all(
      needMeta.map(async (t) => {
        try {
          const m = (await getTaskMeta(t.id)) as Record<string, unknown> | null;
          const meta: TicketMeta = {
            active_brief_iteration: typeof m?.active_brief_iteration === 'number' ? m.active_brief_iteration : null,
            active_exchange: (m?.active_exchange as TicketMeta['active_exchange']) ?? null,
          };
          metaCache.set(t.id, meta);
          seenUpdatedAt.set(t.id, t.updated_at);
          t.meta = meta;
        } catch {
          // A failed meta read keeps the previous meta; the next poll retries (updated_at not marked seen).
        }
      }),
    );
    return { tickets, legEndKnown: cond.legEndKnown };
  }

  async function listMarkerComments(taskIds: string[]): Promise<MarkerComment[]> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) return [];
    const { data, error } = await client
      .from('task_comments')
      .select('task_id, content, created_at')
      .in('task_id', ids)
      .ilike('content', '%SEAT-%')
      .order('created_at', { ascending: true });
    throwIf(error);
    return ((data as MarkerComment[] | null) ?? []).map((c) => ({
      task_id: String(c.task_id),
      content: String(c.content ?? ''),
      created_at: String(c.created_at),
    }));
  }

  return { projectKey, projectInfo, resolveMilestone, resolveScope, readSnapshot, listMarkerComments };
}
