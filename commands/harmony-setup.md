---
name: harmony-setup
description: Configure the Harmony plugin for this project — sets the API token and verifies the connection.
allowed-tools: ["Read", "Write", "Edit", "Bash", "mcp__harmony__list_tasks"]
---

# Harmony Plugin Setup

Configure the Harmony plugin for the current project.

## Steps

### 1. Check for existing configuration

Read `.claude/settings.local.json` if it exists. If `HARMONY_API_TOKEN` is already set under `env`, tell the user it's already configured and ask if they want to update it. If they say no, skip to step 3 (verify).

### 2. Ask for the token

Ask the user for their Harmony API token. They can get one from their Harmony workspace settings.

Once the user provides the token:

- Read `.claude/settings.local.json` if it exists (to preserve other settings), or start with `{}`
- Set `env.HARMONY_API_TOKEN` to the provided token value
- Write the updated JSON back to `.claude/settings.local.json`
- Ensure `.claude/settings.local.json` is in `.gitignore` (check and add if missing)

### 3. Verify the connection

Call `mcp__harmony__list_tasks` with a `limit` of 1 to verify the token works. If it succeeds, report success and show which workspace/project the token is connected to. If it fails, report the error and ask the user to check their token.

### 4. Remind about restart

Tell the user: "Configuration saved. Restart Claude Code (`/exit` then `claude`) for the MCP server to pick up the new token."
