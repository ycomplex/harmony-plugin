// B-1149: the dated Codex price table beside Claude's MODEL_PRICING, and the equivalent-cost formula
// (input − cached) × input + cached × cached + output × output.
import { describe, it, expect } from 'vitest';
import { CODEX_PRICING, deriveCodexCostUsd, resolveCodexPricing } from './claude-result-parse.js';

describe('CODEX_PRICING / deriveCodexCostUsd', () => {
  it('prices own usage at (input − cached) × input + cached × cached + output × output', () => {
    // gpt-5: $1.25 / $0.125 / $10 per million
    expect(deriveCodexCostUsd({ inputTokens: 1_000_000, cacheReadInputTokens: 400_000, outputTokens: 100_000 }, 'gpt-5')).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125 + 0.1 * 10, 10);
  });
  it('gpt-6.1-sol (the catalog-pinned Codex model) is priced at $2.00 / $0.10 / $10.00 (Standard, <= 272K)', () => {
    expect(CODEX_PRICING['gpt-6.1-sol']).toEqual({ input_per_mtok: 2, cached_input_per_mtok: 0.1, output_per_mtok: 10 });
    expect(resolveCodexPricing('codex:gpt-6.1-sol')).toBe(CODEX_PRICING['gpt-6.1-sol']);
    expect(deriveCodexCostUsd({ inputTokens: 1_000_000, cacheReadInputTokens: 400_000, outputTokens: 100_000 }, 'gpt-6.1-sol')).toBeCloseTo(0.6 * 2 + 0.4 * 0.1 + 0.1 * 10, 10);
  });
  it('B-1175: gpt-6-luna is priced at $0.10 / $0.01 / $0.50 and gpt-6-astra at $10 / $1.00 / $50 (Standard, <= 272K)', () => {
    expect(CODEX_PRICING['gpt-6-luna']).toEqual({ input_per_mtok: 0.1, cached_input_per_mtok: 0.01, output_per_mtok: 0.5 });
    expect(CODEX_PRICING['gpt-6-astra']).toEqual({ input_per_mtok: 10, cached_input_per_mtok: 1, output_per_mtok: 50 });
    expect(resolveCodexPricing('codex:gpt-6-luna')).toBe(CODEX_PRICING['gpt-6-luna']);
    expect(resolveCodexPricing('codex:gpt-6-astra')).toBe(CODEX_PRICING['gpt-6-astra']);
    // 1M input of which 200K cached, 100K output: Luna 0.8×0.10 + 0.2×0.01 + 0.1×0.50 = 0.132; Astra 0.8×10 + 0.2×1 + 0.1×50 = 13.2
    expect(deriveCodexCostUsd({ inputTokens: 1_000_000, cacheReadInputTokens: 200_000, outputTokens: 100_000 }, 'gpt-6-luna')).toBeCloseTo(0.132, 10);
    expect(deriveCodexCostUsd({ inputTokens: 1_000_000, cacheReadInputTokens: 200_000, outputTokens: 100_000 }, 'gpt-6-astra')).toBeCloseTo(13.2, 10);
  });
  it('gpt-5.3-codex is priced at $1.75 / $0.175 / $14.00; only page-listed ids have rows', () => {
    expect(CODEX_PRICING['gpt-5.3-codex']).toEqual({ input_per_mtok: 1.75, cached_input_per_mtok: 0.175, output_per_mtok: 14 });
    expect(Object.keys(CODEX_PRICING).sort()).toEqual(['gpt-5', 'gpt-5.1', 'gpt-5.3-codex', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol']);
  });
  it('resolves an exact id (codex: prefix and case tolerated), never a substring sibling', () => {
    expect(resolveCodexPricing('codex:GPT-5')).toBe(CODEX_PRICING['gpt-5']);
    expect(resolveCodexPricing('gpt-5.5-codex')).toBeNull();
    expect(resolveCodexPricing('gpt-5-codex-mini')).toBeNull();
    expect(resolveCodexPricing('gpt-5-codex')).toBeNull();
  });
  it('an unpriced model or no usage stays not captured (null); cached is clamped to input', () => {
    expect(deriveCodexCostUsd({ inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 1 }, 'gpt-5-codex-mini')).toBeNull();
    expect(deriveCodexCostUsd(null, 'gpt-5')).toBeNull();
    expect(deriveCodexCostUsd({ inputTokens: null, cacheReadInputTokens: null, outputTokens: null }, 'gpt-5')).toBeNull();
    expect(deriveCodexCostUsd({ inputTokens: 100, cacheReadInputTokens: 500, outputTokens: 0 }, 'gpt-5')).toBeCloseTo((100 * 0.125) / 1e6, 12);
  });
});

describe('B-1179: deriveCodexCostUsd priced from the catalog row', () => {
  const usage = { inputTokens: 1_000_000, cacheReadInputTokens: 200_000, outputTokens: 100_000 };

  it('Luna, Astra and Sol priced from a row equal to the table give the same numbers as the table', () => {
    for (const id of ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol']) {
      expect(deriveCodexCostUsd(usage, `codex:${id}`, { ...CODEX_PRICING[id] })).toBeCloseTo(deriveCodexCostUsd(usage, id)!, 12);
    }
    // The B-1175 figures above: Luna 0.132, Astra 13.2; Sol 0.8×2 + 0.2×0.1 + 0.1×10 = 2.62
    expect(deriveCodexCostUsd(usage, 'gpt-6-luna', { ...CODEX_PRICING['gpt-6-luna'] })).toBeCloseTo(0.132, 10);
    expect(deriveCodexCostUsd(usage, 'gpt-6-astra', { ...CODEX_PRICING['gpt-6-astra'] })).toBeCloseTo(13.2, 10);
    expect(deriveCodexCostUsd(usage, 'gpt-6.1-sol', { ...CODEX_PRICING['gpt-6.1-sol'] })).toBeCloseTo(2.62, 10);
  });

  it('an OpenRouter-style model with no table row is priced from its row by the same formula', () => {
    const row = { input_per_mtok: 0.3, cached_input_per_mtok: 0.03, output_per_mtok: 1.2 };
    expect(resolveCodexPricing('codex:openrouter/some-model')).toBeNull();
    // 0.8 × 0.3 + 0.2 × 0.03 + 0.1 × 1.2 = 0.24 + 0.006 + 0.12 = 0.366
    expect(deriveCodexCostUsd(usage, 'codex:openrouter/some-model', row)).toBeCloseTo(0.366, 10);
  });

  it('a row price changed between two calls changes the next result (a price change reaches the next leg)', () => {
    const before = deriveCodexCostUsd(usage, 'gpt-6.1-sol', { input_per_mtok: 2, cached_input_per_mtok: 0.1, output_per_mtok: 10 });
    const after = deriveCodexCostUsd(usage, 'gpt-6.1-sol', { input_per_mtok: 3, cached_input_per_mtok: 0.1, output_per_mtok: 10 });
    expect(before).toBeCloseTo(2.62, 10);
    expect(after).toBeCloseTo(0.8 * 3 + 0.2 * 0.1 + 0.1 * 10, 10);
  });

  it('no row and no table entry stays null (not captured)', () => {
    expect(deriveCodexCostUsd(usage, 'codex:openrouter/some-model', null)).toBeNull();
    expect(deriveCodexCostUsd(usage, 'codex:openrouter/some-model')).toBeNull();
  });
});
