# Conductor config (B-1170)

A project's conductor is configured by **one file in its repo** (`.harmony/conductor.json`) plus a small
**host file** for what is true of one machine. This is the reference. The code is
`src/config/conductor-config.ts` (schemas, merge, errors), `src/config/conductor-project-source.ts` (reading
the file from GitHub), `src/daemon/conductor-config-runtime.ts` (the daemon's refresh timer) and
`src/cli/commands/conductor-config.ts` (the three commands).

## Purpose

Before this, a deployment was spread over `~/.harmony/deployment.json`, a profile JSON, a `daemon.env`
exporting `HARMONY_GKE_*` / `HARMONY_CLOUD_RUN_*` / `CLOUDSDK_*` / `HARMONY_APP_*`, and per-script
`HARMONY_PLUGIN_DIR`. Nothing said which one won, and a change needed a host edit plus a restart. Now:

- everything the *project* owns (channel, profile, cluster, namespace, concurrency, model policy ...) is in
  `.harmony/conductor.json`, reviewed by PR like any other code;
- everything that is true of *this machine* (plugin checkout, GitHub App identity, gcloud account, secret
  names) is in `~/.harmony/conductor-host.json`;
- unknown keys are errors that name the key and list the allowed ones, never silent ignores.

## The two files

| File | Lives | Owned by | Read how |
|---|---|---|---|
| **Project file** `.harmony/conductor.json` | on `main` of `config_repo` | the project (PR-reviewed) | fetched over the GitHub contents API, kept as a local last-good snapshot |
| **Host file** `~/.harmony/conductor-host.json` | this machine only (mode 0600) | the operator of the host | read from disk |

`HARMONY_HOME` replaces `~/.harmony` as the directory of the host file and the snapshot. Example files:
`container/conductor.project.example.json` and `container/conductor.host.example.json` (placeholders only;
a test keeps both valid against the schemas).

## Keys

`version` is required in both files and must be `1`. In the project file `channel` and `profile` are
required. The host file may carry **any project key as an override** (it wins over the project file) plus the
host-only keys. "Hot" means a running daemon applies it on the next refresh; "restart" means it is read once
at boot (a change is logged as `restart needed`).

| Key | Type | Default | Owner | Applied |
|---|---|---|---|---|
| `channel` | `"staging"` \| `"prod"` | required | project | restart |
| `profile` | `"cloud"` \| `"gke"` | required | project | restart |
| `images.worker` | string (bare name, or a ref containing `/`) | the worker-image default | project | restart |
| `images.codex` | string | unset | project | restart |
| `gcp.project` | string | required by both profiles | project | restart |
| `gcp.region` | string | the launch script's own default | project | restart |
| `cloud_run.job` | string | the launch script's own default | project | restart |
| `gke.cluster` | string | required for `gke` | project | restart |
| `gke.location` | string (zone or region) | required for `gke` | project | restart |
| `gke.namespace` | string | `harmony-legs` | project | restart |
| `gke.context` | string | derived `gke_<project>_<location>_<cluster>` | host (machine kubeconfig) | restart |
| `gke.registry` | string | the launch script's default registry | project | launch env |
| `gke.base_secret`, `gke.codex_secret` | string (Secret Manager secret **names**) | script defaults | project | launch env |
| `gke.cpu`, `gke.memory` | string | `6`, `20Gi` | project | launch env |
| `gke.ticket_disk`, `gke.storage_class` | string | `20Gi`, `harmony-ticket-disk` when the cluster has it (setup step 17), else `standard-rwo` | project | launch env |
| `gke.deadline_s`, `gke.job_ttl_s`, `gke.poll_s` | integer | `5400`, `3600`, `5` | project | launch env |
| `concurrency.max_workers` | integer >= 0 | `2` (the built-in profile's cap) | project | **hot** |
| `model_policy.default` | string (model alias) | none | project | **hot** |
| `model_policy.per_gate` | map gate -> model alias | none | project | **hot** |
| `log_shipping` | boolean | unset = ship when `gcp.project` is named | project | **hot** (read live by the log shipper, see [Conductor logs](#conductor-logs-b-1174)) |
| `agents` | non-empty list of strings | `["claude-code","codex"]` | project | restart |
| `config_repo` | `"owner/name"` | none (no default repo) | host | start |
| `config_ref` | string | `main` | host | start |
| `plugin_dir` | path | required (both profiles launch from the host's plugin checkout) | host | launch env |
| `github_app.app_id`, `.installation_id`, `.private_key_path` | strings | required | host | launch env |
| `gcloud.account` | string | unset | host | launch env |
| `secrets` | map logical name -> Secret Manager secret **name** | none | host | n/a |

"launch env" keys are written into the daemon's process environment as the variables the launch scripts
read (`HARMONY_GKE_*`, `HARMONY_CLOUD_RUN_*`, `CLOUDSDK_CORE_PROJECT`, `CLOUDSDK_CORE_ACCOUNT`,
`HARMONY_PLUGIN_DIR`, `HARMONY_APP_*`). A variable the operator already exports is never overwritten, and a
refresh updates only the variables the daemon itself set. Strictly, `gcp.project`, `gcp.region`,
`cloud_run.job`, `gke.namespace` and `gke.context` are logged as restart-needed when they change, because a
running process should not move clusters under in-flight legs; the new value still reaches the *next*
launch's environment.

`secrets` holds **names only**. A value that looks like a credential (`ghp_`, `github_pat_`, `sk-`, `eyJ`,
a PEM block, a 40+ character token) is refused with a pointer to Secret Manager.

## Precedence

```
legacy files  <  project file  <  host file  <  env
```

- **env** means `HARMONY_CONDUCTOR_<KEY_PATH_UPPER_SNAKE>` (for example `HARMONY_CONDUCTOR_GKE_NAMESPACE`,
  `HARMONY_CONDUCTOR_CONCURRENCY_MAX_WORKERS`). These are **test overrides only**: they exist so a test or a
  one-off dry run can pin a value without a file. They are not a supported way to run a deployment. Path
  overrides in the same spirit: `HARMONY_CONDUCTOR_PROJECT_FILE`, `_HOST_FILE`, `_SNAPSHOT_FILE`,
  `_CONFIG_REPO`, `_CONFIG_REF`.
- **legacy** is `deployment.json` and the old process-env knobs; every use emits one deprecation warning
  naming the old location and its replacement key (see [Deprecated](#deprecated)).
- Objects merge key by key; arrays (`agents`) and scalars are replaced.
- A *legacy env knob that the operator exports* (for example `HARMONY_GKE_NAMESPACE` in `daemon.env`) beats
  the files **at launch**, because the launch scripts read the process environment and a variable that is
  already set is never overwritten. `doctor` reports this as a conflict.

## How the project file is read

1. `config_repo` (and optionally `config_ref`, default `main`) come from the host file.
2. The daemon reads `.harmony/conductor.json` from that repo through the **GitHub contents API** with its
   existing **harmony-daemon App installation token** (the same credential it already uses for PR merge
   state). No clone, no new credential.
3. It refreshes **every 5 minutes** (and once at boot), sending `If-None-Match` so an unchanged file costs a
   304.
4. A valid new file replaces the **last-good snapshot** `~/.harmony/conductor-snapshot.json` (written
   atomically, mode 0600). The conductor reads the snapshot, so it keeps working through a GitHub outage.
5. An **invalid** file (bad JSON, unknown key, wrong type) never replaces the snapshot: the previous
   snapshot stays in force and the daemon logs one warning with every problem. A bad commit, an outage or an
   uninstalled App can never stop the conductor.
6. **First boot rule.** With no snapshot and no reachable project file, the conductor runs on the legacy
   files (with a warning `no project file reachable yet; running on legacy files`). With no legacy files
   either, it refuses to start and says to run `harmony conductor config sync`. A host with *only* legacy
   files (no host file, no snapshot) behaves exactly as before this feature and starts no timer.
7. `HARMONY_CONDUCTOR_PROJECT_FILE` points at a local file that is read **instead of** the snapshot (no
   network refresh); it is for tests.

The App installation must include `config_repo`. If it does not, the refresh logs a 404/403 that says so;
add the repository to the harmony-daemon installation.

### Hot vs restart-needed

Every 5 minutes, if the merged config changed, the daemon **applies** `concurrency.max_workers` (unless
`HARMONY_DAEMON_MAX_CONCURRENT_WORKERS` is set, which keeps winning), `model_policy`, `log_shipping` and the
launch env, and **logs** `conductor config: restart needed — <keys>` for the restart-only keys
(`channel`, `profile`, `gcp.project`, `gcp.region`, `gke.cluster`, `gke.location`, `gke.namespace`,
`gke.context`, `cloud_run.job`, `images.worker`, `images.codex`). An invalid reload keeps the previous good
config and is logged once per distinct message.

**Model policy.** A conduction's own `run_config.model` always wins. When it names no `default` and no
`per_gate` entry for the leg's gate, the daemon fills the policy into the `run_config` it hands the worker
(both the rendered `{run_config_json}` and the `{model}` it chose), so the worker's own resolution agrees
with the daemon's and never loops on model-switch requests. Codex runs are left alone.

## Errors

Every problem is one line: `<file> › <key>: <problem>. Fix: <fix>`; the loader and `doctor` report **all**
of them, not the first.

```
conductor.json › gke.cluster: the gke profile requires a cluster name. Fix: add "gke": { "cluster": "<cluster-name>" } to .harmony/conductor.json
conductor-host.json › gke.nampespace: unknown key. Fix: remove it, or use one of the allowed keys under gke: cluster, location, namespace, context, registry, base_secret, codex_secret, cpu, memory, ticket_disk, storage_class, deadline_s, job_ttl_s, poll_s
conductor-host.json › secrets.base: looks like a secret VALUE, not a Secret Manager secret NAME (the secrets block holds names only). Fix: store the value in Secret Manager and put only the secret NAME here
```

## Commands

`harmony conductor config <migrate|doctor|sync>`; each accepts `--json`.

```
$ harmony conductor config sync
updated: snapshot /home/op/.harmony/conductor-snapshot.json now holds my-org/config@main (sha 3f2a...)
```

Exit 0 for `updated`/`unchanged`; exit 0 with a loud `WARNING:` line for `kept-last-good` or `unreachable`
*when a snapshot exists*; exit 1 when there is no snapshot to fall back on, no `config_repo`, or no GitHub
credential.

```
$ harmony conductor config migrate --profile gke                     # dry run: prints, writes nothing
$ harmony conductor config migrate --profile gke --write --out-project ./conductor.json
```

Prints the proposed project file, the host file, the `DROPPED` list (each item with a reason; secret values
are never copied) and the warnings. `--write` requires `--out-project` (no implicit default into the current
directory), defaults `--out-host` to the resolved host-file path, refuses to overwrite an existing file
without `--force`, writes the host file with mode 0600, and **never modifies, renames or deletes a legacy
file**. It refuses to write over the legacy `deployment.json` even with `--force`.

```
$ harmony conductor config doctor
SOURCES / ISSUES (n) / CONFLICTS (n) / LEGACY IN USE (n) / HOT ... | RESTART NEEDED ...
```

`doctor` lists every source considered (project override file, snapshot with `fetched_at` and sha, host file,
legacy `deployment.json`, legacy env knobs in *this shell*), every issue, every key set to **different**
values in two layers (project vs host, host vs env, files vs legacy `deployment.json`, files vs a legacy env
knob) with which one wins, and every legacy source still supplying a value with its replacement key. A
conflict with a legacy env knob carries the note *environment wins at launch (deprecated) — unset it or
remove it from daemon.env*. Exit **1** when there is any issue; conflicts and legacy use are warnings (exit
0). To check what the daemon sees, load its environment first: `set -a; . <daemon.env>; set +a`.

## Conductor logs (B-1174)

The daemon writes **two outputs from one logger**:

- **stdout** keeps its text lines, `<ISO timestamp> <line>` (also appended to `HARMONY_DAEMON_LOG` when set).
  Only a remote conductor (`HARMONY_CONDUCTOR_REMOTE=1`, set by its pod spec; `KUBERNETES_SERVICE_HOST` is
  deliberately not used) prints JSON lines on stdout instead.
- **`~/.harmony/logs/conductor.log`** (`HARMONY_CONDUCTOR_LOG` overrides; `HARMONY_HOME` is honoured) is the
  structured record: one JSON object per line `{ts, level, event, message, ticket?, conduction?, leg?, project?}`,
  rotated at 10 MB keeping 5 files (`conductor.log.1` .. `.5`). It is written first and never loses an entry
  because shipping is down, slow or off. Values of known secret env vars (`HARMONY_API_TOKEN`, `GIT_TOKEN`,
  `GH_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, ... and any `*_TOKEN`/`*_SECRET`/`*_PASSWORD`) are
  replaced by their names before either output.

**Shipping to Cloud Logging** is on when the merged config names `gcp.project` and `log_shipping` is not
`false`; it is re-checked on every flush, so editing either in `.harmony/conductor.json` takes effect within
one config refresh plus one flush, no restart. With neither, the shipper is fully off (no gcloud spawn, no
token fetch, no network). Entries go in batches (every 5 s or 500 entries) to log name `harmony-conductor`,
labelled `harmony_project=<key>`, authenticated with `gcloud auth print-access-token` for the host's gcloud
account (`CLOUDSDK_CORE_ACCOUNT`, from the host file's `gcloud.account`). The in-memory queue holds 10,000
entries; when it overflows the oldest are dropped and, once Cloud Logging is reachable again, ONE warning
entry says how many were dropped and over what window (the local file still has them). A permission error
is logged once naming `roles/logging.logWriter` and retried every 5 minutes.

**One-time setup on the conductor host:** install `gcloud`, make sure its active (or configured) account is
the conductor's, and grant that account the writer role on the logging project:

```
gcloud projects add-iam-policy-binding <PROJECT> --member=serviceAccount:<ACCOUNT> --role=roles/logging.logWriter
# (use --member=user:<ACCOUNT> for a user account)
```

**Reading logs.** From the host (or anywhere with the file): 

```
harmony conductor logs --since 1h [--source local|cloud] [--limit 200] [--project <id>]
```

`--source` defaults to `local` when the file exists, else Cloud Logging. From anywhere with `gcloud` and
`roles/logging.viewer` (what an orchestrator runs):

```
gcloud logging read 'logName="projects/<PROJECT>/logs/harmony-conductor" AND timestamp>="2026-10-20T10:00:00Z"' \
  --project=<PROJECT> --format=json --order=desc --limit=200
# narrow by ticket / conduction / severity:
#   ... AND jsonPayload.ticket="B-123"   ... AND jsonPayload.conduction="<id>"   ... AND severity>=WARNING
```

## Adoption runbook (operator)

1. `harmony conductor config migrate --profile <name>` and read the dry run: the two files, what was
   dropped, the warnings.
2. Write the files: `... migrate --profile <name> --write --out-project ./conductor.json`.
3. Add `"config_repo": "owner/name"` to the host file, then **commit the project file** to the config repo as
   `.harmony/conductor.json` on `main` through a normal PR.
4. Put the host file at `~/.harmony/conductor-host.json` (mode 0600) and make sure the harmony-daemon App
   installation includes `config_repo`.
5. `harmony conductor config sync`, then `harmony conductor config doctor`; fix every issue it prints.
6. Restart the conductor (restart-only keys are read at boot).
7. **Prove the new files suffice:** rename the old files away yourself (`deployment.json`, the exports in
   `daemon.env`), restart, and run `doctor` again. No tooling ever does this step for you.

## Deprecated

Still read as the lowest-precedence fallback, each with a deprecation warning, and to be removed once hosts
have migrated:

| Deprecated | Replacement |
|---|---|
| `~/.harmony/deployment.json` (`profiles.*`, `worker_image`, `launcher.*`, `env.HARMONY_PLUGIN_POSTURE`) | `.harmony/conductor.json` (`profile`, `images.worker`, `channel`, ...) and the host file (`plugin_dir`, `github_app`) |
| the standalone profile JSON (`HARMONY_DAEMON_PROFILE`, `container/daemon-profile.*.example.json`) | `profile: "cloud" \| "gke"` selects the built-in launch/reap/probe template (a custom template is ignored once `profile` is named) |
| `daemon.env` exports of `HARMONY_GKE_*` | `gke.*`, `images.worker` (`HARMONY_GKE_IMAGE`) |
| `HARMONY_CLOUD_RUN_REGION`, `HARMONY_CLOUD_RUN_JOB` | `gcp.region`, `cloud_run.job` |
| `CLOUDSDK_CORE_PROJECT` | `gcp.project` |
| `CLOUDSDK_CORE_ACCOUNT` | `gcloud.account` (host file) |
| `HARMONY_APP_ID`, `HARMONY_APP_INSTALLATION_ID`, `HARMONY_APP_PRIVATE_KEY_PATH` | `github_app.*` (host file) |
| per-script `HARMONY_PLUGIN_DIR` | `plugin_dir` (host file) |
| `HARMONY_PLUGIN_POSTURE` | `channel` |

The daemon exports the launch-env values into its own process environment for the launch scripts; it does
not read those back as legacy knobs.

## What stays an environment variable

**`HARMONY_API_TOKEN` stays an environment variable of the service** until a Secret Manager reader exists
(B-1173). The host file's `secrets` block records Secret Manager secret **names only**; secret **values**
never appear in either file, in `migrate` output, or in `doctor` output (`migrate` lists them under
`DROPPED` by name and reason). `HARMONY_APP_PRIVATE_KEY` (inline key contents) is likewise never copied; use
`github_app.private_key_path`.
