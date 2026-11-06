# B-1413 Phase A compatibility handoff

Additive only. Keep DEFAULT_SUPABASE_ANON_KEY and every existing secret binding. No key creation, activation, rotation, revocation, deployment or configuration value change is part of this PR. Feature-account intent is not-applicable: this preserves existing session features and permissions.

## Inputs and transport

CLI: `--supabase-publishable-key` aliases `--supabase-anon-key`. Saved projects may use `supabasePublishableKey` or `supabaseAnonKey`. Environment (including EVAL twins): `HARMONY_SUPABASE_PUBLISHABLE_KEY` or `HARMONY_SUPABASE_ANON_KEY`. Matching aliases work; conflicting nonempty aliases in the selected source fail with names only. Flags → project → environment → defaults, and both prior default-URL exceptions, are preserved. Existing saved projects are not rewritten.

The public key travels in `apikey` during exchange. Legacy public JWTs retain their Bearer compatibility header. `sb_publishable_` and `sb_secret_` never become a public-key Bearer header. The body remains the Harmony API token. Data requests retain the SDK's per-request renewed user-JWT callback. Decoding response metadata does not verify a signature; server signing trust belongs to B-1415.

The channel scripts already accept either format in the positional key argument and retain their legacy environment binding. Provision also accepts the new environment name, validates conflicts, and passes the selected key through the same channel writer. No new secret names are required for existing deployments.

## Exact workspace proposals for the seat (no workspace PR)

In both `tools/orchestrator/watch-board.mjs` and `tools/ticket-timeline.mjs`, immediately after imports and before configuration, insert:

```js
const legacyPublicKey = process.env.HARMONY_SUPABASE_ANON_KEY;
const publishablePublicKey = process.env.HARMONY_SUPABASE_PUBLISHABLE_KEY;
if (legacyPublicKey && publishablePublicKey && legacyPublicKey !== publishablePublicKey) {
  throw new Error('Conflicting Supabase public key aliases: HARMONY_SUPABASE_ANON_KEY and HARMONY_SUPABASE_PUBLISHABLE_KEY');
}
```

Replace only the first line of each key initializer as follows (leave the following baked-default line byte-for-byte untouched):

```diff
-const SUPABASE_ANON_KEY = process.env.HARMONY_SUPABASE_ANON_KEY
+const SUPABASE_ANON_KEY = (legacyPublicKey || publishablePublicKey)
```

```diff
-const ANON = process.env.HARMONY_SUPABASE_ANON_KEY
+const ANON = (legacyPublicKey || publishablePublicKey)
```

Replace the watch-board exchange headers:

```diff
-        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
+        headers: {
+          'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY,
+          ...(!/^sb_(publishable|secret)_/.test(SUPABASE_ANON_KEY)
+            ? { Authorization: `Bearer ${SUPABASE_ANON_KEY}` } : {}),
+        },
```

Replace the ticket-timeline exchange headers:

```diff
-    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON}` },
+    headers: {
+      'Content-Type': 'application/json', apikey: ANON,
+      ...(!/^sb_(publishable|secret)_/.test(ANON) ? { Authorization: `Bearer ${ANON}` } : {}),
+    },
```

Add the new alias to each tool's environment documentation. Keep watch-board's accessToken callback and timeline's data-request user-JWT Authorization unchanged. The plugin's historical repair/backfill/redrive/sweep consumers import HarmonyAuth and inherit the shared transport; they need no copied credential or dedicated auth implementation. Workspace capture-board-snapshot delegates to the CLI. Plugin `.github/` has no public-key bindings to amend; no workflow diff is proposed by this ticket.

## Propagation and founder steps (names only)

1. Before release, prove a live staging read through the existing `setup-staging-channel.sh` channel, recording branch/revision, target `staging`, result and fresh-worker legacy result without values. Synthetic tests are not this hosted proof. Do not open settings or other credential stores in the worker; if the channel cannot be invoked through an authorized opaque loader, ask the seat for that path or sanitized evidence from this exact revision.
2. Merge source to main only after the seat accepts release. CI generates staging. New worker clones consume that staging immediately against the prod board, hence legacy compatibility must hold before any migration/cutover. Provision script changes arrive after staging regeneration.
3. Promote via the workspace promote script under explicit seat authority after the compatible web production schema. This publishes installed plugin code; interactive sessions must restart to load it.
4. Conductor code/allowlists/redaction require the new conductor image plus Update/restart. Worker image changes, when needed, require a successful image build before fresh legs. Running legs are not relaunched by Update.
5. Figma manifests now allow optional `anon-key` and `publishable-key` fields on the EXISTING per-board Secrets `harmony-figma-refresh-board` and `harmony-figma-refresh-board-prod`. Legacy-only Secrets remain valid. If the founder later provides the alternative field, set one or identical values; conflicting values fail. Founder re-applies the manifest only with each job's current pinned image retained. Refresh-runner code arrives with that channel's image build and CronJob digest repin, then the next hourly run. Do not activate new key values as part of Phase A.
6. Any Dashboard key creation, Secret Manager/GitHub/Kubernetes value setting, signing activation, key default activation, disabling or revocation belongs to founder-owned Phase B (B-1417), outside this PR. Names-only proposals confer no value-change authority.

B-1415 technical design `0132abdd-bc7b-4401-baf2-ace89514c955` was re-read as Accepted on 2026-11-06. Synthetic HS256/ES256 response-metadata and renewal tests now cover its unchanged claims/no-aud contract without private key material or a signature-validity claim. B-1415's Accepted technical design is required only for old/new signing-response tests. If still unaccepted, declare the named dependency wait after pushing independent work; do not invent a signing contract. Hosted new-key adoption remains unproved and outside this Phase A change.

## Build validation record (2026-11-06)

193 compatibility/adjacent tests pass across twelve files; the additive Codex literal expectations were reconciled and 48 provider/drift tests pass across two more files. Typecheck, lint, shell syntax and generated-artifact checks pass. A broad run before the snapshot reconciliation reported 7287 passed, 4 failed, 7 skipped: two expected Codex snapshot differences (fixed inline), an unchanged smoke-script test returning SIGPIPE 141 (passes in isolation), and an unchanged GKE quota test exceeding its 5-second timeout under full-suite load. This is a failed full-run result, not a full-suite pass. Do not hide it behind the isolated results or broaden this compatibility ticket into infrastructure cleanup. These validation findings are drained on the ticket; no follow-up ticket was minted.

The required live staging read and real fresh-worker legacy proof are still outstanding. A synthetic worker guard test proves input compatibility only. This revision must stay draft/Planned until the seat supplies an authorized opaque channel invocation or sanitized proofs for the exact pushed revision. No release brief is filed yet.
