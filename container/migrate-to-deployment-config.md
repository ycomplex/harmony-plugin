# Migrating a live deployment onto `~/.harmony/deployment.json` (B-800)

> **This is a procedure for a HUMAN to run by hand, once, on each machine that runs a Harmony
> daemon / build container.** It is NOT executed by this build — B-800's build step only ships the
> code that CAN read the new file (`src/config/deployment-config.ts`, the daemon's `--config`/
> `--profile` boot flags, `mint-installation-token.mjs`'s `--config`-aware `--base` resolution, and
> `container/provision.sh` / `container/cloud-worker-*.sh`'s already-wired preferred-with-fallback
> reads). Actually running these steps against a real deployment happens later, at the ticket's
> **verify** step — not here.

## What this consolidates

Today a live deployment's config is spread across up to four places:

| Old mechanism | New home |
|---|---|
| A flat env file (`~/.harmony-container.env`, `container/env.example`) — the worker container's base env, and (since B-732) `mint-installation-token.mjs --base <file>`'s input | the `env` section |
| A standalone launch-profile JSON (`~/harmony-daemon-profile.json`, a copy of `container/daemon-profile.example.json` or `daemon-profile.cloud.example.json`), named by `HARMONY_DAEMON_PROFILE` | the `profiles` section, keyed by a name you choose |
| The launcher-host facts scattered across env vars (`HARMONY_APP_ID`/`HARMONY_APP_INSTALLATION_ID`/`HARMONY_APP_PRIVATE_KEY_PATH`, `HARMONY_PLUGIN_DIR`) and the hardcoded `KNOWN_REFS` map (`src/tools/environment.ts`) | the `launcher` section |
| The fixed three-slot clone assumption baked into `container/entrypoint.sh` (`WEB_REPO`/`PLUGIN_REPO`/`WORKSPACE_REPO` env vars) — a team with a different topology (one repo, N repos, no meta-repo wrapper) can't express it | the `repos` section (B-814) — an ordered, arbitrary list; ABSENT `repos` falls back byte-for-byte to the old three-slot behavior, so this section is opt-in |
| The worker image name, hardcoded as the literal `harmony-build-env` in the local-docker launch template and set once, out of band, on the Cloud Run job definition | the top-level `worker_image` key (B-929) — a plain string, defaulted in the schema to `harmony-build-env`; absent config ⇒ the local template renders that same literal and the cloud path passes no `--image` at all, so this too is opt-in |

All four land in **one JSON file per deployment** — see `src/config/deployment-config.ts`'s header
comment for the authoritative shape (zod is the single source of truth). One machine can run **N**
daemon deployments bound to **N** boards, each with its own file — the file's PATH is the instance
parameter, not a fixed location. That's exactly what the two worked examples below exercise.

**Nothing about this migration is required to keep working.** Every consumer (the daemon, the CLI,
`provision.sh`, the cloud-worker scripts, `mint-installation-token.mjs`) degrades gracefully when no
deployment config exists at the resolved path — a missing file is not an error, it's "not
configured, use the old mechanism." You can run this migration on your own schedule, one deployment
at a time, and the old files can stay in place indefinitely as an inert backup.

## Resolution precedence, recap

Every reader resolves the file the same way: **an explicit path (a `--config <path>` flag, where
one exists) > the `HARMONY_DEPLOYMENT_CONFIG` env var > the single-deployment default
`~/.harmony/deployment.json`.**

Not every consumer offers a `--config` flag — some only support the env var / default path:

| Consumer | `--config` flag? | `HARMONY_DEPLOYMENT_CONFIG` env var? |
|---|---|---|
| `harmony config get <path>` (CLI) | yes | yes |
| Daemon boot (`node dist/bin/daemon.js`) | yes, this ticket's item 1 | yes |
| `mint-installation-token.mjs` | yes, this ticket's item 2 | yes |
| `container/provision.sh` (`launcher.supabase.url` lookup) | no | yes |
| `container/cloud-worker-launch.sh` (`profiles.cloud.gcloud_project` AND `repos`, B-814, lookups) | no | yes |
| `src/tools/environment.ts` (`launcher.supabase_refs` merge, inside the running MCP/CLI process) | no | yes |

**Practical consequence:** for the DEFAULT deployment (path `~/.harmony/deployment.json`), you don't
need to think about this — every consumer just finds it. For a SECOND, non-default deployment (like
"Team Health" below), set `HARMONY_DEPLOYMENT_CONFIG` in every process environment that deployment's
containers/daemon run in (the container's env-file, the daemon's launchd plist / shell env) so the
env-var-only consumers pick it up automatically — reserve the `--config` flag for one-off CLI reads.

**One more load-bearing nuance for the `launcher` section specifically:** `launcher.plugin_dir` and
`launcher.github_app.*` are, today, *documented facts*, not automatically-injected env vars — the
daemon process itself still needs `HARMONY_PLUGIN_DIR`, `HARMONY_APP_ID`,
`HARMONY_APP_INSTALLATION_ID`, `HARMONY_APP_PRIVATE_KEY_PATH` set directly in ITS OWN environment
(e.g. the launchd plist's `EnvironmentVariables`), because (a) the launch/reap/probe command
templates expand `$HARMONY_PLUGIN_DIR` via ordinary shell inheritance from the daemon's env, and (b)
`mint-installation-token.mjs` reads the three App-identity vars directly from its own env by design
(see its header comment's zero-dependency rationale) — B-800 does not change either read path. Put
the same values in `deployment.json`'s `launcher` section too — it's the going-forward documented
source of truth other tooling can read — but don't remove them from the daemon's process env when
you do.

## `worker_image`: which container image this deployment's workers run (B-929)

A **top-level** key — a sibling of `env` / `profiles` / `launcher` / `repos`, not a member of any
one of them, because it is a property of the DEPLOYMENT rather than of a launch mechanism. Both
launch paths read the same value.

```jsonc
{
  "worker_image": "acme-build-env",
  "env": { /* … */ },
  "profiles": { /* … */ },
  "launcher": { /* … */ },
  "repos": [ /* … */ ]
}
```

| | |
|---|---|
| **Default** | `harmony-build-env`, written in exactly one place: the zod schema in `src/config/deployment-config.ts`. Every consumer either gets it from a parsed config or imports `WORKER_IMAGE_DEFAULT`. |
| **Local docker** | `container/daemon-profile.example.json`'s launch template says `{worker_image}`; the daemon substitutes it. With no deployment config the substitution falls back to the schema default, so the rendered command is byte-identical to the pre-B-929 literal. |
| **Cloud Run** | `container/cloud-worker-launch.sh` reads it via `harmony config get worker_image` (same best-effort pattern as `profiles.cloud.gcloud_project`) and adds `--image` to the **existing** `gcloud run jobs update` call. No config ⇒ no `--image` flag ⇒ the job's image is untouched, exactly as before. |
| **Bare name vs full ref** | A value containing `/` is a fully-qualified image ref used **verbatim** (another registry, or a pinned digest). A bare name resolves against `$HARMONY_WORKER_IMAGE_REGISTRY`, defaulting to `us-central1-docker.pkg.dev/$CLOUDSDK_CORE_PROJECT/harmony-workers`. |

**When you need it:** only when a project needs something the *image itself* must carry — a system
package, a browser, a compiler toolchain. A project that merely pins a Node version or a package
manager (`.nvmrc`, `.node-version`, `engines.node`, `packageManager`) needs **no config change at
all**: the shared image's toolchain manager honours those automatically, and a repo declaring none
of them is left untouched. See `container/README.md` → "Running a second project's toolchain".

**How to produce the image:** never by hand. Declare the binaries in a flat JSON requirements list
and generate the layer — `container/worker-image/README.md`. Publish it with the documented
`gcloud builds submit` path (not a per-image Cloud Build trigger), then set `worker_image`.

**Rolling back** a bad worker image: editing this key back to the last good version tag and
restarting the daemon is the **primary** rollback tier — see the three-tier table in
`container/README.md`.

## Prerequisites

- Read `src/config/deployment-config.ts`'s header comment once — it's the authoritative shape.
- Know where your existing `~/.harmony-container.env` and launch-profile JSON(s) live.
- `harmony` CLI available (`node dist/bin/harmony.js` from a plugin checkout, or the installed
  binary) to verify with `harmony config get` after each step.

---

## Example (a): the default single-deployment case

The common case — one daemon, one board, migrating to the default path with no flags needed
anywhere.

1. **Create the directory and start the file:**
   ```bash
   mkdir -p ~/.harmony
   ```

2. **Fold in the `env` section** — copy every SET (non-empty, uncommented) key out of your existing
   `~/.harmony-container.env` into a JSON object. Given an env file like:
   ```
   HARMONY_TARGET=prod
   HARMONY_API_TOKEN=harmony_abc123
   GIT_USER_NAME=Harmony Worker
   GIT_USER_EMAIL=worker@ycomplex.com
   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...
   ```
   (`GIT_TOKEN` is deliberately omitted — it's minted per-run by `mint-installation-token.mjs` and
   would just be stripped again; carrying a stale value forward serves no purpose.)

3. **Fold in the `profiles` section** — one entry per launch-profile JSON you currently point
   `HARMONY_DAEMON_PROFILE` at. Name it whatever you'll pass to `--profile`; `local` matches the
   docker profile's own convention (`container/daemon-profile.example.json`):
   ```json
   "profiles": {
     "local": {
       "launch": "mkdir -p $HOME/.harmony-conductions/{ticket}/{conduction_id}/projects ... (paste your existing launch template verbatim)",
       "reap": "bash \"$HARMONY_PLUGIN_DIR/container/docker-worker-reap.sh\" {conduction_id} {ticket}",
       "probe": "docker ps --filter name=harmony-worker-{conduction_id} --filter status=running --quiet | grep -q .",
       "maxConcurrentWorkers": 3
     }
   }
   ```
   Paste your CURRENT live profile's fields byte-for-byte — this is a format migration, not a
   content change.

4. **Fold in the `launcher` section** — the App identity + plugin dir facts, and (only if you've
   ever needed a `supabase_refs` override) that map:
   ```json
   "launcher": {
     "plugin_dir": "/absolute/path/to/harmony-plugin",
     "github_app": {
       "app_id": "123456",
       "installation_id": "78901234",
       "private_key_path": "/absolute/path/to/harmony-daemon.private-key.pem"
     }
   }
   ```
   Skip `launcher.supabase` entirely for a prod-target deployment — it's only needed for a
   staging/custom-target deployment (see `commands/harmony-setup.md`'s non-prod-target note).

5. **Fold in the `repos` section (B-814, OPTIONAL)** — an ordered list replacing the fixed
   `WEB_REPO`/`PLUGIN_REPO`/`WORKSPACE_REPO` three-slot clone. Skip this step entirely to keep
   today's env-var-driven behavior unchanged (feature-detected: absent `repos` falls back
   byte-for-byte). This is the explicit list-form of the SAME default three-slot topology
   `container/entrypoint.sh` clones today, for a team that wants it spelled out rather than implicit:
   ```json
   "repos": [
     { "url": "https://github.com/ycomplex/harmony-workspace.git", "path": "/workspace/workspace", "meta_repo_role": true },
     { "url": "https://github.com/ycomplex/harmony-web.git", "path": "/workspace/workspace/web" },
     { "url": "https://github.com/ycomplex/harmony-plugin.git", "path": "/workspace/workspace/plugin", "is_plugin": true }
   ]
   ```
   `meta_repo_role` marks the one entry that's the nesting parent (cloned first; every other entry
   whose `path` falls inside it clones nested — mirrors the `workspace` → `web`/`plugin` layout
   above). `is_plugin` marks the one entry `container/entrypoint.sh` hands provisioning off to; its
   clone `ref` always comes from `HARMONY_PLUGIN_POSTURE` (never from this entry's own `ref`, if it
   even sets one) — see example (b) below for the N=1 case this section exists for in the first
   place (a team with no meta-repo wrapper at all).

6. **Assemble `~/.harmony/deployment.json`** — the sections above as one object (`repos` omitted
   here since example (a) doesn't need it — see step 5):
   ```json
   {
     "env": { "HARMONY_TARGET": "prod", "HARMONY_API_TOKEN": "harmony_abc123", "GIT_USER_NAME": "Harmony Worker", "GIT_USER_EMAIL": "worker@ycomplex.com", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-..." },
     "profiles": { "local": { "launch": "...", "reap": "...", "probe": "...", "maxConcurrentWorkers": 3 } },
     "launcher": { "plugin_dir": "/absolute/path/to/harmony-plugin", "github_app": { "app_id": "123456", "installation_id": "78901234", "private_key_path": "/absolute/path/to/harmony-daemon.private-key.pem" } }
   }
   ```

7. **Verify it parses and reads back correctly:**
   ```bash
   node /absolute/path/to/harmony-plugin/dist/bin/harmony.js config get profiles.local.launch
   node /absolute/path/to/harmony-plugin/dist/bin/harmony.js config get launcher.github_app.app_id
   ```
   A schema violation (typo'd key, missing required `launch`/`reap`) throws a clear error naming the
   file and the problem — fix it before moving on.

8. **Switch the daemon boot to the named-profile route** (optional but recommended — see the
   precedence recap above; the old route keeps working indefinitely if you skip this):
   - Directly: `HARMONY_API_TOKEN=<token> node dist/bin/daemon.js --profile local` (no `--config`
     needed — the default path resolves automatically).
   - launchd: edit `~/Library/LaunchAgents/com.ycomplex.harmony-daemon.plist`'s `ProgramArguments`
     to append `--profile` / `local` as separate `<string>` entries, and you may now DROP the
     `HARMONY_DAEMON_PROFILE` entry from `EnvironmentVariables` (keep `HARMONY_API_TOKEN`,
     `HARMONY_PLUGIN_DIR`, and the three App-identity vars — see the nuance above). Reload:
     ```bash
     launchctl bootout gui/$UID/com.ycomplex.harmony-daemon
     launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.ycomplex.harmony-daemon.plist
     ```

9. **Leave `~/.harmony-container.env` in place** — the container/mint-script route still reads it
   as `--base`'s fallback, but now that `~/.harmony/deployment.json` exists at the default path, its
   `env` section wins automatically (no launch-template edit needed; `resolveBaseContent` checks the
   deployment config FIRST, regardless of whether `--base` was also passed). You may delete the old
   file once you've watched one real worker leg succeed and are confident the migration is right —
   this doc does not tell you to delete anything as part of the migration itself.

---

## Example (b): a SECOND, differently-named deployment — "Team Health"

Same machine, a second daemon bound to a different board ("Team Health"'s own project/token), at a
**non-default path** so it can't collide with the default deployment from example (a).

1. **Pick a dedicated directory and path** — e.g. `~/.harmony-team-health/deployment.json` (any
   path works; this mirrors the `~/.harmony-container.env` naming convention for a second
   deployment's private config):
   ```bash
   mkdir -p ~/.harmony-team-health
   ```

2. **Assemble the file** exactly as in example (a), but with Team Health's own board token and its
   own profile(s)/name(s) — reusing the SAME plugin checkout's `plugin_dir` and the SAME GitHub App
   identity is fine if the App is installed on the same repos; give Team Health's daemon its own
   `HARMONY_API_TOKEN` (its board), and its own profile name (`team-health` here, deliberately
   different from `local` above so both deployments' profile names never collide if anyone ever
   merges the two files). **This is also the worked example for a `repos` section (B-814):** Team
   Health has no separate web app, but there is **no plugin-less route** — `container/entrypoint.sh`
   always hands provisioning off to whichever entry carries `is_plugin: true`, and only
   `harmony-plugin` itself has a `container/provision.sh` to hand off to. So even a minimal
   deployment's `repos` list is **N=2**: the product repo as the `meta_repo_role` entry, plus
   `harmony-plugin` cloned nested inside it as the `is_plugin` entry — mirroring example (a)'s
   `workspace` → `web`/`plugin` layout, just without the `web` sibling:
   ```json
   {
     "env": { "HARMONY_TARGET": "prod", "HARMONY_API_TOKEN": "harmony_teamhealth_xyz789", "GIT_USER_NAME": "Harmony Worker", "GIT_USER_EMAIL": "worker@ycomplex.com", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-..." },
     "profiles": { "team-health": { "launch": "...", "reap": "...", "probe": "...", "maxConcurrentWorkers": 2 } },
     "launcher": { "plugin_dir": "/absolute/path/to/harmony-plugin", "github_app": { "app_id": "123456", "installation_id": "78901234", "private_key_path": "/absolute/path/to/harmony-daemon.private-key.pem" } },
     "repos": [
       { "url": "https://github.com/ycomplex/team-health.git", "path": "/workspace/workspace", "meta_repo_role": true },
       { "url": "https://github.com/ycomplex/harmony-plugin.git", "path": "/workspace/workspace/plugin", "is_plugin": true }
     ]
   }
   ```
   (The plugin entry's `path` above matches `container/provision.sh`'s own still-hardcoded
   `PLUGIN_DIR` — that internal hardcode is unchanged by B-814, so the `is_plugin` entry must
   currently target this exact path for provisioning to find it. Marking the PRODUCT repo itself
   `is_plugin` at that path — as an earlier draft of this doc suggested — hands provisioning to a
   repo with no `provision.sh` and hard-fails at the container entrypoint, while the actual plugin is
   never cloned; there is no shape that avoids cloning `harmony-plugin`.)

3. **Verify with an EXPLICIT `--config`** (this path is non-default, so every flag-aware consumer
   needs it spelled out):
   ```bash
   node /absolute/path/to/harmony-plugin/dist/bin/harmony.js config get profiles.team-health.launch --config ~/.harmony-team-health/deployment.json
   node /absolute/path/to/harmony-plugin/dist/bin/harmony.js config get repos --config ~/.harmony-team-health/deployment.json
   ```

4. **Boot Team Health's daemon with BOTH flags:**
   ```bash
   HARMONY_API_TOKEN=harmony_teamhealth_xyz789 \
   HARMONY_PLUGIN_DIR=/absolute/path/to/harmony-plugin \
   HARMONY_APP_ID=123456 \
   HARMONY_APP_INSTALLATION_ID=78901234 \
   HARMONY_APP_PRIVATE_KEY_PATH=/absolute/path/to/harmony-daemon.private-key.pem \
   node dist/bin/daemon.js --config ~/.harmony-team-health/deployment.json --profile team-health
   ```
   For launchd supervision, this is a SEPARATE plist with its own `Label` (e.g.
   `com.ycomplex.harmony-daemon-team-health`), its own `EnvironmentVariables` (the five vars above),
   and `--config` / `--profile` appended to `ProgramArguments` alongside the node/daemon.js pair —
   copy `com.ycomplex.harmony-daemon.plist`, rename the label, and adjust.

5. **For the env-var-only consumers** (`provision.sh`'s `launcher.supabase.url` lookup, the
   cloud-worker scripts' `profiles.cloud.gcloud_project` lookup, and the MCP/CLI's
   `launcher.supabase_refs` merge — none of which take a `--config` flag), set
   `HARMONY_DEPLOYMENT_CONFIG=/home/you/.harmony-team-health/deployment.json` in every process
   environment Team Health's containers/daemon run in — its own `--env-file`
   (`~/.harmony-team-health-container.env`, a sibling to the default deployment's
   `~/.harmony-container.env`) and its daemon's own launchd plist / shell env. This is what lets
   those consumers resolve the RIGHT file automatically without ever seeing a `--config` flag.

6. **Confirm the two deployments never collide:** `harmony config get` against each path
   independently should show each deployment's own `profiles`/`launcher` values, and each daemon
   process's own env (`HARMONY_API_TOKEN` etc.) should differ. Nothing in either file references the
   other.
