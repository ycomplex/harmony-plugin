---
name: harmony-setup
description: Configure the Harmony plugin for this project — save the API token and target, then verify the connection after restarting.
allowed-tools: ["Read", "Write", "Edit", "Bash", "mcp__harmony__get_project"]
---

# Harmony Plugin Setup

Configure the Harmony plugin for the current project.

A non-prod target (e.g. `staging`, for B-488-style plugin-change dogfood) is a supported,
documented configuration, not an undocumented workaround (B-800) — this command now asks which
target you're pointing at instead of silently assuming prod. This writes the same
`.claude/settings.local.json` env triple that `container/env.example` and
`scripts/setup-channel-env.sh` use elsewhere in this repo for the same purpose; on a launcher host
running the daemon, the analogous source of truth is `~/.harmony/deployment.json`'s
`launcher.supabase` section (`src/config/deployment-config.ts`) — this command doesn't read or
write that file, it only documents that the same triple applies here too.

## Steps

### 1. Check for existing configuration

Read `.claude/settings.local.json` if it exists. If `HARMONY_API_TOKEN` is already set under `env`, tell the user it's already configured and ask if they want to update it. If they say no, confirm that this session was started in this directory after the latest configuration edit. Only then skip to step 5 (verify). If that restart has not happened or is uncertain, go to step 4. Declining an update does not make an old session's connection proof of the saved configuration.

### 2. Ask for the target

Ask the user which Harmony target this project should talk to:

- **prod** (default) — the real board, where tickets live. No extra fields needed.
- **staging** or **custom** — a non-prod target (e.g. the B-488 staging-channel dogfood setup, or
  a self-hosted/scratch Supabase project). Also ask for:
  - The Supabase URL (`HARMONY_SUPABASE_URL`)
  - The Supabase anon key (`HARMONY_SUPABASE_ANON_KEY`) — required for staging/custom (prod has a
    baked-in default and does not need one)

### 3. Ask for the token and write the configuration

Ask the user for their Harmony API token for the chosen target. They can get one from the project's settings in Harmony — Project Settings → Connect AI (tokens are minted per project, and a token reaches only that project).

Once the user provides the token (and, for a non-prod target, the Supabase URL + anon key):

- Read `.claude/settings.local.json` if it exists (to preserve other settings), or start with `{}`
- Set `env.HARMONY_API_TOKEN` to the provided token value
- For a non-prod target, ALSO set `env.HARMONY_SUPABASE_URL` and `env.HARMONY_SUPABASE_ANON_KEY` to the provided values (leave both unset for prod — the plugin's baked-in default covers it)
- Write the updated JSON back to `.claude/settings.local.json`
- Ensure `.claude/settings.local.json` is in `.gitignore` (check and add if missing)

### 4. Save now, verify after restart

After any configuration edit, tell the user: "Configuration saved. Connection verification is pending. Restart Claude Code (`/exit` then `claude`) in this directory, then run `/harmony-setup` again and choose not to update the configuration so we can verify it."

Stop here in this session. The MCP server loads configuration at startup; a call now could use the previous token or target. Do not call a verification tool, report connection success, or blame the new token before the restart. If the configuration was already present but restart is unconfirmed, say verification is pending and give the same restart instructions without claiming a new save.

### 5. Verify the restarted connection

Only after confirming that this session started after the latest configuration edit, call `mcp__harmony__get_project`. Do not substitute a CLI call or task-list result: the CLI can select a credential stored for another project, and neither proves which configuration the restarted MCP server loaded.

Show the project name and key, and the Supabase target from the returned `environment` block. Show the workspace name/identity if the response includes it; otherwise explicitly say: "Workspace identity is not returned by this check and remains unconfirmed." Never infer a workspace from an old session, task, or project name.

Ask the user to compare the returned project and target with the board they intended. If they match, report that the restarted project connection was verified, keeping any workspace limitation visible; do not claim full workspace verification when its identity is unavailable. If they differ, report the mismatch without a success verdict. If the call fails or required project/target identity is missing, report the error or incomplete verification and ask the user to check the saved configuration. If the MCP tool is unavailable, verification remains pending. Any subsequent edit returns to step 4 and requires another restart.
