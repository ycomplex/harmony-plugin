// B-1149: the refusal verdict fixtures — each CLI's quota-with-reset, quota-without-reset, rate-limit
// and unrelated-error shapes, plus the forced-refusal test hook.
import { describe, it, expect } from 'vitest';
import { parseCodexRefusal, countCodexTurns, codexAdapter } from './codex.js';
import { parseClaudeRefusal } from './claude-code.js';
import { absoluteResetTime, forcedRefusal, relativeResetSeconds } from './refusal.js';

const NOW = new Date('2026-10-17T18:00:00.000Z');
const NO_ENV = {};
const lines = (...e: unknown[]) => e.map((x) => JSON.stringify(x)).join('\n');
const HOOK_NOISE = { type: 'item.completed', item: { id: 'item_0', type: 'error', message: '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.' } };

describe('parseCodexRefusal', () => {
  it('quota with a relative reset ("try again in …") → quota + resets_at', () => {
    const out = lines(
      { type: 'thread.started', thread_id: 't' },
      HOOK_NOISE,
      { type: 'error', message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again in 2 hours 30 minutes." },
      { type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 30 minutes." } },
    );
    expect(parseCodexRefusal(out, NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: '2026-10-17T20:30:00.000Z' });
  });

  it('quota with a structured resets_in_seconds field → quota + resets_at', () => {
    const out = lines({ type: 'turn.failed', error: { code: 'usage_limit_reached', message: 'usage limit reached', resets_in_seconds: 600 } });
    expect(parseCodexRefusal(out, NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: '2026-10-17T18:10:00.000Z' });
  });

  it('quota without a reset → quota + null', () => {
    const out = lines({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Pro to continue." } });
    expect(parseCodexRefusal(out, NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: null });
  });

  it('rate limit (429) → rate-limit', () => {
    const out = lines({ type: 'error', message: 'stream error: exceeded retry limit, last status: 429 Too Many Requests' });
    expect(parseCodexRefusal(out, NOW, NO_ENV)).toEqual({ kind: 'rate-limit', resets_at: null });
  });

  it('an unrelated error → no refusal; the hook-trust error ITEMS alone never count', () => {
    expect(parseCodexRefusal(lines({ type: 'turn.failed', error: { message: 'boom' } }), NOW, NO_ENV)).toBeNull();
    expect(parseCodexRefusal(lines(HOOK_NOISE, HOOK_NOISE, { type: 'turn.completed', usage: {} }), NOW, NO_ENV)).toBeNull();
    expect(parseCodexRefusal(lines({ type: 'item.completed', item: { type: 'error', message: 'usage limit' } }), NOW, NO_ENV)).toBeNull();
  });

  it('the adapter telemetry carries the refusal, even when only a bare error event was emitted', () => {
    const out = lines({ type: 'thread.started', thread_id: 't' }, { type: 'error', message: 'usage limit reached' });
    const rec = codexAdapter.telemetry.parse(out, { model: null, credential: 'login-cache' });
    expect(rec?.refusal).toEqual({ kind: 'quota', resets_at: null });
    expect(rec?.isError).toBe(true);
  });
});

describe('parseClaudeRefusal', () => {
  const env = (result: string, is_error = true) => JSON.stringify({ type: 'result', subtype: 'success', is_error, result, session_id: 's', usage: {} });

  it('quota with the legacy epoch reset ("usage limit reached|<epoch>") → quota + resets_at', () => {
    expect(parseClaudeRefusal(env('Claude AI usage limit reached|1792000000'), NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: new Date(1792000000 * 1000).toISOString() });
  });

  it('quota with a relative reset → quota + resets_at', () => {
    expect(parseClaudeRefusal(env('5-hour limit reached. Try again in 45 minutes.'), NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: '2026-10-17T18:45:00.000Z' });
  });

  it('quota without a placeable reset (a bare clock time) → quota + null', () => {
    expect(parseClaudeRefusal(env('5-hour limit reached ∙ resets 3pm'), NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: null });
    expect(parseClaudeRefusal(env('Weekly limit reached'), NOW, NO_ENV)).toEqual({ kind: 'quota', resets_at: null });
  });

  it('rate limit → rate-limit', () => {
    expect(parseClaudeRefusal(env('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'), NOW, NO_ENV)).toEqual({ kind: 'rate-limit', resets_at: null });
  });

  it('an unrelated error, a non-error envelope, or not an envelope → no refusal', () => {
    expect(parseClaudeRefusal(env('Not logged in'), NOW, NO_ENV)).toBeNull();
    expect(parseClaudeRefusal(env('usage limit reached', false), NOW, NO_ENV)).toBeNull();
    expect(parseClaudeRefusal('garbage', NOW, NO_ENV)).toBeNull();
  });
});

describe('HARMONY_TEST_FORCE_REFUSAL (test hook)', () => {
  it('forces the named refusal in both adapters; any other value is ignored', () => {
    expect(forcedRefusal({ HARMONY_TEST_FORCE_REFUSAL: 'quota' })).toEqual({ kind: 'quota', resets_at: null });
    expect(forcedRefusal({ HARMONY_TEST_FORCE_REFUSAL: 'nope' })).toBeNull();
    expect(parseCodexRefusal('', NOW, { HARMONY_TEST_FORCE_REFUSAL: 'rate-limit' })).toEqual({ kind: 'rate-limit', resets_at: null });
    expect(parseClaudeRefusal('', NOW, { HARMONY_TEST_FORCE_REFUSAL: 'quota' })).toEqual({ kind: 'quota', resets_at: null });
  });
});

describe('reset-time helpers', () => {
  it('relative and absolute forms', () => {
    expect(relativeResetSeconds('try again in 1 day 2 hours')).toBe(93600);
    expect(relativeResetSeconds('no time here')).toBeNull();
    expect(absoluteResetTime(1792000000)).toBe(new Date(1792000000000).toISOString());
    expect(absoluteResetTime('2026-10-18T09:00:00Z')).toBe('2026-10-18T09:00:00.000Z');
    expect(absoluteResetTime('3:05 PM')).toBeNull();
  });
});

describe('countCodexTurns', () => {
  it('counts model-initiated items (agent messages + tool/command calls), not reasoning or error items', () => {
    const out = lines(
      { type: 'thread.started', thread_id: 't' },
      HOOK_NOISE,
      { type: 'item.completed', item: { type: 'reasoning', text: 'x' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'get_task' } },
      { type: 'item.completed', item: { type: 'file_change' } },
      { type: 'item.started', item: { type: 'command_execution' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    );
    expect(countCodexTurns(out)).toBe(4);
    expect(countCodexTurns('')).toBeNull();
  });
});
