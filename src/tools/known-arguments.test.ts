import { describe, it, expect } from 'vitest';
import { assertKnownArguments } from './known-arguments.js';

const tool = {
  name: 'demo_tool',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string' },
      add: {
        type: 'array',
        items: {
          type: 'object',
          properties: { content: { type: 'string' }, checked: { type: 'boolean' } },
        },
      },
      delete: { type: 'array', items: { type: 'string' } },
      field_values: { type: 'object' },
    },
  },
};

function messageOf(fn: () => void): string {
  try {
    fn();
  } catch (err: any) {
    return err.message;
  }
  throw new Error('expected a throw');
}

describe('assertKnownArguments (B-1400)', () => {
  it('accepts documented keys, including nested entry keys', () => {
    expect(() =>
      assertKnownArguments(tool, { task_id: 'B-1', add: [{ content: 'a', checked: true }], delete: ['x'] }),
    ).not.toThrow();
  });

  it('accepts a known key whose value is undefined', () => {
    expect(() => assertKnownArguments(tool, { task_id: 'B-1', add: undefined, delete: undefined })).not.toThrow();
  });

  it('treats null, undefined and non-object args as {}', () => {
    expect(() => assertKnownArguments(tool, null)).not.toThrow();
    expect(() => assertKnownArguments(tool, undefined)).not.toThrow();
    expect(() => assertKnownArguments(tool, 'nope')).not.toThrow();
    expect(() => assertKnownArguments(tool, ['a'])).not.toThrow();
  });

  it('names the tool, every unknown top-level key and the accepted keys in one error', () => {
    const msg = messageOf(() => assertKnownArguments(tool, { task_id: 'B-1', items: [], extra: 1 }));
    expect(msg).toContain('demo_tool does not accept: items, extra.');
    expect(msg).toContain('Accepted arguments: task_id, add, delete, field_values.');
  });

  it('reports unknown keys inside array-of-object entries as <prop>[<index>].<key>', () => {
    const msg = messageOf(() =>
      assertKnownArguments(tool, { task_id: 'B-1', add: [{ content: 'ok' }, { text: 'x', content: 'y' }] }),
    );
    expect(msg).toContain('demo_tool does not accept: add[1].text.');
    expect(msg).toContain('Each add entry accepts: content, checked.');
  });

  it('does not inspect free-form object or string-array properties', () => {
    expect(() =>
      assertKnownArguments(tool, { task_id: 'B-1', field_values: { anything: 1 }, delete: ['a', 'b'] }),
    ).not.toThrow();
  });

  it('skips non-object array elements without throwing', () => {
    expect(() => assertKnownArguments(tool, { add: ['plain', null, 3] })).not.toThrow();
  });

  it('appends a hint line for a matching unknown key', () => {
    const msg = messageOf(() =>
      assertKnownArguments(tool, { acceptance_criteria: [] }, { acceptance_criteria: 'Use the other tool.' }),
    );
    expect(msg.split('\n').at(-1)).toBe('Use the other tool.');
  });

  it('does not append a hint for a key that was not used', () => {
    const msg = messageOf(() => assertKnownArguments(tool, { other: 1 }, { acceptance_criteria: 'Use the other tool.' }));
    expect(msg).not.toContain('Use the other tool.');
  });

  it('never uses a phrase handleToolCall rewrites', () => {
    const msg = messageOf(() =>
      assertKnownArguments(tool, { not_found: 1, add: [{ rls: 1 }] }, { not_found: 'hint' }),
    );
    for (const phrase of ['not found', 'no rows', 'permission denied', 'RLS']) {
      expect(msg).not.toContain(phrase);
    }
  });
});
