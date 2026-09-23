// B-1062 step 4 — the drain contract test: proves `runRecordedWalkDrainPass` launches NO container leg
// and writes NO `conduction_leg_costs` row when it processes a request. Two independent proofs, per the
// ticket:
//   (a) STATIC — the module's own source can never import the leg-launching/leg-cost modules at all
//       (a structural guarantee stronger than "didn't happen to call it this run").
//   (b) RUNTIME — a spied fake Supabase client proves the drain's `client.from(...)` calls, across a
//       full successful processing pass, never once name `conduction_leg_costs` (the table
//       `leg-cost-record.ts`'s `recordLegCost` writes — see that file for the exact call site) or
//       `recorded_walk_requests` are the ONLY two tables touched.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runRecordedWalk: vi.fn(),
}));
vi.mock('../tools/record-walk.js', () => ({ runRecordedWalk: mocks.runRecordedWalk }));

import { runRecordedWalkDrainPass, RECORDED_WALK_REQUESTS_TABLE } from './recorded-walk-drain.js';

const SOURCE_PATH = fileURLToPath(new URL('./recorded-walk-drain.ts', import.meta.url));

describe('recorded-walk-drain.ts — the leg-cost/container-launch structural fence (B-1062 step 4)', () => {
  it('imports NEITHER the leg-cost-record module NOR the claude-result-parse module NOR any container-launch entry point', () => {
    // Scoped to actual `import` STATEMENTS only — the file's own doc comments name leg-cost-record.ts
    // in prose (explaining exactly what this fence excludes), which would otherwise false-trip a
    // whole-source regex. The import-statement scoping is the same discipline the workspace CLAUDE.md's
    // "CI-log greps must strip ANSI first" note is an instance of: match what actually executes, not
    // prose that happens to contain the same substring.
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import ')).join('\n');
    expect(importLines).not.toMatch(/leg-cost-record/);
    expect(importLines).not.toMatch(/claude-result-parse/);
    expect(importLines).not.toMatch(/recordLegCost/);
    expect(importLines).not.toMatch(/runCommand/); // the scheduler's launch-a-process dependency
    expect(importLines).not.toMatch(/cloud-worker-launch/);
    expect(importLines).not.toMatch(/container\/provision/);
  });

  // The drain calls the gate-walk core DIRECTLY, in-process — it never imports anything that could
  // spawn `claude -p` or a container launch. The one thing it DOES import besides the core is the
  // Supabase client type (a type-only import, erased at build time).
  it('imports only the gate-walk core and Supabase\'s SupabaseClient type', () => {
    const source = readFileSync(SOURCE_PATH, 'utf8');
    const importLines = source.split('\n').filter((l) => l.trim().startsWith('import '));
    expect(importLines).toEqual([
      "import type { SupabaseClient } from '@supabase/supabase-js';",
      "import { runRecordedWalk, type RecordWalkArgs, type RecordWalkResult } from '../tools/record-walk.js';",
    ]);
  });
});

describe('recorded-walk-drain.ts — runtime proof: zero conduction_leg_costs writes, zero extra tables', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a full successful processing pass touches ONLY the recorded_walk_requests table', async () => {
    mocks.runRecordedWalk.mockResolvedValue({
      task_id: 'resolved-B-2000', eligibility: { items: [], eligible: true }, refused: false,
      gates: [{ gate: 'clarify', landed: true }], attestation_recorded: false,
    });

    const tablesTouched: string[] = [];
    const pendingRow = {
      id: 'req-1', task_id: 'B-2000', summary: 'Fix the thing.', evidence_links: [], attest_walk: null,
      requested_by: 'human-1', requested_at: '2026-09-20T00:00:00Z', status: 'pending', processed_at: null, error: null,
    };
    const from = vi.fn((table: string) => {
      tablesTouched.push(table);
      const chain: any = { _eqCalls: [] };
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.order = vi.fn(() => chain);
      chain.limit = vi.fn(async () => ({ data: [pendingRow], error: null }));
      chain.update = vi.fn((payload: any) => {
        const isClaim = payload.status === 'processing';
        const result: any = {};
        result.eq = vi.fn(() => result);
        result.select = vi.fn(() => result);
        result.maybeSingle = vi.fn(async () => (isClaim ? { data: { id: 'req-1' }, error: null } : { data: null, error: null }));
        result.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
        return result;
      });
      return chain;
    });
    const client = { from } as any;

    // The gate-walk core is MOCKED here specifically so this test isolates the DRAIN's own table
    // usage from whatever `runRecordedWalk` itself would touch (that surface is covered by
    // record-walk.test.ts and gate-slots.ratified-by.test.ts separately) — this test's job is only
    // to prove the drain layer adds no leg-cost write of its own.
    const processed = await runRecordedWalkDrainPass({ client, projectId: 'proj-1', userId: 'user-1', log: () => {} });

    expect(processed).toBe(1);
    expect(new Set(tablesTouched)).toEqual(new Set([RECORDED_WALK_REQUESTS_TABLE]));
    expect(tablesTouched).not.toContain('conduction_leg_costs');
    expect(mocks.runRecordedWalk).toHaveBeenCalledTimes(1);
  });
});
