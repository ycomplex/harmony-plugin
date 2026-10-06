# B-1074 hand-carry: second Cloud Build trigger, on `prod`

**Not applied by this change.** Creating a GCP Cloud Build trigger is GCP-side state this worktree
cannot create, verify, or see — per the accepted B-1074 design, a human/orchestrator must hand-carry
it. This file is a well-reasoned **template**, not a verified command.

## Before running anything

The existing trigger (B-820) already publishes this image on every push to `main` that touches
`container/**`. Confirm its exact fields first, so the second trigger mirrors them exactly (region,
project, repo connection, service account, etc. may differ from the guesses below):

```bash
gcloud builds triggers describe harmony-worker-image-publish --region=us-central1
# adjust --project / --region if the trigger lives elsewhere
```

Pay particular attention to:
- `--repo-owner` / `--repo-name` (or the newer 2nd-gen repository-connection resource name, if this
  trigger was created against a Cloud Build repository connection rather than the classic GitHub App
  integration)
- the service account the trigger runs as (`--service-account`), if one is set explicitly rather than
  the default Cloud Build SA
- `--project` / `--region`

## The new trigger

Additive, beside the existing `harmony-worker-image-publish` trigger — this does not replace it. Key
differences from the existing trigger: branch pattern is `^prod$` (not `^main$`), and there is
deliberately **no `--included-files` path filter** — every push to `prod` (i.e. every
`./promote-prod.sh` run, since that is the only thing that pushes this repo's `prod` branch) should
republish the image, even one that touches no file under `container/`, so the baked Claude Code
version stays fresh.

```bash
gcloud builds triggers create github \
  --project=harmony-conductor \
  --region=us-central1 \
  --name=harmony-worker-image-publish-on-promote \
  --repo-owner=ycomplex --repo-name=harmony-plugin \
  --branch-pattern='^prod$' \
  --build-config=container/cloudbuild.yaml
```

If the existing trigger was created against a 2nd-gen Cloud Build repository connection instead of
`--repo-owner`/`--repo-name` (the classic GitHub App form), mirror that instead — e.g. substitute
`--repository=projects/harmony-conductor/locations/us-central1/connections/<connection>/repositories/<repo>`
in place of the `--repo-owner`/`--repo-name` pair, per whatever `gcloud builds triggers describe`
above actually shows.

## Why commit time, not plugin version, guards the race

`container/cloudbuild.yaml` runs identically from either trigger. Both triggers can fire close
together (a `container/**` change landing on `main` around the same time as an unrelated
`./promote-prod.sh` run), and whichever build's `push-latest` step runs last wins `:latest` — the
`guard-latest` step in `container/cloudbuild.yaml` resolves that race by comparing the
`harmony.source_commit_time` OCI label (the triggering commit's own commit time, UTC ISO-8601, lexically
sortable) baked into the current `:latest` image against this build's own commit time, and skips the
`:latest` push when the current image is already as new or newer. It is **not** keyed on the plugin's
version (`.claude-plugin/plugin.json`) because `main` is permanently pinned at the inert `0.0.0-dev`
since the B-1007 cutover — a version-based comparison would always lose on `main`-triggered builds.

See `container/README.md`'s "Publishing an image" section for the fuller picture (the
`harmony.claude_code_version` label, the `/etc/harmony-claude-version` file, and `provision.sh`'s
startup echo).
