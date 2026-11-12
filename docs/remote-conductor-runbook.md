# Remote conductor runbook (B-1173, B-1186)

> **Living · product · Tier 2** · verified against plugin 0.17.50 / web 541092e on 2026-11-12 · **revise when:** the conductor image, its manifests, `setup-cluster.sh`, the leg size or the quotas the ceiling needs change. Convention: harmony-workspace `docs/README.md` (B-1044).

How to run a project's conductor as **one pod on the project's own GKE cluster**, from a machine that has only this
plugin installed. Follow it top to bottom. Every command is written so it works from any directory: the plugin is
addressed through `$PLUGIN_DIR` (step 0), never through a relative path or a bare `harmony`.

Nothing here is specific to one project. Angle-bracket placeholders are yours to fill:

| Placeholder | Meaning | Example shape |
|---|---|---|
| `<project>` | the GCP project that holds the cluster, the registry and the secrets | `my-gcp-project` |
| `<cluster>` | the GKE cluster | `harmony-legs` |
| `<zone>` / `<region>` | the cluster's zone, and the region it sits in | `us-central1-a` / `us-central1` |
| `<daemon-account>` | the Google service account (or user) that runs kubectl for the conductor on the host | `conductor@<project>.iam.gserviceaccount.com` |
| `<conductor-account>` | the Google service account the pod acts as (Workload Identity) | `harmony-conductor@<project>.iam.gserviceaccount.com` |
| `<artifact-repo>` | the Artifact Registry repository holding the conductor and worker images | `harmony-workers` |
| `<registry>` | the full registry path `<region>-docker.pkg.dev/<project>/<artifact-repo>` (`setup-cluster.sh` prints it) | `us-central1-docker.pkg.dev/my-gcp-project/harmony-workers` |
| `<config-repo>` | `owner/name` of the repo whose `main` holds `.harmony/conductor.json` | `my-org/my-workspace` |

Secrets appear by **name only**. The values that are specific to one deployment (its project id, cluster, accounts,
secret names) belong in that deployment's own notes, not here.

## What runs where

| Thing | Value |
|---|---|
| Namespace | `harmony-conductor` (its own; legs stay in `harmony-legs`) |
| Deployment / container | `harmony-conductor` / `conductor`, 1 replica, rolling update with `maxSurge 1`, `maxUnavailable 0` |
| Pod label | `app.kubernetes.io/name=harmony-conductor` |
| Kubernetes identity | `harmony-conductor/harmony-conductor`, with a Role in `harmony-legs` and a Role in `harmony-conductor` (its own Deployment only). Nothing cluster-wide |
| Google identity | `<conductor-account>` through Workload Identity |
| Image | `<registry>/harmony-conductor`, tags `:<plugin version>-<channel>` (for example `0.16.41-staging`) and `:<channel>`; the Deployment is pinned to a version tag |
| Scheduling | the cluster's `default-pool` (the system pool), PriorityClass `harmony-conductor` |
| Sweep | CronJob `harmony-sweep` in `harmony-conductor`, every 6 hours |
| Codex owner (only with Codex legs) | CronJob `harmony-codex-refresh` in `harmony-conductor`, every minute, with its own PVC and service account, from the owner image built from `container/codex-auth/` (not the conductor image). It is set up by `docs/codex-auth-cutover.md`, not by this runbook |
| Source files | `container/conductor/` (image and `k8s/` manifests) and `container/gke/setup-cluster.sh`, steps 18 to 27 |

## Ordering rules (do not reorder)

1. A local sweep (a launchd or cron job that runs `container/gke/sweep-ticket-disks.sh`) is removed **only after**
   the CronJob has run once successfully.
2. A conductor already running elsewhere (for example on a Mac) stops **only after** the pod holds the lease.
3. The host's `roles/container.developer` grant (setup-cluster step 8) stays until the fallback section says the
   local fallback no longer needs it.
4. `priorityclass.yaml` is applied **before** the Deployment, because the Deployment names it.

## 0. Prerequisites on the operator machine

You need, on the machine you run this from:

- the Harmony plugin installed (Claude Code plugin) **or** a checkout of this repository on the `staging` or `prod`
  branch. The `main` branch carries no `dist/`, so it cannot run these commands until it has been built;
- `node` 20 or newer, `gcloud` and `kubectl`;
- **`gke-gcloud-auth-plugin`**, which `kubectl` calls to authenticate to GKE. Install it with
  `gcloud components install gke-gcloud-auth-plugin` (or the OS package `google-cloud-cli-gke-gcloud-auth-plugin`)
  and check `gke-gcloud-auth-plugin --version`. Without it every `kubectl` command below fails with an
  authentication-plugin error;
- a kubeconfig entry for the cluster, created once:
  `gcloud container clusters get-credentials <cluster> --zone <zone> --project <project>`
  (the context is named `gke_<project>_<zone>_<cluster>`; check with `kubectl config current-context`);
- rights to create the resources in steps 3 to 6 (project owner, or the equivalent roles).

Then set `PLUGIN_DIR` **once** in the shell you work in. Every later command uses it.

```bash
# An installed plugin lives in the Claude Code plugin cache; pick the newest version:
PLUGIN_DIR="$(ls -d "$HOME"/.claude/plugins/cache/*/harmony-plugin/* | sort -V | tail -1)"
# ...or a checkout of this repository (on the staging or prod branch):
# PLUGIN_DIR=/path/to/harmony-plugin

# It must hold the built CLI and the scripts:
test -f "$PLUGIN_DIR/dist/bin/harmony.js" && test -f "$PLUGIN_DIR/container/gke/setup-cluster.sh" && echo "PLUGIN_DIR ok: $PLUGIN_DIR"
```

All commands below are `node "$PLUGIN_DIR/dist/bin/harmony.js" ...` and `bash "$PLUGIN_DIR/container/..."`. Run the
`kubectl apply` commands that name a manifest file as `kubectl apply -f "$PLUGIN_DIR/container/conductor/k8s/<file>"`.

## 1. Size the system pool

The conductor pod runs on the cluster's `default-pool`, **not** on the leg pool (the leg pool is tainted so the
conductor can never keep a leg node alive). That pool also runs GKE's own system pods. If it is too small, a rollout
(which runs **two** conductor pods for a moment) cannot schedule, or the autoscaler's scale-up brings in more system
pods that push the conductor out.

Measure, do not guess:

1. **Measure with the leg pool at its MAXIMUM node count**, not at zero legs. Run a few legs, or temporarily raise
   the leg pool's minimum to its maximum, and wait until the nodes are up. The system pods' footprint grows with the
   cluster: `konnectivity-agent` is scaled by the cluster-proportional autoscaler and `kube-dns` scales with node
   count, so a measurement taken at zero legs understates what is requested at peak.
2. Read what is already requested on a system node:
   `kubectl describe node <system-node>` and look at "Allocated resources" (CPU requests against allocatable). List
   the system pods with `kubectl -n kube-system get pods -o wide`.
3. **Size `default-pool` for the conductor plus those pods.** The conductor requests 50m CPU and 256Mi memory
   (`container/conductor/k8s/deployment.yaml`); a rollout runs two of them, so budget 100m CPU and 512Mi on top of the
   system pods' requests at peak, and leave headroom for the autoscaler to add more. If the sum does not fit on the
   nodes you have, add nodes before you add anything else.
4. Tell the setup script the size you chose:
   `--system-nodes <n>` (default 2) and `--system-machine-type <type>` (default `e2-medium`). On a **new** cluster
   they set the system pool at creation (together with `--workload-metadata=GKE_METADATA`). On an **existing**
   cluster the script never resizes anything: it enables `GKE_METADATA` on `default-pool` when it is missing
   (refusing while a leg Job is active, because that recreates the nodes) and prints `DRIFT:` lines, with the exact
   fix command, when the node count or machine type differs from what you asked for.

Re-run this step whenever the leg pool's maximum changes, or after a GKE upgrade that adds system pods.

## 2. Create the Cloud Build triggers (GCP side)

Two triggers on the plugin repository, both using `container/conductor/cloudbuild.yaml`:

- on push to the plugin's **`staging`** branch, with substitution `_CHANNEL=staging`;
- on push to its **`prod`** branch, with `_CHANNEL=prod`.

The build file names no project (B-1435). `_CHANNEL` may be left empty on a trigger: the build then derives it from
the branch it built (`staging` or `prod`) and fails, naming `_CHANNEL`, on any other branch. The image path defaults
from the build's own project: `_IMAGE` empty means `<_REGION>-docker.pkg.dev/<the build's PROJECT_ID>/<_ARTIFACT_REPO>/harmony-conductor`,
with `_REGION` defaulting to `us-central1` and `_ARTIFACT_REPO` to `harmony-workers`. A trigger in your own project
therefore needs only `_CHANNEL`; pass the others when your registry differs:

```bash
gcloud builds triggers create github --project <project> --name harmony-conductor-staging \
  --repo-owner <owner> --repo-name <plugin-repo> --branch-pattern '^staging$' \
  --build-config container/conductor/cloudbuild.yaml \
  --substitutions _CHANNEL=staging
gcloud builds triggers create github --project <project> --name harmony-conductor-prod \
  --repo-owner <owner> --repo-name <plugin-repo> --branch-pattern '^prod$' \
  --build-config container/conductor/cloudbuild.yaml \
  --substitutions _CHANNEL=prod,_REGION=<region>,_ARTIFACT_REPO=<artifact-repo>
# or the whole path at once: --substitutions _CHANNEL=prod,_IMAGE=<registry>/harmony-conductor
```

The worker-image build (`container/cloudbuild.yaml`) follows the same rule: `_IMAGE` and `_DOCKER_IMAGE` default to
`<_REGION>-docker.pkg.dev/<the build's PROJECT_ID>/<_ARTIFACT_REPO>/harmony-build-env` and `.../harmony-build-env-docker`.

Proves: a merge that regenerates `staging` publishes a staging image, and a promotion to `prod` publishes a prod
image, each labelled `harmony.plugin_version`. The build runs `container/conductor/smoke.sh` against the candidate
image before anything is pushed, including the credential-free boot preflight
(`conductor-boot.js preflight`), so an image that lacks a tool or a script never gets a tag.

## 3. Run the cluster setup

Dry-run first, then for real. Steps 18 to 27 are idempotent: they read first and change only what differs.

```bash
bash "$PLUGIN_DIR/container/gke/setup-cluster.sh" \
  --project <project> --zone <zone> --cluster <cluster> \
  --daemon-sa <daemon-account> \
  --cloud-run-runtime-sa <runtime-account-of-the-cloud-run-job> \
  --system-nodes <n> --system-machine-type <type> \
  --dry-run
# read the output, then run the same command without --dry-run
```

Your legs use your own project's registry and transcript bucket by default (B-1217). With `gcp.project` set in the
project file, a leg launches from `us-central1-docker.pkg.dev/<project>/harmony-workers/harmony-build-env-docker:latest`
and writes transcripts to `gs://<project>-transcripts`, and `setup-cluster.sh` checks and binds that same bucket. To
use other names, set them in the project file: `images.worker` (a bare name is joined to `gke.registry`; a ref with a
`/` is used as is), `gke.registry`, and `gke.transcript_bucket` (pass the same name to `setup-cluster.sh
--transcript-bucket`). The bucket is never created for you; create it before step 3.

Leave out `--cloud-run-runtime-sa` if you do not use the cloud profile from the pod (step 22 then says it was
skipped). The script also applies `container/conductor/k8s/priorityclass.yaml` (step 27) with your credentials; step 5
below applies it by hand if you used `--no-conductor`.

### 3a. Choosing the parallelism ceiling, and the quotas it needs (B-1194)

How many legs run at once is a choice about appetite, not a measurement. The pool scales to zero and a leg costs the
same per hour whether 2 or 20 run, so a higher ceiling changes *when* money is spent, not how much. Weigh these before
picking a number: model API rate limits (Anthropic, OpenAI), GitHub API limits, merge contention (by default the
operator approves every pull request, so more legs means more pull requests waiting on a human), and the fact that a
looping bug spends faster at a higher ceiling. The cap is partly a circuit breaker; a Google Cloud budget alert is the
console-side alarm for it.

A leg requests 6 CPU and 10Gi and sets no limits (`container/gke/gke-worker-launch.sh`,
`container/gke/gke-render-leg.mjs`). The 6 CPU request is what keeps one leg per node on an 8 vCPU machine; the memory
request is sized from measured usage (peak 7.68 GiB over 129 legs). Set the ceiling in two places, together:
`--max-nodes` on the pool (`setup-cluster.sh`, default 5) and `concurrency.max_workers` in the project file.

#### The quotas the ceiling needs

Google Cloud caps how much a project may run at once. A new project's defaults are too low for even a small pool:
the project-wide CPU cap starts at 32 on many projects, and the regional address cap at 8. Ask for the increases
**before** you raise the ceiling. A leg that cannot get a node waits in `Pending` with no error on the board.

Every row below is a Compute Engine quota. Work out the figure from four numbers:

- `C`: the parallelism ceiling (the pool's `--max-nodes`, equal to `concurrency.max_workers`).
- `V`: vCPU per leg node. `e2-standard-8` has 8. One leg per node, so a node is a leg.
- `S`: system nodes, and `s`, vCPU per system node. The script's system pool is `e2-medium`, 2 vCPU.
- `T`: how many ticket disks exist at once. **This is not the ceiling.** A ticket keeps its 20Gi disk
  (`gke.ticket_disk`) from its first leg until the sweep deletes it after the ticket is Verified, Cancelled or
  archived, so `T` is roughly the number of tickets in flight plus those waiting for verify, often several times `C`.

Add one node of headroom (`+1`) to the node-shaped rows: a GKE surge upgrade adds a node before it removes one.

| Quota (metric) | Scope | What uses it | Must be at least | Worked example: `C`=5, `V`=8, `S`=2, `s`=2 |
|---|---|---|---|---|
| `CPUS_ALL_REGIONS` ("CPUs (all regions)") | project | every node's vCPU, in every region | `(C + 1) x V + S x s` | 6 x 8 + 2 x 2 = 52: request **64** |
| `E2_CPUS` (machine-family pool, where exposed) | region | E2 leg and system nodes | `(C + 1) x V + S x s` when both pools are E2 | 52: request **64**; inspect actual quota names |
| `CPUS` ("CPUs") | region | the same vCPU, counted per region | `(C + 1) x V + S x s` | 52: often within the default |
| `IN_USE_ADDRESSES` ("In-use IP addresses") | region | one external IP per node | `C + S + 1` | 8: request **16** (a default of 8 leaves no room for a rollout) |
| `INSTANCES` ("VM instances") | region | one VM per node | `C + S + 1` | 8: usually within the default |
| `SSD_TOTAL_GB` ("Persistent Disk SSD (GB)") | region | ticket disks: the class is `pd-balanced`, which counts as SSD | `T x 20` plus anything else already on `pd-balanced` or `pd-ssd` | 19 open ticket disks: 380 GB |
| `DISKS_TOTAL_GB` ("Persistent Disk Standard (GB)") | region | node boot disks: the script uses `pd-standard`, 100 GB each | `(C + S + 1) x 100` | 800 GB: usually within the default |

The bold figures are the increases a project on default quotas typically has to request; the rest usually fit the
defaults. Defaults vary by project and billing history, so read yours first:

```bash
gcloud compute project-info describe --project <project> --format=json \
  | jq -r '.quotas[] | select(.metric=="CPUS_ALL_REGIONS") | "\(.metric) \(.usage)/\(.limit)"'
gcloud compute regions describe <region> --project <project> --format=json \
  | jq -r '.quotas[] | select(.metric|IN("CPUS","E2_CPUS","IN_USE_ADDRESSES","INSTANCES","SSD_TOTAL_GB","DISKS_TOTAL_GB"))
           | "\(.metric) \(.usage)/\(.limit)"'
```

Check the actual machine-family CPU pool as well as `CPUS_ALL_REGIONS`: metric names and E2/N1 sharing vary by project. Include only system nodes in that pool in the family formula. In one observed deployment, the regional `E2_CPUS` limit was 24 while the global limit was 32. Two e2-medium system nodes and two e2-standard-8 legs consumed 20 vCPU; a third leg needed 28 and could not fit the family limit. Request that pool's increase too, retaining the extra-node rollout allowance. See [Compute Engine allocation quotas](https://docs.cloud.google.com/compute/resource-usage).

**Requesting an increase**, once per quota that is short:

1. In the Google Cloud console, pick the project, then open **IAM & Admin > Quotas & System Limits**.
2. In the filter box, type the metric's display name from the table (for example `CPUs (all regions)`). For a
   regional quota, also filter **Dimensions: region** to your region.
3. Tick the row, then choose **Edit quotas** at the top.
4. Enter the new limit. Round up: asking for 64 rather than 52 leaves room to raise the ceiling later without
   another request.
5. Give a reason. Google reads this; plain and specific works. For example:
   `GKE node pool for CI-style build workers: up to 5 e2-standard-8 nodes (8 vCPU each) plus a 2-node system
   pool, autoscaling from zero. Needs 52 vCPU at peak; requesting 64 for upgrade headroom.`
   For addresses: `One external IP per GKE node: up to 5 build nodes plus 2 system nodes, plus one surge node
   during upgrades. Requesting 16.`
6. Submit. Small increases on an account with billing history are usually granted within minutes, and an email
   confirms it. A larger one, or a new billing account, can take a day or be refused; the email says which.

Do not raise `max_workers` until every grant shows on the quota page. If one is refused, keep the ceiling at what
the granted quotas allow.

The disk quotas rarely need a request at small ceilings, but `SSD_TOTAL_GB` grows with tickets, not with legs. If it
gets close, check that the sweep runs (`harmony-sweep` CronJob, every 6 hours) before asking for more. Disks of
Verified tickets that are still there mean the sweep is not running.

Raising the ceiling, in this order (the pool first, the cap last):

```bash
gcloud container clusters update <cluster> --project <project> --zone <zone> \
  --node-pool <pool> --enable-autoscaling --min-nodes 0 --max-nodes <ceiling>
# edit concurrency.max_workers to <ceiling> in the project file (.harmony/conductor.json, or the configmap seed),
# then for the pod's seed copy (FILL is the sed list from step 4):
sed "${FILL[@]}" "$M/configmap.yaml" | kubectl -n harmony-conductor apply -f -
```

`concurrency.max_workers` is hot: the conductor re-reads the merged config every 5 minutes, so no restart is needed
(`HARMONY_DAEMON_MAX_CONCURRENT_WORKERS`, when set, still wins).

## 4. Put the config in the manifests

The shipped manifests carry **no deployment's own values** (B-1435). Every value that is yours is a `__NAME__`
placeholder, filled by `sed` at apply time:

| Placeholder | What it is | Where `setup-cluster.sh` prints it | Files |
|---|---|---|---|
| `__GCP_PROJECT__` | the GCP project (`<project>`) | `project:` | `configmap.yaml` (host and seed `gcp.project`), `cronjob-sweep.yaml` |
| `__REGION__` | the region (`<region>`) | `region:` | `configmap.yaml` (`gcp.region`) |
| `__ZONE__` | the cluster's zone (`<zone>`), the seed's `gke.location` | `zone:` | `configmap.yaml` |
| `__REGISTRY__` | the full registry path `<region>-docker.pkg.dev/<project>/<artifact-repo>` | `registry:` | `deployment.yaml` (image and `HARMONY_CONDUCTOR_IMAGE`), `cronjob-sweep.yaml` |
| `__CONDUCTOR_GSA__` | the conductor's Google service-account email (`<conductor-account>`) | `conductor GSA:` | `configmap.yaml` (`gcloud.account`), `serviceaccount.yaml` (the `iam.gke.io/gcp-service-account` annotation), `cronjob-sweep.yaml` |
| `__CONDUCTOR_VERSION__` | the image's version tag, `<plugin version>-<channel>` | not printed: the Cloud Build run publishes it (step 5) | `deployment.yaml`, `cronjob-sweep.yaml` |
| `__CONFIG_REPO__` | `owner/name` of the config repo (`<config-repo>`) | not printed: yours | `configmap.yaml` |
| `__GITHUB_APP_ID__` | the GitHub App's id (an identifier, not a secret) | not printed: yours | `configmap.yaml` |
| `__GITHUB_INSTALLATION_ID__` | the App's installation id on your organisation | not printed: yours | `configmap.yaml` |

The one `sed` line that fills them all (`setup-cluster.sh` prints it at the end with the first five already filled;
a placeholder a file does not hold is simply not matched):

```bash
FILL=(-e "s|__GCP_PROJECT__|<project>|g" -e "s|__REGION__|<region>|g" -e "s|__ZONE__|<zone>|g"
      -e "s|__REGISTRY__|<registry>|g" -e "s|__CONDUCTOR_GSA__|<conductor-account>|g"
      -e "s|__CONDUCTOR_VERSION__|<plugin version>-<channel>|g" -e "s|__CONFIG_REPO__|<config-repo>|g"
      -e "s|__GITHUB_APP_ID__|<app id>|g" -e "s|__GITHUB_INSTALLATION_ID__|<installation id>|g")
sed "${FILL[@]}" "$PLUGIN_DIR/container/conductor/k8s/<file>" | kubectl apply -f -
```

**Product-wide defaults the manifests keep.** They name no deployment, cannot by themselves point at anyone's
resources, and are yours to change if you used other names:

| Default | Where | Change it when |
|---|---|---|
| secret names `HARMONY_API_TOKEN` and `harmony-daemon-app-private-key` | `configmap.yaml` host `secrets` block (names only) | you passed other names to `setup-cluster.sh` |
| `gke.cluster` and `gke.namespace` `harmony-legs` | `configmap.yaml` seed | you passed `--cluster` / `--namespace` |
| `gke.storage_class` `harmony-ticket-disk` | `configmap.yaml` seed | you changed the storage class |
| seed `channel` `prod`; Deployment `HARMONY_PLUGIN_POSTURE` `prod` | `configmap.yaml`, `deployment.yaml` | staging deployment: set `staging` and `ack:staging` respectively |
| seed `concurrency.max_workers` `2`, `gke.ticket_disk` `20Gi`, `log_shipping` `true` | `configmap.yaml` | your granted ceiling, disk budget or logging policy differs |
| image name `harmony-conductor` | `deployment.yaml`, `cronjob-sweep.yaml` (after `__REGISTRY__/`) | never: the build publishes that name |
| `_REGION` `us-central1`, `_ARTIFACT_REPO` `harmony-workers` | both `cloudbuild.yaml` files | your registry is elsewhere (step 2) |

The Kubernetes object names and the `harmony-conductor` namespace are fixed: the lifecycle code patches them by name.

For a Claude-only deployment, retain the two host `secrets` keys shown above: `api_token` and `github_app_private_key`. The Claude credential secret is selected by the worker credential setup, not by adding a Codex login to this host block.

**Keys the manifests no longer ship (B-1435).** Add them to your filled copy only if they apply to you:

- `secrets.codex_auth` (host): set it only if you use the legacy Codex login. Token-only delivery
  (`docs/codex-auth-cutover.md`) does not need it.
- `model_policy` (seed): set your own workspace model policy, or leave it out.
- `gke.registry` (seed): it defaults from `gcp.project` (`us-central1-docker.pkg.dev/<project>/harmony-workers`, B-1217); set
  it only if your worker images live elsewhere.

**The one sanctioned exception to the no-legacy-env rule.** The Deployment sets no `CLOUDSDK_*` or `HARMONY_GKE_*`
variable: the config values live in the ConfigMap files, and such a variable would only produce a deprecation warning
at boot. The sweep CronJob (`cronjob-sweep.yaml`) does keep `CLOUDSDK_CORE_ACCOUNT` and `CLOUDSDK_CORE_PROJECT`, filled
from `__CONDUCTOR_GSA__` and `__GCP_PROJECT__`, the same values as the ConfigMap's `gcloud.account` and `gcp.project`.

`deployment.yaml` also carries `HARMONY_PLUGIN_POSTURE`: the channel the registry reports and Update follows. It ships
as `prod` (B-1222); set `ack:staging` to run staging builds, and set the seed project file's `channel` to match. With
Codex legs on token-only delivery, it also carries `HARMONY_CODEX_TOKEN_ONLY=1` and `HARMONY_CODEX_ACCESS_RESOURCE`
(`docs/codex-auth-cutover.md`, step 5); keep them when you re-apply the manifest: without them Codex legs fall back to
the copied-login path, which fails once that login has been removed.

Fill a **copy** (pipe through `sed` as above, or write the filled files outside the plugin directory), so the plugin
directory stays clean. Check the filled ConfigMap before applying, with nothing else on the machine mixed in:

```bash
sed "${FILL[@]}" "$PLUGIN_DIR/container/conductor/k8s/configmap.yaml" > /tmp/configmap.filled.yaml
node "$PLUGIN_DIR/dist/bin/harmony.js" conductor config doctor --configmap /tmp/configmap.filled.yaml --isolated
```

It reads the two ConfigMap files as the host and project layers (no API server), ignores this machine's
`deployment.json` and legacy env knobs, and reports any placeholder left unfilled (see `docs/conductor-config.md`).

## 5. Apply the manifests

The Deployment pins a **version** tag, never a moving one. Use the version the Cloud Build run published
(`gcloud artifacts docker tags list <registry>/harmony-conductor`) in `FILL` (step 4).

```bash
M="$PLUGIN_DIR/container/conductor/k8s"
kubectl apply --dry-run=server -f "$M/priorityclass.yaml"
kubectl apply -f "$M/priorityclass.yaml"           # FIRST: the Deployment names it (cluster-scoped, operator-applied)
sed "${FILL[@]}" "$M/configmap.yaml" | kubectl apply -f -
sed "${FILL[@]}" "$M/serviceaccount.yaml" | kubectl apply -f -   # setup-cluster.sh already annotated it; harmless
sed "${FILL[@]}" "$M/cronjob-sweep.yaml" | kubectl apply -f -
sed "${FILL[@]}" "$M/deployment.yaml" | kubectl apply --dry-run=server -f -
sed "${FILL[@]}" "$M/deployment.yaml" | kubectl apply -f -
```

Proves: the manifests are valid on the live cluster. After that, the web panel's Update button (or `node "$PLUGIN_DIR/dist/bin/harmony.js" conductor restart` from a machine that runs no conductor, which asks the registry) moves the tag itself.

### Why a PriorityClass, and what it cannot do

`priorityclass.yaml` defines `harmony-conductor` (value 100000, `PreemptLowerPriority`, not the default). When the leg
pool scales up and the cluster gets busier, the scheduler preempts lower-priority pods to place higher ones; leg pods
carry the default priority, so the conductor outranks them and is never the pod sacrificed for a leg.

It does **not** protect the conductor from **system-critical** pods (`system-cluster-critical` /
`system-node-critical`, such as `kube-dns` and `konnectivity-agent`): their priority is in the billions and they can
still preempt the conductor when the system pool is full. **Headroom is the main fix**, which is why step 1 sizes the
pool for the conductor *and* those pods at peak. If the conductor pod is ever found `Pending` or evicted, run
`kubectl -n harmony-conductor describe pod -l app.kubernetes.io/name=harmony-conductor` and read the events: a
`Preempted` or `FailedScheduling` event on `default-pool` means step 1 needs another pass.

## 6. Watch the pod come up

```bash
kubectl -n harmony-conductor get pods -l app.kubernetes.io/name=harmony-conductor -w
kubectl -n harmony-conductor logs -l app.kubernetes.io/name=harmony-conductor --tail=50
```

While another conductor still holds the lease, the pod must sit in standby (ready, not launching) and log that it is
waiting. The boot log must show **no** `deprecated:` line and no placeholder value; if it does, fix the file it names
(step 4) and re-apply.

## 7. Stop the conductor that runs elsewhere

On the machine that runs it: `node "$PLUGIN_DIR/dist/bin/harmony.js" conductor stop`. The pod takes the lease; the
registry panel shows location `remote`. Only now is ordering rule 2 satisfied.

## 8. Run the first sweep by hand

```bash
kubectl -n harmony-conductor create job --from=cronjob/harmony-sweep sweep-first
kubectl -n harmony-conductor logs job/sweep-first
```

When it succeeds, remove any local sweep job (launchd or cron). Proves "the sweep runs in the cluster"; satisfies
ordering rule 1.

## 9. Denied-call demo

`kubectl auth can-i list secrets -n kube-system --as=system:serviceaccount:harmony-conductor:harmony-conductor` must
print `no`. Then a Secret Manager read of a secret the conductor account was **not** granted, run as that account, must
be refused. Keep both outputs.

## 10. Pod deletion

`kubectl -n harmony-conductor delete pod -l app.kubernetes.io/name=harmony-conductor`. Kubernetes starts a new pod; it
re-takes the lease and adopts the running legs. Proves the restart criterion.

## 11. Update from the web

Publish a newer image and press Update in the conductor panel (or run
`node "$PLUGIN_DIR/dist/bin/harmony.js" conductor restart` on a machine that runs no conductor, which queues the request). The Deployment moves to the newest version tag for the
channel and running legs are not relaunched. Then press Update with a deliberately bad image (a tag that cannot
start) once: the old pod keeps running, leases stay held, and the panel shows the failed update and its reason.

**Version tags are channel-qualified (B-1269).** `./promote-prod.sh` rebuilds the same plugin version for the `prod`
channel, so a bare `:<version>` tag used to move from the staging image to the prod image and the staging Update then
refused ("carries no plugin version tag; refusing to deploy a moving tag") until the next merge. Each channel now owns
`:<version>-staging` / `:<version>-prod`, so a promote cannot strip the other channel's version. Update still refuses a
channel image that has only a moving tag. Images built before this change carry a bare `:<version>` tag, which Update
still accepts on its own channel's image. **Post-promote window for those older images, and recovery if Update ever
refuses:** pin the Deployment by hand to the version tag the channel image should run:
`kubectl -n harmony-conductor set image deployment/harmony-conductor conductor=<image>:<version-tag>` (for a
fixed build, `<version>-<channel>`). This fix reaches the running pod only via an Update or such a hand pin.

## 12. Soak

Conduct several real tickets to Verified with no conductor running anywhere else.

## Fallback: a local conductor takes over, or scale to zero

*Rehearse once and record the date in your deployment notes.*

**Scale the remote conductor to zero** (running legs carry on):
`node "$PLUGIN_DIR/dist/bin/harmony.js" conductor stop --remote` (or
`kubectl -n harmony-conductor scale deployment harmony-conductor --replicas=0`). The pod releases the lease on a clean
shutdown.

**A local conductor takes over:** on the local machine, after the remote one is at zero or its lease has gone stale
(5 minutes), run `node "$PLUGIN_DIR/dist/bin/harmony.js" conductor start --local`. The registry refuses a start while
a different holder is live, so a refusal means the pod is still up: scale it down first.

**Back to remote:** `node "$PLUGIN_DIR/dist/bin/harmony.js" conductor stop`, then
`node "$PLUGIN_DIR/dist/bin/harmony.js" conductor start --remote`.

## Odd things to know

- The conductor's leg-namespace Role also grants `patch` on Secrets and PersistentVolumeClaims: the launcher applies
  existing ticket disks (a patch) and sets owner references on the per-leg Secret, whose name is dynamic. `patch` and
  `delete` on Secrets therefore also reach the base Secrets, inside `harmony-legs` only.
- Inside the pod the launch scripts skip `--context` (there is no kubeconfig). The ticket-disk class comes from
  `gke.storage_class` in the project file; if it is unset the launcher probes for `harmony-ticket-disk`, and a refused
  read (the pod's Role cannot read the cluster-scoped StorageClass) keeps `harmony-ticket-disk` rather than falling
  back to `standard-rwo`. Only a real "not found" falls back.
- `gke-gcloud-auth-plugin` is not needed **inside** the pod (it authenticates with its service account token), but it
  is needed on every operator machine that runs `kubectl`, `start --remote` or `stop --remote`.
- `start --remote` and `stop --remote` run with the **caller's own** kubectl credentials, so the caller keeps
  `roles/container.developer`.
- `conductor logs` and the lifecycle guard read `gcp.project` from the same config files as everything else; with no
  project configured they stop and say where to set it (`gcp.project` in `.harmony/conductor.json` or
  `~/.harmony/conductor-host.json`) instead of guessing.


### Startup infrastructure failures (B-1267)

New GKE Jobs get 600 seconds to start the `worker` container. Scheduling alone does
not count as worker startup. At expiry, TriggeredScaleUp / Pulling events or a
running init container earn another window when their progress fingerprint changes.
Repeated evidence cannot extend indefinitely: the total startup cap is twice the
configured window. ImagePullBackOff / ErrImagePull / CrashLoopBackOff and PVC
ProvisioningFailed override progress. Persistent unschedulability without progress
parks at the first deadline. Override with the
positive integer `HARMONY_GKE_STARTUP_TIMEOUT_S` in the conductor's environment (the
Deployment's `env` for the pod) if a pool's normal scale-up takes longer. Once the worker has run, the existing worker deadline
and completion/disruption checks apply.

At startup expiry the launcher reads the PVC, pod status and the latest relevant
namespaced events, requests Job deletion, and exits 74. The conductor parks with
`startup-unavailable`, includes the reason in the leg log and ticket comment, and
runs its existing reap-before-park safeguard. The ticket disk is retained. Resolve
the reported quota, image or scheduling problem before resuming the conduction.
Failed reads include their kubectl error; successful reads remain usable independently.
All startup reads, Job polling and startup deletion use an external GNU `timeout`
(5 seconds, then a 1-second kill grace), preserving in-cluster service-account auth
without client-side kubectl override flags. Authentication failures on deletion are
reported separately from other deletion failures.

Upgrading a deployment from an image built before B-1267: **re-apply
`container/conductor/k8s/rbac-legs.yaml`** (it adds namespaced event reads), then
Update or restart the conductor pod. Merging alone does not update a running
conductor. Without the Role update the launcher still fails promptly, but event
detail is unavailable. An older conductor treats exit 74 as a dirty exit, so the
launcher and its classifier must come from the same conductor image. If you raised
`HARMONY_GKE_STARTUP_TIMEOUT_S` as a stopgap before the upgrade, set it back to
600 (or leave it unset) once the pod runs the new image.
