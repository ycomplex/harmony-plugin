# Worker git guard and credential locations (B-1451)

A worker leg must never push a credential, and must never push to the plugin's release branches.
B-1451 was the incident that showed both could happen: the Claude Figma server config, with the
access token in its header, was written into the plugin checkout's `.mcp.json`, where any commit and
push from that checkout would carry it. This page describes what now prevents that, and its limits.

## What runs at leg start

`container/provision.sh`, in the headless branch, before the first agent launch:

1. **Figma is configured outside every checkout, and never fatally.** `harmony figma install-worker`
   checks the token with one `initialize` request to the Figma MCP server (5-second timeout):
   - HTTP 401 or 403: nothing is configured and the leg runs without Figma. One line says so.
   - A network error, a timeout or a 5xx: Figma is configured as optional. One line says so.
   - Any other failure: one line, exit 0, the leg runs without Figma.

   For Claude Code it writes `$HOME/.harmony/figma-mcp.json` (directory 0700, file 0600) and
   refuses to write it inside a git work tree. The file's header names the variable
   `FIGMA_MCP_ACCESS_TOKEN` rather than holding the token: Claude Code 2.1.322 expands `${VAR}` in an
   http server's headers (tested against a local listener for both a project `.mcp.json` and
   `--mcp-config`). `provision.sh` exports `HARMONY_FIGMA_MCP_CONFIG` only when the file was written,
   and `harmony agent argv` then adds `--mcp-config <path>` to the Claude launch line. The
   `--plugin-dir` flag is still accepted but nothing is written there. For Codex the
   `[mcp_servers.figma]` block in `$CODEX_HOME/config.toml` names the same variable and is now
   `required = false`.
2. **The push guard is installed** (`container/git-guard/install.sh`): the wrapper goes to
   `$HOME/bin/git`, ahead of the real git on `PATH`, and the hook to `$HOME/.harmony/git-guard/hooks`.
   The dogfood shell installs it too.
3. **The plugin code checkout is detached** and its local `staging`, `prod` and `main` branches are
   deleted.
4. **A dirty plugin checkout stops the leg** (`container/git-guard/dirty-check.sh`): if
   `git status --porcelain` lists anything, one line names the paths (never their contents) and the
   leg exits 1. This runs once, before the first launch; relaunches, resumes and model handoffs inside
   the leg do not repeat it.

## The push-only wrapper

The wrapper skips git's global options (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager` and
the rest, spaced or `=` forms) to find the subcommand. Only when that is exactly `push` does it run
`git -c core.hooksPath=<guard-home>/hooks push ...`; every other command, and anything it cannot
classify, reaches the real git unchanged through `exec`, so arguments, exit codes, stdin and the
terminal are untouched. The real git is resolved to an absolute path at install time.

No global `core.hooksPath` is set. A global setting would replace every repository's own hooks
(pre-commit, commit-msg, husky) on every command; scoping it to `push` leaves all of those alone.

## The three refusals

The pre-push hook prints one line per refusal, prefixed `B-1451 push guard:`, and exits 1 when:

1. The push updates or deletes `refs/heads/staging`, `refs/heads/prod` or `refs/heads/main`.
2. The push runs from the main worktree of the plugin code checkout recorded at install time. A
   linked worktree of that checkout passes; that is where plugin work belongs.
3. An added line in the commits being pushed has the shape of a credential: a Figma token, a GitHub
   token, a fine-grained GitHub token, an OpenAI-style key, a JWT, a Supabase secret key or a Harmony
   API token (B-1305). The range is the commits after the
   remote's old tip, or, for a new branch, those not on any remote-tracking branch. The refusal names
   the file, the line in the new file, the commit and the pattern name, never the matched text.
   Removed lines are not scanned.

## Chaining

When the guard passes it runs the repository's own pre-push hook, if one exists and is executable:
the local `core.hooksPath` (a relative path is resolved against the work tree root, as with husky's
`.husky/_`), else `<git-common-dir>/hooks/pre-push`. It gets the same arguments and the same input,
and its exit status becomes the push's. The guard's hooks directory holds only `pre-push`, so no
other hook of the repository is masked during a push.

## Limits

- `git push --no-verify` skips the guard, and so does calling the real git by its absolute path.
- During a guarded push the repository's own hooks other than `pre-push` (for example a
  `reference-transaction` hook) do not run, since `core.hooksPath` points at the guard's directory.
- The guard is a seatbelt for mistakes. Only GitHub-side rules (branch protection, rulesets, push
  protection) stop a deliberate push.

## Where worker credentials live

| Credential | Location |
|---|---|
| Figma, Claude Code | `$HOME/.harmony/figma-mcp.json`, header refers to `FIGMA_MCP_ACCESS_TOKEN` in the environment |
| Figma, Codex | `$CODEX_HOME/config.toml`, `bearer_token_env_var = "FIGMA_MCP_ACCESS_TOKEN"` |
| Codex access token | `$CODEX_HOME/auth.json` (B-1306) |
| OpenRouter key | environment only (B-1178) |
| GitHub | `GIT_TOKEN` in the environment, read through `GIT_ASKPASS`; never in `.git/config` |

None of these is inside a repository checkout.

## Propagation

Every file here runs from the worker's clone of the plugin's `staging` branch, so the change is live
for legs launched about a minute after a merge regenerates `staging`. The worker image and the
conductor image are unchanged, and no conductor Update is needed.
