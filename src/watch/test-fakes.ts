/**
 * Test fakes for `harmony watch` (B-1422): a fake clock, an in-memory board reader, and a minimal
 * supabase-js query-builder fake. No network, no real timers.
 */
import { ScopeError, type BoardReader, type BoardSnapshot, type ConductionSlice, type MarkerComment, type MilestoneInfo, type ProjectInfo, type TicketSnapshot } from './board-read.js';
import type { WatchScope } from './seat-files.js';

export const T0 = Date.parse('2026-11-07T10:00:00.000Z');

export class FakeClock {
  t: number;
  sleeps: number[] = [];
  private hooks: Array<(t: number) => void> = [];
  constructor(start: number = T0) {
    this.t = start;
  }
  now = (): number => this.t;
  iso = (offsetMs = 0): string => new Date(this.t + offsetMs).toISOString();
  /** Called after every sleep with the new time. */
  onTick(h: (t: number) => void): void {
    this.hooks.push(h);
  }
  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return;
    this.sleeps.push(ms);
    this.t += ms;
    for (const h of this.hooks) h(this.t);
    await Promise.resolve();
  };
}

export function conduction(over: Partial<ConductionSlice> = {}): ConductionSlice {
  return {
    id: 'cond-1',
    status: 'active',
    leg_started_at: null,
    last_leg_ended_at: null,
    last_worker_exit_class: null,
    ...over,
  };
}

let counter = 0;
export function ticket(n: number, over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  counter += 1;
  return {
    id: `task-${n}`,
    key: `B-${n}`,
    task_number: n,
    title: `Ticket ${n}`,
    workflow_state: 'In Progress',
    awaiting_human_input: false,
    awaiting_human_reason: null,
    awaiting_human_ref: null,
    updated_at: new Date(T0 - 60_000 - counter).toISOString(),
    archived: false,
    milestone_id: 'm1',
    waiting_on: null,
    conduction: null,
    meta: { active_brief_iteration: null, active_exchange: null },
    ...over,
  };
}

/** A pause filed by an ended leg (`plan-draft` on brief `br-<n>`, iteration 1 by default). */
export function paused(n: number, reason = 'plan-draft', over: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return ticket(n, {
    awaiting_human_input: true,
    awaiting_human_reason: reason,
    awaiting_human_ref: { type: 'brief', id: `br-${n}` },
    meta: { active_brief_iteration: 1, active_exchange: null },
    conduction: conduction({
      id: `cond-${n}`,
      leg_started_at: new Date(T0 - 600_000).toISOString(),
      last_leg_ended_at: new Date(T0 - 120_000).toISOString(),
      last_worker_exit_class: 'clean-pause',
    }),
    ...over,
  });
}

/** In-memory board implementing the reader interface. */
export class FakeBoard implements BoardReader {
  key = 'B';
  name = 'Backlogs';
  /**
   * Milestones of this project. `null` (the default) resolves any milestone id with no name, as
   * the older tests expect; a map refuses an id it does not hold, as the real reader does.
   */
  milestones: Map<string, MilestoneInfo> | null = null;
  tickets = new Map<string, TicketSnapshot>();
  legEndKnown = true;
  /** Errors thrown by the next `readSnapshot` calls, in order. */
  failures: unknown[] = [];
  comments: MarkerComment[] = [];
  reads = 0;
  constructor(private clock?: FakeClock) {}
  put(t: TicketSnapshot): TicketSnapshot {
    this.tickets.set(t.id, structuredClone(t));
    return t;
  }
  /** Change a ticket; bumps `updated_at` to the clock's now. */
  update(id: string, patch: Partial<TicketSnapshot>): void {
    const cur = this.tickets.get(id);
    if (!cur) throw new Error(`no ticket ${id}`);
    this.tickets.set(id, { ...cur, ...structuredClone(patch), updated_at: new Date(this.clock?.now() ?? Date.now()).toISOString() });
  }
  remove(id: string): void {
    this.tickets.delete(id);
  }
  async projectKey(): Promise<string> {
    return this.key;
  }
  async projectInfo(): Promise<ProjectInfo> {
    return { key: this.key, name: this.name };
  }
  async resolveMilestone(idOrName: string): Promise<MilestoneInfo> {
    if (this.milestones === null) return { id: idOrName, name: null };
    const hit = this.milestones.get(idOrName) ?? [...this.milestones.values()].find((m) => m.name === idOrName);
    if (!hit) throw new ScopeError(`milestone ${idOrName} is not in project ${this.key}`);
    return hit;
  }
  async resolveScope(scope: WatchScope): Promise<string[]> {
    const all = [...this.tickets.values()];
    if (scope.kind === 'milestone') {
      const m = await this.resolveMilestone(scope.id);
      return all.filter((t) => t.milestone_id === m.id && !t.archived).map((t) => t.id);
    }
    if (scope.kind === 'conductions') return all.filter((t) => t.conduction?.status === 'active').map((t) => t.id);
    const nums = new Set(scope.keys.map((k) => Number(String(k).replace(/^[A-Za-z]+-/, ''))));
    return all.filter((t) => nums.has(t.task_number)).map((t) => t.id);
  }
  async readSnapshot(ids: string[]): Promise<BoardSnapshot> {
    this.reads += 1;
    if (this.failures.length > 0) throw this.failures.shift();
    const tickets = ids.map((id) => this.tickets.get(id)).filter((t): t is TicketSnapshot => !!t).map((t) => structuredClone(t));
    if (!this.legEndKnown) for (const t of tickets) if (t.conduction) delete t.conduction.last_leg_ended_at;
    return { tickets, legEndKnown: this.legEndKnown };
  }
  async listMarkerComments(ids: string[]): Promise<MarkerComment[]> {
    return this.comments.filter((c) => ids.includes(c.task_id));
  }
}

// ---------------------------------------------------------------------------
// supabase-js fake
// ---------------------------------------------------------------------------

export interface FakeQuery {
  table: string;
  select: string | null;
  filters: Array<[string, string, unknown]>;
  orders: Array<[string, unknown]>;
  single: boolean;
}

export type FakeResult = { data: unknown; error: unknown };

/** A query-builder fake: every awaited query is answered by `handler`. */
export function fakeSupabase(handler: (q: FakeQuery) => FakeResult) {
  const calls: FakeQuery[] = [];
  const client = {
    from(table: string) {
      const q: FakeQuery = { table, select: null, filters: [], orders: [], single: false };
      const b: Record<string, unknown> = {
        select(cols: string) {
          q.select = cols;
          return b;
        },
        eq(c: string, v: unknown) {
          q.filters.push(['eq', c, v]);
          return b;
        },
        in(c: string, v: unknown) {
          q.filters.push(['in', c, v]);
          return b;
        },
        ilike(c: string, v: unknown) {
          q.filters.push(['ilike', c, v]);
          return b;
        },
        order(c: string, o: unknown) {
          q.orders.push([c, o]);
          return b;
        },
        single() {
          q.single = true;
          return b;
        },
        then(res: (v: FakeResult) => unknown, rej: (e: unknown) => unknown) {
          calls.push(q);
          return Promise.resolve()
            .then(() => handler(q))
            .then(res, rej);
        },
      };
      return b;
    },
  };
  return { client, calls };
}
