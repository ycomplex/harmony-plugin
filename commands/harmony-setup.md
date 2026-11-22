---
name: harmony-setup
description: Configure the Harmony plugin for this project — pick a project stored in ~/.harmony (or save a new token there) and the target, then verify the connection after restarting.
allowed-tools: ["Read", "Write", "Edit", "Bash", "mcp__harmony__get_project"]
---

# Harmony Plugin Setup

Configure the Harmony plugin for the current project.

A non-prod target (e.g. `staging`, for B-488-style plugin-change dogfood) is a supported,
documented configuration, not an undocumented workaround (B-800) — this command now asks which
target you're pointing at instead of silently assuming prod. Since B-1501 it writes
`HARMONY_PROJECT` (and, only for a non-prod project stored without a pair, the Supabase pair) rather
than a token; a hand-written `.claude/settings.local.json` may still carry the older env triple that `container/env.example` and
`scripts/setup-channel-env.sh` use elsewhere in this repo for the same purpose; on a launcher host
running the daemon, the analogous source of truth is `~/.harmony/deployment.json`'s
`launcher.supabase` section (`src/config/deployment-config.ts`) — this command doesn't read or
write that file, it only documents that the same triple applies here too.

## Steps

Tokens live in one place: `~/.harmony/config.json`, one entry per project, written by `harmony`
commands (mode 600). A project's `.claude/settings.local.json` names the stored project with
`HARMONY_PROJECT`; it never needs a token (B-1501). The plugin picks its project in this order:
`HARMONY_API_TOKEN` in the environment, then `HARMONY_PROJECT`, then (terminal commands only) the
CLI's active project.

### 1. Check for existing configuration

Read `.claude/settings.local.json` if it exists.

- If `env.HARMONY_PROJECT` is set, tell the user which stored project it names and ask if they want to change it.
- If `env.HARMONY_API_TOKEN` is set, tell the user this project keeps a copy of its token in that file, and **offer** to move it into `~/.harmony` (step 3b). Move it only on a clear yes; a no keeps the file as it is.
- If either is set and the user wants no change, confirm that this session was started in this directory after the latest configuration edit. Only then skip to step 5 (verify). If that restart has not happened or is uncertain, go to step 4. Declining an update does not make an old session's connection proof of the saved configuration.

### 2. Ask for the target

Ask the user which Harmony target this project should talk to:

- **prod** (default) — the real board, where tickets live. No extra fields needed.
- **staging** or **custom** — a non-prod target (e.g. the B-488 staging-channel dogfood setup, or
  a self-hosted/scratch Supabase project). Also ask for (unless step 3 finds a stored project that carries them):
  - The Supabase URL (`HARMONY_SUPABASE_URL`)
  - The Supabase anon key (`HARMONY_SUPABASE_ANON_KEY`) — required for staging/custom (prod has a
    baked-in default and does not need one)

### 3. Pick a stored project, or save a new token

**3a. Projects already held.** Before asking for any token, run `harmony project list` and show the
user the project names it prints (names only; it never prints a token). Ask whether this project is
one of them.

If they pick one, say `<key>`:

- Read `.claude/settings.local.json` if it exists (to preserve other settings), or start with `{}`
- Set `env.HARMONY_PROJECT` to `<key>`. Write **no** token.
- Prefer the stored project's own Supabase pair. Only when the target is non-prod **and** that stored project carries no pair of its own, also set `env.HARMONY_SUPABASE_URL` and `env.HARMONY_SUPABASE_ANON_KEY`. Never set them for prod, and never set a pair that differs from the one the project is stored with: the plugin refuses that combination by name rather than send the token to another backend.
- Write the updated JSON back to `.claude/settings.local.json`, and ensure `.claude/settings.local.json` is in `.gitignore` (check and add if missing)

**3b. A project not held yet** (or the user said yes to moving the old copy in step 1). Ask the user
for their Harmony API token for the chosen target, unless you are moving the one already in
`settings.local.json`. They can get one from the project's settings in Harmony — Project Settings →
Connect AI (tokens are minted per project, and a token reaches only that project).

- Save it with the non-activating save, which checks it against Harmony first and never changes the
  CLI's active project. Pipe the token in on stdin from a here-string you write, for example
  `harmony login --no-activate --token-stdin <<<'<token>'` (for a non-prod target add
  `--supabase-url <url> --supabase-anon-key <key>`). The token is never passed as a command
  argument: never use `--token <token>` here. Never echo it back to the user, and never write it into
  any file of this repository.
- The command prints the key it stored the project under (when a different project already holds
  that name, it says so and prints another key). Use that key.
- Set `env.HARMONY_PROJECT` to the key in `.claude/settings.local.json`, as in 3a, and ensure the file is
  in `.gitignore`.
- When moving an old copy: leave `env.HARMONY_API_TOKEN` in place for now — while it is there it
  still wins over `HARMONY_PROJECT`. Tell the user the old copy is deleted only after the restarted
  session verifies with the new configuration (step 5).

### 4. Save now, verify after restart

After any configuration edit, tell the user: "Configuration saved. Connection verification is pending. Restart Claude Code (`/exit` then `claude`) in this directory, then run `/harmony-setup` again and choose not to update the configuration so we can verify it."

Stop here in this session. The MCP server loads configuration at startup; a call now could use the previous token or target. Do not call a verification tool, report connection success, or blame the new token before the restart. If the configuration was already present but restart is unconfirmed, say verification is pending and give the same restart instructions without claiming a new save.

### 5. Verify the restarted connection

Only after confirming that this session started after the latest configuration edit, call `mcp__harmony__get_project`. Do not substitute a CLI call or task-list result: the CLI can select a credential stored for another project, and neither proves which configuration the restarted MCP server loaded.

Show the project name and key, and the Supabase target from the returned `environment` block. Show the workspace name/identity if the response includes it; otherwise explicitly say: "Workspace identity is not returned by this check and remains unconfirmed." Never infer a workspace from an old session, task, or project name.

If an old `env.HARMONY_API_TOKEN` copy is waiting to be removed (step 3b), the session that just
verified still used that copy, because it wins over `HARMONY_PROJECT`. In that case, after the user
confirms the match below: remove `env.HARMONY_API_TOKEN` from `.claude/settings.local.json` (keep
`HARMONY_PROJECT`), go to step 4, and verify once more after the restart; only that second
verification proves the stored project works. If the second check fails, put nothing back
automatically: report it, and tell the user the token is still stored in `~/.harmony/config.json`.

Ask the user to compare the returned project and target with the board they intended. If they match, report that the restarted project connection was verified, keeping any workspace limitation visible; do not claim full workspace verification when its identity is unavailable. If they differ, report the mismatch without a success verdict. If the call fails or required project/target identity is missing, report the error or incomplete verification and ask the user to check the saved configuration. If the MCP tool is unavailable, verification remains pending. Any subsequent edit returns to step 4 and requires another restart.
