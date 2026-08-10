import { describe, it, expect } from 'vitest';
import { slugRef, dedupeRefs } from './payload-refs.js';

describe('slugRef', () => {
  it('kebab-cases the text with the given prefix', () => {
    expect(slugRef('ac', 'The board exports a PDF')).toBe('ac-the-board-exports-a-pdf');
  });

  it('collapses runs of non-alphanumeric characters to a single hyphen', () => {
    expect(slugRef('child', 'Schema — migration & RLS!!')).toBe('child-schema-migration-rls');
  });

  it('trims leading/trailing punctuation before slugging', () => {
    expect(slugRef('step', '  -- Write the tests -- ')).toBe('step-write-the-tests');
  });

  it('lowercases mixed-case text', () => {
    expect(slugRef('ac', 'Saved Filters Are Per-User')).toBe('ac-saved-filters-are-per-user');
  });

  it('truncates the slug portion to maxLen (default 40) characters', () => {
    const longText = 'This is a very long acceptance criterion sentence that certainly exceeds forty characters';
    const ref = slugRef('ac', longText);
    const slugPart = ref.slice('ac-'.length);
    expect(slugPart.length).toBeLessThanOrEqual(40);
    expect(ref).toBe('ac-this-is-a-very-long-acceptance-criterion');
  });

  it('never leaves a dangling trailing hyphen after truncation cuts mid-word', () => {
    // 'ac-' + 40 chars would land mid-word ('crite-rion') without the trailing-hyphen trim below;
    // pick a case where the cut boundary itself falls exactly on a hyphen to pin that trim.
    const text = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbb'; // 40 a's, then a hyphen, then more
    const ref = slugRef('x', text, 41);
    expect(ref.endsWith('-')).toBe(false);
  });

  it('respects a custom maxLen', () => {
    expect(slugRef('ac', 'one two three four five', 7)).toBe('ac-one-two');
  });

  it('degrades empty/all-punctuation text to the literal slug "item" rather than a bare trailing hyphen', () => {
    expect(slugRef('ac', '')).toBe('ac-item');
    expect(slugRef('ac', '!!!???')).toBe('ac-item');
  });

  it('is stable across repeated calls on the same text (deterministic — no positional/random component)', () => {
    expect(slugRef('child', 'Add the MCP tool')).toBe(slugRef('child', 'Add the MCP tool'));
  });
});

describe('dedupeRefs', () => {
  it('leaves refs untouched when there are no collisions', () => {
    const items = [{ ref: 'ac-a' }, { ref: 'ac-b' }, { ref: 'ac-c' }];
    expect(dedupeRefs(items).map((i) => i.ref)).toEqual(['ac-a', 'ac-b', 'ac-c']);
  });

  it('appends a deterministic -2, -3, ... suffix to every collision after the first, in item order', () => {
    const items = [{ ref: 'ac-x' }, { ref: 'ac-x' }, { ref: 'ac-x' }, { ref: 'ac-y' }];
    expect(dedupeRefs(items).map((i) => i.ref)).toEqual(['ac-x', 'ac-x-2', 'ac-x-3', 'ac-y']);
  });

  it('never mutates the input items — returns a new array/objects for renamed refs only', () => {
    const items = [{ ref: 'ac-x', content: 'first' }, { ref: 'ac-x', content: 'second' }];
    const result = dedupeRefs(items);
    expect(items[1].ref).toBe('ac-x'); // original untouched
    expect(result[0]).toBe(items[0]); // first occurrence returned as-is (same reference)
    expect(result[1]).not.toBe(items[1]); // collision returned as a new object
    expect(result[1].ref).toBe('ac-x-2');
    expect(result[1].content).toBe('second'); // other fields preserved
  });

  it('handles multiple independent collision groups in one payload', () => {
    const items = [{ ref: 'a' }, { ref: 'b' }, { ref: 'a' }, { ref: 'b' }, { ref: 'a' }];
    expect(dedupeRefs(items).map((i) => i.ref)).toEqual(['a', 'b', 'a-2', 'b-2', 'a-3']);
  });
});
