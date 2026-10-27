import { describe, it, expect } from 'vitest';
import {
  liveWaitingOn,
  parseWaitingOn,
  strandedWorkSignal,
  waitResumeAtMs,
  WAIT_CEILING_MS,
  WAIT_DEFAULT_RECHECK_MS,
} from './waiting-on.js';

const T0 = Date.parse('2026-10-21T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const marker = (over: Record<string, unknown> = {}) => ({
  waiting_on: { kind: 'ci', ref: 'pr#12', since: iso(T0), first_since: iso(T0), ...over },
});

describe('parseWaitingOn (B-1157)', () => {
  it('parses a well-formed marker', () => {
    expect(parseWaitingOn(marker())).toMatchObject({ kind: 'ci', ref: 'pr#12' });
  });
  it.each([
    ['null field_values', null],
    ['no marker', {}],
    ['null marker', { waiting_on: null }],
    ['array marker', { waiting_on: [] }],
    ['unknown kind', marker({ kind: 'nap' })],
    ['missing ref', marker({ ref: undefined })],
    ['blank ref', marker({ ref: '  ' })],
    ['bad since', marker({ since: 'soon' })],
    ['bad first_since', marker({ first_since: 42 })],
    ['bad resume_after', marker({ resume_after: 'later' })],
  ])('returns null for %s', (_n, fv) => {
    expect(parseWaitingOn(fv)).toBeNull();
  });
});

describe('liveWaitingOn (B-1157)', () => {
  it('is live inside the ceiling', () => {
    expect(liveWaitingOn(marker(), { firedAtMs: T0 - 1000, nowMs: T0 + 1000 })).not.toBeNull();
  });
  it('is not live when written before this leg fired', () => {
    expect(liveWaitingOn(marker(), { firedAtMs: T0 + 1, nowMs: T0 + 1000 })).toBeNull();
  });
  it('without firedAtMs the leg-start check is skipped', () => {
    expect(liveWaitingOn(marker(), { nowMs: T0 + 1000 })).not.toBeNull();
  });
  it('is not live at or past the ceiling from first_since, even after re-declaration', () => {
    const fv = marker({ since: iso(T0 + WAIT_CEILING_MS - 1000) });
    expect(liveWaitingOn(fv, { nowMs: T0 + WAIT_CEILING_MS - 1 })).not.toBeNull();
    expect(liveWaitingOn(fv, { nowMs: T0 + WAIT_CEILING_MS })).toBeNull();
  });
});

describe('waitResumeAtMs (B-1157)', () => {
  it('uses resume_after when present', () => {
    const w = parseWaitingOn(marker({ resume_after: iso(T0 + 60_000) }))!;
    expect(waitResumeAtMs(w)).toBe(T0 + 60_000);
  });
  it('defaults to since + 15 min', () => {
    expect(waitResumeAtMs(parseWaitingOn(marker())!)).toBe(T0 + WAIT_DEFAULT_RECHECK_MS);
  });
  it('clamps to the ceiling', () => {
    const w = parseWaitingOn(marker({ resume_after: iso(T0 + 2 * WAIT_CEILING_MS) }))!;
    expect(waitResumeAtMs(w)).toBe(T0 + WAIT_CEILING_MS);
  });
});

describe('strandedWorkSignal (B-1157)', () => {
  it('is null for a quiet row', () => {
    expect(strandedWorkSignal({ awaiting_human_input: false, active_exchange: null, pending_resolution: null })).toBeNull();
  });
  it('names each stranded shape', () => {
    expect(strandedWorkSignal({ active_exchange: { answers_submitted_at: 'x' } })).toBe('late-answers-landed');
    expect(strandedWorkSignal({ active_exchange: { force_quit_requested_at: 'x' } })).toBe('late-answers-landed');
    expect(strandedWorkSignal({ awaiting_human_input: true })).toBe('late-human-ball');
    expect(strandedWorkSignal({ pending_resolution: { command: 'reshape' } })).toBe('late-reshape');
    expect(strandedWorkSignal({ pending_acceptance_event_id: 'e1' })).toBe('late-acceptance');
    // B-1204: an edited-in-tool marker is stranded work like any staged marker (not dropped, not dirty).
    expect(strandedWorkSignal({ pending_resolution: { command: 'edited-in-tool', detail: "I've made edits in Figma." } })).toBe('late-reshape');
  });
  it('a signal already present on a row the leg saw is NOT late (it had its chance)', () => {
    const ex = { answers_submitted_at: 'a1' };
    expect(strandedWorkSignal({ active_exchange: ex }, [{ active_exchange: ex }])).toBeNull();
    expect(strandedWorkSignal({ pending_acceptance_event_id: 'e1' }, [{ pending_acceptance_event_id: 'e1' }])).toBeNull();
    expect(strandedWorkSignal({ pending_resolution: { command: 'reshape' } }, [{ pending_resolution: { command: 'reshape' } }])).toBeNull();
    // seen on the FIRE-time row only (second element) is enough
    expect(strandedWorkSignal({ pending_acceptance_event_id: 'e1' }, [{}, { pending_acceptance_event_id: 'e1' }])).toBeNull();
  });
  it('a signal that is new or changed relative to the seen rows is late', () => {
    expect(strandedWorkSignal({ pending_acceptance_event_id: 'e2' }, [{ pending_acceptance_event_id: 'e1' }])).toBe('late-acceptance');
    expect(strandedWorkSignal({ active_exchange: { answers_submitted_at: 'a2' } }, [{ active_exchange: { answers_submitted_at: 'a1' } }])).toBe('late-answers-landed');
    expect(strandedWorkSignal({ pending_resolution: { command: 'reshape', detail: 'b' } }, [{ pending_resolution: { command: 'reshape', detail: 'a' } }])).toBe('late-reshape');
    expect(strandedWorkSignal({ pending_acceptance_event_id: 'e1' }, [{}, {}])).toBe('late-acceptance');
  });
  it('a stale signal does not mask a genuinely new one of lower priority', () => {
    expect(
      strandedWorkSignal(
        { active_exchange: { answers_submitted_at: 'a1' }, pending_acceptance_event_id: 'e2' },
        [{ active_exchange: { answers_submitted_at: 'a1' } }],
      ),
    ).toBe('late-acceptance');
  });
  it('late-human-ball is not compared against seen rows (a human-held ball cannot loop legs)', () => {
    expect(strandedWorkSignal({ awaiting_human_input: true }, [{ awaiting_human_input: true }])).toBe('late-human-ball');
  });
  it('an active exchange with no stamp is not stranded', () => {
    expect(strandedWorkSignal({ active_exchange: {} })).toBeNull();
  });
});
