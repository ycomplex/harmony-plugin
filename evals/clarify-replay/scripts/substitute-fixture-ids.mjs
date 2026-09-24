// B-1081 -- substitute each case's `__FIXTURE_TICKET_ID__` with its fixture-project ticket id.
//
// Every replay case's prompt.md is committed with the literal placeholder `__FIXTURE_TICKET_ID__`
// (RUNBOOK.md §4). The fixture project (key FX on the staging Supabase project) preserves the
// production ticket NUMBERS, so case `B-293` targets `FX-293`. Until 2026-09-24 this was a hand-run
// `sed` that no CI or worker run ever performed -- the first genuinely completed CI run showed the
// clarify skill being asked about a ticket literally named `__FIXTURE_TICKET_ID__` (B-1081).
//
// Run it AFTER fetch-labels.mjs and BEFORE `claude plugin eval`. Idempotent: a prompt already
// carrying a substituted id is left alone. WORKING TREE ONLY -- prompt.md is tracked; never commit
// a substituted prompt (restore with `git checkout -- evals/clarify-replay/cases/*/prompt.md`).
//
//   node evals/clarify-replay/scripts/substitute-fixture-ids.mjs            # all B-* cases
//   node evals/clarify-replay/scripts/substitute-fixture-ids.mjs B-293 B-818 # a subset
//   FIXTURE_PROJECT_KEY=QA node evals/clarify-replay/scripts/substitute-fixture-ids.mjs
//
// Zero-build .mjs, same reasoning as fetch-labels.mjs's header.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = '__FIXTURE_TICKET_ID__';

/** Pure: the substituted prompt text, or null when nothing changed. `caseDir` is the case
 *  directory NAME (e.g. `B-293`); only `<KEY>-<n>` directories are substituted -- the two
 *  `ctrl-*` calibration controls carry no placeholder and are skipped by construction. */
export function substitutePrompt(prompt, caseDir, projectKey = 'FX') {
  const m = /^[A-Z]+-(\d+)$/.exec(caseDir);
  if (!m) return null;
  if (!prompt.includes(PLACEHOLDER)) return null;
  return prompt.split(PLACEHOLDER).join(`${projectKey}-${m[1]}`);
}

export function substituteAll(casesDir, { only = null, projectKey = 'FX', log = () => {} } = {}) {
  const results = { substituted: [], unchanged: [], skipped: [] };
  for (const name of readdirSync(casesDir).sort()) {
    if (only && !only.includes(name)) continue;
    const promptPath = join(casesDir, name, 'prompt.md');
    let prompt;
    try { prompt = readFileSync(promptPath, 'utf8'); } catch { results.skipped.push(name); continue; }
    const next = substitutePrompt(prompt, name, projectKey);
    if (next === null) { results.unchanged.push(name); continue; }
    writeFileSync(promptPath, next);
    results.substituted.push(name);
    log(`OK   ${name} -> ${projectKey}-${name.split('-')[1]} (${promptPath})`);
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const here = dirname(fileURLToPath(import.meta.url));
  const casesDir = join(here, '..', 'cases');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const projectKey = process.env.FIXTURE_PROJECT_KEY || 'FX';
  const r = substituteAll(casesDir, { only: only.length ? only : null, projectKey, log: console.log });
  console.log(`substitute-fixture-ids: ${r.substituted.length} substituted, ${r.unchanged.length} unchanged (already substituted or no placeholder), ${r.skipped.length} without prompt.md`);
  console.log('WORKING TREE ONLY -- restore before committing: git checkout -- evals/clarify-replay/cases/*/prompt.md');
}
