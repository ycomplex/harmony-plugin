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
