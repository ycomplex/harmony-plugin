#!/usr/bin/env node
// scripts/model-catalog-liveness-check.mjs
//
// B-881: the model_catalog LIVENESS check — the thing that keeps "one maintained list of models,
// checked against reality" true over time, not just at migration time. Reads every `active = true`
// row from `model_catalog` (via a service-role client — this needs write access, unlike the
// anon-key/JWT client src/supabase.ts builds for the CLI/MCP server), invokes the REAL `claude` CLI
// against each alias with a trivial one-shot prompt, and writes back the result:
//   - resolves cleanly  -> `verified_at = now()` (the freshness signal a human reviewing the table
//                          can trust — "this alias was confirmed real as of this timestamp").
//   - fails to resolve  -> `active = false` (a confirmed-dead alias is pulled out of the catalog
//                          IMMEDIATELY, not just flagged — this repo's isAllowedModelAlias/
//                          getModelContextBudgetBytes only ever select `active = true`, so this is
//                          what actually stops a bad name from reaching a run).
//
// NEVER SILENTLY SWALLOWS A CLI INVOCATION ERROR (the ticket's explicit ask): every failure — a
// `claude` invocation that errors, a Supabase read/write error, a missing secret — is logged to
// stderr with `::error::` (GitHub Actions' own annotation prefix, so it surfaces in the run's
// Checks tab, not just buried in the log body) and reflected in this script's exit code. This is a
// CHECK THAT RUNS, deliberately never faked in a unit test — see this file's own test coverage (or
// rather, the lack of it): the whole point is a REAL claude CLI invocation against a REAL model
// endpoint, which no mock can stand in for without defeating the check's purpose. Only the
// pure decision/parsing helpers below (decideGuard, parseVerifyResult) are unit-tested — the same
// split scripts/reembed-guard.mjs already established (pure decision logic tested, the actual
// external invocation exercised only by a real scheduled run).
//
// REQUIRED before a job can actually run this check (a human must add these — see this ticket's own
// build report, and .github/workflows/model-catalog-liveness.yml's matching header comment):
//   - repo secret            STAGING_SUPABASE_SERVICE_ROLE_KEY  (staging job)
//   - production env secret  PROD_SUPABASE_SERVICE_ROLE_KEY     (prod job, `production` environment)
//   - repo secret            ANTHROPIC_API_KEY                  (BOTH jobs — the `claude` CLI needs
//                                                                 this to invoke a model at all; this
//                                                                 build could not provision it — no
//                                                                 access to add real GitHub secrets)
// Any of the three missing -> DORMANT, exit 1 (fail loud, mirroring scripts/reembed-guard.mjs's own
// philosophy — a missing secret must never look like a clean, healthy skip).
//
// B-1053: after the per-alias sweep above, a SEPARATE assertion — "the model a conduction will
// run on is visible before it costs anything" — checks that the LIVE model_catalog's
// `pinned_default_profiles` column (a harmony-web migration; may not have landed on this
// environment's Supabase project yet, see checkPinnedDefaultLiveness below for the tolerance) agrees
// with this repo's own hand-edited PINNED_DEFAULT_MODEL_BY_PROFILE (src/config/run-config.ts) for
// this deployment profile. See mapLabelToPinnedProfile/decidePinnedDefaultCheck/
// checkPinnedDefaultLiveness below.
//
// Usage (invoked by the workflow):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ANTHROPIC_API_KEY=... \
//   node scripts/model-catalog-liveness-check.mjs <staging|production>

import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Pure, table-driven decision — which secret (if any) is missing.
 * @param {{ supabaseUrl?: string|null, supabaseKey?: string|null, anthropicKey?: string|null }} input
 * @returns {'dormant-supabase' | 'dormant-anthropic' | 'run'}
 */
export function decideGuard({ supabaseUrl, supabaseKey, anthropicKey } = {}) {
  const hasSupabase =
    typeof supabaseUrl === 'string' && supabaseUrl.trim() !== '' &&
    typeof supabaseKey === 'string' && supabaseKey.trim() !== '';
  if (!hasSupabase) return 'dormant-supabase';
  const hasAnthropic = typeof anthropicKey === 'string' && anthropicKey.trim() !== '';
  if (!hasAnthropic) return 'dormant-anthropic';
  return 'run';
}

/**
 * Was a `claude --model <alias> -p ...` invocation a confirmed success? Pure — takes the
 * spawnSync-shaped result, never spawns anything itself (that's runVerifyClaude below).
 * @param {{ status: number|null, stdout?: string, stderr?: string, error?: Error }} result
 * @returns {boolean}
 */
export function parseVerifyResult(result) {
  if (!result || result.error) return false;
  return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim().length > 0;
}

/** Spawns the REAL `claude` CLI — a minimal, real invocation that exits cleanly only if `alias`
 *  actually resolves to a runnable model. Injectable so the pure decision logic above can be
 *  exercised without ever touching a real binary; the DEFAULT is what a scheduled run actually
 *  executes. */
export function runVerifyClaude(alias, { spawn = spawnSync, timeoutMs = 60_000 } = {}) {
  return spawn('claude', ['--model', alias, '-p', 'Reply with exactly one word: OK'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// =================================================================================================
// B-1053: pinned-default liveness — "the model a conduction will run on is visible before it costs
// anything" — a SEPARATE assertion from the per-alias sweep above: does the LIVE catalog agree with
// this repo's own hand-edited pin for THIS deployment profile?
// =================================================================================================

/** B-1053: duplicated (never imported) from src/config/run-config.ts's
 *  PINNED_DEFAULT_MODEL_BY_PROFILE. This script runs under plain `node` with no TS loader and no
 *  committed `dist/` on `main` (see this repo's CLAUDE.md -> Versioning) — there is no runtime path
 *  from this .mjs file to that .ts module, so this is the SAME accepted-cost duplication
 *  run-config.ts's own header comment already documents for its copy of environment.ts's
 *  KNOWN_REFS (there: KNOWN_REFS_FOR_MODEL). Keep both copies in sync by hand. */
const PINNED_DEFAULT_MODEL_BY_PROFILE = {
  prod: 'claude-sonnet-5',
  staging: 'claude-sonnet-5',
};

/**
 * Maps THIS SCRIPT's own `<staging|production>` label argument to run-config.ts's
 * PINNED_DEFAULT_MODEL_BY_PROFILE key space. These are two DIFFERENT naming conventions, not a
 * typo — this script's label mirrors the GitHub Actions job name (`staging` / `production`);
 * run-config.ts's map (and its own KNOWN_REFS_FOR_MODEL / src/tools/environment.ts precedent) uses
 * the short Supabase-project-ref-derived name (`staging` / `prod`):
 *   'staging'    -> 'staging' (same word, coincidentally)
 *   'production' -> 'prod'    (the real mismatch this mapping exists to make explicit)
 * Anything else (e.g. this script's own CLI default label `'env'`, used only when invoked with no
 * argument at all) maps to `null` — "this assertion does not apply here", never a guess.
 * @param {string} label
 * @returns {'staging' | 'prod' | null}
 */
export function mapLabelToPinnedProfile(label) {
  const normalized = String(label ?? '').trim().toLowerCase();
  if (normalized === 'staging') return 'staging';
  if (normalized === 'production') return 'prod';
  return null;
}

/**
 * Pure decision over the result of querying model_catalog for the row(s) whose
 * `pinned_default_profiles` array contains this deployment's mapped profile. Never touches
 * Supabase/network itself — checkPinnedDefaultLiveness below does that and calls this.
 * @param {{ error?: { code?: string, message?: string } | null, rows?: Array<{ alias: string }> | null, expectedAlias: string }} input
 * @returns {{ kind: 'column-absent' }
 *   | { kind: 'query-error', message: string }
 *   | { kind: 'no-row' }
 *   | { kind: 'multiple-rows', aliases: string[] }
 *   | { kind: 'mismatch', liveAlias: string, expectedAlias: string }
 *   | { kind: 'match', alias: string }}
 */
export function decidePinnedDefaultCheck({ error, rows, expectedAlias } = {}) {
  if (error) {
    // Postgres' "column does not exist" — the companion harmony-web migration that adds
    // pinned_default_profiles may not have reached this environment's Supabase project yet
    // (B-383 prod-before-promote). This is the ONE error shape this assertion tolerates.
    if (error.code === '42703') {
      return { kind: 'column-absent' };
    }
    return { kind: 'query-error', message: error.message ?? String(error) };
  }
  const list = rows ?? [];
  if (list.length === 0) {
    return { kind: 'no-row' };
  }
  if (list.length > 1) {
    return { kind: 'multiple-rows', aliases: list.map((row) => row.alias) };
  }
  const liveAlias = list[0].alias;
  if (liveAlias !== expectedAlias) {
    return { kind: 'mismatch', liveAlias, expectedAlias };
  }
  return { kind: 'match', alias: liveAlias };
}

/**
 * The actual pinned-default assertion — queries the live `model_catalog` (same service-role
 * client the per-alias sweep already uses) and logs the outcome of decidePinnedDefaultCheck above.
 * NEVER throws. Returns whether this assertion should contribute to the overall exit code — the
 * same true/false-contributes-to-hadFailure shape runLivenessCheck's per-alias loop already uses;
 * matched deliberately rather than inventing a parallel accumulation pattern.
 *
 * Column-absent is the ONE outcome that must never register as a red/failing check on this
 * account — logged as a clearly-labeled WARNING (not `::error::`), and the rest of the script's
 * existing behavior proceeds unaffected.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {any} opts.client
 * @param {Record<string, string>} [opts.pinnedDefaultByProfile]
 * @param {(...args: any[]) => void} [opts.log]
 * @param {(...args: any[]) => void} [opts.errLog]
 * @returns {Promise<boolean>} true if this assertion failed (should flip hadFailure)
 */
export async function checkPinnedDefaultLiveness({
  label,
  client,
  pinnedDefaultByProfile = PINNED_DEFAULT_MODEL_BY_PROFILE,
  log = console.log,
  errLog = console.error,
}) {
  const LABEL = String(label).toUpperCase();
  const profile = mapLabelToPinnedProfile(label);

  if (profile === null) {
    log(
      `${LABEL} model-catalog liveness: no pinned-default profile mapping for label '${label}' — ` +
        'skipping the pinned-default assertion.',
    );
    return false;
  }

  const expectedAlias = pinnedDefaultByProfile[profile];
  const { data, error } = await client
    .from('model_catalog')
    .select('alias, pinned_default_profiles')
    .contains('pinned_default_profiles', [profile]);

  const decision = decidePinnedDefaultCheck({ error, rows: data, expectedAlias });

  switch (decision.kind) {
    case 'column-absent':
      log(
        `${LABEL} model-catalog liveness: WARNING — 'pinned_default_profiles' does not exist on ` +
          "model_catalog in this environment yet (the companion harmony-web migration hasn't " +
          'landed here) — skipping the pinned-default assertion this run.',
      );
      return false;
    case 'query-error':
      errLog(
        `::error::${LABEL} model-catalog liveness FAILED to read pinned_default_profiles ` +
          `(${decision.message}).`,
      );
      return true;
    case 'no-row':
      errLog(
        `::error::${LABEL} model-catalog liveness: no row in model_catalog is pinned as the ` +
          `default for profile '${profile}' — expected '${expectedAlias}'.`,
      );
      return true;
    case 'multiple-rows':
      errLog(
        `::error::${LABEL} model-catalog liveness: ${decision.aliases.length} rows are pinned as ` +
          `the default for profile '${profile}' (${decision.aliases.join(', ')}) — exactly one row ` +
          'must be pinned per profile.',
      );
      return true;
    case 'mismatch':
      errLog(
        `::error::${LABEL} model-catalog liveness: the LIVE pinned default for profile '${profile}' ` +
          `is '${decision.liveAlias}', but PINNED_DEFAULT_MODEL_BY_PROFILE expects ` +
          `'${decision.expectedAlias}' (src/config/run-config.ts) — these must agree.`,
      );
      return true;
    case 'match':
      log(
        `${LABEL} model-catalog liveness: pinned default for profile '${profile}' confirmed — ` +
          `'${decision.alias}'.`,
      );
      return false;
    default:
      return false;
  }
}

/**
 * Run the full liveness sweep and return the intended process exit code (does NOT call
 * process.exit, so it is unit-testable). Every external effect (Supabase client, claude
 * invocation, logging) is injectable.
 *
 * @param {object} [opts]
 * @param {string} [opts.label]
 * @param {string|null} [opts.supabaseUrl]
 * @param {string|null} [opts.supabaseKey]
 * @param {string|null} [opts.anthropicKey]
 * @param {(url: string, key: string) => any} [opts.createSupabaseClient]
 * @param {(alias: string) => { status: number|null, stdout?: string, stderr?: string, error?: Error }} [opts.verifyAlias]
 * @param {(...args: any[]) => void} [opts.log]
 * @param {(...args: any[]) => void} [opts.errLog]
 * @returns {Promise<number>}
 */
export async function runLivenessCheck({
  label = 'env',
  supabaseUrl = process.env.SUPABASE_URL,
  supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY,
  anthropicKey = process.env.ANTHROPIC_API_KEY,
  createSupabaseClient = createClient,
  verifyAlias = runVerifyClaude,
  checkPinnedDefault = checkPinnedDefaultLiveness,
  log = console.log,
  errLog = console.error,
} = {}) {
  const LABEL = String(label).toUpperCase();
  const decision = decideGuard({ supabaseUrl, supabaseKey, anthropicKey });

  if (decision === 'dormant-supabase') {
    errLog(
      `::error::${LABEL} model-catalog liveness DORMANT — SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing.`,
    );
    return 1;
  }
  if (decision === 'dormant-anthropic') {
    errLog(
      `::error::${LABEL} model-catalog liveness DORMANT — ANTHROPIC_API_KEY missing (the \`claude\` ` +
        'CLI needs this to invoke a model at all).',
    );
    return 1;
  }

  const client = createSupabaseClient(supabaseUrl, supabaseKey);
  const { data, error } = await client
    .from('model_catalog')
    .select('alias, label, context_budget_bytes, active, verified_at')
    .eq('active', true);

  if (error) {
    errLog(`::error::${LABEL} model-catalog liveness FAILED to read model_catalog (${error.message}).`);
    return 1;
  }

  const rows = data ?? [];
  let hadFailure = false;

  if (rows.length === 0) {
    log(`${LABEL} model-catalog liveness: zero active rows — nothing to verify.`);
  }

  for (const row of rows) {
    const result = verifyAlias(row.alias);
    if (parseVerifyResult(result)) {
      log(`${LABEL} model-catalog liveness: '${row.alias}' resolved OK.`);
      const { error: updateError } = await client
        .from('model_catalog')
        .update({ verified_at: new Date().toISOString() })
        .eq('alias', row.alias);
      if (updateError) {
        errLog(
          `::error::${LABEL} model-catalog liveness: '${row.alias}' verified OK but failed to ` +
            `write verified_at (${updateError.message}).`,
        );
        hadFailure = true;
      }
    } else {
      hadFailure = true;
      const detail = result?.error?.message ?? result?.stderr ?? `exit ${result?.status}`;
      errLog(
        `::error::${LABEL} model-catalog liveness: '${row.alias}' FAILED to resolve (${detail}) — ` +
          'flipping active=false.',
      );
      const { error: updateError } = await client
        .from('model_catalog')
        .update({ active: false })
        .eq('alias', row.alias);
      if (updateError) {
        errLog(
          `::error::${LABEL} model-catalog liveness: '${row.alias}' failed verification AND could ` +
            `not flip active=false (${updateError.message}) — this alias is STILL live in the ` +
            'catalog; a human must intervene directly.',
        );
      }
    }
  }

  // B-1053: pinned-default assertion — runs regardless of whether there were any active rows
  // above (an independent question: which row is pinned as the deployment default), and
  // contributes to the same hadFailure/exit-code accumulation as the per-alias loop.
  const pinnedFailed = await checkPinnedDefault({ label, client, log, errLog });
  if (pinnedFailed) hadFailure = true;

  return hadFailure ? 1 : 0;
}

// CLI entry — only when executed directly (not when imported by a test).
const invokedDirectly =
  Array.isArray(process.argv) &&
  typeof process.argv[1] === 'string' &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const label = process.argv[2] ?? 'env';
  runLivenessCheck({ label }).then((code) => process.exit(code));
}
