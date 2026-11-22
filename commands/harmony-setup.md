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

**A token never passes through you.** You never see, type, echo or copy a token: not in a command
line (your shell commands and their arguments are in this session's transcript), not in a message,
not in a file you write. `.claude/settings.local.json` may hold one (an older setup), so **never open
it with the Read tool and never print it**: inspect and edit it only with the `node -e` commands
below, which print every variable's name and the values of `HARMONY_PROJECT` and
`HARMONY_SUPABASE_URL` only. The edit commands write a temporary file beside it and rename it over the
file, keeping its mode, so the file is never left half-written.

**Saving a token never changes the CLI's active project**, even on a machine that has none. Terminal
commands outside a session use the active project; if the user wants them to use this project, tell
them to run `harmony project switch <key>` themselves.

Inspect the file (every name; values only for `HARMONY_PROJECT` and `HARMONY_SUPABASE_URL`):

```bash
node -e 'const fs=require("fs"),f=".claude/settings.local.json";if(!fs.existsSync(f)){console.log("(no .claude/settings.local.json)");process.exit(0)}let s;try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){console.log("(not valid JSON)");process.exit(1)}const e=(s&&s.env)||{},shown=["HARMONY_PROJECT","HARMONY_SUPABASE_URL"];for(const k of Object.keys(e))console.log(shown.includes(k)?k+"="+e[k]:k+" (set; value not shown)")'
```

Set `env.HARMONY_PROJECT` (and, only when step 3 says so, the Supabase pair), keeping every other setting:

```bash
node -e 'const fs=require("fs"),f=".claude/settings.local.json";const s=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const [p,u,k]=process.argv.slice(1);s.env=Object.assign({},s.env,{HARMONY_PROJECT:p},u?{HARMONY_SUPABASE_URL:u,HARMONY_SUPABASE_ANON_KEY:k}:{});fs.mkdirSync(".claude",{recursive:true});const w=(f,s)=>{const st=fs.existsSync(f)?fs.statSync(f):null,m=st?st.mode&0o777:0o600,t=f+".tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(s,null,2)+"\n",{mode:m});fs.chmodSync(t,m);fs.renameSync(t,f)};w(f,s)' '<key>' # [ '<supabase-url>' '<anon-key>' ]
```

Then ensure `.claude/settings.local.json` is in `.gitignore` (check and add if missing).

### 1. Check for existing configuration

Run the inspect command above.

- If `HARMONY_PROJECT` is set, tell the user which stored project it names and ask if they want to change it.
- If `HARMONY_API_TOKEN` is set, tell the user this project keeps a copy of its token in that file, and **offer** to move it into `~/.harmony` (step 3b). Move it only on a clear yes; a no keeps the file as it is.
- If either is set and the user wants no change, confirm that this session was started in this directory after the latest configuration edit. Only then skip to step 5 (verify). If that restart has not happened or is uncertain, go to step 4. Declining an update does not make an old session's connection proof of the saved configuration.

### 2. Ask for the target

Ask the user which Harmony target this project should talk to:

- **prod** (default) — the real board, where tickets live. No extra fields needed.
- **staging** or **custom** — a non-prod target (e.g. the B-488 staging-channel dogfood setup, or
  a self-hosted/scratch Supabase project). Also ask for (unless step 3 finds a stored project that carries them):
  - The Supabase URL (`HARMONY_SUPABASE_URL`)
  - The Supabase anon key (`HARMONY_SUPABASE_ANON_KEY`) — required for staging/custom (prod has a
    baked-in default and does not need one). It is a public key, not a token.

### 3. Pick a stored project, or save a new token

**3a. Projects already held.** Before asking for any token, run `harmony project list` and show the
user the project names it prints (names only; it never prints a token). Ask whether this project is
one of them.

If they pick one, say `<key>`:

- Find out whether that stored project carries its own Supabase pair: run
  `env -u HARMONY_API_TOKEN HARMONY_PROJECT=<key> harmony whoami`. Its `Supabase:` line prints the
  address and where it comes from: `(the pair stored with the project)`, or `(...; the project stores
  no pair)`. It prints names and the URL only, never a key or a token.
- Set `HARMONY_PROJECT` to `<key>` with the set command above. Write **no** token.
- Prefer the stored project's own pair. Only when the target is non-prod **and** whoami says the project
  stores no pair, also pass the URL and anon key to the set command. Never set them for prod, and never
  set a pair that differs from the one the project is stored with: the plugin refuses that combination
  by name rather than send the token to another backend.

**3b. Moving the copy in `settings.local.json`** (the user said yes in step 1). You do not read the
token; the command reads it from the file itself:

- Run `harmony project adopt-settings-token --file .claude/settings.local.json`. It checks the token with
  Harmony and saves it in `~/.harmony/config.json` without changing the active project, and leaves the
  file unchanged. When the file also holds `HARMONY_SUPABASE_URL` and its key, that pair is stored with
  the project; to give another, add `--supabase-url <url> --supabase-anon-key <key>`. It prints the key
  it stored the project under (when a different project already holds that name, it says so and prints
  another key). Use that key.
- Set `HARMONY_PROJECT` to that key with the set command above. `HARMONY_API_TOKEN` is still in the
  file and still wins over `HARMONY_PROJECT`; leave it for now.
- **Prove the stored copy works without the file's copy, before removing anything:**
  `env -u HARMONY_API_TOKEN HARMONY_PROJECT=<key> harmony whoami` must say
  `HARMONY_PROJECT=<key> in the environment` and print the intended Supabase address, and
  `env -u HARMONY_API_TOKEN HARMONY_PROJECT=<key> harmony project info` must print the intended project
  (it exchanges the stored token with Harmony). If either fails or names another project or address,
  stop: remove nothing, report the output, and tell the user the file still holds its working copy.
- Only when both pass, remove the file's copy, keeping everything else:

  ```bash
  node -e 'const fs=require("fs"),f=".claude/settings.local.json";const s=JSON.parse(fs.readFileSync(f,"utf8"));if(s.env)delete s.env.HARMONY_API_TOKEN;const w=(f,s)=>{const st=fs.existsSync(f)?fs.statSync(f):null,m=st?st.mode&0o777:0o600,t=f+".tmp-"+process.pid;fs.writeFileSync(t,JSON.stringify(s,null,2)+"\n",{mode:m});fs.chmodSync(t,m);fs.renameSync(t,f)};w(f,s)'
  ```

  Run the inspect command once more: `HARMONY_API_TOKEN` must no longer be listed. If the file held a
  pair the stored project now carries, you may remove `HARMONY_SUPABASE_URL` / `_ANON_KEY` the same way
  (only after whoami says `(the pair stored with the project)`).

**3c. A project not held yet.** You do not handle a new token at all. Tell the user to run, **in a
terminal of their own** (not through this session, and not with `!`):

```bash
harmony login --no-activate --token-stdin
```

adding `--supabase-url <url> --supabase-anon-key <key>` for a non-prod target. At a terminal it asks for
the token without showing what they paste, checks it with Harmony, stores it without changing the active
project, and prints the key it stored the project under. They get the token from the project's
settings in Harmony — Project Settings → Connect AI (tokens are minted per project, and a token reaches
only that project). Never ask them to paste the token into this session. Wait until they say it is
done, then run `harmony project list`; continue only once it shows the project. Then set
`HARMONY_PROJECT` to that key as in 3a.

### 4. Save now, verify after restart

After any configuration edit, tell the user: "Configuration saved. Connection verification is pending. Restart Claude Code (`/exit` then `claude`) in this directory, then run `/harmony-setup` again and choose not to update the configuration so we can verify it."

Stop here in this session. The MCP server loads configuration at startup; a call now could use the previous token or target. Do not call a verification tool, report connection success, or blame the new token before the restart. If the configuration was already present but restart is unconfirmed, say verification is pending and give the same restart instructions without claiming a new save.

### 5. Verify the restarted connection

Only after confirming that this session started after the latest configuration edit, call `mcp__harmony__get_project`. Do not substitute a CLI call or task-list result: the CLI can select a credential stored for another project, and neither proves which configuration the restarted MCP server loaded.

Show the project name and key, and the Supabase target from the returned `environment` block. Show the workspace name/identity if the response includes it; otherwise explicitly say: "Workspace identity is not returned by this check and remains unconfirmed." Never infer a workspace from an old session, task, or project name.

Ask the user to compare the returned project and target with the board they intended. If they match, report that the restarted project connection was verified, keeping any workspace limitation visible; do not claim full workspace verification when its identity is unavailable. If they differ, report the mismatch without a success verdict. If the call fails or required project/target identity is missing, report the error or incomplete verification and ask the user to check the saved configuration. If the MCP tool is unavailable, verification remains pending. Any subsequent edit returns to step 4 and requires another restart.
