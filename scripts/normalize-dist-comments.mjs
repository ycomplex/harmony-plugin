#!/usr/bin/env node
// Normalize esbuild's cwd-relative node_modules paths in the committed dist/ bundle (B-553).
//
// `npm run build` runs esbuild, which records each bundled module's path
// relative to the current working directory in TWO places:
//   1. a `// node_modules/<pkg>/...` boundary comment, and
//   2. a `"node_modules/<pkg>/..."(exports) { ... }` module key inside the
//      __commonJS / __esm wrappers it generates for CJS/ESM-shimmed deps.
// Built from the repo root (node_modules is ./node_modules) both forms are
// repo-relative. Built from a nested git worktree WITHOUT a local node_modules,
// Node resolves dependencies from an ancestor (e.g. plugin/node_modules, two
// levels up), so esbuild bakes `../../node_modules/...` into BOTH forms. That
// cwd-dependent prefix is the only difference, and it makes `verify:dist`
// (rm -rf dist && npm run build && git diff --exit-code dist) fail against a
// root/CI checkout even though nothing semantic changed — a clean local green,
// a red CI, uncatchable locally.
//
// This canonicalizes both forms back to repo-relative so the build is
// cwd-invariant: a worktree build produces byte-identical dist to a root build.
// Run automatically as npm `postbuild`, so it applies inside every
// `npm run build` — including the one verify:dist invokes and the one CI runs.
//
// Dependency-free (node: built-ins only): the marketplace install skips
// `npm install`, so anything in the build path must run with zero deps.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Strip a leading run of `../` segments immediately before `node_modules/`,
// after either delimiter esbuild emits the path with: a `// ` boundary comment
// or a `"` module key. Both are non-executable bundler artifacts (the bundle is
// self-contained — nothing resolves these at runtime), so a real source change
// still diffs; this only removes the spurious cwd noise. Idempotent: a root
// build (already `node_modules/`) is left untouched.
export function normalize(content) {
  return content.replace(/(\/\/ |")(?:\.\.\/)+(node_modules\/)/g, "$1$2");
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectJsFiles(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

function main() {
  // Resolve dist relative to this script, not cwd, so it works from any worktree.
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  let changed = 0;
  for (const file of collectJsFiles(distDir)) {
    const before = readFileSync(file, "utf8");
    const after = normalize(before);
    if (after !== before) {
      writeFileSync(file, after);
      changed++;
    }
  }
  if (changed > 0) {
    console.log(
      `normalize-dist-comments: canonicalized node_modules paths in ${changed} file(s)`,
    );
  }
}

// Run the dist walk only when invoked directly (node scripts/...), not on import
// (the vitest pin imports `normalize` without triggering the walk).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
