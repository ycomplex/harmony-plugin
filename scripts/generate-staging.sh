#!/usr/bin/env bash
# =================================================================================================
# scripts/generate-staging.sh — B-1007: generate the `staging` branch from `main`.
#
# THE TOPOLOGY (three branches, one direction of travel):
#
#     main  ──(this script, on every push to main)──▶  staging  ──(promote-prod.sh, ff-only)──▶  prod
#     SOURCE ONLY                                      CI-GENERATED                              SERVED
#     no tracked dist/                                 tracked dist/ + real version              marketplace pin
#     version pinned at the inert 0.0.0-dev            patch-bumped here                         ref: "prod"
#
# `main` carries source only: `dist/` is gitignored there and `.claude-plugin/plugin.json`'s version
# stays at the inert `0.0.0-dev`. That removes the two files every plugin PR used to collide on.
# The real version and the built `dist/` are GENERATED here, on `staging`, by CI — so the version
# is still the only signal Claude Code uses to detect plugin updates; only the mechanism moved
# downstream of the PR.
#
# WHY MERGE, NEVER RESET — this is load-bearing, do not "simplify" it:
#   `prod` is fast-forwarded from `staging` by the workspace's promote-prod.sh, whose preflight
#   requires `origin/prod` to be an ANCESTOR of `origin/staging`. Any history rewrite here
#   (`git push --force`, `--force-with-lease`, `git checkout -B`, `git reset --hard` onto a new
#   base) makes `origin/prod` stop being an ancestor and permanently breaks that fast-forward.
#   So: this script only ever MERGES `main` into `staging` and pushes a plain, non-forced update.
#   There is deliberately no --force of any kind anywhere in this file.
#
# RE-RUN SAFETY (idempotence) — the mechanism, stated explicitly because it is testable:
#   The single gate is an ANCESTRY CHECK. Before anything is merged, bumped, built or committed,
#   the script asks whether the `main` tip it was handed is ALREADY an ancestor of `origin/staging`.
#   If it is, everything main carries has already been generated, so the script exits 0 having
#   changed nothing — no second version bump, no empty commit, no push. A second run on the SAME
#   main commit therefore always takes that early exit. A belt-and-braces second guard runs after
#   the rebuild: if nothing at all is staged AND no merge is in progress, it exits 0 rather than
#   creating an empty commit (`git commit` is never invoked with --allow-empty).
#
# BOOTSTRAP (the first ever run, when `origin/staging` does not exist):
#   `staging` is created from `origin/main`, and the bump BASE is seeded from `origin/prod`'s
#   `.claude-plugin/plugin.json` — the last really published version — NOT from main's inert
#   `0.0.0-dev`, so the generated version keeps climbing from what the marketplace has served.
#   Every run after that bumps staging's OWN current version.
#
# WHAT IT DOES, in order:
#   1. fetch main (+ staging/prod if they exist)
#   2. ancestry check -> exit 0 if there is nothing to generate
#   3. check out `staging` (bootstrap it from main when absent), then MERGE main into it
#   4. patch-bump the version and write it into .claude-plugin/plugin.json
#   5. npm ci && npm run build
#   6. `git add -f dist .claude-plugin/plugin.json`  (-f because `main`'s .gitignore ignores dist/,
#      and .gitignore is shared across branches — without -f the generated bundle is never staged)
#   7. commit as the generating identity, and push `staging` (no force)
#
# USAGE
#   scripts/generate-staging.sh
#
# Every remote/branch/identity/build detail is overridable by env var so the unit tests can drive
# this against a local fixture repo with no network and no GitHub App:
#   HARMONY_STAGING_REMOTE          remote name                     (default: origin)
#   HARMONY_STAGING_MAIN_BRANCH     source branch                   (default: main)
#   HARMONY_STAGING_BRANCH          generated branch                (default: staging)
#   HARMONY_STAGING_PROD_BRANCH     bootstrap version seed branch   (default: prod)
#   HARMONY_STAGING_BUILD_CMD       build command                   (default: npm ci && npm run build)
#   HARMONY_STAGING_BOT_NAME        commit identity name            (default: harmony-daemon[bot])
#   HARMONY_STAGING_BOT_EMAIL       commit identity email           (default: harmony-daemon[bot]@users.noreply.github.com)
#   HARMONY_STAGING_SEED_VERSION    bootstrap seed override; only consulted when the prod branch is
#                                   absent, in which case bootstrap fails closed without it.
# =================================================================================================
set -euo pipefail

REMOTE="${HARMONY_STAGING_REMOTE:-origin}"
MAIN_BRANCH="${HARMONY_STAGING_MAIN_BRANCH:-main}"
STAGING_BRANCH="${HARMONY_STAGING_BRANCH:-staging}"
PROD_BRANCH="${HARMONY_STAGING_PROD_BRANCH:-prod}"
BUILD_CMD="${HARMONY_STAGING_BUILD_CMD:-npm ci && npm run build}"
BOT_NAME="${HARMONY_STAGING_BOT_NAME:-harmony-daemon[bot]}"
BOT_EMAIL="${HARMONY_STAGING_BOT_EMAIL:-harmony-daemon[bot]@users.noreply.github.com}"

say() { echo "generate-staging: $*"; }
die() { echo "generate-staging: $*" >&2; exit 1; }

# --- 1. Fetch -----------------------------------------------------------------------------------
git fetch --no-tags "$REMOTE" "$MAIN_BRANCH" || die "cannot fetch $REMOTE/$MAIN_BRANCH"
MAIN_SHA="$(git rev-parse FETCH_HEAD)"
say "main tip: $MAIN_SHA"

STAGING_EXISTS=0
if git ls-remote --exit-code --heads "$REMOTE" "$STAGING_BRANCH" >/dev/null 2>&1; then
  STAGING_EXISTS=1
  git fetch --no-tags "$REMOTE" "$STAGING_BRANCH" || die "cannot fetch $REMOTE/$STAGING_BRANCH"
  git update-ref "refs/remotes/$REMOTE/$STAGING_BRANCH" FETCH_HEAD
fi

PROD_EXISTS=0
if git ls-remote --exit-code --heads "$REMOTE" "$PROD_BRANCH" >/dev/null 2>&1; then
  PROD_EXISTS=1
  git fetch --no-tags "$REMOTE" "$PROD_BRANCH" || die "cannot fetch $REMOTE/$PROD_BRANCH"
  git update-ref "refs/remotes/$REMOTE/$PROD_BRANCH" FETCH_HEAD
fi

# --- 2. Re-run safety: is there anything at all to generate? --------------------------------------
if [ "$STAGING_EXISTS" = "1" ] && git merge-base --is-ancestor "$MAIN_SHA" "refs/remotes/$REMOTE/$STAGING_BRANCH"; then
  say "$MAIN_BRANCH tip $MAIN_SHA is already an ancestor of $REMOTE/$STAGING_BRANCH — nothing to generate."
  exit 0
fi

# --- 3. Check out staging, then MERGE main into it ------------------------------------------------
# A leftover UNTRACKED dist/ (gitignored on main, tracked on staging) would block the branch switch,
# so clear it first — but only when it is genuinely untracked at HEAD. It is rebuilt below anyway.
if ! git ls-files --error-unmatch dist >/dev/null 2>&1; then
  rm -rf dist
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "working tree has uncommitted tracked changes — refusing to generate from a dirty tree"
fi

BOOTSTRAP=0
if [ "$STAGING_EXISTS" = "1" ]; then
  if git show-ref --verify --quiet "refs/heads/$STAGING_BRANCH"; then
    git checkout "$STAGING_BRANCH"
    # --ff-only, never a reset: a diverged local branch must fail loudly, not be overwritten.
    git merge --ff-only "refs/remotes/$REMOTE/$STAGING_BRANCH"
  else
    git checkout -b "$STAGING_BRANCH" "refs/remotes/$REMOTE/$STAGING_BRANCH"
  fi
else
  BOOTSTRAP=1
  say "$REMOTE/$STAGING_BRANCH does not exist — bootstrapping it from $MAIN_BRANCH."
  git checkout -b "$STAGING_BRANCH" "$MAIN_SHA"
fi

if [ "$BOOTSTRAP" = "0" ]; then
  # --no-commit so the merge, the version bump and the rebuilt dist/ land as ONE commit; the commit
  # below still records both parents, so the previous staging tip stays an ancestor of the new one.
  if ! git merge --no-ff --no-commit --no-edit "$MAIN_SHA"; then
    git merge --abort || true
    die "merging $MAIN_BRANCH into $STAGING_BRANCH conflicted — resolve it on $STAGING_BRANCH by hand"
  fi
fi

# --- 4. Work out the bump base, then patch-bump ----------------------------------------------------
MANIFEST=".claude-plugin/plugin.json"
if [ "$BOOTSTRAP" = "1" ]; then
  if [ "$PROD_EXISTS" = "1" ]; then
    BASE_VERSION="$(git show "refs/remotes/$REMOTE/$PROD_BRANCH:$MANIFEST" | node -e '
      let d = ""; process.stdin.on("data", (c) => (d += c));
      process.stdin.on("end", () => { const v = JSON.parse(d).version; if (!v) throw new Error("no version"); console.log(v); });
    ')" || die "cannot read the seed version from $REMOTE/$PROD_BRANCH:$MANIFEST"
    say "bootstrap seed version from $REMOTE/$PROD_BRANCH: $BASE_VERSION"
  elif [ -n "${HARMONY_STAGING_SEED_VERSION:-}" ]; then
    BASE_VERSION="$HARMONY_STAGING_SEED_VERSION"
    say "bootstrap seed version from HARMONY_STAGING_SEED_VERSION: $BASE_VERSION"
  else
    die "bootstrap needs a seed version: $REMOTE/$PROD_BRANCH does not exist and HARMONY_STAGING_SEED_VERSION is unset"
  fi
else
  BASE_VERSION="$(node -e 'const v = require("./" + process.argv[1]).version; if (!v) throw new Error("no version"); console.log(v);' "$MANIFEST")" \
    || die "cannot read the current version from $STAGING_BRANCH:$MANIFEST"
  say "bump base ($STAGING_BRANCH's own current version): $BASE_VERSION"
fi

NEW_VERSION="$(node -e '
  const m = String(process.argv[1]).trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) { console.error(`cannot parse semver: ${process.argv[1]}`); process.exit(1); }
  console.log(`${Number(m[1])}.${Number(m[2])}.${Number(m[3]) + 1}`);
' "$BASE_VERSION")" || die "cannot patch-bump $BASE_VERSION"
say "version: $BASE_VERSION -> $NEW_VERSION"

# Rewrite only the version FIELD, textually, so the manifest's formatting is otherwise untouched.
node -e '
  const fs = require("node:fs");
  const [file, version] = process.argv.slice(1);
  const raw = fs.readFileSync(file, "utf8");
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === raw) { console.error(`version field not rewritten in ${file}`); process.exit(1); }
  if (JSON.parse(next).version !== version) { console.error("rewrite did not take"); process.exit(1); }
  fs.writeFileSync(file, next);
' "$MANIFEST" "$NEW_VERSION"

# --- 5. Build ---------------------------------------------------------------------------------------
say "building: $BUILD_CMD"
bash -c "$BUILD_CMD"

# --- 6. Stage (the -f is required: main gitignores dist/, and .gitignore is shared across branches) --
git add -f dist "$MANIFEST"

# --- 7. Commit + push (never forced) ----------------------------------------------------------------
if git diff --cached --quiet && [ ! -f "$(git rev-parse --git-dir)/MERGE_HEAD" ]; then
  say "nothing staged and no merge in progress — refusing to create an empty commit."
  exit 0
fi

MAIN_SHORT="$(git rev-parse --short "$MAIN_SHA")"
git -c "user.name=$BOT_NAME" -c "user.email=$BOT_EMAIL" commit --no-verify -m "chore(staging): generate v$NEW_VERSION from $MAIN_BRANCH@$MAIN_SHORT

Generated by scripts/generate-staging.sh (B-1007): merged $MAIN_BRANCH into $STAGING_BRANCH,
patch-bumped $BASE_VERSION -> $NEW_VERSION and committed a fresh dist/ build. \`main\` stays
source-only; \`prod\` fast-forwards from here."

say "pushing $STAGING_BRANCH to $REMOTE"
git push "$REMOTE" "refs/heads/$STAGING_BRANCH:refs/heads/$STAGING_BRANCH"
say "done: $STAGING_BRANCH is at $(git rev-parse HEAD) (v$NEW_VERSION)"
