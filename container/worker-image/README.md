# `container/worker-image/` — build a worker image from a requirements LIST (B-929)

A build leg for a project that is not Harmony used to fail before doing any work, because the
worker image only carried Harmony's own toolchain. B-929 ships two levers for that; this directory
is the second one's producer.

| Lever | Where it lives | Use it when |
|---|---|---|
| 1. Toolchain manager in the base image | `container/Dockerfile` (fnm + the base image's own corepack) + `container/activate-toolchain.sh` | the project pins a **Node version** or a **package manager** — `.nvmrc`, `.node-version`, `engines.node`, `packageManager`. Nothing to build: the shared image already handles it. |
| 2. A different worker image | this directory (generate it) + `worker_image` in the deployment config (point at it) | the project needs something an image must carry: a system package, a browser, a compiler, a CLI. |

**You never hand-write a Dockerfile.** You declare the binaries your build needs; the generator
emits the layer, and the emitted layer ends in a `command -v` assertion per declared binary — so an
unresolved requirement fails the **image build**, once, at publish time, instead of failing a build
**leg** at 2am with `command not found` after the worker already claimed the ticket.

## The input contract

A flat JSON array of objects. `requirements.example.json` in this directory is a working one.

```json
[
  { "bin": "pnpm", "npm": "pnpm@11.21.0" },
  { "bin": "rsync" },
  { "bin": "ping", "apt": "iputils-ping" },
  { "lib": "libicu72" }
]
```

(The third entry exists to show the `apt`-differs-from-`bin` case — `ping` is provided by
`iputils-ping`. Swap in whatever your project actually needs; `{ "bin": "convert", "apt":
"imagemagick" }` is the same shape. The fourth is a **library**: a package with no binary.)

An entry is **either** a `bin` (an executable, with exactly one source) **or** a `lib`:

| Key | Required | Meaning |
|---|---|---|
| `bin` | yes, unless `lib` | the executable that **must** exist in the built image. Asserted with `command -v`. |
| `apt` | no | the Debian package providing the bin. **Defaults to `bin`** — omit it whenever they match. |
| `npm` | no | an npm spec installed globally instead of an apt package. |
| `url` + `sha256` | no (B-1085) | a **checksum-pinned static binary**: downloaded over `https` to `/usr/local/bin/<bin>`, verified against the 64-hex `sha256`, then made executable. Both keys or neither. |
| `lib` | instead of `bin` (B-1085) | a Debian package that provides **no binary** — a shared library, or a font package a headless browser needs. Installed with apt, asserted with `dpkg -s`. Takes no other key. |

Rules the generator enforces (each one is a unit test in `src/container/worker-image.test.ts`):

- exactly **one** source per bin — declaring two of `apt` / `npm` / `url` is rejected, not silently resolved;
- a `url` **must** carry a `sha256` (and vice versa), must be `https://`, and its `bin` must be a plain
  file name — there is no unpinned download and **no installer-script source**: a requirements list
  must not become a way to run `curl … | sh` in an image build, and an unpinned download would let the
  same list build two different images on two different days;
- a `lib` entry takes no other key — an entry is a bin or a lib, never both;
- an **unknown key** is rejected, so a `npmm:` typo can never be silently ignored;
- a **duplicate** `bin` (or `lib`) is rejected;
- values are restricted to `A-Za-z0-9._@+/:-` — a value carrying shell metacharacters (or a URL with a
  query string) is rejected rather than escaped into a `RUN` line;
- output ordering is **deterministic** (bins sorted by `bin`, libs by name), so the same list in a
  different order emits a byte-identical Dockerfile and therefore the same layer cache key.

### A toolchain the project pins through a version manager (B-1085)

The first third-party project — a .NET 10 backend whose Node, pnpm and .NET versions are pinned in
`mise.toml` — needed nothing for Node and pnpm (lever 1 activates those) and exactly two things from
an image: the `mise` binary, which is neither an apt nor an npm package, and ICU, the native library
.NET needs on a slim Debian base. That is this list:

```json
[
  { "bin": "mise",
    "url": "https://github.com/jdx/mise/releases/download/v2026.9.17/mise-v2026.9.17-linux-x64",
    "sha256": "63049bc35fb9065e8dc35ac8b25fdae53e9bd6f1885a843aedeba398e046a1ee" },
  { "lib": "libicu72" }
]
```

The SDK itself is **not** in the image: the leg runs `mise install` and gets whatever the project's
own `mise.toml` pins, so the image never drifts from the repo (measured on that project: 20 s for
Node, pnpm and the .NET SDK together, per cold leg). The same project's unit suite runs half its
files in headless Chromium, which needs its system libraries **and at least one font package** in the
image — all `lib` entries; take the list from `playwright install-deps --dry-run chromium` rather
than guessing, because a browser with no fonts does not fail to launch, it crashes mid-run. Two things to know: the URL is
architecture-specific (Cloud Run workers are `linux/amd64`; a local-docker daemon on an Apple-silicon
host needs the `linux-arm64` asset and its own checksum), and the download happens at every cold leg
start — baking the toolchain into the image is a later optimisation, not part of this contract.

This is deliberately a **flat array of scalar-valued objects**: it is exactly what the equivalent
YAML list parses into, so a later producer (B-936's project manifest) can emit this file with a
one-line yaml→json conversion. **B-929 owns only this consumer contract** — it does not define, and
must not be read as pre-empting, the `.harmony/project.yml` manifest format.

## Generating and publishing

```bash
# 1. Emit the Dockerfile (stdout, or --out <path>).
node dist/bin/worker-image.js \
  --requirements container/worker-image/requirements.example.json \
  --base harmony-build-env \
  --out /tmp/Dockerfile.acme

# 2. Publish it, the SAME documented path the shared image uses — `gcloud builds submit`,
#    NOT a per-image Cloud Build trigger (decided explicitly on B-929: one trigger publishes the
#    shared image from container/cloudbuild.yaml; per-project images are published on demand by
#    whoever owns the project, not by Harmony's CI).
#    Run it as the human owner account: `unset CLOUDSDK_CORE_ACCOUNT` first.
cp /tmp/Dockerfile.acme container/Dockerfile.acme
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/<project>/harmony-workers/acme-build-env \
  container/

# 3. Point the deployment at it (lever 2) — ~/.harmony/deployment.json:
#      { "worker_image": "acme-build-env" }
#    A BARE name resolves against the deployment's registry; a value containing "/" is used
#    verbatim (that is how you point at another registry or pin a digest). See container/README.md
#    → "Which image a worker runs".
```

`--base` defaults to `harmony-build-env`, the same default `worker_image` carries, so the common
case — "the Harmony worker image plus these three tools" — needs no flag at all.

## Why the base is never forked

The emitted layer is `FROM` the shared worker image, so it inherits `git`, `gh`, `jq`, `python3`,
`node`, `corepack`, `fnm`, the `worker` user, and — critically — the **entrypoint's mode dispatch
contract** (`shell` / `headless <prompt>`), which the daemon's launch templates depend on. A forked
base would have to re-establish all of that and would drift the first time the shared image moved.
`container/smoke.sh` asserts exactly these properties, and the CI toolchain-contract job runs it
against a generated image too.
