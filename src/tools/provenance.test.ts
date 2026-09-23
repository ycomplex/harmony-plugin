import { describe, it, expect } from 'vitest';
import {
  PROVENANCE_HUMAN_IN_SESSION,
  PROVENANCE_AGENT_SYNTHESIZED,
  PROVENANCE_WEB_ONLY,
  PROVENANCE_AGENT_ON_BEHALF,
  PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_SESSION,
  PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_BROWSER,
  PROVENANCE_HUMAN_RECORDED,
  PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED,
  guardKnowledgeWriteProvenance,
} from './provenance.js';

describe('provenance.ts constants (B-1021)', () => {
  it('the three B-734 constants keep their original values', () => {
    expect(PROVENANCE_HUMAN_IN_SESSION).toBe('human-in-session');
    expect(PROVENANCE_AGENT_SYNTHESIZED).toBe('agent-synthesized');
    expect(PROVENANCE_WEB_ONLY).toBe('human-in-browser');
  });

  it('the two closed agent-on-behalf values are exactly the human-provenance pair', () => {
    expect(PROVENANCE_AGENT_ON_BEHALF).toBe('agent-on-behalf');
    expect(PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_SESSION).toBe('agent-on-behalf:human-in-session');
    expect(PROVENANCE_AGENT_ON_BEHALF_HUMAN_IN_BROWSER).toBe('agent-on-behalf:human-in-browser');
  });

  // B-1062: a THIRD closed suffix — a human's decision RECORDED (harmony record), never conducted live.
  it('B-1062: the third closed agent-on-behalf suffix is human-recorded', () => {
    expect(PROVENANCE_HUMAN_RECORDED).toBe('human-recorded');
    expect(PROVENANCE_AGENT_ON_BEHALF_HUMAN_RECORDED).toBe('agent-on-behalf:human-recorded');
  });
});

describe('guardKnowledgeWriteProvenance (B-1021)', () => {
  it('permits null and undefined (a knowledge write with no provenance stays fine)', () => {
    expect(() => guardKnowledgeWriteProvenance(null)).not.toThrow();
    expect(() => guardKnowledgeWriteProvenance(undefined)).not.toThrow();
  });

  it('rejects bare human-in-browser with a clear error naming the accepted values', () => {
    expect(() => guardKnowledgeWriteProvenance('human-in-browser')).toThrow(/human-in-browser/);
    expect(() => guardKnowledgeWriteProvenance('human-in-browser')).toThrow(/agent-on-behalf/);
  });

  it('accepts both closed agent-on-behalf values', () => {
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:human-in-session')).not.toThrow();
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:human-in-browser')).not.toThrow();
  });

  // B-1062: the widened fence accepts the new third suffix...
  it('B-1062: accepts the widened agent-on-behalf:human-recorded value', () => {
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:human-recorded')).not.toThrow();
  });

  // ...while STILL REJECTING bare human-in-browser — a negative test proving the fence did not
  // become permissive generally, it only grew one more named suffix.
  it('B-1062: still rejects bare human-in-browser after the widening', () => {
    expect(() => guardKnowledgeWriteProvenance('human-in-browser')).toThrow(/human-in-browser/);
  });

  it('rejects an agent-on-behalf: value with any suffix outside the closed pair', () => {
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:something-else')).toThrow(/invalid provenance/);
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:agent-synthesized')).toThrow(/invalid provenance/);
    expect(() => guardKnowledgeWriteProvenance('agent-on-behalf:')).toThrow(/invalid provenance/);
  });

  it('passes through everything else unchanged (free-form tags, agent-synthesized[:<mode>], etc.)', () => {
    expect(() => guardKnowledgeWriteProvenance('human-in-session')).not.toThrow();
    expect(() => guardKnowledgeWriteProvenance('agent-synthesized')).not.toThrow();
    expect(() => guardKnowledgeWriteProvenance('agent-synthesized:unattended')).not.toThrow();
    expect(() => guardKnowledgeWriteProvenance('some-freeform-tag')).not.toThrow();
  });
});
