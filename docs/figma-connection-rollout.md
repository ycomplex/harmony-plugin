# Workspace Figma: founder rollout (B-1201)

Nothing here authorizes a promote, IAM change or cluster apply by a worker. Use placeholders for
identifiers; never paste credentials into board comments. Run **staging first**, prove it, then prod.
Keep the CronJob suspended and workspace connections disabled until prerequisites are complete.

## Isolated Claude Code sign-in (B-1314)

Figma currently refuses dynamic registration for `Harmony workspace Figma` with HTTP 403.
Harmony keeps its own honest registration for future approval; never register under another client's
name. For the founder's own projects and contributed consulting workspaces, use a fresh sign-in made
by real Claude Code. Open self-service and asking Figma to approve Harmony are separate decisions.

The operator entry point is:

```sh
harmony figma connect --claude-sign-in
```

Run the CLI from the target project's authenticated Harmony directory in an interactive terminal.
It checks workspace ownership and the environment's connection switch before minting or reading
credentials. The operator needs `kubectl` access to namespace `harmony-legs`, permission to create,
exec, copy from and delete pods there, and a browser. No local Docker daemon is required.
The command creates a fresh `node:22-bookworm-slim` pod and installs Claude Code; the one version
setting is `HARMONY_FIGMA_CLAUDE_VERSION` (default `2.1.312`, the disposable-probe version).
It runs real `claude mcp add` and `claude mcp login figma --no-browser`; approve the fresh Figma login.
It copies the private credentials with `kubectl cp` into a mode-0700 temporary directory, confirms
pod deletion **before** import, and then asks for the same-account REST token, library and plan.
Check the verified editing identity and confirm save. Existing low-budget confirmation still applies.
The existing handler validates the candidate and appends versions before activating the generation;
a rejected candidate preserves the working connection. The CLI never refreshes the grant.

After successful handoff the scheduled workspace job is the **only refresh owner**. The command
removes its temporary file/directory on success, error and ordinary interruption. It never uses an
everyday Claude profile, revokes/logs out a grant, prints credentials or keeps a reusable export.
A killed host process (`SIGKILL`, power loss) cannot guarantee cleanup: inspect leftover
`harmony-figma-<uuid>` pods in `harmony-legs` and `harmony-figma-*` private directories under the
host temporary directory. Delete the named pod and private files before reconnecting. A cleanup
failure reports only those locations; do not use the sign-in in Claude Code again.

Fallback for an operator who already made a **fresh isolated** sign-in and stopped its Claude Code:

```sh
harmony figma connect --claude-credentials <private-file>
```

The file must be a private, owner-readable regular JSON file, at most 1 MiB, containing exactly one
Figma `mcpOAuth` entry. Symlinks and ambiguous, incomplete or expired entries are refused. The importer
supports the observed flat `accessToken`, `refreshToken`, `expiresAt` (epoch milliseconds), `clientId`,
`clientSecret`, `serverName`, `serverUrl` and `scope` fields, pins Figma's token endpoint and
`client_secret_post`, and ignores arbitrary additional fields. This mode requires an explicit
isolation/sole-owner acknowledgement. The operator removes the supplied file and isolated config
after handoff; Harmony never deletes an arbitrary operator-supplied profile.

A locally rejected import can be replaced by a new isolated sign-in. An **uncertain save must not be
retried**: check `harmony figma health` and the workspace connection first. If ownership is uncertain,
reconcile status and use a fresh grant rather than spending/reusing a possibly handed-off one.
Never probe, copy or refresh the shared spike secret `harmony-figma-mcp-auth`.

### Availability and evidence

Per the founder's 2026-10-27 operator record, connections are **ON for staging only, OFF on prod**.
The default-off mechanism below remains authoritative for a new environment. This records the
founder's staging action, not a claim that the remaining rollout proofs passed. B-1314 releases on
automated evidence; the founder performs the fresh disposable import/save/scheduled-refresh walk
after merge as B-1201 proof (a). A one-off disposable refresh probe is not that end-to-end proof.

This change needs no schema migration or Conductor Update. Source operators use a locally built CLI
after the plugin merge; generated staging and installed prod CLI follow their normal versioned
channels. Installed prod code still requires deliberate promotion and a new session; that does not
enable production connections. The designer guide update follows the plugin and B-1206's guide merge.

## Default-off switch and mandatory enable gate

This release is DARK by founder decision (2026-10-27). The database switch is
`private.figma_rollout.connections_enabled`, seeded **false**, with no client write privileges.
`figma_connections_enabled()` is the shared availability check. Off or unavailable means the UI
has no connect controls; the CLI refuses before OAuth; the handler refuses before credential validation
or Secret Manager writes; activation refuses; refresh queue returns no work and transitions refuse;
launch context returns only disconnected + false, without token references. Launchers additionally
require explicit `connections_enabled:true` before reading or mounting access/PAT. Missing means off.
Disconnect remains available through its owner RPC so disabling never prevents credential retirement.

Merging either PR does **not** enable connections. Never change this migration's default to true.
Founder SQL to inspect: `SELECT connections_enabled FROM private.figma_rollout WHERE id`.
Founder SQL to disable: `UPDATE private.figma_rollout SET connections_enabled=false WHERE id`.
Existing running legs may retain tokens; disabling prevents new launches, not retroactive revocation.

The enable gate is, in order: staging setup below; (a) disposable-grant rotation through the real
refresher with crash/ambiguity and grant-before-access proof; (b) add-only allowed-prefix and denied
read/create/outside-prefix checks; (c) actual GKE, Cloud Run and Docker-host token-only mounts,
existing bindings, cleanup, disconnect and generation races. **All three are UNRUN at release.**
Use an isolated staging validation environment and disposable workspace/credentials for the candidate
proofs, never a customer connection or the working spike grant. A founder may exercise the candidate
on that isolated validation database; leave the deployed staging/production switch false until all
proofs are recorded PASS. No proof exception is granted to an ordinary user, CLI flag or launcher env.
After all three PASS, schema/secrets/images are ready and the Conductor Update is complete, the founder
alone enables the target environment with
`UPDATE private.figma_rollout SET connections_enabled=true WHERE id`.
Record environment, proof outcomes and enabling time on B-1201. Do not unsuspend/enable on a mock pass.


## Staging preparation

1. Create `harmony-figma-connect@harmony-conductor.iam.gserviceaccount.com`:
   `gcloud iam service-accounts create harmony-figma-connect --project harmony-conductor`.
   Resolve `<PROJECT_NUMBER>` with `gcloud projects describe harmony-conductor --format='value(projectNumber)'`.
   Bind `roles/secretmanager.secretVersionAdder` on the project with a condition
   `resource.name.startsWith('projects/<PROJECT_NUMBER>/secrets/harmony-figma-ws-')`.
   Use `gcloud projects add-iam-policy-binding harmony-conductor --member serviceAccount:<CONNECT_GSA>
   --role roles/secretmanager.secretVersionAdder --condition <PREFIX_CONDITION>`.
   **No secretAccessor, secrets.create, Secret Manager Admin, Editor or IAM mutation permission.**
2. Provision the v1.11 slots for each workspace with `gcloud secrets create <NAME> --replication-policy automatic`:
   `harmony-figma-ws-<workspace-uuid>-grant`, `-pat`, `-access`. Customers never do this.
   This is the operator step named by an unprovisioned-slots error. Self-service is B-1310.
3. Create a handler key with `gcloud iam service-accounts keys create <PRIVATE_KEY_FILE>
   --iam-account <CONNECT_GSA>`. Put the JSON in `FIGMA_CONNECT_GCP_KEY_JSON` in a private env file;
   run `supabase secrets set --project-ref <STAGING_REF> --env-file <PRIVATE_ENV_FILE>`.
   Files must be 0600, outside every repo, never printed; remove them after upload.
4. Deploy web schema/function first. The handler authenticates the caller, checks the live owner,
   validates REST/MCP identity, library and selected plan, then adds versions and activates exact refs.
   A candidate failure leaves the working refs intact. No database credential payloads or readback.
   It uses minimal pinned Deno imports. On a CDN-flaked edge deploy: `gh run rerun <RUN_ID> --failed`;
   confirm `gh run view <RUN_ID> --json conclusion` is `success`. Fix real code errors instead of retrying.
5. Create refresh GSA `harmony-figma-refresh@harmony-conductor.iam.gserviceaccount.com`; bind its
   namespace/KSA `harmony-conductor/harmony-figma-refresh` through Workload Identity using
   `gcloud iam service-accounts add-iam-policy-binding <REFRESH_GSA> --role roles/iam.workloadIdentityUser
   --member serviceAccount:<GCP_PROJECT>.svc.id.goog[harmony-conductor/harmony-figma-refresh]`.
   Give this identity alone accessor on full-grant slots (and PAT slots for explicit library refresh),
   and version-adder on grant/access slots. It needs no secret creation or IAM mutation permission.
6. Mint a dedicated **staging** board API token for the job user. Founder SQL registers that user's UUID:
   `INSERT INTO private.figma_refresh_operators(user_id) VALUES ('<REFRESH_BOARD_USER_UUID>') ON CONFLICT DO NOTHING`.
   Create Kubernetes Secret `harmony-figma-refresh-board` in `harmony-conductor` from private files with keys
   `token`, `url`, `anon-key`. URL/key must target the same staging project as the token; never rely on prod defaults.
   Ordinary worker users are not registered refresh operators. Deleting this row revokes job board access.
7. Build `container/figma/Dockerfile` and publish an immutable image; fill that image digest in
   `container/figma/refresh-cronjob.yaml`. Apply it suspended with `kubectl -n harmony-conductor apply -f <MANIFEST>`.
   This is an hourly job, `Forbid`, `backoffLimit:0`, `restartPolicy:Never`. A durable board claim precedes a refresh.
   Crash/timeout/ambiguous response requires reconnect; a possibly spent refresh token is never retried.
8. Grant launcher identities accessor on **access/PAT slots only**, not grant slots. Cloud Run's worker
   service account needs access to its bound access/PAT versions; GKE/Docker-host workers remain unable to
   read Secret Manager. Their launcher transfers only those two values through private temporary files.
   GKE creates a per-leg mounted Secret owned by its Job. Docker-host uses SSH stdin and read-only mounts.
   Cloud Run uses `--update-secrets` with exact versions, retaining existing secret bindings.
9. Complete the live proofs below, then unsuspend the refresh CronJob. Explicitly Update the conductor
   to the tested image before enabling connections: launch scripts are baked into its image. Worker
   provision code arrives from regenerated plugin staging; wait for that generation and worker image too.

## Production, after staging proof

Respect milestone merge order: B-1202 web + founder promote; B-1204/B-1205; B-1201 web then plugin; B-1206.
Check the migration sorts after current origin/main before pushing; restamp if necessary. `promote-prod.sh` waits for production web
schema/functions before plugin promotion. Wait for images. Repeat the provisioning/key and board-user
steps against **prod**, apply/repin the suspended CronJob, check bindings and token-only mount paths,
enable the job only after schema/secrets exist, and explicitly Update the conductor. Verify versions
and all three launchers before enabling production connections. CronJob apply and Update are separate.

The handler key is rotated by founder/cloud IAM admins **every 90 days**: create replacement, update
the function secret, prove add-only operation, delete the old key via
`gcloud iam service-accounts keys delete <OLD_KEY_ID> --iam-account <CONNECT_GSA>`.
On suspicion revoke immediately, and remove the role binding/disable the account while investigating.
Deleting a key alone does not instantly invalidate issued access tokens. Reconnect affected workspaces.

**Carry verbatim on release:** a leaked handler key can replace a workspace's Figma connection, but cannot read credentials.
Function secrets are an environment-wide boundary; review every function deployed into that environment.
Never grant the handler secretAccessor to implement library refresh: the scheduled owner handles the explicit
cache request with its PAT, without reading a full grant or refreshing unless expiry makes it due.

## Proof ledger (no unrun proof is a pass)

- Claude static header: operator PASS, Code 2.1.310; fresh profile, exactly one whoami; bogus header rejected 401.
  Image `node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384`.
- Codex bearer: operator PASS on 0.164.0, same identity; image digest **not captured**. Not rerun due B-1306 shared login rotation.
- Disposable OAuth rotation against this refresher: **unrun**. Never refresh the working spike grant as a probe.
  Prove exactly one claim/POST, rotated full grant stored before access version, and timeout/crash fail-closed.
- Handler add-only IAM: **unrun**. Prove allowed-prefix add and denied read/create/outside-prefix add.
- GKE actual token-only mount and disconnect/generation race: **unrun**.
- Cloud Run actual token-only mount and preserved pre-existing secret bindings: **unrun**.
- Docker-host actual token-only read-only mount and cleanup: **unrun**.

Per-leg budgets live with persisted transcripts. Every MCP attempt reserves before calling, retries count,
Retry-After is honored fully (bounded exponential fallback if absent), and persistent throttle files an
operator elicitation. Human-answer workers resume the original logical budget. There is no aggregate ledger.
Parallel legs share Pro Full 200/day 10/min, Organization Full 200/day 15/min, Enterprise Full 600/day 20/min;
View/Collab or Starter is about 20/month. Library components are cached; only owner-requested refresh updates them.


Library lifecycle, founder UX revision (2026-10-27): Settings displays the library read-only and says
to change it with `harmony figma connect` (validated replacement). Save metadata changes only
component-name → repository-path mappings; Refresh library queues a re-read of the saved file by the
refresher. No unvalidated library can be saved in Settings.

Feature-account maintenance disposition: **fold-into-existing: B-1308 (criterion 3)**. Original intents
remain unpublished; B-1308 resolves the predecessor amendment and ordinal sequence. No rebase or live
account publication is part of this release.

Enablement corrections (founder send-back, 2026-10-27): the connect handler verifies the CLI
exchange JWT's signature and claims directly, without adding an audience to auth-token's JWT;
project-scoped callers are confined to their signed workspace and must still be live owners.
A refresh response may rotate, retain or omit its refresh token: retain the existing token when
omitted, always store the complete grant before publishing access, and never retry an ambiguous POST.
Reconnect/expired contexts launch without Figma mounts; context lookup errors log and degrade to
disconnected. Figma-dependent steps still stop with reconnect guidance. Malformed mount references
remain a launch refusal. Worker installation also skips unavailable Figma rather than aborting unrelated work.
