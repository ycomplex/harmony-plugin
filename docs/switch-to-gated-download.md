# Switching to Harmony's own plugin download

**Who this is for:** people who already have today's Harmony plugin, installed from the `ycomplex` marketplace
(`harmony-plugin@ycomplex`). This guide moves you onto Harmony's own download, `harmony-plugin@harmony`, which
needs your Harmony API token. If you do not have today's plugin installed, install from the download directly
instead: [`install-from-gated-download.md`](install-from-gated-download.md).

**Already ran the switch (0.17.66)?** Nothing breaks and updates keep coming. Run
`harmony download token use <project>` once to pin a single token for the download (recommended when you run
sessions for several projects); `harmony download status` shows what the download uses now.

**macOS and Linux only.** The switch writes a small shell script that Claude Code runs. Windows is not covered.

One command, `harmony download switch`, does the work. It can be undone with `harmony download switch --undo`.

The plugin then comes from Harmony's download address, `https://plugin.harmony.ad`. Claude Code fetches the
marketplace file from `https://plugin.harmony.ad/prod/marketplace.json` and the plugin itself from the same address.

## Before you start

1. Claude Code **2.1.238 or newer**:

   ```bash
   claude --version
   ```

   Update Claude Code if yours is older.
2. A Harmony API token whose owner is an **owner, admin or member** of the workspace. A viewer's token is
   refused.
3. The token stored by the Harmony command line, which keeps it in `~/.harmony/config.json`. The download uses
   ONE stored project's token, pinned for it (`downloadProject` in that file); pinning never changes which project
   your terminal commands use. The switch pins the CLI's active project. To pin another, or a token not stored yet:

   ```bash
   harmony download token use <project>   # a project already stored (see: harmony project list)
   harmony download token set             # a new token: it asks for it without showing it
   ```

   Either command also writes the helper file `~/.harmony/download-headers.sh` (Step 2 describes it). Step 2 then
   reports that file as already in place.

   If your token is only in `HARMONY_API_TOKEN` (a shell profile), the switch asks, in a terminal, whether to save
   it to `~/.harmony/config.json` and pin it; otherwise it stops and points at `harmony download token set`.
   If you set your token up with `/harmony-setup` before it stored tokens in `~/.harmony`, it is in your project's
   `.claude/settings.local.json`, which the download cannot read. When you run the switch in a terminal and it finds
   a token only in that project file, it asks once whether to save it for you.

Never put your token in a command line: it is then in your shell history and visible to other processes. Give it
only at a hidden prompt, which shows nothing as you paste: `harmony download token set`, or
`harmony login --token-stdin` run in a terminal (from a pipe it reads standard input instead).

## Step 0: update today's copy

The `harmony download switch` command arrived in a recent version. Update today's copy first:

```bash
claude plugin marketplace update ycomplex
claude plugin update harmony-plugin@ycomplex
```

Then start a **fresh** Claude Code session (a new `claude`), quit it, and check:

```bash
harmony download switch --help
```

If it prints the general `harmony` help instead of the switch's own usage, the `harmony` on your PATH is still
an older version. Run `harmony --version`; if it prints an older version than `claude plugin list` shows, start
one more fresh session and check again.

## Step 1: see what it will do (recommended)

```bash
harmony download switch --dry-run
```

This prints the files it would write, the settings change and the Claude Code commands it would run. It changes
nothing and runs nothing.

Read its `Token: would pin the download to the active project "<name>"` line. The switch pins whichever project
your command line has active, which may not be the one you mean if you work on several. If the name is wrong, pin
the right one first with `harmony download token use <project>`, then run the dry run again.

## Step 2: switch

```bash
harmony download switch
```

It:

1. Checks a token is where the download can read it (it never prints the token), and pins one stored project for
   the download: the one already pinned, else the active project, else (in a terminal) the one you choose.
2. Writes `~/.harmony/download-headers.sh`, readable only by you. Claude Code runs it for each download to get
   the header that carries your token. The file holds no token; it reads the pinned project's token from
   `~/.harmony/config.json`, and nothing else. It needs `node` on the PATH Claude Code gives it.
3. Adds a `harmony` entry under `extraKnownMarketplaces` in your Claude Code settings file,
   `~/.claude/settings.json` (or `settings.json` in the directory `CLAUDE_CONFIG_DIR` names, if you set it). It keeps
   everything else in the file. Before the first change it saves the original beside it as
   `settings.json.before-harmony-download`.
4. Starts Claude Code once in the background, with no prompt and from an empty temporary folder, so it fetches the
   new marketplace. This sends nothing to the model.
5. Installs `harmony-plugin@harmony`.
6. Disables today's copy, `harmony-plugin@ycomplex`, for your user. It stays installed, so you can go back.

It ends with a short summary and where your settings backup is.

If it says Claude Code has not fetched the marketplace yet: start Claude Code once (open it, wait for the
prompt, then `/exit`), and run `harmony download switch` again. It carries on from where it stopped.

If your settings file is not valid JSON, or already has a different `harmony` entry, it stops and changes
nothing. For a different entry, run `harmony download switch --undo` first.

### A project whose own settings enable today's copy

Some projects turn today's copy on in their own shared `.claude/settings.json`. The switch never edits that file;
it tells you when the folder you ran it in is one of them. In each such project run:

```bash
claude plugin disable harmony-plugin@ycomplex --scope project
```

That command changes the project's shared `.claude/settings.json` (`"harmony-plugin@ycomplex": true` becomes
`false`). Do not commit it while anyone on the project is still on today's copy: the committed line is what
turns the plugin on for them, and they would lose it at their next pull.

Once everyone on the project has switched, one person commits the removal of the `harmony-plugin@ycomplex`
entry from that file (remove the line; do not commit `false`, and do not name the new copy there, which each
person's own settings enable). Everyone else then discards their local edit before pulling:
`git checkout .claude/settings.json`.

Keep only one copy enabled. Both are called `harmony-plugin`, and with both on you cannot tell which one you are
running.

## Step 3: check it works

1. ```bash
   claude plugin list
   ```

   Expect `harmony-plugin@harmony` enabled, and every `harmony-plugin@ycomplex` line disabled. A disabled
   `harmony-plugin@ycomplex` line at project or local scope can stay listed even after no settings file names it:
   Claude Code keeps its own record of the install. It does nothing; leave it.
2. Start a **fresh** Claude Code session (a new `claude`, not `/reload-plugins`). Run a skill, for example
   `/harmony-plugin:harmony-queue`. Expect your queue.
3. In a terminal:

   ```bash
   harmony --version
   ```

   Expect the version `claude plugin list` shows for `harmony-plugin@harmony`. If it still prints the old version,
   start one more fresh session.

## Staying up to date

Auto-update is on for this marketplace. Claude Code checks in the background during a session and installs a new
version when there is one; the session you are in keeps the old version until you start a fresh one. It may not
tell you when an update arrives.

To see which version you have:

```bash
claude plugin list
```

To update by hand:

```bash
claude plugin marketplace update harmony
claude plugin update harmony-plugin@harmony
```

Each check downloads the whole plugin (a few megabytes). Nothing turns auto-update off unless one of
`DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set in your environment.

## When your token changes or is revoked

Run `harmony download token set` and give the new token, or, if the new token is already stored for another
project, `harmony download token use <project>`. Both check the token with the download before pinning it.
Nothing else holds a copy, so there is nothing more to change. (A machine switched before the pin existed reads
`HARMONY_API_TOKEN`, then the active project; pinning once stops that.)

While the token is refused, update checks fail, but the plugin you have installed keeps working.

## Going back

```bash
harmony download switch --undo
```

It:

- removes the `harmony` marketplace, which also uninstalls `harmony-plugin@harmony` and removes the `harmony`
  entry from your settings file by itself (no hand edit needed);
- enables today's copy, `harmony-plugin@ycomplex`, for your user again;
- deletes `~/.harmony/download-headers.sh` and its own record, `~/.harmony/download-switch.json`.

It leaves your token, its pin and the settings backup alone. If you disabled today's copy in a project, enable it there
again:

```bash
claude plugin enable harmony-plugin@ycomplex --scope project
```

Then start a fresh Claude Code session.

## What the switch changes, in one place

| What | Where |
|---|---|
| The header helper | `~/.harmony/download-headers.sh` |
| A record of the switch (no token) | `~/.harmony/download-switch.json` |
| The `harmony` marketplace entry | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) |
| Your original settings | `settings.json.before-harmony-download`, beside the settings file |
| The install, and today's copy disabled for your user | Claude Code's own plugin state |

If `HARMONY_CONFIG_DIR` is set, read `~/.harmony` above as that directory.
