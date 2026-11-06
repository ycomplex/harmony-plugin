# Codex single-owner cut-over (B-1306)

This is a founder runbook. Workers must never execute these commands or inspect a
real login. Implementation tests use synthetic credentials only. Merge is inert:
`HARMONY_CODEX_TOKEN_ONLY` is absent by default and the CronJob is suspended.
Do not enable until **after the v1.12.5 production promote** and every other
milestone Codex leg/PR has finished. Merge this PR last. Acceptance and staging
are not evidence of a production credential cut-over.

## Artifacts and identities

The full grant lives only on the `harmony-codex-refresh` PVC in
`harmony-conductor`, under `/private/codex-owner/grant.json`. A durable exclusive
`in-flight` file fences every refresh. Never automatically delete that fence.
A timed-out OAuth request may have consumed the single-use token.
The owner persists and fsyncs the entire rotated grant before adding a version
to **harmony-codex-access**, a separate Secret Manager resource. That resource
contains a token-only envelope, stable user/account identity, expiry and generation.
Workers have accessor permission on that resource only, not the full grant/PVC.
The updater validates it and atomically installs a private file every 30 seconds.
That auth.json also carries a `last_refresh` timestamp (B-1407), because Codex 0.166.0
sends no bearer token without one. The timestamp is kept while the generation is
unchanged, recorded beside it in `last-refresh.json` (which holds no credential, so
the updater never reads auth.json back), and is never part of the published envelope.
Codex reloads it after a 401. The supported CLI is exactly **0.166.0**; a different
version refuses the enabled path until its compatibility is proved.

The single supported-version source is `container/codex-version` (B-1382).
Cloud Build, direct Docker builds, image smoke and token-only provisioning use it.
To upgrade deliberately: edit that one file, install that candidate CLI in an
isolated test environment, run `node scripts/test-codex-token-reload.mjs` against
it, then rebuild. The proof reads the same pin, and all four of its scenarios must
pass (see "Fixture-only checks" below). Never use a real login for this proof. Publish the
compatible worker image before enabled legs use a checkout with the newer pin.
This fix keeps the pin at 0.166.0 and does not enable token-only delivery.

Set these names on the founder machine; none is a credential value:

```bash
PROJECT=harmony-conductor
REGION=us-central1
OWNER_GSA="harmony-codex-refresh@$PROJECT.iam.gserviceaccount.com"
LEG_GSA="harmony-gke-leg@$PROJECT.iam.gserviceaccount.com"
# Set these to the actual Cloud Run job and Docker VM service-account names.
CLOUD_JOB=harmony-worker
CLOUD_GSA=REPLACE_CLOUD_RUN_SERVICE_ACCOUNT
DOCKER_GSA=REPLACE_DOCKER_VM_SERVICE_ACCOUNT
OWNER_IMAGE="$REGION-docker.pkg.dev/$PROJECT/harmony-workers/codex-auth:B1306"
# Use a founder-selected reviewed worker image containing Codex 0.166.0.
WORKER_IMAGE=REPLACE_REVIEWED_WORKER_IMAGE_DIGEST
```

The Docker worker must run on a GCE host with metadata access to its dedicated
service account, with the access-only role below. No login cache or application
credential file is mounted as an authentication fallback. Cloud Run uses its job
service account; GKE uses the existing `harmony-leg` workload identity.

## Ordered enable procedure

1. Complete the milestone promote first. Stop dispatch, and wait for **every** old
   copied-login Codex leg, including B-1306's worker, to exit. Use the Conductor UI
   and job names/status only. Do not probe a copied login to check it. If a leg
   cannot drain naturally, stop it explicitly and preserve its repository work.

   ```bash
   harmony conductor stop --remote
   kubectl -n harmony-legs get jobs
   ```

2. Build the owner from the reviewed promoted checkout. Apply the suspended PVC
   and CronJob, with the actual image digest and project substituted into a local
   copy of the manifest. The owner image is separate from the worker image and
   bundles its runner; it does not run worker provisioning or clone a repository.

   ```bash
   gcloud builds submit --project "$PROJECT" --config container/codex-auth/cloudbuild.yaml --substitutions "_IMAGE=$OWNER_IMAGE"
   cp container/codex-auth/refresh-cronjob.yaml /tmp/codex-refresh.yaml
   # Edit ONLY the image digest and REPLACE_PROJECT in this local copy.
   kubectl apply -f container/codex-auth/refresh-rbac.yaml
   kubectl apply -f /tmp/codex-refresh.yaml
   ```

   Pin the built digest, not a moving tag. Keep `suspend: true`. Use a volume
   storage class with durable POSIX exclusive creation, atomic rename and fsync;
   do not substitute an object-store/FUSE filesystem.
   With the default standard-rwo class (WaitForFirstConsumer), the PVC stays
   Pending until step 4's bootstrap pod mounts it.

3. Create the separate access-only resource and narrow workload identities.
   No worker principal gets owner-volume access or full-login Secret access.

   ```bash
   gcloud iam service-accounts create harmony-codex-refresh --project "$PROJECT"
   gcloud secrets create harmony-codex-access --project "$PROJECT" --replication-policy=automatic
   gcloud secrets add-iam-policy-binding harmony-codex-access --project "$PROJECT" --member "serviceAccount:$OWNER_GSA" --role roles/secretmanager.secretVersionAdder
   gcloud iam service-accounts add-iam-policy-binding "$OWNER_GSA" --project "$PROJECT" --member "serviceAccount:$PROJECT.svc.id.goog[harmony-conductor/harmony-codex-refresh]" --role roles/iam.workloadIdentityUser
   kubectl -n harmony-conductor annotate serviceaccount harmony-codex-refresh "iam.gke.io/gcp-service-account=$OWNER_GSA" --overwrite
   for READER_GSA in "$LEG_GSA" "$CLOUD_GSA" "$DOCKER_GSA"; do
     gcloud secrets add-iam-policy-binding harmony-codex-access --project "$PROJECT" --member "serviceAccount:$READER_GSA" --role roles/secretmanager.secretAccessor
   done
   ```

   A deployment using only the GKE profile needs only "$LEG_GSA" as a reader;
   omit the Cloud Run and Docker reader bindings for profiles it does not use.

   Audit effective IAM by **policy names only**. Remove any broader inherited
   Secret Manager accessor grant that would let workers read the old full-login
   secret. This is a founder prerequisite: a resource-level binding cannot narrow
   an inherited project-wide grant. Never dump a secret payload for validation.

4. Initialize once from a **fresh dedicated device-auth login**, minted by the
   founder in a new private local folder. Never copy the old `harmony-codex-auth`.
   Use the same owner image and PVC in a temporary bootstrap pod. The following
   manifest contains names only; replace the reviewed digest before applying it.

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: harmony-codex-bootstrap
     namespace: harmony-conductor
   spec:
     serviceAccountName: harmony-codex-refresh
     restartPolicy: Never
     securityContext: {runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000}
     containers:
       - name: owner
         image: REPLACE_REVIEWED_OWNER_IMAGE_DIGEST
         command: [sleep, '3600']
         env:
           - {name: HARMONY_CODEX_TOKEN_ONLY, value: '1'}
           - {name: HARMONY_CODEX_AUTH_OWNER_DIR, value: /private/codex-owner}
           - {name: HARMONY_CODEX_ACCESS_RESOURCE, value: projects/harmony-conductor/secrets/harmony-codex-access}
         volumeMounts: [{name: owner, mountPath: /private/codex-owner}]
     volumes:
       - name: owner
         persistentVolumeClaim: {claimName: harmony-codex-refresh}
   ```

   ```bash
   kubectl apply -f /tmp/codex-bootstrap.yaml
   # FRESH_CODEX_HOME is the founder's NEW dedicated login directory, never a copied cache.
   CODEX_HOME="$FRESH_CODEX_HOME" npx -y @openai/codex@0.166.0 login --device-auth
   kubectl -n harmony-conductor cp "$FRESH_CODEX_HOME/auth.json" harmony-codex-bootstrap:/private/codex-owner/fresh-login.json
   kubectl -n harmony-conductor exec harmony-codex-bootstrap -- node /app/codex-auth.mjs owner --initialize
   kubectl -n harmony-conductor delete pod harmony-codex-bootstrap
   kubectl -n harmony-conductor patch cronjob harmony-codex-refresh --type merge -p '{"spec":{"suspend":false}}'
   ```

   Initialization logs only a generation number. The founder removes the fresh
   local login folder after delivery. Never run inference or a diagnostic using
   it: the owner is now the sole refresh holder. Inspect job exit status and
   access-secret **version metadata**, never its contents. A successful version
   publication alone does not prove a worker can reload it.

5. Update the conductor and select the reviewed worker image before enabling
   token-only launches. Remove legacy full-login mounts from the Cloud Run job;
   GKE and Docker new launch paths omit them automatically. Remove old full-login
   mounts/access from base environments as well. Preserve Figma and provider-key
   mounts. The Cloud Run launcher refuses a job still naming the legacy secret.

   ```bash
   harmony conductor restart --remote
   # Keep dispatch stopped while updating the deployment's config/image.
   harmony conductor stop --remote
   gcloud run jobs update "$CLOUD_JOB" --region "$REGION" --image "$WORKER_IMAGE" --remove-secrets=/home/worker/.codex-auth-src/auth.json
   ```

   Set these **names-only** values on the conductor launch environment (its base
   env declaration), and the reviewed worker image in the configured launch
   profile. Do not put credential bytes into any environment variable:

   ```text
   HARMONY_CODEX_TOKEN_ONLY=1
   HARMONY_CODEX_ACCESS_RESOURCE=projects/harmony-conductor/secrets/harmony-codex-access
   ```

   Reload the conductor onto the image carrying the new launch scripts while
   dispatch remains stopped. Confirm image/CLI **version** metadata only.
   Do not assume a merge updates the running pod or every worker image.

6. Permit exactly one founder-selected canary, then pause dispatch again. Verify
   startup and a rotation boundary through non-secret generation/status evidence,
   with no login-copy probe. The permanent automated fake-server test already
   covers same-process reload; the live canary checks deployed delivery. If clean,
   resume normal dispatch. Otherwise follow recovery below.

## Recovery is forward-only

Stop dispatch and suspend the CronJob. Drain/stop affected legs and preserve their
work. A remaining `in-flight` marker means the grant may have been consumed; never
remove it and retry the old token. With all owner jobs stopped, the founder
recreates the bootstrap pod, removes the marker and old grant file **without
reading either**, and repeats step 4 using a freshly minted dedicated login.
Drain all workers before resetting generation to 1. Update the image/config if
needed, repeat the canary, and only then resume dispatch. Never roll back to
copying full refreshable logins after enabling the owner.

```bash
harmony conductor stop --remote
kubectl -n harmony-conductor patch cronjob harmony-codex-refresh --type merge -p '{"spec":{"suspend":true}}'
# After every owner job and affected leg has stopped, in the bootstrap pod only:
kubectl -n harmony-conductor exec harmony-codex-bootstrap -- rm -f /private/codex-owner/in-flight /private/codex-owner/grant.json
```

`codex-login-expired`, `codex-login-identity-mismatch` and
`codex-login-refresh-uncertain` are sanitized board recovery reasons.
`codex-auth-service-unavailable` names a delivery/network failure without asserting
that the login expired. A `codex-auth-board-write-failed` log means the board write
itself failed and the conductor must inspect the leg; it is never reported as a
successful board update. No code path emits credential values in these messages.

## Fixture-only checks

```bash
node scripts/test-codex-token-reload.mjs
npx vitest run src/tools/codex-auth.test.ts src/tools/codex-auth-files.test.ts src/tools/codex-auth-runtime.test.ts src/tools/codex-auth-launch.test.ts
```

The first check is the token-reload proof (B-1407). It needs `unshare` with user and
network namespaces, `python3`, `openssl` and the pinned Codex CLI on PATH. It
re-runs itself in a new network namespace where only loopback is up. Before it starts
`codex` it checks that no other interface is visible and that outside addresses are
unreachable. If it cannot set up or verify that isolation, it exits non-zero and never
starts `codex`. It also checks `codex --version` against `container/codex-version`.

The proof installs auth.json through the real `runWorker`, bundled from source with
esbuild, using synthetic unsigned tokens served by a fake Secret Manager. Codex runs
on its default provider with a fresh HOME and CODEX_HOME. Every route goes to an
HTTPS fake backend on 127.0.0.1: `chatgpt_base_url`, `openai_base_url` and the
refresh URL override all point there, and a throwaway test CA is trusted through
`CODEX_CA_CERTIFICATE`. The fake answers 401 to any request that lacks either the
current generation's bearer token or the fixture `ChatGPT-Account-Id`.

The scenarios are:

- **Negative control.** The installed file with `last_refresh` removed, which is the
  shape workers wrote before B-1407. Codex sends the account id with no bearer, gets
  the 401 and fails the turn, as on the canary.
- **Reload.** Generation 1 carries both headers on every route, including
  `/wham/accounts/check` and `/codex/models`. The first `/responses` call gets a 401,
  and before that reply the fake owner publishes generation 2 and `runWorker`
  installs it. Codex reloads the file, retries with the generation 2 bearer and
  completes the turn, with no OAuth request.
- **Stale `last_refresh`.** A `last_refresh` 30 days old still sends the bearer and
  completes the turn, with no OAuth request.
- **Missing user.** `runWorker` refuses a grant whose tokens have no user id and
  installs nothing.

The proof prints a PASS line for each scenario and deletes its temporary homes and
keys. It never calls a real OAuth or inference endpoint.
