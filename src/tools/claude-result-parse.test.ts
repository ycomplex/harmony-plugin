// B-916: unit coverage for the claude-specific result-envelope parse and the derived-cost fallback.
//
// The envelope fixtures below are shaped from the MEASURED observation at this ticket's design gate
// (Claude Code CLI 2.1.252), not from recollection — most importantly the `is_error: true` +
// `subtype: 'success'` pair, which is the trap this file's first test pins.

import { describe, it, expect } from 'vitest';
import {
  MODEL_PRICING,
  deriveCostUsd,
  parseClaudeResultJson,
  resolveCost,
  resolvePricing,
} from './claude-result-parse.js';

/** A full envelope in the observed shape: nested `usage`, the 1h/5m cache-creation split, the
 *  thinking-token detail, and the separate `duration_api_ms`. */
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done — the build gate is green',
    session_id: 'sess-abc',
    num_turns: 12,
    duration_ms: 900_000,
    duration_api_ms: 400_000,
    total_cost_usd: 1.25,
    service_tier: 'standard',
    modelUsage: {},
    permission_denials: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 900,
      cache_creation: {
        ephemeral_1h_input_tokens: 400,
        ephemeral_5m_input_tokens: 500,
      },
      output_tokens_details: { thinking_tokens: 700 },
    },
    ...overrides,
  });
}

describe('parseClaudeResultJson', () => {
  it("keys the error signal on `is_error`, NOT `subtype` — an errored run still reports subtype 'success'", () => {
    // The exact observed pair: is_error true, subtype 'success', result 'Not logged in'. A capture
    // keyed on subtype records this failed invocation as a clean one.
    const parsed = parseClaudeResultJson(
      envelope({ is_error: true, subtype: 'success', result: 'Not logged in' }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.is_error).toBe(true);
    expect(parsed!.result).toBe('Not logged in');
  });

  it('reads the NESTED usage, including both cache_creation buckets and the thinking-token detail', () => {
    const parsed = parseClaudeResultJson(envelope())!;
    expect(parsed.input_tokens).toBe(1000);
    expect(parsed.output_tokens).toBe(2000);
    expect(parsed.cache_read_input_tokens).toBe(3000);
    expect(parsed.cache_creation_input_tokens).toBe(900);
    // The 1h and 5m buckets are reported SEPARATELY per invocation and priced separately.
    expect(parsed.cache_creation_1h_input_tokens).toBe(400);
    expect(parsed.cache_creation_5m_input_tokens).toBe(500);
    expect(parsed.thinking_tokens).toBe(700);
  });

  it('carries the non-usage fields through: session_id, num_turns, both durations, service_tier and the CLI cost', () => {
    const parsed = parseClaudeResultJson(envelope())!;
    expect(parsed.session_id).toBe('sess-abc');
    expect(parsed.num_turns).toBe(12);
    expect(parsed.duration_ms).toBe(900_000);
    expect(parsed.duration_api_ms).toBe(400_000);
    expect(parsed.service_tier).toBe('standard');
    expect(parsed.cli_cost_usd).toBe(1.25);
  });

  it('treats `modelUsage` as optional enrichment — an absent one changes nothing', () => {
    const withModelUsage = parseClaudeResultJson(
      envelope({ modelUsage: { 'claude-opus-5': { inputTokens: 1 } } }),
    )!;
    const raw = JSON.parse(envelope()) as Record<string, unknown>;
    delete raw.modelUsage;
    const withoutModelUsage = parseClaudeResultJson(JSON.stringify(raw))!;
    expect(withoutModelUsage).toEqual(withModelUsage);
  });

  it('degrades to "not measured" (nulls) rather than wrong numbers when usage fields are absent', () => {
    const parsed = parseClaudeResultJson(JSON.stringify({ result: 'hi', is_error: false }))!;
    expect(parsed.input_tokens).toBeNull();
    expect(parsed.cache_creation_1h_input_tokens).toBeNull();
    expect(parsed.thinking_tokens).toBeNull();
    expect(parsed.cli_cost_usd).toBeNull();
    expect(parsed.is_error).toBe(false);
  });

  it('finds the envelope on the LAST JSON line when the capture picked up a stray leading line', () => {
    const parsed = parseClaudeResultJson(`some wrapper banner\n${envelope()}\n`)!;
    expect(parsed.session_id).toBe('sess-abc');
  });

  it('returns null (not a throw) for a capture that is not a result envelope at all', () => {
    expect(parseClaudeResultJson('')).toBeNull();
    expect(parseClaudeResultJson('COLD_STARTED args=-p do the leg')).toBeNull();
    expect(parseClaudeResultJson('{ not json')).toBeNull();
    expect(parseClaudeResultJson('[1,2,3]')).toBeNull();
    // A JSON object that is not a result envelope (no `result`, no `usage`).
    expect(parseClaudeResultJson('{"hello":"world"}')).toBeNull();
  });
});

describe('the derived-cost fallback (B-495 price table)', () => {
  const opus = MODEL_PRICING.opus;

  it('resolves the Opus row by model-family substring, and NOTHING for an unratified family', () => {
    expect(resolvePricing('claude-opus-5')).toBe(opus);
    expect(resolvePricing('CLAUDE-OPUS-4-5-20251101')).toBe(opus);
    expect(resolvePricing('claude-sonnet-5')).toBeNull();
    expect(resolvePricing(null)).toBeNull();
  });

  it('prices the 1h and 5m cache-write buckets SEPARATELY, at their own rates', () => {
    const usd = deriveCostUsd(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation_1h_input_tokens: 1_000_000,
        cache_creation_5m_input_tokens: 1_000_000,
      },
      opus,
    );
    // 5 (input) + 25 (output) + 0.50 (cache read) + 10 (1h write) + 6.25 (5m write)
    expect(usd).toBeCloseTo(46.75, 10);
  });

  it('does the arithmetic at real, non-round token counts', () => {
    const usd = deriveCostUsd(
      {
        input_tokens: 12_345,
        output_tokens: 6_789,
        cache_read_input_tokens: 1_234_567,
        cache_creation_input_tokens: 90_000,
        cache_creation_1h_input_tokens: 40_000,
        cache_creation_5m_input_tokens: 50_000,
      },
      opus,
    );
    const expected =
      (12_345 * 5 + 6_789 * 25 + 1_234_567 * 0.5 + 40_000 * 10 + 50_000 * 6.25) / 1_000_000;
    expect(usd).toBeCloseTo(expected, 12);
  });

  it('prices the whole cache_creation TOTAL at the 5m (default-TTL) rate when no bucket breakdown was reported — never dropping the cache-write cost, never double-counting it', () => {
    const usd = deriveCostUsd(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation_1h_input_tokens: null,
        cache_creation_5m_input_tokens: null,
      },
      opus,
    );
    expect(usd).toBeCloseTo(6.25, 10);
  });

  it('ignores the cache_creation TOTAL when the breakdown IS present (no double-count)', () => {
    const usd = deriveCostUsd(
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation_1h_input_tokens: 1_000_000,
        cache_creation_5m_input_tokens: 0,
      },
      opus,
    );
    expect(usd).toBeCloseTo(10, 10);
  });

  it('returns null with no price row, and null when nothing at all was measured', () => {
    const measured = {
      input_tokens: 10,
      output_tokens: 10,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cache_creation_1h_input_tokens: null,
      cache_creation_5m_input_tokens: null,
    };
    expect(deriveCostUsd(measured, null)).toBeNull();
    expect(
      deriveCostUsd(
        {
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
          cache_creation_1h_input_tokens: null,
          cache_creation_5m_input_tokens: null,
        },
        opus,
      ),
    ).toBeNull();
  });
});

describe('resolveCost — which figure the row actually carries', () => {
  it("prefers the CLI's own total_cost_usd", () => {
    const parsed = parseClaudeResultJson(envelope())!;
    expect(resolveCost(parsed, 'claude-opus-5')).toEqual({ total_cost_usd: 1.25, cost_source: 'cli' });
  });

  it('falls back to the derived figure when the CLI cost is ABSENT', () => {
    const raw = JSON.parse(envelope()) as Record<string, unknown>;
    delete raw.total_cost_usd;
    const parsed = parseClaudeResultJson(JSON.stringify(raw))!;
    const cost = resolveCost(parsed, 'claude-opus-5');
    expect(cost.cost_source).toBe('derived');
    // 1000*5 + 2000*25 + 3000*0.5 + 400*10 + 500*6.25, all /1e6
    expect(cost.total_cost_usd).toBeCloseTo(
      (1000 * 5 + 2000 * 25 + 3000 * 0.5 + 400 * 10 + 500 * 6.25) / 1_000_000,
      12,
    );
  });

  it('falls back to the derived figure when the CLI cost is ZERO ("not billed through this channel", not "free")', () => {
    const parsed = parseClaudeResultJson(envelope({ total_cost_usd: 0 }))!;
    expect(resolveCost(parsed, 'claude-opus-5').cost_source).toBe('derived');
  });

  it("reports 'unknown' with a NULL cost when neither figure is available — never a plausible-looking number from somebody else's rates", () => {
    const raw = JSON.parse(envelope()) as Record<string, unknown>;
    delete raw.total_cost_usd;
    const parsed = parseClaudeResultJson(JSON.stringify(raw))!;
    expect(resolveCost(parsed, 'claude-sonnet-5')).toEqual({
      total_cost_usd: null,
      cost_source: 'unknown',
    });
  });
});
