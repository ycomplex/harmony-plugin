# Remote conductor runbook (B-1173, B-1186)

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
| `<registry>` | the Artifact Registry repository holding the conductor image | `harmony-workers` |
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
| Image | `<region>-docker.pkg.dev/<project>/<registry>/harmony-conductor`, tags `:<plugin version>` and `:<channel>`; the Deployment is pinned to a version tag |
| Scheduling | the cluster's `default-pool` (the system pool), PriorityClass `harmony-conductor` |
| Sweep | CronJob `harmony-sweep` in `harmony-conductor`, every 6 hours |
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

Quotas the ceiling needs. All three are Compute Engine quotas; read them with
`gcloud compute regions describe <region> --project <project> --format='value(quotas)'`
(and `gcloud compute project-info describe --project <project>` for the project-wide `CPUS_ALL_REGIONS`).

| Quota | Scope | Must be at least |
|---|---|---|
| `CPUS_ALL_REGIONS` | project-wide | ceiling x leg-node vCPU + system-pool vCPU, plus headroom for a surge upgrade |
| `IN_USE_ADDRESSES` | region | leg nodes at the ceiling + system nodes, plus headroom for a rollout |
| `SSD_TOTAL_GB` | region | what is already used + ceiling x ticket-disk size (`gke.ticket_disk`, default `20Gi`) |

To request an increase: open the Google Cloud console, go to IAM & Admin, then Quotas & System Limits; filter by the
quota name and region; tick it; choose Edit quotas; enter the new limit and a one-line reason; submit. Small
increases are usually granted within minutes. Do not raise `max_workers` until the grant shows in the quota page.

Raising the ceiling, in this order (the pool first, the cap last):

```bash
gcloud container clusters update <cluster> --project <project> --zone <zone> \
  --node-pool <pool> --enable-autoscaling --min-nodes 0 --max-nodes <ceiling>
# edit concurrency.max_workers to <ceiling> in the project file (.harmony/conductor.json, or the configmap seed),
# then for the pod's seed copy:
kubectl -n harmony-conductor apply -f "$M/configmap.yaml"
```

`concurrency.max_workers` is hot: the conductor re-reads the merged config every 5 minutes, so no restart is needed
(`HARMONY_DAEMON_MAX_CONCURRENT_WORKERS`, when set, still wins).

## 4. Put the config in the manifests

The shipped manifests carry **placeholders and the reference deployment's names**. Edit these before applying:

| File | What to set |
|---|---|
| `container/conductor/k8s/configmap.yaml` | `config_repo` (`<config-repo>`), the GitHub App `app_id` and `installation_id` (ids, not secrets), `gcloud.account`, `gcp.project` and `gcp.region`, and the `secrets` block (Secret Manager secret **names**). In the seed project file: `gke.cluster`, `gke.location`, `gke.registry` |
| `container/conductor/k8s/deployment.yaml` | the image path and `HARMONY_CONDUCTOR_IMAGE` (`<region>-docker.pkg.dev/<project>/<registry>/harmony-conductor`) |
| `container/conductor/k8s/cronjob-sweep.yaml` | the same image path |
| `container/conductor/k8s/serviceaccount.yaml` | the `iam.gke.io/gcp-service-account` annotation (`<conductor-account>`) |

Do this on a **copy** of the manifests (or a branch of your checkout), so the plugin directory stays clean. The
config values live in the ConfigMap files, not in the pod's environment: a legacy `CLOUDSDK_*` or `HARMONY_GKE_*`
variable in the Deployment would only produce a deprecation warning at boot.

Check the filled files before applying: `node "$PLUGIN_DIR/dist/bin/harmony.js" conductor config doctor`
(see `docs/conductor-config.md`).

## 5. Apply the manifests

The Deployment pins a **version** tag, never a moving one. Use the version the Cloud Build run published
(`gcloud artifacts docker tags list <region>-docker.pkg.dev/<project>/<registry>/harmony-conductor`).

```bash
M="$PLUGIN_DIR/container/conductor/k8s"            # or your edited copy
kubectl apply --dry-run=server -f "$M/priorityclass.yaml"
kubectl apply -f "$M/priorityclass.yaml"           # FIRST: the Deployment names it (cluster-scoped, operator-applied)
kubectl apply -f "$M/configmap.yaml"
sed "s/__CONDUCTOR_VERSION__/<plugin version>/" "$M/cronjob-sweep.yaml" | kubectl apply -f -
sed "s/__CONDUCTOR_VERSION__/<plugin version>/" "$M/deployment.yaml" | kubectl apply --dry-run=server -f -
sed "s/__CONDUCTOR_VERSION__/<plugin version>/" "$M/deployment.yaml" | kubectl apply -f -
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
