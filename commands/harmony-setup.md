---
name: harmony-setup
description: Configure the Harmony plugin for this project — sets the API token (and, for a non-prod target, the Supabase URL/anon key) and verifies the connection.
allowed-tools: ["Read", "Write", "Edit", "Bash", "mcp__harmony__list_tasks"]
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

Read `.claude/settings.local.json` if it exists. If `HARMONY_API_TOKEN` is already set under `env`, tell the user it's already configured and ask if they want to update it. If they say no, skip to step 4 (verify).

### 2. Ask for the target

Ask the user which Harmony target this project should talk to:

- **prod** (default) — the real board, where tickets live. No extra fields needed.
- **staging** or **custom** — a non-prod target (e.g. the B-488 staging-channel dogfood setup, or
  a self-hosted/scratch Supabase project). Also ask for:
  - The Supabase URL (`HARMONY_SUPABASE_URL`)
  - The Supabase anon key (`HARMONY_SUPABASE_ANON_KEY`) — required for staging/custom (prod has a
    baked-in default and does not need one)

### 3. Ask for the token and write the configuration

Ask the user for their Harmony API token for the chosen target. They can get one from their Harmony workspace settings.

Once the user provides the token (and, for a non-prod target, the Supabase URL + anon key):

- Read `.claude/settings.local.json` if it exists (to preserve other settings), or start with `{}`
- Set `env.HARMONY_API_TOKEN` to the provided token value
- For a non-prod target, ALSO set `env.HARMONY_SUPABASE_URL` and `env.HARMONY_SUPABASE_ANON_KEY` to the provided values (leave both unset for prod — the plugin's baked-in default covers it)
- Write the updated JSON back to `.claude/settings.local.json`
- Ensure `.claude/settings.local.json` is in `.gitignore` (check and add if missing)

### 4. Verify the connection

Call `mcp__harmony__list_tasks` with a `limit` of 1 to verify the token works. If it succeeds, report success and show which workspace/project the token is connected to. If it fails, report the error and ask the user to check their token (and, for a non-prod target, the Supabase URL/anon key).

### 5. Remind about restart

Tell the user: "Configuration saved. Restart Claude Code (`/exit` then `claude`) for the MCP server to pick up the new token."
