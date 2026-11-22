# Harmony

Tools for [Harmony](https://github.com/ycomplex/harmony-web) project management — a CLI for your terminal and an MCP server plugin for [Claude Code](https://claude.ai/claude-code).

## CLI

Manage your Harmony tasks, epics, milestones, and more from the terminal.

### Install

The CLI comes with the Claude Code plugin: installing the plugin (see [Installation](#installation)
below) puts `harmony` on your PATH. It is not published to npm.

### Quick start

```bash
# Log in with your API token
harmony login --token <your-api-token>

# List tasks
harmony tasks list

# Get a specific task
harmony tasks get B-42

# Create a task
harmony tasks create --title "Fix login bug" --priority high --status "To Do"

# Update a task
harmony tasks update B-42 --status "In Progress"

# JSON output for scripting
harmony tasks list --json
```

### Commands

| Command | Description |
|---------|-------------|
| `harmony login` | Add a project (provide API token) |
| `harmony logout <name>` | Remove a project |
| `harmony projects` | List logged-in projects |
| `harmony project info` | Show current project details |
| `harmony project switch <name>` | Switch active project |
| `harmony tasks list\|get\|create\|update` | Task CRUD |
| `harmony tasks query` | Advanced search with filters |
| `harmony tasks comments\|comment` | View/add comments |
| `harmony tasks bulk-create\|bulk-update` | Bulk operations |
| `harmony epics list\|create\|update` | Manage epics |
| `harmony labels list\|create\|manage` | Manage labels |
| `harmony milestones list\|create\|update\|ship` | Manage milestones |
| `harmony cycles list\|create\|update` | Manage cycles |
| `harmony subtasks list\|add\|update\|delete` | Manage subtasks |
| `harmony ac list\|add\|update\|delete` | Acceptance criteria |
| `harmony tests list\|add\|update\|delete` | Test cases |
| `harmony docs list\|get\|create\|update` | Project documents |
| `harmony members list` | List workspace members |
| `harmony activity <task-id>` | Task activity timeline |

### Multi-project support

Log in to multiple projects and switch between them:

```bash
harmony login --token <token-a>
harmony login --token <token-b> --name my-other-project
harmony projects          # see all, * marks active (same as harmony project list)
harmony project switch my-other-project
harmony whoami            # which project this shell uses, and why
```

Config is stored in `~/.harmony/config.json`, one entry per project. Which project a command uses:
`HARMONY_API_TOKEN` in the environment first, then `HARMONY_PROJECT` (the name of a stored project),
then the active project. When the environment overrides a different active project, the CLI says so
once on stderr.

### Output modes

- **Text** (default): formatted tables with color
- **JSON** (`--json`): machine-readable output for scripting and piping

## Claude Code Plugin

This package also serves as a Claude Code plugin, providing an MCP server and workflow skills.

### What's included

**MCP Server** — gives Claude Code direct access to Harmony:

- Query, create, and update tasks
- Manage labels, comments, and activity history
- Work with projects, documents, cycles, and milestones
- Bulk operations on tasks

**Workflow Skills:**

- **start-work** — Begin a piece of work: find/create the Harmony task, move it to In Progress, create an isolated git worktree, and recommend an execution route
- **finish-work** — Land completed work: verify readiness, rebase, squash merge, clean up the worktree, and move the task to Done

### Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [superpowers plugin](https://github.com/anthropics/claude-plugins-official) installed (used by workflow skills)
- A Harmony account with an API token

### Installation

macOS and Linux (the installer and the download helper are POSIX `sh`; Windows is not supported). You
need Claude Code, `node` on your PATH, `curl`, `unzip` and a SHA-256 tool (`sha256sum` or `shasum`).

1. Get a Harmony API token: in Harmony, open the project's **Project Settings → Connect AI**.

2. Run the installer and paste the token when it asks:

   ```bash
   curl -fsSL https://plugin.harmony.ad/install.sh | sh
   ```

   Or download it, read it, then run it:

   ```bash
   curl -fsSLO https://plugin.harmony.ad/install.sh
   sh install.sh
   ```

   It downloads the plugin from Harmony's gated download, checks your token, stores it in
   `~/.harmony/config.json` (no copy goes into any repository), pins it for the download, and installs
   `harmony-plugin@harmony` in Claude Code. Updates then arrive automatically.

3. Start a fresh Claude Code session in your project and run `/harmony-setup` to point that project at
   the stored token (it writes `HARMONY_PROJECT`, never a token, to `.claude/settings.local.json`).

What each step does, what to do when the token changes, and what to do when Claude Code cannot find
`node`: [`docs/install-from-gated-download.md`](docs/install-from-gated-download.md).

**Already installed from the public `ycomplex` marketplace?** Move to the gated download with
`harmony download switch` (and back with `harmony download switch --undo`):
[`docs/switch-to-gated-download.md`](docs/switch-to-gated-download.md).

### Manual token configuration

`/harmony-setup` is the usual route. By hand: store the token once with
`harmony login --no-activate --token <token>`, which prints the name it is stored under, then name that
project in your project's `.claude/settings.local.json` (gitignored):

```json
{
  "env": {
    "HARMONY_PROJECT": "my-project"
  }
}
```

`HARMONY_API_TOKEN` still works (in `.envrc`, a shell profile or that `env` block) and wins over
`HARMONY_PROJECT` and the active project, but it puts a copy of the token where you set it.

### How it works

A marketplace install ships `dist/` prebuilt, so the MCP server is ready on the first session. The plugin's `SessionStart` hook builds it only when `dist/index.js` is missing, which happens on a source checkout loaded with `claude --plugin-dir` (see [Development](#development)).

The MCP server starts automatically when the plugin is enabled and provides tools prefixed with `mcp__harmony__` (e.g., `mcp__harmony__get_task`).

## Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npm test           # Run tests
npx tsc --noEmit   # Type-check without emitting
```

Note: This project uses Node16 module resolution. All imports must use `.js` extensions.

## License

The Harmony plugin is proprietary software of YCOMPLEX LTD. Use requires a license (an active Harmony account or a written agreement); see LICENSE.
