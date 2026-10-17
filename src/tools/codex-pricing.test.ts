// B-1149: the dated Codex price table beside Claude's MODEL_PRICING, and the equivalent-cost formula
// (input − cached) × input + cached × cached + output × output.
import { describe, it, expect } from 'vitest';
import { CODEX_PRICING, deriveCodexCostUsd, resolveCodexPricing } from './claude-result-parse.js';

describe('CODEX_PRICING / deriveCodexCostUsd', () => {
  it('prices own usage at (input − cached) × input + cached × cached + output × output', () => {
    // gpt-5-codex: $1.25 / $0.125 / $10 per million
    expect(deriveCodexCostUsd({ inputTokens: 1_000_000, cacheReadInputTokens: 400_000, outputTokens: 100_000 }, 'gpt-5-codex')).toBeCloseTo(0.6 * 1.25 + 0.4 * 0.125 + 0.1 * 10, 10);
  });
  it('resolves an exact id (codex: prefix and case tolerated), never a substring sibling', () => {
    expect(resolveCodexPricing('codex:GPT-5-Codex')).toBe(CODEX_PRICING['gpt-5-codex']);
    expect(resolveCodexPricing('gpt-5.5-codex')).toBeNull();
    expect(resolveCodexPricing('gpt-6.1-sol')).toBeNull();
  });
  it('an unpriced model or no usage stays not captured (null); cached is clamped to input', () => {
    expect(deriveCodexCostUsd({ inputTokens: 10, cacheReadInputTokens: 0, outputTokens: 1 }, 'gpt-6.1-sol')).toBeNull();
    expect(deriveCodexCostUsd(null, 'gpt-5-codex')).toBeNull();
    expect(deriveCodexCostUsd({ inputTokens: null, cacheReadInputTokens: null, outputTokens: null }, 'gpt-5-codex')).toBeNull();
    expect(deriveCodexCostUsd({ inputTokens: 100, cacheReadInputTokens: 500, outputTokens: 0 }, 'gpt-5-codex')).toBeCloseTo((100 * 0.125) / 1e6, 12);
  });
});
