#!/usr/bin/env bash
# =================================================================================================
# scripts/check-generated-artifacts.sh — B-1007: the INVERTED PR gate.
#
# It replaces "Require plugin.json version bump" (B-778), which demanded the opposite of what the
# three-branch topology wants. Under that topology `main` is SOURCE ONLY: the version and the built
# `dist/` are GENERATED on `staging` by scripts/generate-staging.sh. So a pull request into `main`
# must NOT carry either of them — those were exactly the two files every plugin PR used to collide
# on, and a hand-edit of them on `main` would be silently overwritten by the next generation run.
#
# TWO BEHAVIOURS
#   1. ORDINARY PR -> FORBID. Fail if the PR changes `.claude-plugin/plugin.json`'s `version` field,
#      or touches any path under `dist/**`.
#   2. THE CUTOVER PR -> PASS. Exactly one transition is allowed: the B-1007 cutover itself, which
#      by construction must delete the tracked dist/ and set the version to the inert 0.0.0-dev.
#      The signature is the CONJUNCTION of both halves on BOTH sides:
#           base: tracked dist/ present  AND  a real (non-0.0.0) version
#           head: NO tracked dist/       AND  version exactly 0.0.0-dev
#      A PR that only deletes dist/, or only sets 0.0.0-dev, is NOT the cutover signature and is
#      still forbidden.
#
# FAIL-CLOSED (inherited from B-778, deliberately preserved): an unreadable base, a missing
# manifest, unparseable JSON or a non-semver version FAILS. There is no path on which a problem
# this gate cannot evaluate turns into a silent pass.
#
# USAGE
#   scripts/check-generated-artifacts.sh <base-ref> [head-ref]
#   HARMONY_GATE_BASE_REF=<sha> HARMONY_GATE_HEAD_REF=<sha> scripts/check-generated-artifacts.sh
#
# Both refs are parameters (env-var fallbacks) so CI can pass the PR's base/head SHAs and the unit
# tests can drive the same code against local git fixtures.
# =================================================================================================
set -euo pipefail

BASE_REF="${1:-${HARMONY_GATE_BASE_REF:-}}"
HEAD_REF="${2:-${HARMONY_GATE_HEAD_REF:-HEAD}}"
MANIFEST=".claude-plugin/plugin.json"
INERT_VERSION="0.0.0-dev"

fail() { echo "check-generated-artifacts: $*" >&2; exit 1; }

[ -n "$BASE_REF" ] || fail "no base ref given (argument 1, or HARMONY_GATE_BASE_REF) — cannot evaluate, failing closed."

# Read + validate ONE side's manifest version. Any failure here is a hard failure: unreadable ref,
# missing manifest, unparseable JSON, absent or non-semver version.
read_version() { # $1 = ref
  local ref="$1" raw version
  raw="$(git show "$ref:$MANIFEST" 2>/dev/null)" \
    || fail "cannot read $MANIFEST at $ref — failing closed."
  version="$(printf '%s' "$raw" | node -e '
    let d = "";
    process.stdin.on("data", (c) => (d += c));
    process.stdin.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(d); } catch (e) { console.error(`unparseable JSON: ${e.message}`); process.exit(1); }
      const v = parsed && parsed.version;
      if (typeof v !== "string" || !/^\d+\.\d+\.\d+/.test(v.trim())) {
        console.error(`missing or non-semver version: ${JSON.stringify(v)}`);
        process.exit(1);
      }
      console.log(v.trim());
    });
  ')" || fail "cannot parse $MANIFEST at $ref — failing closed."
  printf '%s' "$version"
}

# Whether a ref tracks any file under dist/.
tracks_dist() { # $1 = ref
  local listed
  listed="$(git ls-tree -r --name-only "$1" -- dist 2>/dev/null)" \
    || fail "cannot list the tree at $1 — failing closed."
  [ -n "$listed" ]
}

BASE_VERSION="$(read_version "$BASE_REF")"
HEAD_VERSION="$(read_version "$HEAD_REF")"
echo "check-generated-artifacts: base=$BASE_REF version=$BASE_VERSION | head=$HEAD_REF version=$HEAD_VERSION"

BASE_TRACKS_DIST=0; tracks_dist "$BASE_REF" && BASE_TRACKS_DIST=1
HEAD_TRACKS_DIST=0; tracks_dist "$HEAD_REF" && HEAD_TRACKS_DIST=1

# --- The one allowed transition: the B-1007 cutover ------------------------------------------------
if [ "$BASE_TRACKS_DIST" = "1" ] && [ "$HEAD_TRACKS_DIST" = "0" ] \
   && [ "$HEAD_VERSION" = "$INERT_VERSION" ] \
   && ! printf '%s' "$BASE_VERSION" | grep -Eq '^0\.0\.0'; then
  echo "check-generated-artifacts: OK — recognised the B-1007 cutover signature (base tracked dist/ at v$BASE_VERSION; head tracks none and is inert at $INERT_VERSION)."
  exit 0
fi

# --- Ordinary PR: neither generated artefact may move ----------------------------------------------
CHANGED="$(git diff --name-only "$BASE_REF" "$HEAD_REF" 2>/dev/null)" \
  || fail "cannot diff $BASE_REF..$HEAD_REF — failing closed."

if [ "$BASE_VERSION" != "$HEAD_VERSION" ]; then
  fail "$MANIFEST's version changed ($BASE_VERSION -> $HEAD_VERSION). Under the three-branch topology (B-1007) \`main\` is source only: the version is GENERATED on \`staging\` by scripts/generate-staging.sh and must stay at $INERT_VERSION on \`main\`. Revert the version field — see the Versioning section in CLAUDE.md."
fi

if printf '%s\n' "$CHANGED" | grep -Eq '^dist/'; then
  OFFENDING="$(printf '%s\n' "$CHANGED" | grep -E '^dist/' | head -20)"
  fail "this PR touches tracked paths under dist/:
$OFFENDING
\`dist/\` is generated and committed on \`staging\` by scripts/generate-staging.sh, and is gitignored on \`main\` — see the Versioning section in CLAUDE.md."
fi

if [ "$HEAD_TRACKS_DIST" = "1" ]; then
  fail "head ($HEAD_REF) tracks files under dist/, which \`main\` must not carry. \`dist/\` is generated on \`staging\` — see the Versioning section in CLAUDE.md."
fi

echo "check-generated-artifacts: OK — no version change and no dist/ change."
