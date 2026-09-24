#!/usr/bin/env bash
# B-1081 — seed this control case's generated fixture into the run workspace.
#
# `context.add_dirs` only GRANTS read access to a directory; it does not put it in the run's
# working directory, and the agent has no way to learn its absolute path (the first genuinely
# completed CI run, 36025867254, shows the agent spending all ten turns searching an empty cwd for
# `fixtures/fresh-brief.md` and never calling Write). A `scaffold_script` runs in the empty run
# workspace BEFORE the agent starts, with this file's own directory (the case directory) readable —
# so it copies the fixture to exactly the path prompt.md names. Requires `--scaffold` on the runner
# call (the workflow and RUNBOOK.md pass it). The fixture itself is generated, gitignored label
# content (fetch-labels.mjs --controls); this script copies whatever is there and fails loudly if
# it is missing, so a run without the generated fixture never silently grades an empty file.
set -euo pipefail
case_dir="$(cd "$(dirname "$0")" && pwd)"
src="$case_dir/fixtures/fresh-brief.md"
[ -r "$src" ] || { echo "scaffold: $src is missing — run fetch-labels.mjs --controls <ticket> first" >&2; exit 1; }
mkdir -p fixtures
cp "$src" fixtures/fresh-brief.md
