# B-1201 live build prerequisites

The accepted plan requires native runtime authentication and disposable rotation proofs.
This is an operator handoff, not evidence that any live proof passed. Never send credentials in a board answer.

## Native runtime authentication

In a disposable operator-controlled environment with native Claude and Codex runtime auth, mount
**only** a current Figma access token at a mode-0600 file. Do not mount a Figma OAuth credential file,
refresh token or Secret Manager reader credential into the test worker. Use an empty working directory
and fresh runtime profiles with no saved Figma OAuth login, so native login cannot mask a failed header.

Run `node scripts/figma-auth-proof.mjs <ACCESS_TOKEN_FILE> <PRIVATE_CONFIG_DIRECTORY>`.
The directory must be mode 0700. It creates a secret-bearing Claude MCP config (0600) and a Codex
configuration fragment that references `FIGMA_MCP_ACCESS_TOKEN`; it prints paths only.
This helper does not read Secret Manager, refresh grants, execute a model or claim a proof passed.

Claude: supply `claude-mcp.json` with `--strict-mcp-config --mcp-config <CONFIG_PATH>` and ask
Claude to call `mcp__figma__whoami` exactly once. Allow that tool, not shell/file reads. Keep CLI logs
private and never attach the config. Report actual tool success/failure and the verified handle,
CLI version and image digest. A model's unsupported statement of success is not evidence.

Codex: load the generated TOML fragment in the disposable profile and populate
`FIGMA_MCP_ACCESS_TOKEN` from the mounted file without printing it or putting its value on argv.
Ask it to call Figma `whoami` exactly once. Report the actual tool result, verified handle, CLI
version and image digest. Neither runtime receives the full grant. Destroy the disposable profiles,
token files and configs after the run; logs must be reviewed/redacted before sharing.

## Founder-controlled refresh proof

Use a **disposable** OAuth grant with the designated refresh identity, outside every worker.
Do not test the current working workspace's refresh token. A single-use token must never be probed
twice. The planned implementation must prove durable claim, one refresh, full rotated-grant version
stored before access-token publication, crash/ambiguous-response fail-closed behavior, and no automatic
retry with the old token. Capture timestamps/version resource names and redacted status, never values.
The worker does not yet contain a refresher: this proof must run against that implementation when ready.

## Operator-provisioned slots and permission proof

The handler key must have conditioned `roles/secretmanager.secretVersionAdder`, no create/access.
Provision workspace grant, PAT and access-token containers before connect; an unprovisioned slot must
name this operator provisioning step. Prove allowed-prefix version adds and denied secret reads,
outside-prefix writes and secret creation. Founder sets staging function secrets before enabling it.
Self-serve provisioning belongs to B-1310.

The build still owes GKE, Cloud Run and Docker-host token-only mount proofs and disconnect/generation
race checks after their implementation. Keep each proof marked unrun until it actually executes.

## Release carry-forward

Carry verbatim: a leaked handler key can replace a workspace's Figma connection, but cannot read credentials.
Founder commands run staging first, production after the web-before-plugin promote ordering; CronJob
apply and Conductor Update are distinct. No infrastructure apply or promote is performed by this helper.
Milestone merge order: B-1202 web and founder promote; B-1204/B-1205; B-1201 web/plugin; B-1206.
Restamp the migration after current origin/main immediately before push.
