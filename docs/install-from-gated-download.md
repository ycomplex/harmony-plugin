# Installing the Harmony plugin from Harmony's download

**Who this is for:** a machine with no Harmony plugin yet. If today's plugin is already installed from the
`ycomplex` marketplace (`harmony-plugin@ycomplex`), use [`switch-to-gated-download.md`](switch-to-gated-download.md)
instead.

**macOS and Linux only.** The installer and the small helper Claude Code runs for each download are POSIX `sh`.
Windows is not supported.

The plugin comes from Harmony's download address, `https://plugin.harmony.ad`, which serves it only to a valid
Harmony API token.

## Before you start

- **Claude Code** installed (`claude --version` works).
- **`node`** on your PATH (`node --version` works). Claude Code also needs to find it when it runs the helper; see
  [If Claude Code cannot find node](#if-claude-code-cannot-find-node).
- **`curl`** and **`unzip`**.
- A **SHA-256 tool**: `sha256sum` (Linux) or `shasum` (macOS).
- A **Harmony API token**: in Harmony, open the project's **Project Settings → Connect AI**. A token reaches only
  the project it was made for.

## The one command

```bash
curl -fsSL https://plugin.harmony.ad/install.sh | sh
```

To read it first:

```bash
curl -fsSLO https://plugin.harmony.ad/install.sh
sh install.sh
```

## What it asks and does, in order

1. It asks for your Harmony API token. What you type is not shown.
2. It downloads the plugin's zip from the download with that token, checks its SHA-256, and unzips it.
3. It runs the plugin's own command line from the unzipped copy, `harmony download install`, handing it the token on
   standard input (never as a command argument). That command:
   1. checks your Claude Code settings file can be read, and stops before anything else if it cannot;
   2. checks the token with the download (`GET https://plugin.harmony.ad/prod/marketplace.json`, expecting 200), and
      stops, changing nothing, if the download refuses it;
   3. checks the token with Harmony and stores it in `~/.harmony/config.json` under the project's name. It never
      overwrites a different project stored under the same name: it picks another name and tells you which. It
      never changes which project your terminal commands use (the active project), even on a machine with none:
      it tells you to run `harmony project switch <name>` if you want terminal commands outside a session to use it;
   4. pins that project for the download (`downloadProject` in the same file);
   5. writes the helper `~/.harmony/download-headers.sh` (readable only by you). Claude Code runs it for each
      download to get the header that carries your token. It holds no token; it reads the pinned project's token
      from `~/.harmony/config.json`;
   6. adds a `harmony` entry under `extraKnownMarketplaces` in `~/.claude/settings.json` (or the `settings.json` in
      `CLAUDE_CONFIG_DIR`), keeping everything else, after saving the original beside it as
      `settings.json.before-harmony-download`;
   7. starts Claude Code once in the background, with no prompt and from an empty temporary folder, so it fetches
      the marketplace (this sends nothing to the model), then installs `harmony-plugin@harmony`;
   8. disables `harmony-plugin@ycomplex` for your user if it is there (on a new machine it is not, and that is fine).

   It exits 0 when done, 1 when it refused or failed (the message says which), and 2 when you need to act first. On 2
   after "Claude Code has not fetched the Harmony marketplace yet": open Claude Code once, wait for the prompt,
   `/exit`, then run the one command again (your token is already stored and pinned; it asks for it again, finds
   everything in place and finishes). The `harmony` command does not exist yet at that point: the plugin is not
   installed.
4. Then start a **fresh** Claude Code session in a project and run `/harmony-setup`. It points that project at a
   stored project by writing `HARMONY_PROJECT` to the project's `.claude/settings.local.json`; it never writes the
   token there.

Check it: `claude plugin list` shows `harmony-plugin@harmony` enabled, and in a fresh session `harmony --version`
prints the version it lists. `harmony download status` shows which project the download uses (names only).

## Running `harmony` before a session has started

The `harmony` command reaches your PATH when a Claude Code session starts with the plugin installed (the plugin's
start-up hook links it). Right after the installer finishes, before you have started a session, a terminal does not
know `harmony` yet. For the commands in the sections below, either start Claude Code once (open it, wait for the
prompt, `/exit`) and open a new terminal, or run the plugin's own copy by its full path:

```bash
ls ~/.claude/plugins/cache/harmony/harmony-plugin/          # the installed version, e.g. 0.17.70
node ~/.claude/plugins/cache/harmony/harmony-plugin/<version>/dist/bin/harmony.js download status
```

With `CLAUDE_CONFIG_DIR` set, read `~/.claude` above as that directory.

## Where your token lives

- In `~/.harmony/config.json` (mode 600), one entry per project, each with the project's id. Nowhere else: no copy
  goes into any repository, the helper holds none, and the record `~/.harmony/download-switch.json` holds none.
- `downloadProject` in that file names the one project whose token the download uses. Your terminal's active
  project is separate; pinning never changes it.
- If `HARMONY_CONFIG_DIR` is set, read `~/.harmony` above as that directory.

## When your token changes or is revoked

```bash
harmony download token set               # give the new token (stdin, or a prompt that does not show it)
harmony download token use <project>     # or pin a project already stored (see: harmony project list)
```

Both check the token with the download before pinning it, and rewrite the helper. While the pinned token is refused,
update checks fail, but the plugin you have installed keeps working. A project that uses the token in its sessions
needs the new token stored under the name it names in `HARMONY_PROJECT`; `harmony download token set` prints that
name.

## Which project a session uses

The plugin, in Claude Code and in a terminal, picks its project in this order:

1. `HARMONY_API_TOKEN`, if it is set in the environment: that token.
2. Otherwise `HARMONY_PROJECT`, if it is set: the project stored under that name in `~/.harmony/config.json`, with
   the Supabase address it was stored with. If `HARMONY_SUPABASE_URL` or its key in the environment says a
   different backend, it refuses, naming both addresses, rather than send the token there.
3. Otherwise, for terminal commands only, the active project (`harmony project switch`).

When the environment overrides a different active project, terminal commands say so once on stderr.
`harmony whoami` says which applies in your shell, and why. The download is separate: it uses only its pinned
project.

## If Claude Code cannot find node

The helper reads your stored token with `node`. Claude Code runs it with the PATH of your login shell, which can
differ from your terminal's (for example when node comes from a version manager set up only in an interactive
shell).

What you see: refreshing the marketplace fails (for example `claude plugin marketplace update harmony`, or the
background update) with the helper's message, `harmony: node is not on the PATH Claude Code gave this helper, so it
cannot read the pinned token in …`.

What to do: make `node` available in your login shell, for example by adding the directory the installer printed
for node to `PATH` in `~/.zprofile` or `~/.profile`. Open a new terminal, then run:

```bash
claude plugin marketplace update harmony
```

## Going back

```bash
harmony download switch --undo
```

It removes the `harmony` marketplace (which uninstalls `harmony-plugin@harmony`), deletes the helper and its record,
and leaves your stored token and the settings backup alone. See
[`switch-to-gated-download.md`](switch-to-gated-download.md#going-back).
