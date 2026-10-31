// B-1157 (seat finding, live on B-1185): the declared-wait marker must survive the REAL read seam.
//
// The daemon (src/bin/daemon.ts getTaskMeta) and `tasks clean-check` both read tasks through
// getTask(view:'meta'), a pinned loop-control projection that OMITS `field_values`. #364's tests passed
// because their harnesses hand-build the task row with `field_values` already on it — so the hold gate,
// the settle classification and the stop gate were all inert in production. These tests start from a
// full `tasks` row (carrying gate_slots AND waiting_on, as the board stores it), run it through the REAL
// getTask meta projection, and feed that real output to every consumer.

import { describe, it, expect, vi } from 'vitest';
import { getTask } from '../tools/tasks.js';
import { buildCleanCheckRow } from '../cli/commands/tasks.js';
import { decideStop } from '../hooks/stop-gate.js';
import { waitHoldActive, type DaemonTask } from './scheduler.js';
import { captureBaseline } from './watch.js';
import { liveWaitingOn, waitingOnFieldValues } from './waiting-on.js';

vi.mock('../tools/resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
  resolveTaskIds: vi.fn(),
}));
vi.mock('../tools/members.js', () => ({ resolveAssignee: vi.fn().mockResolvedValue('assignee-uuid') }));

const MIN = 60_000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A marker a leg wrote ~1 minute ago, with a 10 minute recheck. */
const marker = {
  kind: 'ci',
  ref: 'pr#42',
  since: iso(NOW - MIN),
  first_since: iso(NOW - MIN),
  resume_after: iso(NOW + 10 * MIN),
};

/** The board's stored `tasks` row: a big gate_slots blob next to the marker, like a real Built ticket. */
function storedRow(fieldValues: Record<string, unknown>) {
  return {
    id: 'resolved-uuid',
    task_number: 1157,
    title: 'T',
    description: 'd',
    workflow_state: 'Built',
    workflow_activity: null,
    awaiting_human_input: false,
    awaiting_human_reason: null,
    awaiting_human_ref: null,
    pending_acceptance_event_id: null,
    stale: false,
    stale_ref: null,
    parent_task_id: null,
    archived: false,
    subsumed_by_task_id: null,
    conductor_excluded_at: null,
    field_values: fieldValues,
    updated_at: iso(NOW),
    content_updated_at: iso(NOW),
    last_activity_at: iso(NOW),
    task_labels: [],
    checklist_items: [],
  };
}

function clientFor(row: unknown): any {
  return {
    from: vi.fn((table: string) => {
      if (table === 'tasks') {
        return { select: () => ({ eq: () => ({ eq: () => ({ single: vi.fn().mockResolvedValue({ data: row, error: null }) }) }) }) };
      }
      if (table === 'briefs') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }) }) }) };
      }
      return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }), eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) }) };
    }),
  };
}

async function metaOf(fieldValues: Record<string, unknown>) {
  return (await getTask(clientFor(storedRow(fieldValues)), 'proj-1', { task_id: 'B-1157', view: 'meta' })) as any;
}

const GATE_SLOTS = { gate_slots: { clarify: { content: { solving: 'x'.repeat(2000) } } }, build_pr: { pr_number: 364 } };

describe("B-1157: the declared wait survives the REAL getTask(view:'meta') seam", () => {
  it('meta carries the marker as its own key; field_values is branch-only (B-1058) — gate records stay excluded', async () => {
    const meta = await metaOf({ ...GATE_SLOTS, waiting_on: marker });
    expect(meta.waiting_on).toEqual(marker);
    // B-1058: the lean projection stays lean — only the two probe branch refs ride field_values;
    // gate_slots and non-branch build_pr keys never do, and the wait keeps its own key.
    expect(meta.field_values).toEqual({ build_pr: { branch: null }, work_branch: { branch: null } });
  });

  it('meta waiting_on is null when no marker was declared (or it was cleared)', async () => {
    expect((await metaOf({ ...GATE_SLOTS })).waiting_on).toBeNull();
    expect((await metaOf({ ...GATE_SLOTS, waiting_on: null })).waiting_on).toBeNull();
  });

  it('daemon seam: the settle liveness check sees the marker on the real meta row', async () => {
    const meta = await metaOf({ ...GATE_SLOTS, waiting_on: marker });
    const live = liveWaitingOn(waitingOnFieldValues(meta), { firedAtMs: NOW - 5 * MIN, nowMs: NOW });
    expect(live?.ref).toBe('pr#42');
    // A leg that fired AFTER the declaration must not be held by it.
    expect(liveWaitingOn(waitingOnFieldValues(meta), { firedAtMs: NOW, nowMs: NOW })).toBeNull();
  });

  it('daemon seam: the hold gate holds on the real meta row, and releases at the resume time', async () => {
    const meta = (await metaOf({ ...GATE_SLOTS, waiting_on: marker })) as DaemonTask;
    const baseline = captureBaseline(meta);
    expect(waitHoldActive(baseline, meta, NOW)?.ref).toBe('pr#42');
    expect(waitHoldActive(baseline, meta, NOW + 11 * MIN)).toBeNull(); // resume_after reached
  });

  it('daemon seam: with NO marker the hold gate does not hold (behaviour unchanged)', async () => {
    const meta = (await metaOf({ ...GATE_SLOTS })) as DaemonTask;
    expect(waitHoldActive(captureBaseline(meta), meta, NOW)).toBeNull();
  });

  it('clean-check seam: the real CLI row carries the marker and the stop gate sanctions the turn-end', async () => {
    const meta = await metaOf({ ...GATE_SLOTS, waiting_on: marker });
    // The hook consumes `harmony --json tasks clean-check` — a JSON round trip of exactly this row.
    const row = JSON.parse(JSON.stringify(buildCleanCheckRow(meta, 0)));
    expect(row.waiting_on).toEqual(marker);
    expect(row.clean).toBe(false); // Built, flag down: not a clean ROW shape — only the declared wait saves it
    const decision = decideStop({
      ticket: 'B-1157',
      row,
      blocksSoFar: 0,
      stopHookActive: false,
      nowMs: NOW,
      legStartedAtMs: NOW - 5 * MIN,
    });
    expect(decision.action).toBe('allow');
    expect((decision as { reason: string }).reason).toContain('declared external wait');
  });

  it('clean-check seam: without a marker the same Built row is still blocked', async () => {
    const meta = await metaOf({ ...GATE_SLOTS });
    const row = JSON.parse(JSON.stringify(buildCleanCheckRow(meta, 0)));
    expect(row.waiting_on).toBeNull();
    const decision = decideStop({ ticket: 'B-1157', row, blocksSoFar: 0, stopHookActive: false, nowMs: NOW, legStartedAtMs: NOW - 5 * MIN });
    expect(decision.action).toBe('block');
  });

  it('a full-view row (field_values only, no waiting_on key) still works through the fallback', () => {
    const full = { field_values: { waiting_on: marker } };
    expect(liveWaitingOn(waitingOnFieldValues(full), { nowMs: NOW })?.ref).toBe('pr#42');
    expect(buildCleanCheckRow({ id: 'x', field_values: { waiting_on: marker } }, 0).waiting_on).toEqual(marker);
  });
});
