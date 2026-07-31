// B-691 (founder amendment A4): the CONTRACT TEST binding the two watch surfaces.
//
// `src/conductor/poll-loop.ts` (detectChange, 7-way) and `src/daemon/watch.ts` (detectWake, 2-way)
// deliberately return different things, so no type checker can hold them together. This file is what
// does: ONE scenario table, exercised through BOTH, asserting they never disagree about who holds the
// ball.
//
// Why it exists: watch.ts documented itself as mirroring poll-loop.ts's gate-then-classify, and the
// B-691 defect grew underneath that comment — the daemon refreshed its baseline after a worker exit,
// the poll never refreshed at all. Prose parity is not parity. If a future change moves one surface's
// gate, this test fails rather than shipping a second silent divergence.

import { describe, it, expect } from 'vitest';
import { detectChange, captureBaseline as capturePollBaseline } from './poll-loop.js';
import { ballReturned, exchangeWentInactive, type Taskish } from './ball-axis.js';
import { detectWake, captureBaseline as captureWatchBaseline } from '../daemon/watch.js';

const ACTIVE = { exchange_id: 'ex-1', status: 'active', round: 1 } as const;
const ANSWERED = { ...ACTIVE, answers_submitted_at: '2026-07-31T09:50:18.398Z' } as const;

interface Scenario {
  name: string;
  previous: Taskish;
  current: Taskish;
  /** The one sanctioned divergence: the daemon wakes on an at-rest first pickup; the interactive
   *  poll does not treat it as a resolution (it is watching a pause, not launching a leg). */
  atRestFirstPickup?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'human resolved a brief — flag cleared, state advanced',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true },
    current: { workflow_state: 'Clarified', awaiting_human_input: false },
  },
  {
    name: 'human submitted elicitation answers — flag cleared, marker set (the B-685 case)',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: ACTIVE },
    current: { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: ANSWERED },
  },
  {
    name: 'browser reshape — flag cleared, pending_resolution set, state unchanged',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true },
    current: {
      workflow_state: 'Proposed',
      awaiting_human_input: false,
      pending_resolution: { command: 'iterate', detail: 'tighten it' },
    },
  },
  {
    name: 'non-advancing sub-track accept — flag cleared, nothing else moved',
    previous: { workflow_state: 'Decomposed', awaiting_human_input: true },
    current: { workflow_state: 'Decomposed', awaiting_human_input: false },
  },
  {
    name: 'human deferred — parked',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true },
    current: { workflow_state: 'Parked', awaiting_human_input: false },
  },
  {
    name: 'still awaiting the human — nothing has happened',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: ACTIVE },
    current: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: ACTIVE },
  },
  {
    name: 'mechanical discussion cancel — exchange went inactive with NO flag transition',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: ACTIVE },
    current: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: null },
  },
  {
    name: 'indeterminate read — same exchange, status field absent',
    previous: { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: ACTIVE },
    current: {
      workflow_state: 'Proposed',
      awaiting_human_input: true,
      active_exchange: { exchange_id: 'ex-1', round: 1 },
    },
  },
  {
    name: 'B-691 daemon first-sight: ball at rest with an already-answered exchange',
    previous: { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: ANSWERED },
    current: { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: ANSWERED },
    atRestFirstPickup: true,
  },
  {
    name: 'fresh conduction: ball at rest, nothing in flight',
    previous: { workflow_state: 'Proposed', awaiting_human_input: false },
    current: { workflow_state: 'Proposed', awaiting_human_input: false },
    atRestFirstPickup: true,
  },
];

describe('ball-axis contract — the two watch surfaces never disagree about who holds the ball', () => {
  it.each(SCENARIOS)('$name', (scenario) => {
    const { previous, current, atRestFirstPickup } = scenario;

    const pollFired = detectChange(capturePollBaseline(previous), current);
    const daemonWake = detectWake(captureWatchBaseline(previous), current);

    if (ballReturned(previous, current)) {
      // The canonical transition: BOTH surfaces must see it.
      expect(pollFired, 'poll must fire on the return transition').not.toBeNull();
      expect(daemonWake, 'daemon must wake on the return transition').toBe('agent-ball');
      return;
    }

    if (exchangeWentInactive(previous, current)) {
      // The B-461 edge, which fires OUTSIDE the flag transition on both surfaces.
      expect(pollFired?.trigger).toBe('discussion-cancelled');
      expect(daemonWake).toBe('discussion-cancelled');
      return;
    }

    if (atRestFirstPickup) {
      // The ONE sanctioned divergence, asserted so that changing it has to be deliberate: the daemon
      // launches a leg because the ball is the agent's, while the poll — which exists to watch a
      // pause — reports no resolution and later exits 'unwatchable'.
      expect(daemonWake, 'daemon wakes on an at-rest pickup').toBe('agent-ball');
      expect(pollFired, 'poll reports no resolution on an at-rest pickup').toBeNull();
      return;
    }

    // The human still holds the ball: neither surface may claim otherwise.
    expect(pollFired, 'poll must not fire while the human holds the ball').toBeNull();
    expect(daemonWake, 'daemon must not wake while the human holds the ball').toBeNull();
  });

  it('every scenario agrees with the shared predicate about who holds the ball', () => {
    for (const { previous, current } of SCENARIOS) {
      const daemonWake = detectWake(captureWatchBaseline(previous), current);
      // A wake of 'agent-ball' is only ever legitimate when the human does not hold the current ball.
      if (daemonWake === 'agent-ball') {
        expect(current.awaiting_human_input, JSON.stringify(current)).not.toBe(true);
      }
    }
  });
});
