// B-916: unit coverage for the claude-specific result-envelope parse and the derived-cost fallback.
//
// The envelope fixtures below are shaped from the MEASURED observation at this ticket's design gate
// (Claude Code CLI 2.1.252), not from recollection — most importantly the `is_error: true` +
// `subtype: 'success'` pair, which is the trap this file's first test pins.

import { describe, it, expect } from 'vitest';
import {
  MODEL_PRICING,
  deriveCodexCostUsd,
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
    expect(resolvePricing('claude-haiku-5-5')).toBeNull();
    expect(resolvePricing('claude-sonnet-4-6')).toBeNull();
    expect(resolvePricing(null)).toBeNull();
  });

  it('B-1096: the most specific row wins — Opus 5.5 and Fable 5.1 are not priced as their predecessors', () => {
    expect(resolvePricing('claude-opus-5-5')).toBe(MODEL_PRICING['opus-5-5']);
    expect(resolvePricing('claude-opus-5-5')?.input_per_mtok).toBe(4);
    expect(resolvePricing('claude-fable-5-1')?.cache_read_per_mtok).toBe(0.25);
    expect(resolvePricing('claude-fable-5')?.cache_read_per_mtok).toBe(1);
    expect(resolvePricing('claude-sonnet-5')).toBe(MODEL_PRICING['sonnet-5']);
    expect(resolvePricing('claude-sonnet-5-5')).toBe(MODEL_PRICING['sonnet-5']);
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
    expect(resolveCost(parsed, 'claude-haiku-5-5')).toEqual({
      total_cost_usd: null,
      cost_source: 'unknown',
    });
  });
});

describe('B-1179: resolveCost priced from the catalog row', () => {
  /** The observed envelope with the CLI cost removed, so the derived figure is what the row carries.
   *  Its usage has input, output, a cache read and BOTH cache-write buckets. */
  function uncliParsed() {
    const raw = JSON.parse(envelope()) as Record<string, unknown>;
    delete raw.total_cost_usd;
    return parseClaudeResultJson(JSON.stringify(raw))!;
  }

  it.each([
    ['claude-opus-5-5', { input_per_mtok: 4, cached_input_per_mtok: 0.2, output_per_mtok: 20 }],
    ['claude-opus-5', { input_per_mtok: 5, cached_input_per_mtok: 0.5, output_per_mtok: 25 }],
    ['claude-sonnet-5', { input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 10 }],
    ['claude-fable-5-1', { input_per_mtok: 10, cached_input_per_mtok: 0.25, output_per_mtok: 50 }],
  ])('%s: a row equal to MODEL_PRICING derives the IDENTICAL cost (5m write = 1.25x input, 1h = 2x)', (model, row) => {
    const parsed = uncliParsed();
    const fromTable = resolveCost(parsed, model);
    const fromRow = resolveCost(parsed, model, row);
    expect(fromTable.cost_source).toBe('derived');
    expect(fromRow.cost_source).toBe('derived');
    expect(fromRow.total_cost_usd).toBeCloseTo(fromTable.total_cost_usd!, 12);
  });

  it('a row with different prices beats the table', () => {
    const cost = resolveCost(uncliParsed(), 'claude-opus-5', { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 3 });
    // 1000×1 + 2000×3 + 3000×0.1 + 400×(2×1) + 500×(1.25×1), all /1e6
    expect(cost).toEqual({ total_cost_usd: expect.closeTo((1000 + 6000 + 300 + 800 + 625) / 1_000_000, 12), cost_source: 'derived' });
  });

  it("the CLI's own cost still wins over a row", () => {
    const parsed = parseClaudeResultJson(envelope())!;
    expect(resolveCost(parsed, 'claude-opus-5', { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 3 })).toEqual({
      total_cost_usd: 1.25,
      cost_source: 'cli',
    });
  });

  it('a model with no table entry is unknown/null without a row (never 0), and derived WITH one', () => {
    expect(resolveCost(uncliParsed(), 'claude-haiku-5-5', null)).toEqual({ total_cost_usd: null, cost_source: 'unknown' });
    const cost = resolveCost(uncliParsed(), 'claude-haiku-5-5', { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 5 });
    expect(cost.cost_source).toBe('derived');
    expect(cost.total_cost_usd).toBeCloseTo((1000 * 1 + 2000 * 5 + 3000 * 0.1 + 400 * 2 + 500 * 1.25) / 1_000_000, 12);
  });
});

describe('B-1463: Claude Fable 5.2 and tiered Claude catalog rows', () => {
  function uncliParsed() {
    const raw = JSON.parse(envelope()) as Record<string, unknown>;
    delete raw.total_cost_usd;
    return parseClaudeResultJson(JSON.stringify(raw))!;
  }
  /** Haiku 5.5's catalog row as harmony-web seeds it: a base tier and a long-context tier above 100K. */
  const haikuRow = {
    input_per_mtok: 0.1,
    cached_input_per_mtok: 0.01,
    output_per_mtok: 0.5,
    long_context_threshold_tokens: 100_000,
    long_context_price: { input_per_mtok: 0.5, cached_input_per_mtok: 0.05, output_per_mtok: 2.5 },
  };

  it('claude-fable-5-2 resolves to its own row (8 / 0.20 / 40, writes 10 / 16), not to fable-5', () => {
    const row = resolvePricing('claude-fable-5-2');
    expect(row).toBe(MODEL_PRICING['fable-5-2']);
    expect(row).toEqual({
      input_per_mtok: 8,
      output_per_mtok: 40,
      cache_write_1h_per_mtok: 16,
      cache_write_5m_per_mtok: 10,
      cache_read_per_mtok: 0.2,
    });
    // Its neighbours are unchanged.
    expect(resolvePricing('claude-fable-5-1')).toBe(MODEL_PRICING['fable-5-1']);
    expect(resolvePricing('claude-fable-5')).toBe(MODEL_PRICING['fable-5']);
  });

  it('a fable-5-2 catalog row derives the same cost as its MODEL_PRICING row', () => {
    const parsed = uncliParsed();
    const fromTable = resolveCost(parsed, 'claude-fable-5-2');
    const fromRow = resolveCost(parsed, 'claude-fable-5-2', { input_per_mtok: 8, cached_input_per_mtok: 0.2, output_per_mtok: 40 });
    expect(fromTable.cost_source).toBe('derived');
    expect(fromTable.total_cost_usd).toBeCloseTo((1000 * 8 + 2000 * 40 + 3000 * 0.2 + 400 * 16 + 500 * 10) / 1_000_000, 12);
    expect(fromRow.total_cost_usd).toBeCloseTo(fromTable.total_cost_usd!, 12);
  });

  it('a Claude leg priced from a row WITH a long-context threshold is unknown — never priced from the base tier', () => {
    expect(resolveCost(uncliParsed(), 'claude-haiku-5-5', haikuRow)).toEqual({ total_cost_usd: null, cost_source: 'unknown' });
    // A threshold alone (no long-context prices on the row) is still a tiered row.
    expect(
      resolveCost(uncliParsed(), 'claude-haiku-5-5', { ...haikuRow, long_context_price: null }),
    ).toEqual({ total_cost_usd: null, cost_source: 'unknown' });
    // The threshold row does not fall through to MODEL_PRICING, even for a family the table prices.
    expect(resolveCost(uncliParsed(), 'claude-opus-5', { ...haikuRow })).toEqual({ total_cost_usd: null, cost_source: 'unknown' });
  });

  it("the CLI's own cost still wins over a tiered row", () => {
    const parsed = parseClaudeResultJson(envelope())!;
    expect(resolveCost(parsed, 'claude-haiku-5-5', haikuRow)).toEqual({ total_cost_usd: 1.25, cost_source: 'cli' });
  });

  it('Haiku does not regain a price through the MODEL_PRICING fallback', () => {
    expect(resolvePricing('claude-haiku-5-5')).toBeNull();
    expect(resolveCost(uncliParsed(), 'claude-haiku-5-5')).toEqual({ total_cost_usd: null, cost_source: 'unknown' });
  });

  it('a Claude row WITHOUT a threshold (null or absent) is priced from the row exactly as before', () => {
    const base = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 5 };
    const expected = (1000 * 1 + 2000 * 5 + 3000 * 0.1 + 400 * 2 + 500 * 1.25) / 1_000_000;
    for (const row of [base, { ...base, long_context_threshold_tokens: null, long_context_price: null }]) {
      const cost = resolveCost(uncliParsed(), 'claude-haiku-5-5', row);
      expect(cost.cost_source).toBe('derived');
      expect(cost.total_cost_usd).toBeCloseTo(expected, 12);
    }
  });

  it('a Codex row with a threshold is unchanged: base tier at or below it, long-context tier above it', () => {
    const row = {
      input_per_mtok: 2,
      cached_input_per_mtok: 0.1,
      output_per_mtok: 10,
      long_context_threshold_tokens: 272_000,
      long_context_price: { input_per_mtok: 4, cached_input_per_mtok: 0.2, output_per_mtok: 15 },
    };
    const below = deriveCodexCostUsd({ inputTokens: 100_000, cacheReadInputTokens: 50_000, outputTokens: 1_000 }, 'codex:gpt-6.1-sol', row);
    expect(below).toBeCloseTo((50_000 * 2 + 50_000 * 0.1 + 1_000 * 10) / 1_000_000, 12);
    const above = deriveCodexCostUsd({ inputTokens: 300_000, cacheReadInputTokens: 100_000, outputTokens: 1_000 }, 'codex:gpt-6.1-sol', row);
    expect(above).toBeCloseTo((200_000 * 4 + 100_000 * 0.2 + 1_000 * 15) / 1_000_000, 12);
  });
});
