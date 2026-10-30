// B-1178: the Codex provider registry — names only, an unknown provider refused by name, openai = no block.
import { describe, it, expect } from 'vitest';
import {
  CODEX_DEFAULT_PROVIDER,
  CODEX_PROVIDERS,
  CODEX_PROVIDER_ENV_KEYS,
  isDefaultCodexProvider,
  lookupCodexProvider,
  providerSecretName,
} from './codex-providers.js';

describe('B-1178 Codex provider registry', () => {
  it('registers openrouter and deepseek with their base URLs, key env vars and responses wire API', () => {
    expect(CODEX_PROVIDERS.map((p) => [p.name, p.baseUrl, p.envKey, p.wireApi])).toEqual([
      ['openrouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'responses'],
      ['deepseek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY', 'responses'],
    ]);
    expect(CODEX_PROVIDERS.map((p) => p.displayName)).toEqual(['OpenRouter', 'DeepSeek']);
  });

  it('derives the secret NAME harmony-provider-<name>-key', () => {
    expect(providerSecretName('openrouter')).toBe('harmony-provider-openrouter-key');
    expect(CODEX_PROVIDERS.map((p) => p.secretName)).toEqual(['harmony-provider-openrouter-key', 'harmony-provider-deepseek-key']);
  });

  it('lists every key env var (the adapter standing secrets)', () => {
    expect(CODEX_PROVIDER_ENV_KEYS).toEqual(['OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY']);
  });

  it('looks a registered provider up by name', () => {
    const r = lookupCodexProvider('openrouter');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.provider.envKey).toBe('OPENROUTER_API_KEY');
  });

  it('refuses an unknown provider by name, listing the registered ones — never a silent default', () => {
    const r = lookupCodexProvider('anthropic-direct');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("'anthropic-direct'");
      expect(r.error).toContain('openai, openrouter, deepseek');
    }
  });

  it('openai (and an absent / empty name) means no provider block: the login cache', () => {
    expect(CODEX_DEFAULT_PROVIDER).toBe('openai');
    for (const v of ['openai', '', null, undefined]) expect(isDefaultCodexProvider(v)).toBe(true);
    expect(isDefaultCodexProvider('openrouter')).toBe(false);
    expect(lookupCodexProvider('openai').ok).toBe(false);
  });
});
