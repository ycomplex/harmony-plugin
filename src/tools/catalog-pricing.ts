// B-1179: a leg's price, read from its model-catalog row.
//
// The catalog row is the FIRST source of a derived cost: when the row carries all three prices
// (`input_usd_per_mtok`, `cached_input_usd_per_mtok`, `output_usd_per_mtok`), the leg is priced from
// them. Otherwise the caller falls back to the in-code tables (MODEL_PRICING / CODEX_PRICING in
// claude-result-parse.ts), and after that to a null cost with cost_source 'unknown' — never to zero.
//
// The price columns arrive with B-1177, so on a board without them the read fails with an
// undefined-column error. That is the EXPECTED shape until then, and it degrades to "no row price"
// (one stderr warning line), never to a throw and never to a zero. The same holds for any other
// failure: this read is best-effort, and `harmony leg-cost record` writes its row regardless.
//
// The price read deliberately includes INACTIVE rows: a row's price is a fact of the row regardless
// of activation, and an explicitly named inactive offer can still launch a leg (B-1179 — the
// OpenRouter offers run bake-off legs while still seeded active=false). matchRow's single-match rule
// still guards duplicates across active and inactive rows alike. The activation-scoped reads
// (list-aliases, the pinned defaults) live in src/config/run-config.ts and are unaffected.

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_AGENT_ADAPTER, isMissingCatalogColumnError } from '../config/run-config.js';

/** The three per-million-token USD prices one catalog row carries. `input_per_mtok` is the
 *  uncached input rate; `cached_input_per_mtok` is the cache-READ rate. The Claude cache-WRITE
 *  rates are derived from the input rate by the caller (claude-result-parse.ts's rowToModelPricing),
 *  so a row needs no column for them. */
export interface CatalogRowPrice {
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
  /** OpenAI's input threshold and second rate set, when the offer publishes a long-context tier. */
  long_context_threshold_tokens?: number | null;
  long_context_price?: {
    input_per_mtok: number;
    cached_input_per_mtok: number;
    output_per_mtok: number;
  } | null;
}

/** The columns read here — a narrow select, so nothing else on the row can fail the read. */
interface PricedCatalogRow {
  alias?: string | null;
  model_id?: string | null;
  agent?: string | null;
  input_usd_per_mtok?: unknown;
  cached_input_usd_per_mtok?: unknown;
  output_usd_per_mtok?: unknown;
  long_context_threshold_tokens?: unknown;
  long_context_input_usd_per_mtok?: unknown;
  long_context_cached_input_usd_per_mtok?: unknown;
  long_context_output_usd_per_mtok?: unknown;
}

const warn = (msg: string): void => console.error(`harmony leg-cost: WARNING — ${msg}`);

/** The model string with an optional, case-insensitive `codex:` catalog prefix removed. */
const stripCodexPrefix = (s: string): string => s.trim().replace(/^codex:/i, '');

/** A price counts only when it is a finite number >= 0. */
const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isTokenThreshold = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The ONE row `model` names within `runtime`, or null when none or several do. An EXACT alias
 *  match wins; otherwise a row matches when its model_id (or its alias), prefix-stripped, equals the
 *  prefix-stripped model. Several matches mean several offers share the id at possibly different
 *  prices, so no row is chosen: never guess. */
function matchRow(rows: readonly PricedCatalogRow[], model: string, runtime: string): PricedCatalogRow | null {
  const inRuntime = rows.filter((row) => (row.agent || DEFAULT_AGENT_ADAPTER) === runtime);
  const byAlias = inRuntime.filter((row) => row.alias === model);
  if (byAlias.length > 0) return byAlias.length === 1 ? byAlias[0] : null;
  const id = stripCodexPrefix(model);
  const byId = inRuntime.filter(
    (row) =>
      (typeof row.model_id === 'string' && stripCodexPrefix(row.model_id) === id) ||
      (typeof row.alias === 'string' && stripCodexPrefix(row.alias) === id),
  );
  return byId.length === 1 ? byId[0] : null;
}

/** The catalog price of `model` on `runtime` (null runtime = 'claude-code'), or null when the
 *  catalog cannot say: no client, no model, a read error (a missing price column included), no
 *  single matching row, or a row with any of its three prices unset. A null tells the caller to fall
 *  back to the in-code tables. The read deliberately includes inactive rows, because an explicitly
 *  named inactive offer can still launch (B-1179); activation-scoped reads such as list-aliases and
 *  the pinned defaults are in run-config.ts and unaffected. NEVER THROWS. */
export async function fetchCatalogPrice(
  client: SupabaseClient | null | undefined,
  model: string | null | undefined,
  runtime: string | null | undefined,
): Promise<CatalogRowPrice | null> {
  if (!client || !model) return null;
  try {
    const { data, error } = (await client
      .from('model_catalog')
      .select('alias, model_id, agent, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok, long_context_threshold_tokens, long_context_input_usd_per_mtok, long_context_cached_input_usd_per_mtok, long_context_output_usd_per_mtok')) as { data: unknown; error: { code?: string; message?: string } | null };
    if (error) {
      warn(
        isMissingCatalogColumnError(error)
          ? `model_catalog has no price columns on this board yet (${error.message ?? error.code}); pricing from the in-code tables`
          : `could not read model_catalog prices (${error.message ?? String(error)}); pricing from the in-code tables`,
      );
      return null;
    }
    if (!Array.isArray(data)) return null;
    const row = matchRow(data as PricedCatalogRow[], model, runtime || DEFAULT_AGENT_ADAPTER);
    if (!row) return null;
    const {
      input_usd_per_mtok: input,
      cached_input_usd_per_mtok: cached,
      output_usd_per_mtok: output,
      long_context_threshold_tokens: threshold,
      long_context_input_usd_per_mtok: longInput,
      long_context_cached_input_usd_per_mtok: longCached,
      long_context_output_usd_per_mtok: longOutput,
    } = row;
    if (!isPrice(input) || !isPrice(cached) || !isPrice(output)) return null;
    const long_context_price = isPrice(longInput) && isPrice(longCached) && isPrice(longOutput)
      ? { input_per_mtok: longInput, cached_input_per_mtok: longCached, output_per_mtok: longOutput }
      : null;
    return {
      input_per_mtok: input,
      cached_input_per_mtok: cached,
      output_per_mtok: output,
      long_context_threshold_tokens: isTokenThreshold(threshold) ? threshold : null,
      long_context_price,
    };
  } catch (err: unknown) {
    warn(`reading model_catalog prices threw (${err instanceof Error ? err.message : String(err)}); pricing from the in-code tables`);
    return null;
  }
}
