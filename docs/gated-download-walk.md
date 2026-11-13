# The founder's walk: installing the plugin from the gated download (B-1477)

**Status:** written 2026-11-13 for B-1477. The founder runs it first, then a second person repeats it on another
machine. It sits **beside** today's install, `harmony-plugin@ycomplex`, which stays installed (only disabled for
the walk) and comes back in step 8.

The gated download is described in [`plugin-release-artefact.md`](plugin-release-artefact.md). This walk installs
`harmony-plugin@harmony` from it and checks that updates arrive and that a refused token does no harm.

Every step says what to type and what to expect. Values are placeholders:

- `<BASE>` is the gated download's base address. Harmony's own value is in the workspace's
  `docs/project/harmony-deployment-values.md`, never in this repository.
- `<VERSION>` is the plugin version you installed.

Some steps exist only to prove the download works. They are marked **TEST ONLY** and listed at the end. The
customer guide (B-1479) must not copy them.

## Before you start

1. Check Claude Code's version:

   ```bash
   claude --version
   ```

   The walk was tested on `2.1.323`. The minimum is `2.1.238` (the first version that sends headers when it downloads
   a plugin archive). Update Claude Code if yours is older.
2. Have a Harmony API token. Its owner must be an **owner, admin or member** of the workspace. A viewer's token is
   refused.
3. Know `<BASE>` (see above).
4. If you set `CLAUDE_CONFIG_DIR`, read `~/.claude` below as that directory.

## Step 1: save the token and the helper

The token goes in a file only you can read. Paste it when asked; it is not shown and not kept in your shell
history.

```bash
mkdir -p ~/.harmony && chmod 700 ~/.harmony
( umask 077; printf 'Harmony API token: '; IFS= read -rs t; printf '%s' "$t" > ~/.harmony/download-token; unset t; echo )
ls -l ~/.harmony/download-token
```

Expect `-rw-------`.

Now save the helper as `~/.harmony/download-headers.sh`. Claude Code runs it to get the header for each download.

```sh
#!/bin/sh
# Prints the Authorization header for Harmony's gated plugin download.
d=$(dirname "$0")
t=$(tr -d '\r\n' < "$d/download-token")
# TEST ONLY — not for the customer guide (B-1479): note the time of each run. Never the token.
date -u '+%Y-%m-%dT%H:%M:%SZ helper ran' >> "$d/download-headers.log"
printf '{"Authorization":"Bearer %s"}' "$t"
```

```bash
chmod 700 ~/.harmony/download-headers.sh
sh ~/.harmony/download-headers.sh | cut -c1-28; echo
cat ~/.harmony/download-headers.log
```

Expect `{"Authorization":"Bearer ` (the rest is cut off so the token is not shown) and one `helper ran` line.
Delete that log line if you like: from here on, each new line is a download that sent the header.

## Step 2: declare the marketplace in your settings

Open `~/.claude/settings.json` in an editor. Add the `harmony` entry under `extraKnownMarketplaces`. Keep every
key that is already there: if the file already has `extraKnownMarketplaces`, add `harmony` inside it. Use the
**absolute** path to the helper (Claude Code runs it from its config directory), for example
`/Users/you/.harmony/download-headers.sh`:

```json
{
  "extraKnownMarketplaces": {
    "harmony": {
      "source": {
        "source": "url",
        "url": "<BASE>/prod/marketplace.json",
        "headersHelper": "/absolute/path/to/.harmony/download-headers.sh"
      },
      "autoUpdate": true
    }
  }
}
```

Check the file is still valid JSON:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("valid")' ~/.claude/settings.json
```

Expect `valid`.

Do **not**:

- run `claude plugin marketplace add` for this address. Once the marketplace is declared, Claude Code refuses it:
  `Cannot add marketplace "harmony": its source doesn't match its extraKnownMarketplaces entry in user or managed
  settings`;
- use static `headers`, or put a `headersHelper` on the plugin entry. Static headers break the marketplace when
  edited later, and a helper on the plugin entry turns auto-update off (B-1475).

`autoUpdate: true` matters: auto-update is off by default for marketplaces Anthropic does not run.

## Step 3: let Claude Code fetch the marketplace

Start Claude Code once in any directory, wait for the prompt, and quit (`/exit`). Starting a session fetches the
declared marketplace. Then:

```bash
claude plugin marketplace list
```

Expect `harmony` with `Source: URL (<BASE>/prod/marketplace.json)`. The helper log has a new line.

## Step 4: install, and disable today's copy

```bash
claude plugin install harmony-plugin@harmony
claude plugin disable harmony-plugin@ycomplex
```

Expect `Successfully installed plugin: harmony-plugin@harmony (scope: user)`, then the disable to succeed.

Keep only one copy enabled. Both copies are named `harmony-plugin`. With both enabled, Claude Code drops one
copy's hooks, and you cannot tell which copy's tools and skills you are running.

## Step 5: check the install

1. ```bash
   claude plugin list
   ```

   Expect `harmony-plugin@harmony` with `Status: ✔ enabled` and `harmony-plugin@ycomplex` disabled. Note the
   version: that is `<VERSION>`.
2. ```bash
   claude plugin details harmony-plugin
   ```

   For 0.17.60 expect `Skills (16)`, `Hooks (3)  SessionStart, Stop, PreToolUse` and `MCP servers (1)  harmony`.
   A later version may have other counts.
3. Start a **fresh** session (a new `claude`, not `/reload-plugins`).
   - Type `/plugin` and open the **Errors** tab. Expect it to be empty.
   - Run a skill, for example `/harmony-plugin:harmony-queue`. Expect your queue.
   - Ask: "Call get_project and show me environment.plugin_version". Expect `<VERSION>`.
4. In a terminal:

   ```bash
   harmony --version
   ```

   Expect `<VERSION>`. The fresh session's SessionStart hook pointed the `harmony` command at the new copy. If it
   still prints the old version, start one more fresh session; `/reload-plugins` usually does not repoint it.
5. ```bash
   cat ~/.harmony/download-headers.log
   ```

   Expect new lines from steps 3 and 4. (**TEST ONLY**.)

## Step 6: see an update arrive

This step waits for the next promote (`./promote-prod.sh`) to publish a newer version.

1. See which version the download serves now. This command does not print the token and does not run the helper:

   ```bash
   printf 'Authorization: Bearer %s\n' "$(cat ~/.harmony/download-token)" \
     | curl -sS -H @- "<BASE>/prod/release.json" | grep '"version"'
   ```

   When it shows a version higher than `<VERSION>`, go on.
2. Check nothing turns auto-update off:

   ```bash
   env | grep -E '^(DISABLE_AUTOUPDATER|DISABLE_UPDATES|CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC|FORCE_AUTOUPDATE_PLUGINS)='
   ```

   Expect no output. If any of the first three is set, auto-update does nothing unless
   `FORCE_AUTOUPDATE_PLUGINS=1` is also set.
3. Note the time. Open a session and send one message (anything). Leave the session open for up to about
   10 minutes: the background check runs after the first message, after a random delay of up to 10 minutes.
4. Expect the notice `Plugin updated: harmony-plugin · Run /reload-plugins to apply`. The running session keeps the
   old version.
5. (**TEST ONLY**) `cat ~/.harmony/download-headers.log`. Expect a line at about the time of the notice: that is
   the header going out on the background check.
6. Quit and start a fresh session. Check `get_project`'s `environment.plugin_version` and `harmony --version`
   both show the new version.

If no notice comes, update by hand and record that the background update did not happen:

```bash
claude plugin marketplace update harmony
claude plugin update harmony-plugin@harmony
```

Each check downloads the whole zip (about 6 MB). An update lands only when the zip's own version changes.

## Step 7: a refused token does no harm (TEST ONLY)

1. Keep the good token, and put a wrong value in its place:

   ```bash
   cp -p ~/.harmony/download-token ~/.harmony/download-token.good
   printf 'not-a-token' > ~/.harmony/download-token
   ```

2. ```bash
   claude plugin marketplace update harmony
   claude plugin update harmony-plugin@harmony
   ```

   Expect both to fail with 401:

   ```
   ✘ Failed to update marketplace(s): Failed to refresh marketplace 'harmony': HTTP 401 error while downloading marketplace from <BASE>/prod/marketplace.json. ...
   Technical details: Request failed with status code 401
   ✘ Failed to update plugin "harmony-plugin@harmony": HTTP 401 while downloading plugin archive from <BASE>/prod/releases/<VERSION>/harmony-plugin-<VERSION>.zip. ...
   ```

3. `claude plugin list`. Expect `harmony-plugin@harmony` still enabled at `<VERSION>`.
4. Start a **fresh** session with the wrong token still in place, and send one message. Check the `/plugin`
   Errors tab, run `/harmony-plugin:harmony-queue`, and ask for `get_project`. Expect all to work as in step 5.
   No worker could run this part: it needs a logged-in session.
5. The revoked case. In Harmony, create a throwaway API token. Put it in `~/.harmony/download-token` (use the
   `read -rs` line from step 1). Run the two update commands: expect them to succeed. Revoke the token in Harmony.
   Run them again: expect the same 401 lines as in point 2. The download's own message for this case is
   `Invalid or revoked Harmony token`; Claude Code shows only the status code. Then repeat point 4.
6. Restore the good token and check recovery:

   ```bash
   mv ~/.harmony/download-token.good ~/.harmony/download-token
   claude plugin marketplace update harmony
   claude plugin update harmony-plugin@harmony
   ```

   Expect `Successfully updated marketplace: harmony` and
   `harmony-plugin is already at the latest version (<VERSION>)`.

## Step 8: go back to today's install

```bash
claude plugin marketplace remove harmony
```

This also uninstalls `harmony-plugin@harmony`. Then:

1. Remove the `harmony` entry from `extraKnownMarketplaces` in `~/.claude/settings.json`, and check the file is
   valid JSON (the command in step 2). If you leave the entry, the next session fetches the marketplace again.
2. ```bash
   claude plugin enable harmony-plugin@ycomplex
   rm -f ~/.harmony/download-token ~/.harmony/download-token.good ~/.harmony/download-headers.sh ~/.harmony/download-headers.log
   ```

3. Start a fresh session. Expect `claude plugin list` to show only `harmony-plugin@ycomplex`, enabled;
   `harmony --version` to print the `ycomplex` copy's version; and a skill such as
   `/harmony-plugin:harmony-queue` to work.

## The second person

A second person repeats steps 1 to 8 on another machine, with their own token. Record:

- their Claude Code version (`claude --version`);
- their operating system and version;
- the outcome of each step, and any message that differs from this walk.

## What a worker proved, and what it could not run

A worker ran [`scripts/gated-install-check.sh`](../scripts/gated-install-check.sh) against the production
download with a real token, in a throwaway configuration (its own `HOME` and `CLAUDE_CONFIG_DIR`). Its output is
under "Recorded run" below.

| Behaviour | Worker run | Walk step |
|---|---|---|
| `marketplace add` refused once the marketplace is declared | proved (case A) | 2 |
| A session start fetches the declared marketplace, even one that stops at "Not logged in" | proved (case B) | 3 |
| Install: enabled; skills, hooks, MCP server present; `harmony --version` matches | proved (case C) | 4, 5 |
| A wrong token: both refreshes fail with 401; the install stays enabled and unchanged | proved (case D) | 7 |
| The good token restored: both refreshes work again | proved (case E) | 7 |
| Background auto-update, and the header sent on it | not run: needs a logged-in interactive session and a newer version | 6 |
| A logged-in session after a refused refresh | not run: needs a logged-in session | 7 |
| A revoked token | not run | 7 |
| Rolling back on a real machine | not run | 8 |
| macOS and Windows | not run: the worker is Linux | all |

## Recorded run

Run on 2026-11-13 by the B-1477 build leg, Claude Code `2.1.323 (Claude Code)`, channel `prod`; it installed
plugin version 0.17.60. The command was
`scripts/gated-install-check.sh --base <BASE> --token-file <TOKEN_FILE>`, and it exited 0.

`skill directories: 15` counts the directories holding a `SKILL.md`; `Skills (16)` is Claude Code's own count.

```
Claude Code: 2.1.323 (Claude Code)
Channel: prod (marketplace harmony, <BASE>/prod/marketplace.json)
== A declared marketplace
    | Adding marketplace…✘ Failed to add marketplace: Cannot add marketplace "harmony": its source doesn't match its extraKnownMarketplaces entry in user or managed settings; add it from the source that entry lists, or change the entry.
    |
A declared marketplace: PASS — marketplace add refused while declared: Adding marketplace…✘ Failed to add marketplace: Cannot add marketplace "harmony": its source doesn't match its extraKnownMarketplaces entry in user or managed settings; add it from the source that entry lists, or change the entry.
== B fetch at session start
    | session exit 1: Not logged in · Please run /login
    | Configured marketplaces:
    |
    |   ❯ anthropic-plugin-directory
    |     Source: Built in (Anthropic Directory)
    |
    |   ❯ harmony
    |     Source: URL (<BASE>/prod/marketplace.json)
    |
B fetch at session start: PASS — marketplace list shows harmony after one session start
== C install
    | Installing plugin "harmony-plugin@harmony"...✔ Successfully installed plugin: harmony-plugin@harmony (scope: user)
    | Installed plugins:
    |
    |   ❯ harmony-plugin@harmony
    |     Version: 0.17.60
    |     Scope: user
    |     Status: ✔ enabled
    |
C install: PASS — installed 0.17.60, enabled; cache $CLAUDE_CONFIG_DIR/plugins/cache/harmony/harmony-plugin/0.17.60; skill directories: 15; hook events: SessionStart/Stop/PreToolUse; MCP servers: harmony; details: Skills (16); Agents (0); Hooks (3) SessionStart, Stop, PreToolUse; MCP servers (1) harmony; harmony --version prints 0.17.60
== D wrong token
    | Updating marketplace: harmony...✘ Failed to update marketplace(s): Failed to refresh marketplace 'harmony': HTTP 401 error while downloading marketplace from <BASE>/prod/marketplace.json. The marketplace file may not exist at this URL.
    |
    | Technical details: Request failed with status code 401
    |
    | Checking for updates for plugin "harmony-plugin@harmony"…
    | ✘ Failed to update plugin "harmony-plugin@harmony": HTTP 401 while downloading plugin archive from <BASE>/prod/releases/0.17.60/harmony-plugin-0.17.60.zip. The server rejected the request — if it requires authentication, add `headers` to the marketplace source (they are forwarded to plugin archives on the same origin) or configure your proxy.
    |
    | Technical details: Request failed with status code 401
D wrong token: PASS — marketplace update: "Updating marketplace: harmony...✘ Failed to update marketplace(s): Failed to refresh marketplace 'harmony': HTTP 401 error while downloading marketplace from <BASE>/prod/marketplace.json. The marketplace file may not exist at this URL."; plugin update: "✘ Failed to update plugin "harmony-plugin@harmony": HTTP 401 while downloading plugin archive from <BASE>/prod/releases/0.17.60/harmony-plugin-0.17.60.zip. The server rejected the request — if it requires authentication, add `headers` to the marketplace source (they are forwarded to plugin archives on the same origin) or configure your proxy."; still 0.17.60, enabled, cache unchanged
== E recovery
    | Updating marketplace: harmony...Downloading marketplace from <BASE>/prod/marketplace.json
    | Validating marketplace data
    | Saving marketplace to cache
    | ✔ Successfully updated marketplace: harmony
    | Checking for updates for plugin "harmony-plugin@harmony"…
    | ✔ harmony-plugin is already at the latest version (0.17.60).
E recovery: PASS — marketplace update: "Updating marketplace: harmony...Downloading marketplace from <BASE>/prod/marketplace.json"; plugin update: "✔ harmony-plugin is already at the latest version (0.17.60)."
F background auto-update: NOT-RUN — needs a logged-in interactive session and a newer published version (docs/gated-download-walk.md step 6)
G logged-in session after a refused refresh: NOT-RUN — needs a logged-in session (docs/gated-download-walk.md step 7)
== summary (Claude Code 2.1.323 (Claude Code), channel prod, installed 0.17.60)
A declared marketplace: PASS — marketplace add refused while declared: Adding marketplace…✘ Failed to add marketplace: Cannot add marketplace "harmony": its source doesn't match its extraKnownMarketplaces entry in user or managed settings; add it from the source that entry lists, or change the entry.
B fetch at session start: PASS — marketplace list shows harmony after one session start
C install: PASS — installed 0.17.60, enabled; cache $CLAUDE_CONFIG_DIR/plugins/cache/harmony/harmony-plugin/0.17.60; skill directories: 15; hook events: SessionStart/Stop/PreToolUse; MCP servers: harmony; details: Skills (16); Agents (0); Hooks (3) SessionStart, Stop, PreToolUse; MCP servers (1) harmony; harmony --version prints 0.17.60
D wrong token: PASS — marketplace update: "Updating marketplace: harmony...✘ Failed to update marketplace(s): Failed to refresh marketplace 'harmony': HTTP 401 error while downloading marketplace from <BASE>/prod/marketplace.json. The marketplace file may not exist at this URL."; plugin update: "✘ Failed to update plugin "harmony-plugin@harmony": HTTP 401 while downloading plugin archive from <BASE>/prod/releases/0.17.60/harmony-plugin-0.17.60.zip. The server rejected the request — if it requires authentication, add `headers` to the marketplace source (they are forwarded to plugin archives on the same origin) or configure your proxy."; still 0.17.60, enabled, cache unchanged
E recovery: PASS — marketplace update: "Updating marketplace: harmony...Downloading marketplace from <BASE>/prod/marketplace.json"; plugin update: "✔ harmony-plugin is already at the latest version (0.17.60)."
F background auto-update: NOT-RUN — needs a logged-in interactive session and a newer published version (docs/gated-download-walk.md step 6)
G logged-in session after a refused refresh: NOT-RUN — needs a logged-in session (docs/gated-download-walk.md step 7)
```

## Running the check

```bash
scripts/gated-install-check.sh --base <BASE> --token-file <TOKEN_FILE> [--channel prod|staging]
```

It needs `claude`, `node` and `timeout` on PATH. `--channel staging` checks the `harmony-staging` marketplace.
It copies the token into its own temp directory, so case D never touches your token file. It never prints the
token or the base address. It exits 0 when no case fails, 1 when one does and 2 on a usage error.

## Test-only steps

These exist only to prove the download. B-1479's customer guide must not copy them:

- the helper's log line, and every step that reads `~/.harmony/download-headers.log` (steps 1, 3, 5 and 6);
- step 7, the wrong and revoked token exercise, and the `download-token.good` copy it makes;
- `scripts/gated-install-check.sh` and its recorded run.
