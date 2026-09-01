// B-870: the stop gate's own behaviour — the block, the cap, the escape switch, and the four
// fail-open paths. The "clean" definition itself is NOT tested here (it is the daemon's, and
// stop-gate.contract.test.ts is what proves the two never disagree).

import { describe, it, expect } from 'vitest';
import {
  decideStop,
  runStopGate,
  MAX_BLOCKS_PER_TURN_END,
  STOP_GATE_ESCAPE_ENV,
  type StopGateDeps,
  type StopGateRow,
} from './stop-gate.js';

const DIRTY_ROW: StopGateRow = { workflow_state: 'Built', awaiting_human_input: false };
const CLEAN_ROW: StopGateRow = { workflow_state: 'Built', awaiting_human_input: true };

function stdin(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'sess-1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'all done!',
    ...over,
  });
}

interface Harness {
  deps: StopGateDeps;
  logs: string[];
  counters: Record<string, number>;
}

function harness(over: Partial<StopGateDeps> = {}, counters: Record<string, number> = {}): Harness {
  const logs: string[] = [];
  const store = { ...counters };
  const deps: StopGateDeps = {
    input: stdin(),
    breadcrumbPath: '/home/u/.harmony/conduct-sessions/sess-1.json',
    env: {},
    readFile: () => JSON.stringify({ session_id: 'sess-1', task_id: 'uuid-1', ticket: 'B-870' }),
    readBlockCount: (id) => store[id] ?? 0,
    writeBlockCount: (id, n) => {
      store[id] = n;
    },
    queryRow: () => DIRTY_ROW,
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, logs, counters: store };
}

describe('decideStop — the pure decision', () => {
  it('AC1: a ticket-driving session with nothing on the board is BLOCKED, and told the remedies', () => {
    const d = decideStop({ ticket: 'B-870', row: DIRTY_ROW, blocksSoFar: 0, stopHookActive: false });
    expect(d.action).toBe('block');
    const msg = d.action === 'block' ? d.message : '';
    // The three sanctioned alternatives are NAMED, not implied.
    expect(msg).toMatch(/compose_brief/i);
    expect(msg).toMatch(/file_elicitation_round/i);
    expect(msg).toMatch(/defer|park/i);
    // And the "decide it yourself and comment" escape (AC5) is offered, so a tiny question has a home.
    expect(msg.toLowerCase()).toContain('comment');
    // The row it judged is named, so the model can act without re-reading the board.
    expect(msg).toContain('workflow_state=Built');
  });

  it.each([
    ['awaiting a human on a brief/round', { workflow_state: 'Built', awaiting_human_input: true }, 0],
    ['finished (Verified)', { workflow_state: 'Verified', awaiting_human_input: false }, 0],
    ['parked', { workflow_state: 'Parked', awaiting_human_input: false }, 0],
    ['split into children', { workflow_state: 'Decomposed', awaiting_human_input: false }, 2],
  ])('AC2: %s ends the turn uninterrupted', (_label, row, children) => {
    const d = decideStop({
      ticket: 'B-870',
      row: { ...row, non_archived_child_count: children },
      blocksSoFar: 0,
      stopHookActive: false,
    });
    expect(d.action).toBe('allow');
  });

  it('AC6: the cap — two blocks, then the third attempt is allowed through with a loud line', () => {
    const seen: string[] = [];
    let blocks = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const d = decideStop({
        ticket: 'B-870',
        row: DIRTY_ROW,
        blocksSoFar: blocks,
        // The runtime sets this on every stop that FOLLOWS a block.
        stopHookActive: blocks > 0,
      });
      seen.push(d.action);
      if (d.action === 'block') blocks++;
      if (d.action === 'fail-open') {
        expect(d.message).toContain('DEGRADED');
        // It names the row state it could not classify.
        expect(d.message).toContain('workflow_state=Built');
        expect(d.message).toContain('B-870');
      }
    }
    expect(seen).toEqual(['block', 'block', 'fail-open']);
    expect(blocks).toBe(MAX_BLOCKS_PER_TURN_END);
  });

  it('a FRESH turn-end (stop_hook_active false) resets the count — the cap is per turn-end, not per session', () => {
    const d = decideStop({
      ticket: 'B-870',
      row: DIRTY_ROW,
      blocksSoFar: 99,
      stopHookActive: false,
    });
    expect(d.action).toBe('block');
  });

  it('an unreadable counter still cannot wedge: with the re-entry flag set and no count, the gate blocks at most once more', () => {
    // blocksSoFar=0 is exactly what the runner substitutes when the counter file cannot be read.
    const first = decideStop({ ticket: 'B-870', row: DIRTY_ROW, blocksSoFar: 0, stopHookActive: true });
    expect(first.action).toBe('block');
    const capped = decideStop({
      ticket: 'B-870',
      row: DIRTY_ROW,
      blocksSoFar: MAX_BLOCKS_PER_TURN_END,
      stopHookActive: true,
    });
    expect(capped.action).toBe('fail-open');
  });
});

describe('runStopGate — the exit code and the fail-open floor', () => {
  it('blocks with exit 2 and writes the reason to the log', () => {
    const h = harness();
    expect(runStopGate(h.deps)).toBe(2);
    expect(h.logs.join('\n')).toContain('[harmony stop-gate]');
    expect(h.counters['sess-1']).toBe(1);
  });

  it('allows with exit 0 on a clean row and clears the counter', () => {
    const h = harness({ queryRow: () => CLEAN_ROW }, { 'sess-1': 1 });
    expect(runStopGate(h.deps)).toBe(0);
    expect(h.counters['sess-1']).toBe(0);
  });

  it('AC3: the human-only escape switch allows the stop AND logs its use', () => {
    const h = harness({ env: { [STOP_GATE_ESCAPE_ENV]: '1' } });
    expect(runStopGate(h.deps)).toBe(0);
    expect(h.logs.join('\n')).toContain(STOP_GATE_ESCAPE_ENV);
    expect(h.logs.join('\n').toLowerCase()).toContain('disabled');
  });

  it('an EMPTY escape var is not "set" — an accidental blank export must not silently disarm the gate', () => {
    const h = harness({ env: { [STOP_GATE_ESCAPE_ENV]: '' } });
    expect(runStopGate(h.deps)).toBe(2);
  });

  it.each([
    ['malformed stdin JSON', { input: 'not json at all' } as Partial<StopGateDeps>],
    ['an unreadable breadcrumb', { readFile: () => { throw new Error('ENOENT'); } } as Partial<StopGateDeps>],
    ['a garbled breadcrumb', { readFile: () => '{{{' } as Partial<StopGateDeps>],
    ['a CLI failure', { queryRow: () => { throw new Error('harmony exited 1'); } } as Partial<StopGateDeps>],
    ['a CLI timeout', { queryRow: () => { throw new Error('ETIMEDOUT'); } } as Partial<StopGateDeps>],
    ['a network error', { queryRow: () => { throw new Error('getaddrinfo EAI_AGAIN'); } } as Partial<StopGateDeps>],
  ])('AC8: %s fails OPEN (exit 0), never blocks', (_label, over) => {
    const h = harness(over);
    expect(runStopGate(h.deps)).toBe(0);
  });

  it('a breadcrumb naming a DIFFERENT session is never gated on (a stale/mislabelled file cannot block us)', () => {
    const h = harness({
      readFile: () => JSON.stringify({ session_id: 'someone-else', task_id: 'uuid-9', ticket: 'B-1' }),
    });
    expect(runStopGate(h.deps)).toBe(0);
  });

  it('a breadcrumb naming no ticket gates nothing', () => {
    const h = harness({ readFile: () => JSON.stringify({ session_id: 'sess-1' }) });
    expect(runStopGate(h.deps)).toBe(0);
  });

  it('a payload with no session_id gates nothing', () => {
    const h = harness({ input: JSON.stringify({ hook_event_name: 'Stop' }) });
    expect(runStopGate(h.deps)).toBe(0);
  });

  it('a counter that cannot be READ still blocks (the flag alone caps it) and a counter that cannot be WRITTEN never throws', () => {
    const h = harness({
      readBlockCount: () => { throw new Error('EACCES'); },
      writeBlockCount: () => { throw new Error('EROFS'); },
    });
    expect(runStopGate(h.deps)).toBe(2);
  });

  it('AC6 end-to-end through the runner: block, block, then through', () => {
    const store: Record<string, number> = {};
    const codes: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const logs: string[] = [];
      codes.push(
        runStopGate({
          ...harness().deps,
          input: stdin({ stop_hook_active: attempt > 1 }),
          readBlockCount: (id) => store[id] ?? 0,
          writeBlockCount: (id, n) => {
            store[id] = n;
          },
          log: (l) => logs.push(l),
        }),
      );
      if (attempt === 3) expect(logs.join('\n')).toContain('DEGRADED');
    }
    expect(codes).toEqual([2, 2, 0]);
  });
});
