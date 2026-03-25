# harmony-plugin

Harmony project management integration for Claude Code. Provides MCP tools for interacting with Harmony tasks, projects, and workflows, plus two workflow skills (`start-work` and `finish-work`) that automate the full development lifecycle.

## What's included

### MCP Server

A stdio-based MCP server that gives Claude Code direct access to Harmony:

- Query, create, and update tasks
- Manage labels, comments, and activity history
- Work with projects, documents, cycles, and milestones
- Bulk operations on tasks

### Workflow Skills

- **start-work** — Begin a piece of work: find/create the Harmony task, move it to In Progress, create an isolated git worktree, and recommend an execution route
- **finish-work** — Land completed work: verify readiness, rebase, squash merge, clean up the worktree, and move the task to Done

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [superpowers plugin](https://github.com/anthropics/claude-plugins-official) installed (used by workflow skills)
- A Harmony account with an API token

## Installation

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
   /setup
   ```

   This saves the token to `.claude/settings.local.json` (gitignored) and verifies the connection.

4. Restart Claude Code one more time for the MCP server to pick up the token.

To receive automatic updates, run `/plugin`, go to the **Marketplaces** tab, select **ycomplex**, and enable **auto-update**.

### For development

```bash
git clone git@github.com:ycomplex/harmony-plugin.git
claude --plugin-dir ./harmony-plugin
```

### Manual token configuration

If you prefer to set the token without `/setup`:

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

## How it works

The plugin's `SessionStart` hook automatically installs dependencies and builds the TypeScript MCP server on first use. Subsequent sessions skip the build if `dist/index.js` already exists.

The MCP server starts automatically when the plugin is enabled and provides tools prefixed with `mcp__harmony__` (e.g., `mcp__harmony__get_task`).

## Development

```bash
npm install        # Install dependencies
npm run build      # Compile TypeScript
npm run dev        # Watch mode
npx tsc --noEmit   # Type-check without emitting
```

Note: This project uses Node16 module resolution. All imports must use `.js` extensions.

## License

MIT
