#!/usr/bin/env node
// B-1037 -- clarify-replay eval CI wiring: AC4's sanitizer.
//
// A `claude plugin eval` JSON result embeds each grader's own definition alongside its verdict --
// for an `llm` grader that means the FULL rubric text, which for every real case (not the two
// judge-calibration controls) carries the ratified production label embedded in it (see
// scripts/fetch-labels.mjs's writeJudge -- judge.md's marker heading is
// "## THE RATIFIED LABEL — <ticket>: <title>"). That content must never reach an uploaded CI
// artifact (labels are product-decision content, fetched fresh into a gitignored file specifically
// so they are never committed OR published anywhere else -- see RUNBOOK.md).
//
// This script strips every grader's `criteria` / `graderMarkdown` / `config.criteria` field
// (whichever the result JSON's shape actually carries per grader -- all three are stripped
// unconditionally, present or not) from a DEEP CLONE of the input, and writes the result. The CI
// step that calls this is not the only enforcement: the workflow ALSO greps the sanitized output
// for the judge.md marker heading and FAILS the job on any hit -- this script's job is the strip,
// the workflow's grep is the proof (see evals/clarify-replay/ci/skill-eval.yml.proposed).
//
// Usage:
//   node evals/clarify-replay/scripts/sanitize-eval-result.mjs <in.json> <out.json>

import { readFileSync, writeFileSync } from 'node:fs';

const STRIPPED_KEYS = ['criteria', 'graderMarkdown'];

/** Recursively walk a plain-JSON value, stripping `criteria` / `graderMarkdown` from every object
 *  (wherever they appear -- a grader's shape in the result JSON is not pinned here, so this does
 *  not assume a fixed path), and additionally stripping `criteria` specifically from any nested
 *  `config` object (covers `config.criteria`). Pure function, no I/O -- exported for testing. */
export function sanitizeEvalResult(value) {
  if (Array.isArray(value)) return value.map(sanitizeEvalResult);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (STRIPPED_KEYS.includes(key)) continue; // drop criteria / graderMarkdown at ANY level
      if (key === 'config' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const { criteria: _dropped, ...restConfig } = val;
        out[key] = sanitizeEvalResult(restConfig);
        continue;
      }
      out[key] = sanitizeEvalResult(val);
    }
    return out;
  }
  return value;
}

function main() {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('Usage: node sanitize-eval-result.mjs <in.json> <out.json>');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(inPath, 'utf8'));
  } catch (err) {
    console.error(`sanitize-eval-result: cannot read/parse ${inPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const sanitized = sanitizeEvalResult(parsed);
  writeFileSync(outPath, `${JSON.stringify(sanitized, null, 2)}\n`);
  console.log(`sanitize-eval-result: wrote ${outPath} (stripped criteria/graderMarkdown/config.criteria at every level)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
