import { describe, it, expect } from 'vitest';
import { slugRef, dedupeRefs } from './payload-refs.js';

describe('slugRef', () => {
  it('lowercases and hyphenates on non-alphanumeric runs', () => {
    expect(slugRef('ac', 'The board exports a PDF!')).toBe('ac-the-board-exports-a-pdf');
  });

  it('collapses multiple separators into a single hyphen', () => {
    expect(slugRef('ac', 'foo   bar---baz')).toBe('ac-foo-bar-baz');
  });

  it('trims leading/trailing punctuation before prefixing', () => {
    expect(slugRef('child', '  --Schema migration--  ')).toBe('child-schema-migration');
  });

  it('degrades to the bare prefix when text has no alphanumeric content', () => {
    expect(slugRef('ac', '!!! --- ???')).toBe('ac');
  });

  it('truncates to maxLen and trims a trailing hyphen left by the clamp', () => {
    const ref = slugRef('step', 'a very long plan step title that will definitely exceed the default max length');
    expect(ref.length).toBeLessThanOrEqual(40);
    expect(ref.endsWith('-')).toBe(false);
    expect(ref).toBe('step-a-very-long-plan-step-title-that-wi');
  });

  it('respects a custom maxLen', () => {
    const ref = slugRef('child', 'schema migration and rollout plan', 15);
    expect(ref.length).toBeLessThanOrEqual(15);
    expect(ref.endsWith('-')).toBe(false);
    expect(ref).toBe('child-schema-mi');
  });

  it('uses the default maxLen of 40 when omitted', () => {
    const long = slugRef('ac', 'x'.repeat(100));
    expect(long.length).toBe(40);
  });
});

describe('dedupeRefs', () => {
  it('leaves unique refs unchanged', () => {
    const items = [{ ref: 'ac-a' }, { ref: 'ac-b' }, { ref: 'ac-c' }];
    expect(dedupeRefs(items)).toEqual(items);
  });

  it('suffixes a collision with -2, -3, ... in item order', () => {
    const items = [{ ref: 'ac-x' }, { ref: 'ac-x' }, { ref: 'ac-x' }];
    expect(dedupeRefs(items)).toEqual([
      { ref: 'ac-x' },
      { ref: 'ac-x-2' },
      { ref: 'ac-x-3' },
    ]);
  });

  it('is deterministic — running twice on the same input yields the same output', () => {
    const items = [{ ref: 'ac-x' }, { ref: 'ac-x' }, { ref: 'ac-y' }, { ref: 'ac-x' }];
    expect(dedupeRefs(items)).toEqual(dedupeRefs(items));
    expect(dedupeRefs(items)).toEqual([
      { ref: 'ac-x' },
      { ref: 'ac-x-2' },
      { ref: 'ac-y' },
      { ref: 'ac-x-3' },
    ]);
  });

  it('skips a suffix that would collide with an already-disambiguated ref', () => {
    // Item order: "ac-x", then a literal "ac-x-2" (independently produced), then a second
    // "ac-x" collision — the second "ac-x" must NOT become "ac-x-2" (already used by item 2);
    // it must advance to the next free suffix, "ac-x-3".
    const items = [{ ref: 'ac-x' }, { ref: 'ac-x-2' }, { ref: 'ac-x' }];
    expect(dedupeRefs(items)).toEqual([
      { ref: 'ac-x' },
      { ref: 'ac-x-2' },
      { ref: 'ac-x-3' },
    ]);
  });

  it('preserves item order and other fields, only rewriting `ref`', () => {
    const items = [
      { ref: 'ac-x', content: 'first' },
      { ref: 'ac-x', content: 'second' },
    ];
    expect(dedupeRefs(items)).toEqual([
      { ref: 'ac-x', content: 'first' },
      { ref: 'ac-x-2', content: 'second' },
    ]);
  });

  it('does not mutate the input array', () => {
    const items = [{ ref: 'ac-x' }, { ref: 'ac-x' }];
    const snapshot = JSON.parse(JSON.stringify(items));
    dedupeRefs(items);
    expect(items).toEqual(snapshot);
  });

  it('handles an empty array', () => {
    expect(dedupeRefs([])).toEqual([]);
  });
});
