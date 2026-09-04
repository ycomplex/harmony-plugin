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
  { "bin": "ping", "apt": "iputils-ping" }
]
```

(The third entry exists to show the `apt`-differs-from-`bin` case — `ping` is provided by
`iputils-ping`. Swap in whatever your project actually needs; `{ "bin": "convert", "apt":
"imagemagick" }` is the same shape.)

| Key | Required | Meaning |
|---|---|---|
| `bin` | yes | the executable that **must** exist in the built image. This is what gets asserted. |
| `apt` | no | the Debian package providing it. **Defaults to `bin`** — omit it whenever they match. |
| `npm` | no | an npm spec installed globally instead of an apt package. |

Rules the generator enforces (each one is a unit test in `src/container/worker-image.test.ts`):

- exactly **one** source per bin — declaring both `apt` and `npm` is rejected, not silently resolved;
- an **unknown key** is rejected, so a `npmm:` typo can never be silently ignored;
- a **duplicate** `bin` is rejected;
- values are restricted to `A-Za-z0-9._@+/:-` — a value carrying shell metacharacters is rejected
  rather than escaped into a `RUN` line;
- output ordering is **deterministic** (sorted by `bin`), so the same list in a different order emits
  a byte-identical Dockerfile and therefore the same layer cache key.

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
