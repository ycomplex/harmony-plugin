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
  it('gpt-5.3-codex is priced at $1.75 / $0.175 / $14.00; only page-listed ids have rows', () => {
    expect(CODEX_PRICING['gpt-5.3-codex']).toEqual({ input_per_mtok: 1.75, cached_input_per_mtok: 0.175, output_per_mtok: 14 });
    expect(Object.keys(CODEX_PRICING).sort()).toEqual(['gpt-5', 'gpt-5.1', 'gpt-5.3-codex', 'gpt-6.1-sol']);
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
