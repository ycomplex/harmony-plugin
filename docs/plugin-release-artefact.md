# The plugin's released download (B-1475)

This is the contract for the plugin's released download. Four pieces of work build on it:
the gated download (B-1476), the founder's end-to-end test (B-1477), workers installing from it (B-1478) and the
migration guide (B-1479).

## What is published, and when

Every push to `staging` and to `prod` publishes one release. A Cloud Build trigger on each branch runs
[`release/cloudbuild.yaml`](../release/cloudbuild.yaml). That file is a thin caller:

- [`scripts/build-release.mjs`](../scripts/build-release.mjs) builds the zip, `marketplace.json` and `release.json`
  for the commit (tests: `src/build-release.test.ts`).
- [`scripts/publish-release.sh`](../scripts/publish-release.sh) uploads them (tests: `src/publish-release.test.ts`).

`./promote-prod.sh` does not wait for this build. A `prod` release appears a few minutes after the push.

## Storage layout

The bucket is private. Its name reaches the build only as the substitution `_RELEASE_BUCKET`, which has no default.

Every object lives under `channels/<channel>/`, where `<channel>` is `prod` or `staging`. The channel comes from
the branch that triggered the build (`$BRANCH_NAME`). `_CHANNEL` may override it, and must also be `prod` or
`staging`.

Each release writes three objects, once:

```
channels/<channel>/releases/<version>/harmony-plugin-<version>.zip
channels/<channel>/releases/<version>/marketplace.json
channels/<channel>/releases/<version>/release.json
```

Two moving pointers follow:

```
channels/<channel>/marketplace.json
channels/<channel>/release.json
```

The pointers are byte-identical copies of the versioned files. They are written last, only after the three
versioned objects are uploaded and read back with a matching sha256. A pointer never moves backwards: when the
channel already points at a higher version (a late retry of an older build), the older release is still published
but the pointers stay where they are.

## The zip

The zip is `git archive --format=zip <commit>` of the commit built. The plugin root is at the top level of the zip,
with no prefix. It holds the full tracked tree, `dist/` included (`dist/` is tracked on `staging` and `prod`).
`git archive` is deterministic, so the same commit always gives the same bytes.

The zip is about 6 MB today. Trimming it to what the plugin needs at run time is B-1480, which must land before
B-1474.

## Version

The version is `.claude-plugin/plugin.json`'s `version` at the commit built, read with
`git show <commit>:.claude-plugin/plugin.json`. The build refuses, with a non-zero exit and a clear message, when:

- the version is the inert `0.0.0-dev`, or is not semver;
- `dist/index.js` is not in the commit's tree. `main` carries no `dist/`, so a release is built only from
  `staging` or `prod`.

## marketplace.json

Pretty-printed JSON, keys in this order:

```json
{
  "name": "harmony",
  "owner": { "name": "ycomplex" },
  "description": "Harmony project management for Claude Code (prod channel)",
  "metadata": { "version": "<version>" },
  "plugins": [
    {
      "name": "harmony-plugin",
      "description": "Harmony project management integration for Claude Code — MCP tools and workflow skills",
      "version": "<version>",
      "source": {
        "source": "archive",
        "url": "<PUBLIC_BASE_URL>/<channel>/releases/<version>/harmony-plugin-<version>.zip",
        "sha256": "<lowercase hex digest of the zip>"
      }
    }
  ]
}
```

- The marketplace is named `harmony` on `prod` and `harmony-staging` on `staging`. The install id is
  `harmony-plugin@harmony` (and `harmony-plugin@harmony-staging`).
- The file carries no `headers` and no `headersHelper`.
- `PUBLIC_BASE_URL` is the substitution `_PUBLIC_BASE_URL`, with no default. It must be `https://`. One trailing
  slash is stripped. Anything else fails the build before anything is built or uploaded.
- The existing `ycomplex` marketplace (git source, `ref: "prod"`) stays as it is.

## release.json

```json
{
  "schema": 1,
  "channel": "<channel>",
  "version": "<version>",
  "commit": "<full sha>",
  "built_at": "<ISO 8601 UTC>",
  "zip": { "object": "<object path>", "sha256": "<hex>", "bytes": 0 },
  "marketplace_object": "<object path of the versioned marketplace.json>"
}
```

`built_at` is the commit's committer date, not the build time. A rebuild of the same commit is therefore
byte-identical.

## Public addresses

`<PUBLIC_BASE_URL>/<channel>/...` maps one to one onto the bucket's `channels/<channel>/...`. For example,
`<base>/prod/marketplace.json` is the object `channels/prod/marketplace.json`. B-1476 serves and gates these
addresses through the edge function `plugin-download` on the production Supabase project, so the base address has
the form `https://<PROD_REF>.supabase.co/functions/v1/plugin-download`. That is the value for `_PUBLIC_BASE_URL` on
both release triggers, and for `plugin_release.base_url` in a project file that opts its worker legs into the
release (B-1478). Every request carries `Authorization: Bearer <Harmony API token>`. Whether customers later get a
stable address on Harmony's own domain is decided before B-1479's migration guide.

## What a consumer may rely on

A consumer may rely on:

- the object paths and file shapes above;
- a versioned object never changing once published;
- the pointers naming a release whose three objects are already published and verified;
- the zip's sha256 in `marketplace.json` and `release.json` equalling the zip's bytes;
- the zip's own `.claude-plugin/plugin.json` version equalling the release's version.

A consumer may not rely on:

- when a release appears after a push (nothing waits for it);
- every version existing on a channel (a build can fail; versions can be skipped);
- the bucket's name, or the base URL, being any particular value;
- the zip's contents beyond the plugin's tracked tree (B-1480 will trim it).

## Worker legs (B-1478)

A conductor's legs take the plugin from this download only when the project file opts in
(`.harmony/conductor.json` `"plugin_source": "release"` with `plugin_release.base_url`; see
[`conductor-config.md`](conductor-config.md)). Cloning the plugin stays the default and the fallback.

`container/entrypoint.sh`, baked into the worker image, then:

1. maps the leg's posture to a channel: `prod` reads `prod`, `ack:staging` or `staging` reads `staging`; any other
   posture has no published channel and falls back;
2. GETs `<base_url>/<channel>/release.json` with `Authorization: Bearer $HARMONY_API_TOKEN`;
3. maps the record's `zip.object` (`channels/<channel>/<rest>`) to `<base_url>/<channel>/<rest>` and GETs the zip
   with the same header;
4. checks the zip's sha256 against `zip.sha256`, the zip's own `.claude-plugin/plugin.json` version against
   `version`, and that the tree carries `container/release-runtime` (the marker of a release that supports worker
   legs; an older release falls back);
5. extracts it to `$HOME/harmony-plugin`, makes it read-only, exports `HARMONY_PLUGIN_DIR`, and execs that
   release's `container/provision.sh`. The repository entry with `is_plugin: true` is not cloned; every other
   repository still is, the meta repository first.

The bearer is read from a mode-600 file that is removed before the hand-off; it is never in argv or output.
Requests use https only, with a 10 s connect and 300 s total timeout, follow at most three https redirects (curl
drops the bearer on a redirect to another host), and accept at most 1 MiB of `release.json` and 256 MiB of zip.
The image's CA bundle is used; `CURL_CA_BUNDLE` overrides it, as curl itself provides.

Any failure prints exactly one stderr line, `PLUGIN-SOURCE-FALLBACK: <reason>; cloning <ref>`, and the leg clones as
it would without the setting. `provision.sh` receives the outcome as `HARMONY_PLUGIN_SOURCE_RESULT` (`release`,
`clone` or `clone-fallback(<reason>)`), shows it in its banner as `plugin_source=…`, and after a fallback posts one
comment on the ticket naming the reason (best-effort). In a release leg, the B-1451 detach and dirty check are
skipped: the release directory is not a git checkout.

The paths a worker and the conductor read from the plugin at run time are listed in
`src/release/runtime-paths.ts`; a trimmed zip (B-1480) must keep them. `scripts/prove-release-fetch.sh` re-runs the
mechanism proof in the real worker image against a local HTTPS server.

## Immutability

A version already published with different bytes makes the publish fail. Nothing changes: the pointers stay
untouched. A version already published with the same bytes is a no-op for that object, so re-running the same
commit changes nothing.

New objects are uploaded with `gcloud storage cp --if-generation-match=0` (create only). On a precondition failure
the script fetches the existing object and compares its sha256. The local-directory backend of
`publish-release.sh` follows the same rules with plain files, for tests and dry runs.

## How Claude Code notices a new version

### Confirmed from the Claude Code documentation

- An `archive` plugin source takes a `url` and a `sha256`. The url must be `https://`, must not be a loopback
  address, and the archive must be at most 256 MiB.
- A URL marketplace downloads only `marketplace.json`. Each plugin's archive is fetched from its own `url`.
- A url-source marketplace's `headers` or `headersHelper` also apply to archive downloads on the same origin, but
  never across a redirect to another origin.
- Version precedence: the zip's `plugin.json` version, then the entry's `version`, then the sha256.
- Auto-update is off by default for marketplaces not run by Anthropic.
- An entry-level `headersHelper` blocks auto-update.
- Archive sources need Claude Code 2.1.238 or later.

### Found by running

At design time:

- The update check downloads the whole zip every time. It trusts only the zip's own `plugin.json` version.
- The same version with new bytes is ignored. A bumped entry `version` with an unchanged zip is ignored.
- A url-source `headersHelper` in user settings authenticates both the marketplace fetch and the same-origin zip at
  session start.
- A wrong token makes the refresh fail with 401.
- Editing static `headers` in settings after install leaves the marketplace "added but ignored", and the plugin
  fails to load until the marketplace is added again.

The probe below re-checks the version rules. Its run for this build (B-1475), on Claude Code
`2.1.323 (Claude Code)`, releasing `origin/prod` at version 0.17.52:

```
A install: PASS — installed 0.17.52; skills/, hooks/hooks.json, .mcp.json, dist/ present; harmony --version prints 0.17.52
B update: PASS — installed version moved 0.17.52 -> 0.17.1052
C same version, new bytes: PASS — no move (still 0.17.1052, new file absent); zip downloads during the check: 1
D entry version only: PASS — no move (still 0.17.1052; entry says 0.17.2052)
E nothing changed: PASS — still 0.17.1052; the zip was downloaded 1 time(s) by the check
F background auto-update: NOT-RUN — needs an interactive session over time (owned by B-1477)
G 401 during background refresh: NOT-RUN — needs an interactive session over time (owned by B-1477)
```

The server log of that run shows one marketplace fetch and one zip download for every check, including case E,
where nothing had changed. Claude Code accepted an HTTPS host on a private (non-loopback) address with a
self-signed certificate trusted through `NODE_EXTRA_CA_CERTS`. The probe sent no bearer, so it did not exercise
authentication.

At B-1477, against the production gated download with a real token, on Claude Code `2.1.323` (recorded run in
[`gated-download-walk.md`](gated-download-walk.md), repeatable with
[`scripts/gated-install-check.sh`](../scripts/gated-install-check.sh)):

- The route that works is to declare the marketplace in user settings: an `extraKnownMarketplaces.harmony` entry
  with a url source, a `headersHelper` that reads a token file, and `autoUpdate: true`.
- Once declared, `claude plugin marketplace add <BASE>/prod/marketplace.json` is refused: "its source doesn't
  match its extraKnownMarketplaces entry in user or managed settings". Before any session,
  `claude plugin marketplace update harmony` says the marketplace is not found.
- A session start fetches the declared marketplace, even a headless one that stops at "Not logged in".
  `claude plugin install harmony-plugin@harmony` then installs it, enabled.
- With a refused token, `claude plugin marketplace update` and `claude plugin update` both fail with 401. The
  installed copy stays enabled at the same version, and its cache files are unchanged.
- With the good token back, both work again; the plugin update reports it is already at the latest version.

### Not confirmed

B-1477's verify covers these, by the founder's walk in [`gated-download-walk.md`](gated-download-walk.md):

- when background auto-update runs, and that it sends the header;
- whether a logged-in session still loads the plugin after a refused refresh (and with a revoked token);
- macOS and Windows.

## Handoffs

**B-1476 (gated download).** Serve the marketplace and the zips from the same origin, so one url-source
`headersHelper` covers both. Expect about 6 MB per update check per machine, since every check re-downloads the
zip. A read-only credential for the bucket is B-1476's choice.

**B-1477 and B-1479 (the founder's test and the migration guide).** Authenticate with a url-source
`headersHelper` that reads a token file. Never use static `headers`, and never an entry-level `headersHelper`
(it blocks auto-update). Users must turn auto-update on for the new marketplace.

The founder's test is [`gated-download-walk.md`](gated-download-walk.md). B-1479's guide may follow its install
route, but must not copy its test-only steps (the helper's log line, the wrong and revoked token exercise, and the
check script); the walk lists them at the end.

The re-key from `harmony-plugin@ycomplex` to `harmony-plugin@harmony` touches:

- `enabledPlugins` keys, including committed `.claude/settings.json` files;
- `extraKnownMarketplaces` entries;
- the plugin README's install lines;
- `scripts/setup-channel-env.sh`;
- the workspace `CLAUDE.md` lines that name the plugin cache path;
- the web app's new-project setup guide.

It does not touch the SessionStart hook, the glob in `docs/remote-conductor-runbook.md`, or plugin data.

## Founder steps

Names only. The values are recorded in the workspace's `docs/project/harmony-deployment-values.md`, never here.
No new secret is needed, and no `.github` change.

1. Create the bucket:
   `gcloud storage buckets create gs://<RELEASE_BUCKET> --project=<PROJECT> --location=<REGION> --uniform-bucket-level-access --public-access-prevention`
2. Let the trigger's service account write to it:
   `gcloud storage buckets add-iam-policy-binding gs://<RELEASE_BUCKET> --member=serviceAccount:<TRIGGER_SERVICE_ACCOUNT> --role=roles/storage.objectAdmin`
3. Create the prod trigger:
   `gcloud builds triggers create github --name=harmony-plugin-release-prod --repo-owner=ycomplex --repo-name=harmony-plugin --branch-pattern='^prod$' --build-config=release/cloudbuild.yaml --service-account=<TRIGGER_SERVICE_ACCOUNT> --substitutions=_RELEASE_BUCKET=<RELEASE_BUCKET>,_PUBLIC_BASE_URL=<ENDPOINT_BASE_URL>`
4. Create the staging trigger: the same command with `--name=harmony-plugin-release-staging` and
   `--branch-pattern='^staging$'`.
5. Record the values in the workspace's `docs/project/harmony-deployment-values.md`.

## Running the probe

```bash
scripts/release-update-probe.sh [--commit <ref>] [--port <port>]
```

It needs `node`, `python3`, `openssl`, `git` and `claude` on PATH. By default it fetches and releases
`origin/prod` and serves on port 8443. It builds and publishes the release into a temporary local bucket, serves
it over HTTPS on the machine's first non-loopback IPv4 with a throwaway certificate, and runs `claude plugin` with
an isolated `HOME` and `CLAUDE_CONFIG_DIR`. It prints one PASS, FAIL or NOT-RUN line per case, then the request
log. If Claude Code refuses the private-address host, case A says so and the other cases are NOT-RUN. It stops its
server and removes its temp directories on exit.
