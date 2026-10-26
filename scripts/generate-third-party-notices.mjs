#!/usr/bin/env node
// Generate dist/THIRD_PARTY_NOTICES from the esbuild metafile (B-1295).
//
// The Harmony plugin is proprietary (see LICENSE), but its built bundle inlines
// third-party open-source packages from node_modules. Their licenses require
// that the license text travel with every copy, and the bundle is what gets
// copied: the marketplace serves the generated `dist/` from `staging`/`prod`.
// So the notices are GENERATED at build time, next to the bundle, from the
// exact set of packages esbuild put into it, never hand-maintained.
//
// HOW
//   1. `npm run build` passes `--metafile=.build/meta.json` to esbuild (esbuild
//      creates `.build/` itself). Every input under `node_modules/` is mapped
//      to its package root (the LAST `node_modules/` segment, so nested copies
//      are their own packages) and deduped.
//   2. Each package's package.json supplies name, version, license (or the
//      legacy `licenses` array), author and repository. Its license file is
//      the first case-insensitive match of LICENSE*, then LICENCE*, then
//      COPYING*; a NOTICE* file is reproduced as well when present.
//   3. A package that ships NO license file gets its declared SPDX license's
//      canonical text from the templates below, with the copyright holder
//      filled from the declared author, and the section is marked as
//      reconstructed. No license file AND no declared license, or a declared
//      license with no template, FAILS the build naming the package.
//   4. Cross-check: the package set named by the `// node_modules/<pkg>/`
//      boundary comments in dist/**/*.js must equal the metafile-derived set.
//      A difference fails the build and prints both sides, so the notices can
//      never silently drift from what the bundle actually contains.
//
// The output is deterministic (sorted, no timestamps, LF, trailing newline):
// two clean builds produce byte-identical notices.
//
// Runs as part of npm `postbuild`, AFTER normalize-dist-comments.mjs (the
// cross-check reads the canonicalized boundary comments).
//
// Dependency-free (node: built-ins only): the marketplace install skips
// `npm install`, so anything in the build path must run with zero deps.
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SEPARATOR = "=".repeat(78);

export const HEADER = [
  "THIRD-PARTY NOTICES",
  "",
  "This file lists the third-party open-source components bundled into the",
  "Harmony plugin's built files. Each component remains under its own license,",
  "reproduced below. The YCOMPLEX LTD proprietary license (see LICENSE) does",
  "not cover these components.",
].join("\n");

// --- Canonical SPDX license texts (fallback only) ---------------------------------------------
// Used ONLY when a package ships no license file. `{{holder}}` is the copyright holder. The texts
// are the canonical SPDX ones; where the canonical text carries a `<year>` placeholder the year is
// omitted (package metadata does not declare one). Blue Oak 1.0.0 has no copyright line of its
// own, so the holder line is prepended above the unchanged license text.
const MIT_TEXT = `MIT License

Copyright (c) {{holder}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const ISC_TEXT = `ISC License

Copyright (c) {{holder}}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

const ZERO_BSD_TEXT = `Copyright (C) {{holder}}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;

const BSD_DISCLAIMER = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

const BSD_2_TEXT = `Copyright (c) {{holder}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

${BSD_DISCLAIMER}`;

const BSD_3_TEXT = `Copyright (c) {{holder}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

${BSD_DISCLAIMER}`;

const BLUE_OAK_TEXT = `Copyright (c) {{holder}}

# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules. The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice. If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

**_As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim._**
`;

const TEMPLATES = Object.freeze({
  MIT: MIT_TEXT,
  ISC: ISC_TEXT,
  "0BSD": ZERO_BSD_TEXT,
  "BSD-2-Clause": BSD_2_TEXT,
  "BSD-3-Clause": BSD_3_TEXT,
  "BlueOak-1.0.0": BLUE_OAK_TEXT,
});

/** The canonical license text for an SPDX id, with the holder filled in; null when no template. */
export function spdxTemplate(spdx, holder) {
  if (typeof spdx !== "string" || !Object.hasOwn(TEMPLATES, spdx)) return null;
  return TEMPLATES[spdx].replaceAll("{{holder}}", holder);
}

// --- Path -> package mapping ------------------------------------------------------------------

/**
 * Map a metafile input path (or a dist boundary-comment path) to its package.
 * Uses the LAST `node_modules/` segment, so `node_modules/a/node_modules/b/x.js` is package `b`.
 * Returns `{ name, root, canonicalRoot }` — `root` keeps any leading `../` (it is cwd-relative and
 * is what resolves on disk), `canonicalRoot` strips it like normalize-dist-comments.mjs does — or
 * null when the path is not under node_modules.
 */
export function packageFromInputPath(inputPath) {
  const marker = "node_modules/";
  const idx = inputPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = inputPath.slice(idx + marker.length).split("/");
  const scoped = rest[0].startsWith("@");
  if (!rest[0] || (scoped && !rest[1])) return null;
  const name = scoped ? `${rest[0]}/${rest[1]}` : rest[0];
  const root = inputPath.slice(0, idx + marker.length) + name;
  const canonicalRoot = root.replace(/^(?:\.\.\/)+/, "");
  return { name, root, canonicalRoot };
}

/** Every distinct package root named by a metafile's inputs, keyed by canonical root. */
export function packagesFromMeta(meta) {
  const byRoot = new Map();
  for (const input of Object.keys(meta.inputs ?? {})) {
    const pkg = packageFromInputPath(input);
    if (pkg && !byRoot.has(pkg.canonicalRoot)) byRoot.set(pkg.canonicalRoot, pkg);
  }
  return [...byRoot.values()].sort((a, b) => cmp(a.canonicalRoot, b.canonicalRoot));
}

/** The package-name set named by `// node_modules/<pkg>/` boundary comments in bundle text. */
export function packageNamesFromBundle(content) {
  const names = new Set();
  for (const m of content.matchAll(/^\/\/ ((?:\.\.\/)*node_modules\/\S+)$/gm)) {
    const pkg = packageFromInputPath(m[1]);
    if (pkg) names.add(pkg.name);
  }
  return names;
}

/**
 * Compare the metafile-derived and boundary-comment-derived package-name sets.
 * Returns `{ ok, onlyInMeta, onlyInDist }` with both differences sorted.
 */
export function crossCheck(metaNames, distNames) {
  const meta = new Set(metaNames);
  const dist = new Set(distNames);
  const onlyInMeta = [...meta].filter((n) => !dist.has(n)).sort(cmp);
  const onlyInDist = [...dist].filter((n) => !meta.has(n)).sort(cmp);
  return { ok: onlyInMeta.length === 0 && onlyInDist.length === 0, onlyInMeta, onlyInDist };
}

// --- package.json metadata --------------------------------------------------------------------

/** The declared license: `license` (string or legacy `{ type }`), else the legacy `licenses` array. */
export function declaredLicense(pkgJson) {
  const { license, licenses } = pkgJson;
  if (typeof license === "string" && license.trim()) return license.trim();
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type.trim();
  }
  if (Array.isArray(licenses)) {
    const ids = licenses
      .map((l) => (typeof l === "string" ? l : l && typeof l.type === "string" ? l.type : ""))
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) return `(${ids.join(" OR ")})`;
  }
  return null;
}

/** The author as one string: a string author verbatim, an object as `name <email> (url)`. */
export function authorString(author) {
  if (typeof author === "string") return author.trim() || null;
  if (author && typeof author === "object" && typeof author.name === "string" && author.name.trim()) {
    let s = author.name.trim();
    if (typeof author.email === "string" && author.email) s += ` <${author.email}>`;
    if (typeof author.url === "string" && author.url) s += ` (${author.url})`;
    return s;
  }
  return null;
}

/** A browsable repository URL from package.json's `repository`, or null. */
export function repositoryUrl(repository) {
  let url = typeof repository === "string" ? repository : repository?.url;
  if (typeof url !== "string" || !url.trim()) return null;
  url = url.trim();
  const shorthand = url.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
  if (shorthand) return `https://github.com/${shorthand[1]}`;
  url = url
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^git:\/\//, "https://")
    .replace(/^http:\/\//, "https://")
    .replace(/\.git$/, "");
  return url;
}

// --- Notices rendering ------------------------------------------------------------------------

/** Codepoint comparison — locale-independent, so the output is identical on every machine. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Version order: dot-separated parts, numeric where both parts are numeric. */
function cmpVersion(a, b) {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return cmp(x, y);
  }
  return 0;
}

/** LF line endings, no trailing blank lines, exactly one trailing newline. */
function tidy(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\s+$/, "") + "\n";
}

/**
 * The license body for one package record. A record is
 * `{ name, version, license, author, repository, licenseText, noticeText }` (`licenseText` /
 * `noticeText` null when the package ships no such file). Throws, naming the package, when there
 * is no license file and the declared license is missing or has no template.
 */
export function licenseSection(record) {
  if (record.licenseText) return { text: tidy(record.licenseText), reconstructed: false };
  if (!record.license) {
    throw new Error(
      `${record.name}@${record.version} ships no license file and declares no license — ` +
        "cannot produce its notice. Resolve this before the package can be bundled.",
    );
  }
  const holder = record.author || `${record.name} contributors`;
  const text = spdxTemplate(record.license, holder);
  if (text === null) {
    throw new Error(
      `${record.name}@${record.version} ships no license file and declares license ` +
        `"${record.license}", which has no template (known: ${Object.keys(TEMPLATES).join(", ")}). ` +
        "Add a template for it, or resolve the package's license text another way.",
    );
  }
  return {
    text:
      `License text reconstructed from package metadata (declared license: ${record.license}); ` +
      "the package ships no license file.\n\n" +
      tidy(text),
    reconstructed: true,
  };
}

/** The full THIRD_PARTY_NOTICES text for a list of package records. Pure and deterministic. */
export function buildNotices(records) {
  const unique = new Map();
  for (const r of records) {
    const key = `${r.name}@${r.version}`;
    if (!unique.has(key)) unique.set(key, r);
  }
  const sorted = [...unique.values()].sort(
    (a, b) => cmp(a.name, b.name) || cmpVersion(a.version, b.version),
  );
  const parts = [HEADER];
  for (const r of sorted) {
    const lines = [SEPARATOR, `${r.name}@${r.version}`, `License: ${r.license ?? "UNKNOWN"}`];
    if (r.repository) lines.push(`Repository: ${r.repository}`);
    let block = lines.join("\n") + "\n\n" + licenseSection(r).text;
    if (r.noticeText) block += "\nNOTICE:\n\n" + tidy(r.noticeText);
    parts.push(block.replace(/\n$/, ""));
  }
  return tidy(parts.join("\n\n"));
}

// --- Filesystem side --------------------------------------------------------------------------

// Source/data files that merely share a license-ish name (license.js, licence.json, ...) are code,
// not license text, and must never be reproduced as a notice.
const NOT_LICENSE_TEXT = /\.(js|mjs|cjs|ts|json|map)$/i;

/**
 * The single root file whose name starts (case-insensitively) with one of `prefixes`, excluding
 * code/data files; null when none matches. More than one candidate is a FAILURE, never a silent
 * pick: reproducing only one of several license files would drop a notice without anyone noticing.
 * `pkgName` only labels the error.
 */
export function findLicenseFile(entries, prefixes, pkgName = "<package>") {
  const lowered = prefixes.map((p) => p.toLowerCase());
  const candidates = [...entries]
    .filter((e) => !NOT_LICENSE_TEXT.test(e))
    .filter((e) => lowered.some((p) => e.toLowerCase().startsWith(p)))
    .sort(cmp);
  if (candidates.length > 1) {
    throw new Error(
      `${pkgName} ships more than one ${prefixes.join("/")} file (${candidates.join(", ")}) — ` +
        `reproduce them all deliberately before bundling it; refusing to pick one silently.`,
    );
  }
  return candidates[0] ?? null;
}

function readRecord(repoRoot, pkg) {
  const dir = resolve(repoRoot, pkg.root);
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`${pkg.name} (${pkg.canonicalRoot}) has no package.json — cannot read its license.`);
  }
  const json = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
  const licenseFile = findLicenseFile(files, ["LICENSE", "LICENCE", "COPYING"], pkg.name);
  const noticeFile = findLicenseFile(files, ["NOTICE"], pkg.name);
  return {
    name: json.name ?? pkg.name,
    version: json.version ?? "0.0.0",
    license: declaredLicense(json),
    author: authorString(json.author),
    repository: repositoryUrl(json.repository),
    licenseText: licenseFile ? readFileSync(join(dir, licenseFile), "utf8") : null,
    noticeText: noticeFile ? readFileSync(join(dir, noticeFile), "utf8") : null,
  };
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort(cmp)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectJsFiles(full));
    else if (full.endsWith(".js")) out.push(full);
  }
  return out;
}

function main() {
  // Resolve everything relative to this script, not cwd, so it works from any worktree.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const metaPath = join(repoRoot, ".build", "meta.json");
  const distDir = join(repoRoot, "dist");
  if (!existsSync(metaPath)) {
    throw new Error(`${metaPath} is missing — the esbuild build must run with --metafile=.build/meta.json.`);
  }
  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const packages = packagesFromMeta(meta);

  const distNames = new Set();
  for (const file of collectJsFiles(distDir)) {
    for (const n of packageNamesFromBundle(readFileSync(file, "utf8"))) distNames.add(n);
  }
  const check = crossCheck(
    packages.map((p) => p.name),
    distNames,
  );
  if (!check.ok) {
    throw new Error(
      "the metafile and the dist/ boundary comments disagree on the bundled package set.\n" +
        `  only in .build/meta.json: ${check.onlyInMeta.join(", ") || "(none)"}\n` +
        `  only in dist/ comments:   ${check.onlyInDist.join(", ") || "(none)"}`,
    );
  }

  const records = packages.map((p) => readRecord(repoRoot, p));
  writeFileSync(join(distDir, "THIRD_PARTY_NOTICES"), buildNotices(records));
  const fallback = records.filter((r) => !r.licenseText).length;
  console.log(
    `generate-third-party-notices: wrote dist/THIRD_PARTY_NOTICES — ${records.length} package(s), ` +
      `${fallback} from the license-template fallback`,
  );
}

// Run only when invoked directly (node scripts/...), not on import (the vitest suite imports the
// pure functions without triggering the filesystem walk).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (err) {
    console.error(`generate-third-party-notices: FAILED — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
