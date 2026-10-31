import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { briefFrameSchema, validateBriefFrame } from './brief-frame-schema.js';
import { FRAME_KIND_FOR_REASON, type GateFrame } from './briefs.js';

const samples = JSON.parse(readFileSync(new URL('./brief-frame-replay.json', import.meta.url), 'utf8')) as Array<{
  ticket: string; id: string; reason: string; frame: GateFrame;
}>;

describe('real frame compatibility (B-1158)', () => {
  it('replays exactly 18 retained revisions, accepting all six frame kinds', () => {
    expect(samples).toHaveLength(18);
    expect(new Set(samples.map(s => s.frame.kind)).size).toBe(6);
    const refused = samples.filter(s => {
      try { validateBriefFrame(s.frame, FRAME_KIND_FOR_REASON[s.reason]); return false; }
      catch { return true; }
    });
    expect(refused.map(s => `${s.ticket}/${s.id}`)).toEqual([]);
  });
  for (const sample of samples) {
    it(`${sample.ticket}/${sample.id}: ${sample.frame.kind}`, () => {
      expect(() => validateBriefFrame(sample.frame, FRAME_KIND_FOR_REASON[sample.reason])).not.toThrow();
    });
  }
  it('accepts GateFrame types and preserves additive fields without mutating input', () => {
    const frame = { kind: 'clarify', solving: '', in_scope: [], not_solving: [], future: { flag: true } } satisfies GateFrame & { future: unknown };
    const original = JSON.stringify(frame);
    validateBriefFrame(frame, 'clarify');
    expect(JSON.stringify(frame)).toBe(original);
    expect(briefFrameSchema.parse(frame)).toHaveProperty('future');
  });
  it('accepts release prs absent or present, and rejects malformed nested prs', () => {
    const frame = structuredClone(samples.find(s => s.frame.kind === 'release')!.frame) as Extract<GateFrame, { kind: 'release' }>;
    Object.assign(frame.act, { prs: [{ repo: 'harmony-plugin', number: 1, url: 'any string' }] });
    expect(() => validateBriefFrame(frame)).not.toThrow();
    Object.assign(frame.act, { prs: [{ repo: 'harmony-plugin', number: '1', url: 'x' }] });
    expect(() => validateBriefFrame(frame)).toThrow('doc.frame.act.prs[0].number');
  });
  it('allows server-owned release fields to be omitted', () => {
    const frame = { ...samples.find(s => s.frame.kind === 'release')!.frame } as Record<string, unknown>;
    delete frame.risk_classes; delete frame.contradiction_signal;
    expect(() => validateBriefFrame(frame)).not.toThrow();
  });
  it('allows omitted or cleared optional frames', () => {
    expect(() => validateBriefFrame(undefined)).not.toThrow();
    expect(() => validateBriefFrame(null)).not.toThrow();
  });
  it('names wrong kinds and required nested fields', () => {
    expect(() => validateBriefFrame({ kind: 'bogus' })).toThrow('doc.frame.kind');
    expect(() => validateBriefFrame(samples[0].frame, 'release')).toThrow('doc.frame.kind');
    const release = structuredClone(samples.find(s => s.frame.kind === 'release')!.frame) as Record<string, unknown>;
    release.act = 'land this';
    expect(() => validateBriefFrame(release)).toThrow('doc.frame.act');
    const clarify = { kind: 'clarify', solving: 'x', in_scope: [], not_solving: ['x'] };
    expect(() => validateBriefFrame(clarify)).toThrow('doc.frame.not_solving[0]');
    clarify.not_solving = [{}] as never;
    expect(() => validateBriefFrame(clarify)).toThrow('doc.frame.not_solving[0].item');
  });
});

it('validates settlement reports without requiring them on legacy release frames', () => {
  const frame = structuredClone(samples.find(s => s.frame.kind === 'release')!.frame) as Extract<GateFrame, {kind:'release'}>;
  frame.settled_beyond_design = [];
  expect(() => validateBriefFrame(frame)).not.toThrow();
  frame.settled_beyond_design = [{ behaviour: 'Keeps stale value', ac: 'AC1', knowledge_entry_id: 'entry' }];
  expect(() => validateBriefFrame(frame)).not.toThrow();
  frame.settled_beyond_design[0].knowledge_entry_id = ' ';
  expect(() => validateBriefFrame(frame)).toThrow('knowledge_entry_id');
});

// B-1047 — a design frame's declared reach and its rules.
describe('design reach and rules (B-1047)', () => {
  const design = (over: Record<string, unknown> = {}) => ({
    kind: 'design', track: 'technical-design', tracks: [{ track: 'technical-design', status: 'this-brief' }], reach: [], ...over,
  });
  const rule = (over: Record<string, unknown> = {}) => ({
    ref: 'rule-a', operation: 'create', wording: 'Every list view paginates server-side.', domains: ['web'], surfaces: ['board'],
    knowledge_scope: 'product', reach: 'this_surface', target_entry_id: null, expected_fingerprint: null, ...over,
  });
  const reference = rule({ operation: 'reference', target_entry_id: 'entry-7', expected_fingerprint: 'fp-7' });

  it.each(['this_ticket_only', 'this_surface', 'this_product'])('accepts reach_level %s', (level) => {
    const rules = level === 'this_ticket_only' ? [] : [rule()];
    expect(() => validateBriefFrame(design({ reach_level: level, rules }), 'design')).not.toThrow();
  });

  it('refuses an unknown reach_level', () => {
    expect(() => validateBriefFrame(design({ reach_level: 'this_team' }), 'design')).toThrow(/doc\.frame\.reach_level/);
  });

  it('a legacy design frame with no reach_level and no rules still validates', () => {
    expect(() => validateBriefFrame(design(), 'design')).not.toThrow();
  });

  it.each(['this_surface', 'this_product'])('refuses %s with zero rules', (level) => {
    expect(() => validateBriefFrame(design({ reach_level: level }), 'design')).toThrow(/must declare at least one rule/);
    expect(() => validateBriefFrame(design({ reach_level: level, rules: [] }), 'design')).toThrow(/must declare at least one rule/);
  });

  it.each(['create', 'amend'])('refuses a this_ticket_only design that would %s a rule', (operation) => {
    const r = rule({ operation, target_entry_id: 'entry-7', expected_fingerprint: 'fp-7' });
    expect(() => validateBriefFrame(design({ reach_level: 'this_ticket_only', rules: [operation === 'create' ? rule() : r] }), 'design'))
      .toThrow(/this_ticket_only design creates no rule/);
  });

  it('allows a this_ticket_only design to reference an existing rule', () => {
    expect(() => validateBriefFrame(design({ reach_level: 'this_ticket_only', rules: [reference] }), 'design')).not.toThrow();
  });

  it.each(['amend', 'reference'])('%s requires target_entry_id and expected_fingerprint', (operation) => {
    expect(() => validateBriefFrame(design({ reach_level: 'this_product', rules: [rule({ operation })] }), 'design'))
      .toThrow(/must name target_entry_id and expected_fingerprint/);
  });

  it('refuses blank wording and rules with no declared reach_level', () => {
    expect(() => validateBriefFrame(design({ reach_level: 'this_surface', rules: [rule({ wording: '  ' })] }), 'design')).toThrow(/wording/);
    expect(() => validateBriefFrame(design({ rules: [rule()] }), 'design')).toThrow(/rules need a declared doc\.frame\.reach_level/);
  });
});
