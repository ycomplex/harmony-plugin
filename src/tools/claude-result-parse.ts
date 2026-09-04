// B-916: the CLAUDE-SPECIFIC parse of `claude -p --output-format json`'s result envelope.
//
// This is the one agent-shaped file in the leg-cost feature, and it is deliberately quarantined
// here — on the WORKER's side of the B-718 agent-neutrality seam, reached only from the worker
// profile (container/provision.sh) via the `harmony leg-cost record` CLI accessor. Nothing in
// src/daemon/ imports it, and nothing ever may: the exit code is still the only control signal out
// of a worker (see src/daemon/scheduler.ts's SchedulerDeps.runCommand guardrail comment). A second
// agent runtime gets its OWN parser beside this one; it does not get to edit the daemon.
//
// MEASURED against Claude Code CLI 2.1.252 at this ticket's design gate — these are observations,
// not recollections:
//
//  - The ENTIRE stdout is ONE JSON line, emitted at the end. That is why provision.sh re-echoes
//    `.result` verbatim after each invocation: wiring the flag without the re-echo would replace
//    B-720's readable operator tail with a blob.
//  - `usage` is NESTED, not flat: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
//    `cache_creation_input_tokens`, `output_tokens_details.thinking_tokens`, and a
//    `cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens }` breakdown — the 1h
//    and 5m cache-write buckets are reported SEPARATELY per invocation, and they price differently.
//  - TRAP: key on `is_error`, NOT `subtype`. The observed run errored (`is_error: true`,
//    `result: "Not logged in"`) and STILL reported `subtype: "success"`. A capture keyed on
//    `subtype` records a failed invocation as a clean one.
//  - `modelUsage` was `{}` in that observation. It is treated here as OPTIONAL ENRICHMENT that
//    nothing depends on — never a required field.

/** The nested `usage` object of a result envelope. Every field optional: a CLI version that stops
 *  reporting one must degrade to "not measured", never to a wrong number. */
export interface ClaudeResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  output_tokens_details?: {
    thinking_tokens?: number;
  };
  service_tier?: string;
}

/** The measurements one invocation yielded, flattened onto the `conduction_leg_costs` column names
 *  (src/tools/leg-cost-record.ts) so the CLI accessor is a straight hand-off with no second
 *  mapping. `result` is carried through because it is what provision.sh re-echoes; nothing here
 *  interprets it. */
export interface ParsedClaudeResult {
  /** THE error signal — `is_error`, never `subtype` (see the module header's trap note). */
  is_error: boolean;
  result: string | null;
  session_id: string | null;
  num_turns: number | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  service_tier: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_creation_1h_input_tokens: number | null;
  cache_creation_5m_input_tokens: number | null;
  thinking_tokens: number | null;
  /** The CLI's own `total_cost_usd`, exactly as reported (null when absent). Kept distinct from the
   *  resolved `total_cost_usd` below so a caller can always tell what came from the CLI. */
  cli_cost_usd: number | null;
}

// -----------------------------------------------------------------------------------------------
// The price table (B-495) and the derived-cost fallback.
// -----------------------------------------------------------------------------------------------

/** Published per-million-token rates for ONE model family. The two cache-WRITE rates are separate
 *  fields, not a single one, because the CLI reports the 1h and 5m buckets separately and they are
 *  charged at different multiples of the base input rate (1h = 2x input, 5m = 1.25x input — the
 *  published Anthropic prompt-caching multipliers, which is exactly how the ratified $5 input /
 *  $10 1h-write pair below reconciles). */
export interface ModelPricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_1h_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_read_per_mtok: number;
}

/** B-495's price table, keyed by a lower-cased model-FAMILY substring (the `--model` alias the leg
 *  actually launched with — e.g. `claude-opus-5` — matches on `opus`).
 *
 *  DELIBERATELY ONE ROW. Only the Opus rates were ratified for this ticket, and an unrecognized
 *  model resolves to NO pricing, so its `cost_source` is `'unknown'` and its `total_cost_usd` is
 *  null — an honest "we cannot say" rather than a plausible-looking number computed from somebody
 *  else's rates. That is the whole point of carrying `cost_source` at all. Adding a family here is
 *  a one-line change once its rates are ratified; guessing one is not. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  opus: {
    input_per_mtok: 5,
    output_per_mtok: 25,
    cache_write_1h_per_mtok: 10,
    cache_write_5m_per_mtok: 6.25,
    cache_read_per_mtok: 0.5,
  },
};

/** The price row for a model alias, or null when this deployment has no ratified rates for it.
 *  Never throws. */
export function resolvePricing(model: string | null | undefined): ModelPricing | null {
  if (!model) return null;
  const alias = model.toLowerCase();
  for (const [family, pricing] of Object.entries(MODEL_PRICING)) {
    if (alias.includes(family)) return pricing;
  }
  return null;
}

const MTOK = 1_000_000;

/** Compute one invocation's cost from its token counts, pricing the 1h and 5m cache-write buckets
 *  SEPARATELY (they are different rates — see ModelPricing).
 *
 *  When the CLI reported only the `cache_creation_input_tokens` TOTAL and no `cache_creation`
 *  breakdown, the whole total is priced at the 5m rate: 5m is the default TTL, so that is the
 *  correct assumption rather than a conservative one, and the alternative (dropping the cache-write
 *  cost entirely) would understate the invocation. When the breakdown IS present it is authoritative
 *  and the total is ignored — never both, which would double-count.
 *
 *  Returns null when there is no price row, or when there is nothing measured to price at all
 *  (every token count absent) — a genuine zero-token invocation is a real 0, an unmeasured one is
 *  not, and conflating them is what `cost_source: 'unknown'` exists to prevent. */
export function deriveCostUsd(
  parsed: Pick<
    ParsedClaudeResult,
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_read_input_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_creation_1h_input_tokens'
    | 'cache_creation_5m_input_tokens'
  >,
  pricing: ModelPricing | null,
): number | null {
  if (!pricing) return null;

  const measured = [
    parsed.input_tokens,
    parsed.output_tokens,
    parsed.cache_read_input_tokens,
    parsed.cache_creation_input_tokens,
    parsed.cache_creation_1h_input_tokens,
    parsed.cache_creation_5m_input_tokens,
  ].some((v) => typeof v === 'number');
  if (!measured) return null;

  const hasBreakdown =
    typeof parsed.cache_creation_1h_input_tokens === 'number' ||
    typeof parsed.cache_creation_5m_input_tokens === 'number';
  const write1h = hasBreakdown ? (parsed.cache_creation_1h_input_tokens ?? 0) : 0;
  const write5m = hasBreakdown
    ? (parsed.cache_creation_5m_input_tokens ?? 0)
    : (parsed.cache_creation_input_tokens ?? 0);

  const usd =
    ((parsed.input_tokens ?? 0) * pricing.input_per_mtok +
      (parsed.output_tokens ?? 0) * pricing.output_per_mtok +
      (parsed.cache_read_input_tokens ?? 0) * pricing.cache_read_per_mtok +
      write1h * pricing.cache_write_1h_per_mtok +
      write5m * pricing.cache_write_5m_per_mtok) /
    MTOK;
  return usd;
}

/** The ONE cost-resolution rule, so no caller re-decides it: PREFER the CLI's own
 *  `total_cost_usd` (`'cli'`); fall back to the derived figure when the CLI's is absent OR ZERO
 *  (a zero from the CLI means "not billed through this channel", not "this invocation was free");
 *  `'unknown'` with a null cost when neither is available. */
export function resolveCost(
  parsed: ParsedClaudeResult,
  model: string | null | undefined,
): { total_cost_usd: number | null; cost_source: 'cli' | 'derived' | 'unknown' } {
  if (typeof parsed.cli_cost_usd === 'number' && parsed.cli_cost_usd > 0) {
    return { total_cost_usd: parsed.cli_cost_usd, cost_source: 'cli' };
  }
  const derived = deriveCostUsd(parsed, resolvePricing(model));
  if (derived !== null) return { total_cost_usd: derived, cost_source: 'derived' };
  return { total_cost_usd: null, cost_source: 'unknown' };
}

// -----------------------------------------------------------------------------------------------
// The parse.
// -----------------------------------------------------------------------------------------------

// Named `asNumber`/`asString` rather than `num`/`str`: these are module-TOP-LEVEL bindings in a
// file esbuild bundles alongside vendored dependencies, and short generic names there force the
// bundler to rename the vendored code's own identifiers — turning a two-line source change into a
// several-hundred-line committed `dist/` diff for no reason.
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** JSON.parse the captured stdout, tolerantly. The whole capture is normally ONE JSON line, so the
 *  whole trimmed text is tried first; a capture that picked up a stray leading line (a wrapper's
 *  banner, a warning some future CLI prints before the envelope) falls back to the LAST line that
 *  parses as an object. Returns null when nothing in the text is a JSON object. */
function parseEnvelope(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const whole = JSON.parse(trimmed);
    if (whole && typeof whole === 'object' && !Array.isArray(whole)) {
      return whole as Record<string, unknown>;
    }
  } catch {
    // fall through to the per-line scan below
  }
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse one invocation's captured stdout into its measurements, or null when the text is not a
 *  claude result envelope at all (an older CLI that ignored `--output-format json`, a stub, an
 *  invocation that died before emitting anything). A null return is a legitimate, expected outcome
 *  — the caller records the invocation without measurements rather than recording nothing.
 *
 *  Never throws. */
export function parseClaudeResultJson(text: string): ParsedClaudeResult | null {
  const envelope = parseEnvelope(text);
  if (!envelope) return null;
  // `result` + `usage` are what make this a RESULT envelope rather than some other JSON that
  // happened to be on stdout; `is_error` alone is too generic to key on.
  if (!('result' in envelope) && !('usage' in envelope)) return null;

  const usage = (envelope.usage ?? {}) as ClaudeResultUsage;
  const cacheCreation = usage.cache_creation ?? {};

  return {
    // The trap: `is_error`, never `subtype` — an errored run still reports subtype 'success'.
    is_error: envelope.is_error === true,
    result: asString(envelope.result),
    session_id: asString(envelope.session_id),
    num_turns: asNumber(envelope.num_turns),
    duration_ms: asNumber(envelope.duration_ms),
    duration_api_ms: asNumber(envelope.duration_api_ms),
    service_tier: asString(envelope.service_tier) ?? asString(usage.service_tier),
    input_tokens: asNumber(usage.input_tokens),
    output_tokens: asNumber(usage.output_tokens),
    cache_read_input_tokens: asNumber(usage.cache_read_input_tokens),
    cache_creation_input_tokens: asNumber(usage.cache_creation_input_tokens),
    cache_creation_1h_input_tokens: asNumber(cacheCreation.ephemeral_1h_input_tokens),
    cache_creation_5m_input_tokens: asNumber(cacheCreation.ephemeral_5m_input_tokens),
    thinking_tokens: asNumber(usage.output_tokens_details?.thinking_tokens),
    cli_cost_usd: asNumber(envelope.total_cost_usd),
  };
}
