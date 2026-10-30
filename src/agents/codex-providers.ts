// B-1178: the Codex model-provider registry — which non-OpenAI providers a Codex leg may run on, and how.
//
// Pure data + pure functions, no I/O. A `model_catalog` row names its provider (`provider` column; absent or
// null = the runtime's default, `openai` for Codex — see entryProvider in src/config/run-config.ts). `openai`
// is NOT in this table on purpose: it means "no provider block, the ChatGPT login cache", exactly as before
// B-1178. Every other provider runs on ONE metered API key per provider, mounted into the worker as the env
// var `env_key` from the Secret Manager secret `harmony-provider-<name>-key` (a NAME; this file never holds
// or reads a value). An unknown provider is refused by name — there is never a silent default.

/** The provider a Codex catalog row means when it names none: no provider block, the login cache. */
export const CODEX_DEFAULT_PROVIDER = 'openai';

export interface CodexProvider {
  /** The provider id — the catalog's `provider` value and the `[model_providers.<name>]` table key. */
  name: string;
  displayName: string;
  /** The provider's OpenAI-compatible base URL. */
  baseUrl: string;
  /** The env var Codex reads the API key from (and the key of the Kubernetes Secret that carries it). */
  envKey: string;
  wireApi: 'responses';
  /** The Secret Manager / Kubernetes secret NAME holding the key: `harmony-provider-<name>-key`. */
  secretName: string;
}

/** The secret NAME a provider's key lives under. */
export function providerSecretName(name: string): string {
  return `harmony-provider-${name}-key`;
}

function provider(name: string, displayName: string, baseUrl: string, envKey: string): CodexProvider {
  return { name, displayName, baseUrl, envKey, wireApi: 'responses', secretName: providerSecretName(name) };
}

/** Every non-OpenAI provider, in a stable order. OpenRouter is the one mounted and proven; DeepSeek is
 *  registered only (no secret is created for it until a ticket proves it). */
export const CODEX_PROVIDERS: readonly CodexProvider[] = [
  provider('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'),
  provider('deepseek', 'DeepSeek', 'https://api.deepseek.com', 'DEEPSEEK_API_KEY'),
];

/** Every registered provider's key env var — the adapter's standing secrets beside the login cache. */
export const CODEX_PROVIDER_ENV_KEYS: readonly string[] = CODEX_PROVIDERS.map((p) => p.envKey);

/** True for the default provider (and for an absent / empty name): no provider block, login cache. */
export function isDefaultCodexProvider(name: string | null | undefined): boolean {
  return name === undefined || name === null || name === '' || name === CODEX_DEFAULT_PROVIDER;
}

export type CodexProviderLookup = { ok: true; provider: CodexProvider } | { ok: false; error: string };

/** Look a non-default provider up by name. `openai` is not a registry entry (it has no provider block)
 *  and an unknown name is refused, naming the registered ones. */
export function lookupCodexProvider(name: string): CodexProviderLookup {
  const found = CODEX_PROVIDERS.find((p) => p.name === name);
  if (found) return { ok: true, provider: found };
  const known = [CODEX_DEFAULT_PROVIDER, ...CODEX_PROVIDERS.map((p) => p.name)].join(', ');
  if (isDefaultCodexProvider(name)) {
    return { ok: false, error: `'${CODEX_DEFAULT_PROVIDER}' is the default provider (login cache), not a registry entry` };
  }
  return { ok: false, error: `unknown Codex model provider '${name}' — registered providers: ${known}` };
}
