import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseCodexFinalStatement } from './codex.js';

const event = (type: string, item?: unknown) => JSON.stringify({ type, item });
const message = (text: unknown) => event('item.completed', { type: 'agent_message', text });
const start = event('turn.started');

describe('Codex final statement', () => {
  it('selects the final turn from the existing two-turn adapter fixture', () => {
    const stream = readFileSync(new URL('./fixtures/codex-exec-two-turns.jsonl', import.meta.url), 'utf8');
    expect(parseCodexFinalStatement(stream)).toBe('second turn');
  });
  it('keeps only the last completed nonempty agent message, preserving its whitespace', () => {
    expect(parseCodexFinalStatement([start, message('earlier'), event('item.started', { type: 'agent_message', text: 'partial' }),
      event('item.completed', { type: 'command_execution', text: 'tool' }), message('  final\nstatement  '), message(''), message(null), event('turn.completed')].join('\n'))).toBe('  final\nstatement  ');
  });
  it.each(['turn.failed', 'turn.completed'])('never substitutes an earlier turn when final turn ends with %s', type => {
    expect(parseCodexFinalStatement([start, message('earlier'), event('turn.completed'), start, event(type)].join('\n'))).toBeNull();
  });
  it('ignores malformed lines, warnings and non-event JSON', () => {
    expect(parseCodexFinalStatement([start, '{bad', 'WARNING', '{}', 'null', message('done')].join('\n'))).toBe('done');
  });
  it('requires a turn boundary; empty, malformed and message-only tails are not final statements', () => {
    for (const stream of ['', '{bad', message('unanchored')]) expect(parseCodexFinalStatement(stream)).toBeNull();
  });
});
