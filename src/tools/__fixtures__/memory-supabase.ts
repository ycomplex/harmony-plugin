/**
 * B-1452 test fixture: a tiny in-memory stand-in for the supabase-js query builder, enough for the
 * elicitation / incident / comment handlers (select, insert, update, eq, order, limit, single,
 * maybeSingle, and a bare `await` on an update). Every write is logged, so a test can assert that a
 * value never reached ANY table.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;

export interface WriteLog {
  table: string;
  op: 'insert' | 'update';
  payload: Row;
}

export interface MemoryDb {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  writes: WriteLog[];
  /** Tables whose reads fail with this message. */
  failReads: Map<string, string>;
}

const DEFAULTS: Record<string, Row> = {
  elicitation_exchanges: {
    status: 'active',
    rounds: [],
    answers_submitted_at: null,
    force_quit_requested_at: null,
    brief_id: null,
    gate: null,
  },
};

export function memorySupabase(seed: Record<string, Row[]> = {}): MemoryDb {
  const tables: Record<string, Row[]> = {};
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => structuredClone(r));
  const writes: WriteLog[] = [];
  const failReads = new Map<string, string>();
  let nextId = 1;

  const from = (table: string) => {
    tables[table] ??= [];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row = {};
    const filters: Array<[string, unknown]> = [];
    let orderBy: [string, boolean] | null = null;
    let limit: number | null = null;

    const matching = (): Row[] => {
      let rows = tables[table].filter((r) => filters.every(([c, v]) => r[c] === v));
      if (orderBy) {
        const [c, asc] = orderBy;
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return rows;
    };

    const run = (): { data: unknown; error: unknown } => {
      if (op === 'insert') {
        const row: Row = {
          ...(DEFAULTS[table] ?? {}),
          id: `${table}-${nextId++}`,
          created_at: new Date(Date.UTC(2026, 10, 11, 0, 0, nextId)).toISOString(),
          ...structuredClone(payload),
        };
        tables[table].push(row);
        writes.push({ table, op, payload: structuredClone(payload) });
        return { data: [structuredClone(row)], error: null };
      }
      if (op === 'update') {
        const rows = matching();
        for (const r of rows) Object.assign(r, structuredClone(payload));
        writes.push({ table, op, payload: structuredClone(payload) });
        return { data: rows.map((r) => structuredClone(r)), error: null };
      }
      const fail = failReads.get(table);
      if (fail) return { data: null, error: { message: fail } };
      return { data: matching().map((r) => structuredClone(r)), error: null };
    };

    const first = (required: boolean) => {
      const res = run();
      if (res.error) return { data: null, error: res.error };
      const rows = res.data as Row[];
      if (required && rows.length !== 1) return { data: null, error: { message: `expected one row in ${table}, got ${rows.length}` } };
      return { data: rows[0] ?? null, error: null };
    };

    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: Row) => {
        op = 'insert';
        payload = p;
        return b;
      },
      update: (p: Row) => {
        op = 'update';
        payload = p;
        return b;
      },
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return b;
      },
      order: (c: string, o?: { ascending?: boolean }) => {
        orderBy = [c, o?.ascending !== false];
        return b;
      },
      limit: (n: number) => {
        limit = n;
        return b;
      },
      single: async () => first(true),
      maybeSingle: async () => first(false),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve().then(run).then(res, rej),
    };
    return b;
  };

  return { client: { from } as unknown as SupabaseClient, tables, writes, failReads };
}
