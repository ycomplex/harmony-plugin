# Harmony

Tools for [Harmony](https://github.com/ycomplex/harmony-web) project management — a CLI for your terminal and an MCP server plugin for [Claude Code](https://claude.ai/claude-code).

## CLI

Manage your Harmony tasks, epics, milestones, and more from the terminal.

### Install

```bash
npm install -g @harmony-ad/harmony
```

Or run directly with npx:

```bash
npx @harmony-ad/harmony --help
```

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
harmony projects          # see all, * marks active
harmony project switch my-other-project
```

Config is stored in `~/.harmony/config.json`.

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

1. Inside Claude Code, add the marketplace and install the plugin:

   ```
   /plugin marketplace add ycomplex/harmony-plugin
   /plugin install harmony-plugin@ycomplex
   ```

2. Restart Claude Code for the hooks and MCP server to take effect:

   ```
   /exit
   ```

   Then start `claude` again. On first startup, the plugin automatically installs dependencies and builds the MCP server (~10 seconds).

3. Configure your API token:

   ```
   /harmony-setup
   ```

   This saves the token to `.claude/settings.local.json` (gitignored) and verifies the connection.

4. Restart Claude Code one more time for the MCP server to pick up the token.

To receive automatic updates, run `/plugin`, go to the **Marketplaces** tab, select **ycomplex**, and enable **auto-update**.

### Manual token configuration

If you prefer to set the token without `/harmony-setup`:

**direnv** — Create `.envrc` in your project root:
```bash
export HARMONY_API_TOKEN="hmy_your_token_here"
```

**Claude Code settings** — Create `.claude/settings.local.json` in your project root:
```json
{
  "env": {
    "HARMONY_API_TOKEN": "hmy_your_token_here"
  }
}
```

**Shell profile** — Add `export HARMONY_API_TOKEN="hmy_your_token_here"` to `~/.zshrc` or `~/.bashrc`.

### How it works

The plugin's `SessionStart` hook automatically installs dependencies and builds the TypeScript MCP server on first use. Subsequent sessions skip the build if `dist/index.js` already exists.

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

MIT
