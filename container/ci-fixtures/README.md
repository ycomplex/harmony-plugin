# `container/ci-fixtures/` — the toolchain-contract fixtures (B-929)

Three tiny stand-in "cloned repos" the CI **toolchain-contract** job runs
`container/activate-toolchain.sh` against, inside a freshly built worker image. They exist because
the property that matters most about lever 1 is a **negative** one (a repo that declares nothing
must be untouched), and a negative is only credible if something asserts it on every PR.

| Fixture | Declares | Asserted outcome |
|---|---|---|
| `no-pins/` | nothing | **AC2 inertness** — still the image's Node 22, `~/.harmony-toolchain.sh` never created, fnm's version store still empty. This is Harmony's own three repos' shape. |
| `pinned/` | `.nvmrc` = 24.14.1 + `packageManager` = pnpm@11.21.0 | **AC1** — `node --version` is v24.14.1, `pnpm --version` is 11.21.0, and `pnpm install --frozen-lockfile` completes. |
| `engines-only/` | `engines.node` = 24.14.1, **no** `.nvmrc` | the `engines.node` path resolves too — fnm's `--resolve-engines` (verified live at build time on fnm 1.39.0) with `container/activate-toolchain.sh`'s own floor-parse as the fallback. |

They are deliberately dependency-free: the point is the toolchain, not a package graph. `pinned/` has
no committed `pnpm-lock.yaml` on purpose — the CI job generates it with `pnpm install --lockfile-only`
and only then runs `--frozen-lockfile`, so the test proves pnpm actually works end to end instead of
proving that a hand-written lockfile of a format nobody here can verify happens to parse.
