// B-870 AC7: the interactive stop gate and the daemon's exit classifier decide "clean" from ONE
// list. This file is the no-drift proof — a table of representative row shapes run through BOTH
// paths, asserting they never disagree. It fails the moment either side grows a shape the other
// does not have.
//
// The two paths, kept honestly distinct:
//   * the STOP GATE path — `decideStop`, i.e. exactly what the Stop hook runs;
//   * the DAEMON path — `classifyWorkerExit` with every non-row axis pinned neutral (clean exit
//     code, nothing progressed, no timeout, no reap), so the ONLY thing that can save the row from
//     a park is one of the classifier's own clean branches 1-3. `action !== 'park'` is therefore
//     precisely "the daemon called this row shape clean".

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyWorkerExit, isCleanRowShape, type ClassifyArgs } from '../daemon/classify.js';
import { decideStop, STOP_GATE_ESCAPE_ENV, type StopGateRow } from './stop-gate.js';

const ROOT = process.cwd();

interface Shape {
  label: string;
  row: { workflow_state?: string | null; awaiting_human_input?: boolean | null };
  children: number;
  stale?: boolean;
}

// Representative shapes: every clean branch, every near-miss of every clean branch, and the
// ordinary mid-flight rows the gate exists to catch.
const SHAPES: Shape[] = [
  { label: 'awaiting a human (brief filed) at Built', row: { workflow_state: 'Built', awaiting_human_input: true }, children: 0 },
  { label: 'awaiting a human at Clarified', row: { workflow_state: 'Clarified', awaiting_human_input: true }, children: 0 },
  { label: 'awaiting a human with no state at all', row: { workflow_state: null, awaiting_human_input: true }, children: 0 },
  { label: 'awaiting a human on a STALE ticket (branch 1 precedes branch 4)', row: { workflow_state: 'Built', awaiting_human_input: true }, children: 0, stale: true },
  { label: 'Verified', row: { workflow_state: 'Verified', awaiting_human_input: false }, children: 0 },
  { label: 'Cancelled', row: { workflow_state: 'Cancelled', awaiting_human_input: false }, children: 0 },
  { label: 'Parked', row: { workflow_state: 'Parked', awaiting_human_input: false }, children: 0 },
  { label: 'Unverified (a terminal-LOOKING impostor)', row: { workflow_state: 'Unverified', awaiting_human_input: false }, children: 0 },
  { label: 'Parked lot (substring impostor)', row: { workflow_state: 'Parked lot', awaiting_human_input: false }, children: 0 },
  { label: 'revising-Cancelled (back-edge, not terminal)', row: { workflow_state: 'revising-Cancelled', awaiting_human_input: false }, children: 0 },
  { label: 'Decomposed with 3 live children (split umbrella)', row: { workflow_state: 'Decomposed', awaiting_human_input: false }, children: 3 },
  { label: 'Decomposed with 1 live child', row: { workflow_state: 'Decomposed', awaiting_human_input: false }, children: 1 },
  { label: 'Decomposed with ZERO live children', row: { workflow_state: 'Decomposed', awaiting_human_input: false }, children: 0 },
  { label: 'Decomposed, children, but awaiting the human (branch 1 wins)', row: { workflow_state: 'Decomposed', awaiting_human_input: true }, children: 4 },
  { label: 'Decomposed, children, flag MISSING (neither branch 1 nor branch 3)', row: { workflow_state: 'Decomposed' }, children: 4 },
  { label: 'Built, flag down — the ordinary mid-flight row the gate exists to catch', row: { workflow_state: 'Built', awaiting_human_input: false }, children: 0 },
  { label: 'Planned, flag down', row: { workflow_state: 'Planned', awaiting_human_input: false }, children: 0 },
  { label: 'Deployed, flag down', row: { workflow_state: 'Deployed', awaiting_human_input: false }, children: 0 },
  { label: 'Backlog, flag null', row: { workflow_state: 'Backlog', awaiting_human_input: null }, children: 0 },
  { label: 'no state, flag down', row: { workflow_state: null, awaiting_human_input: false }, children: 0 },
  { label: 'stale mid-flight row', row: { workflow_state: 'Built', awaiting_human_input: false }, children: 0, stale: true },
];

/** What the STOP GATE decides — the hook's real entry point, on a fresh turn-end. */
function gateSaysClean(shape: Shape): boolean {
  const row: StopGateRow = { ...shape.row, non_archived_child_count: shape.children };
  return decideStop({ ticket: 'B-870', row, blocksSoFar: 0, stopHookActive: false }).action === 'allow';
}

/** What the DAEMON decides, with every non-row axis pinned neutral (see the header). */
function daemonSaysClean(shape: Shape): boolean {
  const args: ClassifyArgs = {
    row: { ...shape.row, stale: shape.stale ?? false },
    nonArchivedChildCount: shape.children,
    exitCode: 0,
    progressed: false,
    timedOut: false,
    operatorReaped: false,
    repoProgressed: false,
  };
  return classifyWorkerExit(args).action !== 'park';
}

describe('AC7 no-drift: the stop gate and the daemon exit classifier never disagree about a row shape', () => {
  it.each(SHAPES.map((s) => [s.label, s] as const))('%s', (_label, shape) => {
    const gate = gateSaysClean(shape);
    const daemon = daemonSaysClean(shape);
    const shared = isCleanRowShape(shape.row, shape.children);
    expect(gate, `stop gate disagreed with the daemon on: ${shape.label}`).toBe(daemon);
    expect(shared, `the shared predicate disagreed with the daemon on: ${shape.label}`).toBe(daemon);
  });

  it('the table actually exercises BOTH answers (a table that is all-clean or all-dirty proves nothing)', () => {
    const clean = SHAPES.filter(gateSaysClean).length;
    expect(clean).toBeGreaterThan(0);
    expect(clean).toBeLessThan(SHAPES.length);
  });

  it('the table covers all three clean kinds', () => {
    expect(SHAPES.some((s) => s.row.awaiting_human_input === true && gateSaysClean(s))).toBe(true);
    expect(SHAPES.some((s) => s.row.workflow_state === 'Verified' && gateSaysClean(s))).toBe(true);
    expect(
      SHAPES.some((s) => s.row.workflow_state === 'Decomposed' && s.children > 0 && gateSaysClean(s)),
    ).toBe(true);
  });

  it('the gate IMPORTS the daemon predicate rather than restating it — the structural half of no-drift', () => {
    const src = readFileSync(join(ROOT, 'src/hooks/stop-gate.ts'), 'utf8');
    expect(src).toMatch(/import \{[^}]*isCleanRowShape[^}]*\} from '\.\.\/daemon\/classify\.js'/);
    // No hand-rolled terminal list / decomposed test may live in the hook.
    expect(src).not.toMatch(/'Verified'/);
    expect(src).not.toMatch(/'Decomposed'/);
  });

  it("the CLI read the hook calls computes `clean` with the SAME shared predicate", () => {
    const src = readFileSync(join(ROOT, 'src/cli/commands/tasks.ts'), 'utf8');
    expect(src).toContain('clean-check');
    expect(src).toMatch(/classifyCleanRowShape/);
    expect(src).toMatch(/from '\.\.\/\.\.\/daemon\/classify\.js'/);
  });
});

describe('the Stop hook is wired up and degrades safely (B-870)', () => {
  const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks/hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  };
  const wrapper = readFileSync(join(ROOT, 'hooks/stop-gate.sh'), 'utf8');

  it('hooks.json registers a Stop hook alongside the existing SessionStart entry', () => {
    expect(hooksJson.hooks.SessionStart?.length).toBeGreaterThanOrEqual(1);
    const stop = hooksJson.hooks.Stop;
    expect(stop?.length).toBe(1);
    const cmd = stop[0].hooks[0];
    expect(cmd.type).toBe('command');
    expect(cmd.command).toContain('hooks/stop-gate.sh');
    expect(cmd.command).toContain('${CLAUDE_PLUGIN_ROOT}');
    // Bounded: a hook without a timeout can hang a turn-end.
    expect(cmd.timeout).toBeGreaterThan(0);
  });

  it('AC9 fast path: the wrapper `test -f`s the breadcrumb BEFORE it ever mentions node', () => {
    const breadcrumbTest = wrapper.indexOf('[ -f "$BREADCRUMB" ] || exit 0');
    const firstNode = wrapper.indexOf('node "$GATE"');
    expect(breadcrumbTest).toBeGreaterThan(-1);
    expect(firstNode).toBeGreaterThan(-1);
    expect(breadcrumbTest).toBeLessThan(firstNode);
  });

  it('the breadcrumb is the conduct-session file, NEVER .harmony-task.json (which start-work writes at the build gate only)', () => {
    expect(wrapper).toContain('conduct-sessions');
    expect(wrapper).not.toContain('.harmony-task.json');
  });

  it('AC3: the escape switch is a human-set env var, logged when it is used', () => {
    expect(wrapper).toContain(STOP_GATE_ESCAPE_ENV);
    expect(wrapper).toMatch(new RegExp(`${STOP_GATE_ESCAPE_ENV}[\\s\\S]{0,400}>&2`));
  });

  it('the escape switch is ABSENT from every shipped daemon/container profile — a worker can never start with the gate off', () => {
    for (const rel of [
      'container/daemon-profile.example.json',
      'container/daemon-profile.cloud.example.json',
      'container/env.example',
      'container/provision.sh',
      'container/entrypoint.sh',
      'container/cloud-worker-launch.sh',
    ]) {
      const body = readFileSync(join(ROOT, rel), 'utf8');
      expect(body, `${rel} must not set ${STOP_GATE_ESCAPE_ENV}`).not.toContain(STOP_GATE_ESCAPE_ENV);
    }
  });
});
