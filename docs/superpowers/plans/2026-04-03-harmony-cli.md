# Harmony CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CLI (`harmony`) to the plugin repo that mirrors the MCP server's full functionality, with text and JSON output modes and multi-project auth.

**Architecture:** The existing MCP tool handlers already return plain data objects — they are the shared core. The CLI imports them directly. MCP wraps results in `{ content: [{ type: 'text' }] }`; CLI formats them as tables or JSON. A new config system in `~/.harmony/` manages multi-project auth with stored API tokens.

**Tech Stack:** TypeScript, Commander.js (CLI framework), chalk (colors), cli-table3 (tables). Shares existing Supabase client + auth code.

---

## File Structure

```
src/
  tools/                          # EXISTING — handlers stay here, they ARE the core
    tasks.ts                      # (no changes needed)
    query-tasks.ts                # (no changes needed)
    comments.ts                   # (no changes needed)
    ...etc                        # All existing tool files unchanged
  cli/
    index.ts                      # CLI entry point — commander setup, global --json flag
    config.ts                     # ~/.harmony/ config management (read/write/switch projects)
    auth.ts                       # CLI auth — wraps HarmonyAuth with config-based token
    formatter.ts                  # Output formatting — text tables vs JSON
    commands/
      tasks.ts                    # harmony tasks list|get|create|update
      query.ts                    # harmony tasks query
      comments.ts                 # harmony tasks comments|comment
      epics.ts                    # harmony epics list|create|update
      labels.ts                   # harmony labels list|create|manage
      milestones.ts               # harmony milestones list|create|update|ship
      cycles.ts                   # harmony cycles list|create|update
      project.ts                  # harmony project info|switch
      members.ts                  # harmony members list
      activity.ts                 # harmony activity
      docs.ts                     # harmony docs list|get|create|update
      subtasks.ts                 # harmony subtasks list|manage
      acceptance-criteria.ts      # harmony ac list|manage
      test-cases.ts               # harmony tests list|manage
      bulk.ts                     # harmony tasks bulk-create|bulk-update
      auth.ts                     # harmony login|logout|projects
  bin/
    harmony.ts                    # Shebang entry point — imports cli/index.ts
```

**What does NOT change:** Every file in `src/tools/` stays exactly as-is. The handlers already take `(client, projectId, userId, args)` and return data. The MCP server entry point (`src/index.ts`) stays as-is. Tests in `src/tools/*.test.ts` stay as-is.

---

### Task 1: Package setup — rename, add dependencies, configure bin entry

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (via npm install)
- Modify: `tsconfig.json`

- [ ] **Step 1: Update package.json**

```json
{
  "name": "@harmony/cli",
  "version": "0.2.0",
  "description": "Harmony CLI and MCP server for project management",
  "type": "module",
  "bin": {
    "harmony-mcp": "./dist/index.js",
    "harmony": "./dist/bin/harmony.js"
  },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@supabase/supabase-js": "^2.98.0",
    "chalk": "^5.4.1",
    "cli-table3": "^0.6.5",
    "commander": "^13.1.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/cli-table3": "^0.6.0",
    "eslint": "^10.1.0",
    "globals": "^17.4.0",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.57.2",
    "vitest": "^4.1.1"
  }
}
```

Changes from current: renamed to `@harmony/cli`, bumped to `0.2.0`, added `harmony` bin entry, added `chalk`, `cli-table3`, `commander` dependencies, added `@types/cli-table3` dev dependency.

- [ ] **Step 2: Update tsconfig.json to include bin/ directory**

The current tsconfig likely only includes `src/`. Verify it covers `src/bin/` and `src/cli/` — since they're under `src/`, they should already be included. If `rootDir` is set, ensure it's `src/`. Check that `outDir` is `dist/` so `src/bin/harmony.ts` compiles to `dist/bin/harmony.js`.

Read the current `tsconfig.json` and verify. If `rootDir` is `"src"` and `outDir` is `"dist"`, no changes are needed — `src/bin/` and `src/cli/` will be included automatically.

- [ ] **Step 3: Install dependencies**

Run: `npm install`
Expected: Installs chalk, cli-table3, commander. Lock file updated.

- [ ] **Step 4: Run existing tests to verify nothing is broken**

Run: `npm test`
Expected: All 72 tests pass. Package rename has no effect on behavior.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json
git commit -m "feat: rename to @harmony/cli and add CLI dependencies"
```

---

### Task 2: Config system — ~/.harmony/ multi-project configuration

**Files:**
- Create: `src/cli/config.ts`
- Create: `src/cli/config.test.ts`

The config file at `~/.harmony/config.json` stores multiple project profiles:

```json
{
  "activeProject": "backlogs",
  "projects": {
    "backlogs": {
      "name": "backlogs",
      "token": "hmy_abc123...",
      "supabaseUrl": "https://xxx.supabase.co",
      "supabaseAnonKey": "eyJ..."
    },
    "other-project": {
      "name": "other-project",
      "token": "hmy_def456...",
      "supabaseUrl": "https://yyy.supabase.co",
      "supabaseAnonKey": "eyJ..."
    }
  }
}
```

`supabaseUrl` and `supabaseAnonKey` are optional — they default to the hardcoded values in `src/supabase.ts` (the production Harmony instance). Only needed if pointing at a different Supabase project.

- [ ] **Step 1: Write failing tests for config**

```typescript
// src/cli/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadConfig,
  saveConfig,
  getActiveProject,
  addProject,
  removeProject,
  switchProject,
  listProjects,
  CONFIG_DIR,
  CONFIG_FILE,
} from './config.js';

// Use a temp dir for tests to avoid touching real ~/.harmony
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harmony-test-'));
  vi.stubEnv('HARMONY_CONFIG_DIR', tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns empty config when no file exists', () => {
    const config = loadConfig();
    expect(config).toEqual({ activeProject: null, projects: {} });
  });

  it('reads existing config file', () => {
    const existing = {
      activeProject: 'my-proj',
      projects: { 'my-proj': { name: 'my-proj', token: 'tok' } },
    };
    fs.mkdirSync(path.join(tmpDir), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify(existing),
    );
    const config = loadConfig();
    expect(config.activeProject).toBe('my-proj');
    expect(config.projects['my-proj'].token).toBe('tok');
  });
});

describe('addProject', () => {
  it('adds a project and sets it as active', () => {
    addProject('demo', 'tok123');
    const config = loadConfig();
    expect(config.activeProject).toBe('demo');
    expect(config.projects['demo']).toEqual({ name: 'demo', token: 'tok123' });
  });

  it('overwrites an existing project with the same name', () => {
    addProject('demo', 'old-tok');
    addProject('demo', 'new-tok');
    const config = loadConfig();
    expect(config.projects['demo'].token).toBe('new-tok');
  });
});

describe('removeProject', () => {
  it('removes a project', () => {
    addProject('demo', 'tok');
    removeProject('demo');
    const config = loadConfig();
    expect(config.projects['demo']).toBeUndefined();
  });

  it('clears activeProject if the removed project was active', () => {
    addProject('demo', 'tok');
    removeProject('demo');
    const config = loadConfig();
    expect(config.activeProject).toBeNull();
  });

  it('throws if the project does not exist', () => {
    expect(() => removeProject('ghost')).toThrow('not found');
  });
});

describe('switchProject', () => {
  it('switches the active project', () => {
    addProject('a', 'tok-a');
    addProject('b', 'tok-b');
    switchProject('a');
    const config = loadConfig();
    expect(config.activeProject).toBe('a');
  });

  it('throws if the project does not exist', () => {
    expect(() => switchProject('ghost')).toThrow('not found');
  });
});

describe('getActiveProject', () => {
  it('returns the active project config', () => {
    addProject('demo', 'tok');
    const proj = getActiveProject();
    expect(proj).toEqual({ name: 'demo', token: 'tok' });
  });

  it('throws if no active project', () => {
    expect(() => getActiveProject()).toThrow('No active project');
  });
});

describe('listProjects', () => {
  it('returns all projects with active flag', () => {
    addProject('a', 'tok-a');
    addProject('b', 'tok-b');
    const list = listProjects();
    expect(list).toEqual([
      { name: 'a', active: false },
      { name: 'b', active: true },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/cli/config.test.ts`
Expected: FAIL — module `./config.js` does not exist

- [ ] **Step 3: Implement config module**

```typescript
// src/cli/config.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ProjectConfig {
  name: string;
  token: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export interface HarmonyConfig {
  activeProject: string | null;
  projects: Record<string, ProjectConfig>;
}

function getConfigDir(): string {
  return process.env.HARMONY_CONFIG_DIR ?? path.join(os.homedir(), '.harmony');
}

function getConfigFile(): string {
  return path.join(getConfigDir(), 'config.json');
}

export const CONFIG_DIR = getConfigDir();
export const CONFIG_FILE = getConfigFile();

export function loadConfig(): HarmonyConfig {
  const file = getConfigFile();
  if (!fs.existsSync(file)) {
    return { activeProject: null, projects: {} };
  }
  const raw = fs.readFileSync(file, 'utf-8');
  return JSON.parse(raw) as HarmonyConfig;
}

export function saveConfig(config: HarmonyConfig): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

export function addProject(name: string, token: string, opts?: { supabaseUrl?: string; supabaseAnonKey?: string }): void {
  const config = loadConfig();
  config.projects[name] = { name, token, ...opts };
  config.activeProject = name;
  saveConfig(config);
}

export function removeProject(name: string): void {
  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Project "${name}" not found in config.`);
  }
  delete config.projects[name];
  if (config.activeProject === name) {
    const remaining = Object.keys(config.projects);
    config.activeProject = remaining.length > 0 ? remaining[0] : null;
  }
  saveConfig(config);
}

export function switchProject(name: string): void {
  const config = loadConfig();
  if (!config.projects[name]) {
    throw new Error(`Project "${name}" not found in config. Run \`harmony login\` first.`);
  }
  config.activeProject = name;
  saveConfig(config);
}

export function getActiveProject(): ProjectConfig {
  const config = loadConfig();
  if (!config.activeProject || !config.projects[config.activeProject]) {
    throw new Error('No active project. Run `harmony login` to add one.');
  }
  return config.projects[config.activeProject];
}

export function listProjects(): Array<{ name: string; active: boolean }> {
  const config = loadConfig();
  return Object.keys(config.projects).map((name) => ({
    name,
    active: name === config.activeProject,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/cli/config.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing + new config tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli/config.ts src/cli/config.test.ts
git commit -m "feat: add ~/.harmony config system for multi-project auth"
```

---

### Task 3: CLI auth bridge — connect config to existing HarmonyAuth

**Files:**
- Create: `src/cli/auth.ts`

This module reads the active project's token from config and creates an authenticated Supabase client, reusing the existing `HarmonyAuth` and `createAuthenticatedClient` from the MCP server code.

- [ ] **Step 1: Implement CLI auth bridge**

```typescript
// src/cli/auth.ts
import { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getActiveProject, ProjectConfig } from './config.js';

export interface AuthenticatedContext {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}

export async function getAuthenticatedContext(projectConfig?: ProjectConfig): Promise<AuthenticatedContext> {
  const project = projectConfig ?? getActiveProject();

  // Set env vars if the project has custom Supabase config
  if (project.supabaseUrl) {
    process.env.HARMONY_SUPABASE_URL = project.supabaseUrl;
  }
  if (project.supabaseAnonKey) {
    process.env.HARMONY_SUPABASE_ANON_KEY = project.supabaseAnonKey;
  }

  const auth = new HarmonyAuth(project.token);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();
  const userId = auth.getUserId();

  return { client, projectId, userId };
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npx tsc --noEmit`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/auth.ts
git commit -m "feat: add CLI auth bridge connecting config to HarmonyAuth"
```

---

### Task 4: Output formatter — text tables and JSON mode

**Files:**
- Create: `src/cli/formatter.ts`
- Create: `src/cli/formatter.test.ts`

- [ ] **Step 1: Write failing tests for formatter**

```typescript
// src/cli/formatter.test.ts
import { describe, it, expect } from 'vitest';
import { formatTable, formatDetail, formatOutput } from './formatter.js';

describe('formatOutput', () => {
  it('returns JSON string when json=true', () => {
    const data = { id: '1', title: 'Test' };
    const result = formatOutput(data, { json: true });
    expect(result).toBe(JSON.stringify(data, null, 2));
  });
});

describe('formatTable', () => {
  it('formats an array of objects as a table string', () => {
    const data = [
      { id: '1', title: 'Task A', status: 'To Do' },
      { id: '2', title: 'Task B', status: 'Done' },
    ];
    const result = formatTable(data, [
      { key: 'id', header: 'ID' },
      { key: 'title', header: 'Title' },
      { key: 'status', header: 'Status' },
    ]);
    expect(result).toContain('Task A');
    expect(result).toContain('Task B');
    expect(result).toContain('To Do');
    expect(result).toContain('Done');
    expect(result).toContain('ID');
    expect(result).toContain('Title');
  });

  it('returns "No results." for empty array', () => {
    const result = formatTable([], [{ key: 'id', header: 'ID' }]);
    expect(result).toBe('No results.');
  });
});

describe('formatDetail', () => {
  it('formats key-value pairs vertically', () => {
    const result = formatDetail([
      { label: 'Title', value: 'My Task' },
      { label: 'Status', value: 'In Progress' },
    ]);
    expect(result).toContain('Title');
    expect(result).toContain('My Task');
    expect(result).toContain('Status');
    expect(result).toContain('In Progress');
  });

  it('handles null/undefined values as empty string', () => {
    const result = formatDetail([
      { label: 'Due', value: null },
    ]);
    expect(result).toContain('Due');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/cli/formatter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement formatter**

```typescript
// src/cli/formatter.ts
import Table from 'cli-table3';
import chalk from 'chalk';

export interface ColumnDef {
  key: string;
  header: string;
  width?: number;
  transform?: (value: any, row: any) => string;
}

export function formatOutput(data: any, opts: { json: boolean }, textFn?: () => string): string {
  if (opts.json) {
    return JSON.stringify(data, null, 2);
  }
  return textFn ? textFn() : JSON.stringify(data, null, 2);
}

export function formatTable(rows: any[], columns: ColumnDef[]): string {
  if (rows.length === 0) return 'No results.';

  const table = new Table({
    head: columns.map((c) => chalk.bold(c.header)),
    ...(columns.some((c) => c.width) ? { colWidths: columns.map((c) => c.width ?? null) } : {}),
    style: { head: [], border: [] },
    wordWrap: true,
  });

  for (const row of rows) {
    table.push(
      columns.map((col) => {
        const raw = row[col.key];
        if (col.transform) return col.transform(raw, row);
        return raw?.toString() ?? '';
      }),
    );
  }

  return table.toString();
}

export function formatDetail(fields: Array<{ label: string; value: any }>): string {
  const table = new Table({
    style: { head: [], border: [] },
  });

  for (const { label, value } of fields) {
    table.push({ [chalk.bold(label)]: value?.toString() ?? '' });
  }

  return table.toString();
}

// Helpers for common formatting patterns

export function formatPriority(priority: string): string {
  switch (priority) {
    case 'high': return chalk.red(priority);
    case 'medium': return chalk.yellow(priority);
    case 'low': return chalk.green(priority);
    default: return priority;
  }
}

export function formatStatus(status: string): string {
  switch (status) {
    case 'Done': return chalk.green(status);
    case 'In Progress': return chalk.blue(status);
    case 'In Review': return chalk.magenta(status);
    case 'To Do': return chalk.yellow(status);
    case 'Backlog': return chalk.gray(status);
    default: return status;
  }
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/cli/formatter.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/formatter.ts src/cli/formatter.test.ts
git commit -m "feat: add CLI output formatter with table and JSON modes"
```

---

### Task 5: CLI entry point and bin shebang

**Files:**
- Create: `src/bin/harmony.ts`
- Create: `src/cli/index.ts`

- [ ] **Step 1: Create the bin entry point**

```typescript
// src/bin/harmony.ts
#!/usr/bin/env node
import '../cli/index.js';
```

Note: The shebang will be on the first line. TypeScript will preserve it in the output.

Actually, TypeScript strips shebangs. We need a different approach — use a plain JS wrapper or add the shebang post-build. The simplest: make the bin entry a plain `.js` file that isn't compiled.

Instead, update the approach: put the shebang in the TS file. TypeScript 5.x preserves shebangs in output. Verify this works during testing.

- [ ] **Step 2: Create the CLI entry point with Commander**

```typescript
// src/cli/index.ts
import { Command } from 'commander';
import { registerTaskCommands } from './commands/tasks.js';
import { registerQueryCommand } from './commands/query.js';
import { registerCommentCommands } from './commands/comments.js';
import { registerEpicCommands } from './commands/epics.js';
import { registerLabelCommands } from './commands/labels.js';
import { registerMilestoneCommands } from './commands/milestones.js';
import { registerCycleCommands } from './commands/cycles.js';
import { registerProjectCommands } from './commands/project.js';
import { registerMemberCommands } from './commands/members.js';
import { registerActivityCommand } from './commands/activity.js';
import { registerDocCommands } from './commands/docs.js';
import { registerSubtaskCommands } from './commands/subtasks.js';
import { registerAcceptanceCriteriaCommands } from './commands/acceptance-criteria.js';
import { registerTestCaseCommands } from './commands/test-cases.js';
import { registerBulkCommands } from './commands/bulk.js';
import { registerAuthCommands } from './commands/auth.js';

const program = new Command();

program
  .name('harmony')
  .description('Harmony project management CLI')
  .version('0.2.0')
  .option('--json', 'Output results as JSON', false);

// Auth commands (top-level: harmony login, harmony logout, harmony projects)
registerAuthCommands(program);

// Project commands (harmony project info|switch)
registerProjectCommands(program);

// Task commands (harmony tasks list|get|create|update)
registerTaskCommands(program);

// Query (harmony tasks query) — registered under the tasks group
registerQueryCommand(program);

// Comments (harmony tasks comments|comment) — registered under the tasks group
registerCommentCommands(program);

// Bulk operations (harmony tasks bulk-create|bulk-update) — registered under the tasks group
registerBulkCommands(program);

// Subtasks (harmony subtasks list|manage)
registerSubtaskCommands(program);

// Acceptance criteria (harmony ac list|manage)
registerAcceptanceCriteriaCommands(program);

// Test cases (harmony tests list|manage)
registerTestCaseCommands(program);

// Organization
registerEpicCommands(program);
registerLabelCommands(program);
registerMilestoneCommands(program);
registerCycleCommands(program);

// Metadata
registerMemberCommands(program);
registerActivityCommand(program);

// Documents
registerDocCommands(program);

program.parse();
```

- [ ] **Step 3: Verify build succeeds (will fail — command modules don't exist yet)**

This step just creates the entry point. The command modules will be created in subsequent tasks. For now, comment out all the import/register lines except the program setup and auth commands (which we'll build first).

Create a minimal version first:

```typescript
// src/cli/index.ts (minimal — to be expanded as commands are added)
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';

const program = new Command();

program
  .name('harmony')
  .description('Harmony project management CLI')
  .version('0.2.0')
  .option('--json', 'Output results as JSON', false);

registerAuthCommands(program);

program.parse();
```

- [ ] **Step 4: Build and test the binary runs**

Run: `npx tsc --noEmit` (will fail because commands/auth.js doesn't exist yet — that's expected, proceed to Task 6)

- [ ] **Step 5: Commit the scaffolding**

```bash
git add src/bin/harmony.ts src/cli/index.ts
git commit -m "feat: add CLI entry point and bin shebang"
```

---

### Task 6: Auth commands — login, logout, projects

**Files:**
- Create: `src/cli/commands/auth.ts`

These are top-level commands: `harmony login`, `harmony logout`, `harmony projects`.

- [ ] **Step 1: Implement auth commands**

```typescript
// src/cli/commands/auth.ts
import { Command } from 'commander';
import chalk from 'chalk';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { getProject } from '../../tools/project.js';
import { addProject, removeProject, listProjects } from '../config.js';
import { formatOutput, formatTable } from '../formatter.js';

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Add a project by providing an API token')
    .requiredOption('--token <token>', 'Harmony API token')
    .option('--name <name>', 'Project name (auto-detected if not provided)')
    .option('--supabase-url <url>', 'Custom Supabase URL (advanced)')
    .option('--supabase-anon-key <key>', 'Custom Supabase anon key (advanced)')
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        // Exchange token to validate it and get project info
        if (opts.supabaseUrl) process.env.HARMONY_SUPABASE_URL = opts.supabaseUrl;
        if (opts.supabaseAnonKey) process.env.HARMONY_SUPABASE_ANON_KEY = opts.supabaseAnonKey;

        const auth = new HarmonyAuth(opts.token);
        const client = await createAuthenticatedClient(auth);
        const projectId = auth.getProjectId();

        // Fetch project name if not provided
        let name = opts.name;
        if (!name) {
          const project = await getProject(client, projectId);
          name = project.name.toLowerCase().replace(/\s+/g, '-');
        }

        addProject(name, opts.token, {
          supabaseUrl: opts.supabaseUrl,
          supabaseAnonKey: opts.supabaseAnonKey,
        });

        if (json) {
          console.log(JSON.stringify({ name, status: 'logged_in' }));
        } else {
          console.log(chalk.green(`Logged in to project "${name}" (now active).`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(`Login failed: ${err.message}`));
        }
        process.exit(1);
      }
    });

  program
    .command('logout')
    .description('Remove a project from the CLI')
    .argument('<name>', 'Project name to remove')
    .action(async (name) => {
      const json = program.opts().json;
      try {
        removeProject(name);
        if (json) {
          console.log(JSON.stringify({ name, status: 'logged_out' }));
        } else {
          console.log(chalk.green(`Removed project "${name}".`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(err.message));
        }
        process.exit(1);
      }
    });

  program
    .command('projects')
    .description('List all logged-in projects')
    .action(async () => {
      const json = program.opts().json;
      const projects = listProjects();

      if (json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }

      if (projects.length === 0) {
        console.log('No projects configured. Run `harmony login --token <token>` to add one.');
        return;
      }

      console.log(
        formatTable(
          projects.map((p) => ({
            name: p.name,
            active: p.active ? chalk.green('*') : '',
          })),
          [
            { key: 'active', header: '' },
            { key: 'name', header: 'Project' },
          ],
        ),
      );
    });
}
```

- [ ] **Step 2: Build and test the CLI boots**

Run: `npm run build && node dist/bin/harmony.js --help`
Expected: Shows help with `login`, `logout`, `projects` commands.

Run: `node dist/bin/harmony.js login --help`
Expected: Shows login options including `--token`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/auth.ts
git commit -m "feat: add harmony login/logout/projects commands"
```

---

### Task 7: Core command helper — reduce boilerplate across commands

**Files:**
- Create: `src/cli/run-command.ts`

Every CLI command follows the same pattern: get auth context, call handler, format output, handle errors. Extract this into a helper.

- [ ] **Step 1: Implement the command runner**

```typescript
// src/cli/run-command.ts
import chalk from 'chalk';
import { getAuthenticatedContext, AuthenticatedContext } from './auth.js';

export async function runCommand<T>(
  opts: { json: boolean },
  handler: (ctx: AuthenticatedContext) => Promise<T>,
  formatter: (data: T) => string,
): Promise<void> {
  try {
    const ctx = await getAuthenticatedContext();
    const data = await handler(ctx);
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      console.log(formatter(data));
    }
  } catch (err: any) {
    if (opts.json) {
      console.error(JSON.stringify({ error: err.message }));
    } else {
      console.error(chalk.red(`Error: ${err.message}`));
    }
    process.exit(1);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/run-command.ts
git commit -m "feat: add runCommand helper to reduce CLI command boilerplate"
```

---

### Task 8: Task commands — list, get, create, update

**Files:**
- Create: `src/cli/commands/tasks.ts`
- Modify: `src/cli/index.ts` (add import + register)

- [ ] **Step 1: Implement task commands**

```typescript
// src/cli/commands/tasks.ts
import { Command } from 'commander';
import { listTasks, getTask, createTask, updateTask } from '../../tools/tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatPriority, formatStatus, formatDate } from '../formatter.js';

const TASK_COLUMNS = [
  { key: 'visual_id', header: 'ID', transform: (_: any, row: any) => `${row._projectKey ?? ''}-${row.task_number}` },
  { key: 'title', header: 'Title', width: 50 },
  { key: 'status', header: 'Status', transform: (v: string) => formatStatus(v) },
  { key: 'priority', header: 'Priority', transform: (v: string) => formatPriority(v) },
  { key: 'due_date', header: 'Due', transform: (v: string | null) => formatDate(v) },
];

export function registerTaskCommands(program: Command): void {
  const tasks = program
    .command('tasks')
    .description('Manage tasks');

  tasks
    .command('list')
    .description('List tasks with optional filters')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <id>', 'Filter by assignee')
    .option('--epic <id>', 'Filter by epic')
    .option('--label <ids...>', 'Filter by label IDs')
    .option('--archived', 'Include archived tasks', false)
    .option('--limit <n>', 'Max results', '50')
    .option('--offset <n>', 'Skip results', '0')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) => {
          return listTasks(ctx.client, ctx.projectId, {
            status: opts.status,
            assignee_id: opts.assignee,
            epic_id: opts.epic,
            label_ids: opts.label,
            archived: opts.archived,
            limit: parseInt(opts.limit),
            offset: parseInt(opts.offset),
          });
        },
        (data) => formatTable(data, TASK_COLUMNS),
      );
    });

  tasks
    .command('get')
    .description('Get full details of a task')
    .argument('<id>', 'Task ID (UUID, number, or B-123)')
    .action(async (id) => {
      await runCommand(
        program.opts(),
        async (ctx) => getTask(ctx.client, ctx.projectId, id),
        (task) =>
          formatDetail([
            { label: 'ID', value: `${task.task_number}` },
            { label: 'Title', value: task.title },
            { label: 'Status', value: formatStatus(task.status) },
            { label: 'Priority', value: formatPriority(task.priority) },
            { label: 'Assignee', value: task.assignee_id ?? 'Unassigned' },
            { label: 'Epic', value: task.epic_id ?? 'None' },
            { label: 'Due', value: formatDate(task.due_date) },
            { label: 'Description', value: task.description ?? '' },
          ]),
      );
    });

  tasks
    .command('create')
    .description('Create a new task')
    .requiredOption('--title <title>', 'Task title')
    .option('--status <status>', 'Status (default: Backlog)')
    .option('--priority <priority>', 'Priority: high, medium, low')
    .option('--assignee <id>', 'Assignee (name, email, or UUID)')
    .option('--epic <id>', 'Epic ID')
    .option('--description <text>', 'Task description (markdown)')
    .option('--due <date>', 'Due date (YYYY-MM-DD)')
    .option('--cycle <id>', 'Cycle ID')
    .option('--milestone <id>', 'Milestone ID')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          createTask(ctx.client, ctx.projectId, ctx.userId, {
            title: opts.title,
            status: opts.status,
            priority: opts.priority,
            assignee_id: opts.assignee,
            epic_id: opts.epic,
            description: opts.description,
            due_date: opts.due,
            cycle_id: opts.cycle,
            milestone_id: opts.milestone,
          }),
        (task) => `Created task #${task.task_number}: ${task.title}`,
      );
    });

  tasks
    .command('update')
    .description('Update an existing task')
    .argument('<id>', 'Task ID')
    .option('--title <title>', 'New title')
    .option('--status <status>', 'New status')
    .option('--priority <priority>', 'New priority')
    .option('--assignee <id>', 'New assignee (null to unassign)')
    .option('--epic <id>', 'New epic (null to unassign)')
    .option('--description <text>', 'New description')
    .option('--due <date>', 'New due date (null to clear)')
    .option('--cycle <id>', 'Cycle ID')
    .option('--milestone <id>', 'Milestone ID')
    .action(async (id, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateTask(ctx.client, ctx.projectId, ctx.userId, {
            task_id: id,
            title: opts.title,
            status: opts.status,
            priority: opts.priority,
            assignee_id: opts.assignee,
            epic_id: opts.epic,
            description: opts.description,
            due_date: opts.due,
            cycle_id: opts.cycle,
            milestone_id: opts.milestone,
          }),
        (task) => `Updated task #${task.task_number}: ${task.title}`,
      );
    });
}
```

- [ ] **Step 2: Update CLI entry point to register task commands**

Add to `src/cli/index.ts`:

```typescript
import { registerTaskCommands } from './commands/tasks.js';
```

And after `registerAuthCommands(program)`:

```typescript
registerTaskCommands(program);
```

- [ ] **Step 3: Build and test help output**

Run: `npm run build && node dist/bin/harmony.js tasks --help`
Expected: Shows `list`, `get`, `create`, `update` subcommands.

Run: `node dist/bin/harmony.js tasks list --help`
Expected: Shows filter options.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/tasks.ts src/cli/index.ts
git commit -m "feat: add harmony tasks list|get|create|update commands"
```

---

### Task 9: Query and comment commands

**Files:**
- Create: `src/cli/commands/query.ts`
- Create: `src/cli/commands/comments.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement query command**

```typescript
// src/cli/commands/query.ts
import { Command } from 'commander';
import { queryTasks } from '../../tools/query-tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatPriority, formatStatus, formatDate } from '../formatter.js';

export function registerQueryCommand(program: Command): void {
  const tasks = program.commands.find((c) => c.name() === 'tasks');
  if (!tasks) return;

  tasks
    .command('query')
    .description('Advanced task search with filters')
    .option('--status <status>', 'Filter by status')
    .option('--assignee <id>', 'Filter by assignee')
    .option('--epic <id>', 'Filter by epic')
    .option('--cycle <id>', 'Filter by cycle')
    .option('--milestone <id>', 'Filter by milestone')
    .option('--priority <priority>', 'Filter by priority')
    .option('--label <ids...>', 'Filter by label IDs (AND logic)')
    .option('--due-from <date>', 'Due date from (YYYY-MM-DD)')
    .option('--due-to <date>', 'Due date to (YYYY-MM-DD)')
    .option('--stale <days>', 'Tasks not updated in N days')
    .option('--archived', 'Include archived tasks', false)
    .option('--sort <field>', 'Sort by: position, due_date, priority, updated_at')
    .option('--limit <n>', 'Max results', '50')
    .option('--offset <n>', 'Skip results', '0')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          queryTasks(ctx.client, ctx.projectId, {
            status: opts.status,
            assignee_id: opts.assignee,
            epic_id: opts.epic,
            cycle_id: opts.cycle,
            milestone_id: opts.milestone,
            priority: opts.priority,
            label_ids: opts.label,
            due_date_from: opts.dueFrom,
            due_date_to: opts.dueTo,
            stale_days: opts.stale ? parseInt(opts.stale) : undefined,
            archived: opts.archived,
            sort_by: opts.sort,
            limit: parseInt(opts.limit),
            offset: parseInt(opts.offset),
          }),
        (data) =>
          formatTable(data, [
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status', transform: (v: string) => formatStatus(v) },
            { key: 'priority', header: 'Priority', transform: (v: string) => formatPriority(v) },
            { key: 'due_date', header: 'Due', transform: (v: string | null) => formatDate(v) },
          ]),
      );
    });
}
```

- [ ] **Step 2: Implement comment commands**

```typescript
// src/cli/commands/comments.ts
import { Command } from 'commander';
import { listComments, addComment } from '../../tools/comments.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

export function registerCommentCommands(program: Command): void {
  const tasks = program.commands.find((c) => c.name() === 'tasks');
  if (!tasks) return;

  tasks
    .command('comments')
    .description('List comments on a task')
    .argument('<task-id>', 'Task ID')
    .action(async (taskId) => {
      await runCommand(
        program.opts(),
        async (ctx) => listComments(ctx.client, ctx.projectId, taskId),
        (data) =>
          formatTable(data, [
            { key: 'created_at', header: 'Date', transform: (v: string) => formatDate(v) },
            { key: 'user_id', header: 'User' },
            { key: 'content', header: 'Comment', width: 60 },
          ]),
      );
    });

  tasks
    .command('comment')
    .description('Add a comment to a task')
    .argument('<task-id>', 'Task ID')
    .argument('<content>', 'Comment text (markdown)')
    .action(async (taskId, content) => {
      await runCommand(
        program.opts(),
        async (ctx) => addComment(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, content }),
        (data) => `Comment added.`,
      );
    });
}
```

- [ ] **Step 3: Update CLI entry point**

Add imports and register calls for `registerQueryCommand` and `registerCommentCommands`.

- [ ] **Step 4: Build and verify**

Run: `npm run build && node dist/bin/harmony.js tasks query --help`
Expected: Shows all query filter options.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/query.ts src/cli/commands/comments.ts src/cli/index.ts
git commit -m "feat: add harmony tasks query and comment commands"
```

---

### Task 10: Project, members, and activity commands

**Files:**
- Create: `src/cli/commands/project.ts`
- Create: `src/cli/commands/members.ts`
- Create: `src/cli/commands/activity.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement project commands**

```typescript
// src/cli/commands/project.ts
import { Command } from 'commander';
import { getProject } from '../../tools/project.js';
import { switchProject, listProjects } from '../config.js';
import { runCommand } from '../run-command.js';
import { formatDetail } from '../formatter.js';
import chalk from 'chalk';

export function registerProjectCommands(program: Command): void {
  const proj = program
    .command('project')
    .description('Project info and switching');

  proj
    .command('info')
    .description('Show current project details')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => getProject(ctx.client, ctx.projectId),
        (data) =>
          formatDetail([
            { label: 'Name', value: data.name },
            { label: 'Key', value: data.key },
            { label: 'Description', value: data.description ?? '' },
            { label: 'Statuses', value: data.custom_statuses?.join(' -> ') ?? '' },
          ]),
      );
    });

  proj
    .command('switch')
    .description('Switch active project')
    .argument('<name>', 'Project name')
    .action(async (name) => {
      const json = program.opts().json;
      try {
        switchProject(name);
        if (json) {
          console.log(JSON.stringify({ activeProject: name }));
        } else {
          console.log(chalk.green(`Switched to project "${name}".`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(err.message));
        }
        process.exit(1);
      }
    });
}
```

- [ ] **Step 2: Implement members command**

```typescript
// src/cli/commands/members.ts
import { Command } from 'commander';
import { listMembers } from '../../tools/members.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerMemberCommands(program: Command): void {
  const members = program
    .command('members')
    .description('Workspace members');

  members
    .command('list')
    .description('List workspace members')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => listMembers(ctx.client, ctx.projectId),
        (data) =>
          formatTable(data, [
            { key: 'display_name', header: 'Name' },
            { key: 'email', header: 'Email' },
            { key: 'role', header: 'Role' },
            { key: 'user_id', header: 'ID' },
          ]),
      );
    });
}
```

- [ ] **Step 3: Implement activity command**

```typescript
// src/cli/commands/activity.ts
import { Command } from 'commander';
import { listActivity } from '../../tools/activity.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

export function registerActivityCommand(program: Command): void {
  program
    .command('activity')
    .description('Show project activity timeline')
    .option('--task <id>', 'Filter by task ID')
    .option('--limit <n>', 'Max results', '50')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          listActivity(ctx.client, ctx.projectId, {
            task_id: opts.task,
            limit: parseInt(opts.limit),
          }),
        (data) =>
          formatTable(data, [
            { key: 'created_at', header: 'When', transform: (v: string) => formatDate(v) },
            { key: 'type', header: 'Type' },
            { key: 'summary', header: 'Summary', width: 60 },
          ]),
      );
    });
}
```

- [ ] **Step 4: Update CLI entry point, build, verify**

Add imports and register calls. Run `npm run build && node dist/bin/harmony.js project --help`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/project.ts src/cli/commands/members.ts src/cli/commands/activity.ts src/cli/index.ts
git commit -m "feat: add project info/switch, members, and activity commands"
```

---

### Task 11: Epic, label, milestone, and cycle commands

**Files:**
- Create: `src/cli/commands/epics.ts`
- Create: `src/cli/commands/labels.ts`
- Create: `src/cli/commands/milestones.ts`
- Create: `src/cli/commands/cycles.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement epic commands**

```typescript
// src/cli/commands/epics.ts
import { Command } from 'commander';
import { listEpics, createEpic, updateEpic } from '../../tools/epics.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerEpicCommands(program: Command): void {
  const epics = program
    .command('epics')
    .description('Manage epics');

  epics
    .command('list')
    .description('List all epics')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => listEpics(ctx.client, ctx.projectId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'Name', width: 40 },
            { key: 'color', header: 'Color' },
          ]),
      );
    });

  epics
    .command('create')
    .description('Create a new epic')
    .requiredOption('--name <name>', 'Epic name')
    .option('--color <color>', 'Color hex code')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) => createEpic(ctx.client, ctx.projectId, { name: opts.name, color: opts.color }),
        (data) => `Created epic: ${data.name}`,
      );
    });

  epics
    .command('update')
    .description('Update an epic')
    .argument('<id>', 'Epic ID')
    .option('--name <name>', 'New name')
    .option('--color <color>', 'New color')
    .action(async (id, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) => updateEpic(ctx.client, ctx.projectId, { epic_id: id, name: opts.name, color: opts.color }),
        (data) => `Updated epic: ${data.name}`,
      );
    });
}
```

- [ ] **Step 2: Implement label commands**

```typescript
// src/cli/commands/labels.ts
import { Command } from 'commander';
import { listLabels, createLabel } from '../../tools/labels.js';
import { manageTaskLabels } from '../../tools/task-labels.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';

export function registerLabelCommands(program: Command): void {
  const labels = program
    .command('labels')
    .description('Manage labels');

  labels
    .command('list')
    .description('List all workspace labels')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => listLabels(ctx.client, ctx.projectId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'Name' },
            { key: 'color', header: 'Color' },
          ]),
      );
    });

  labels
    .command('create')
    .description('Create a new label')
    .requiredOption('--name <name>', 'Label name')
    .option('--color <color>', 'Color hex code')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) => createLabel(ctx.client, ctx.projectId, { name: opts.name, color: opts.color }),
        (data) => `Created label: ${data.name}`,
      );
    });

  labels
    .command('manage')
    .description('Add or remove labels on a task')
    .argument('<task-id>', 'Task ID')
    .option('--add <ids...>', 'Label IDs to add')
    .option('--remove <ids...>', 'Label IDs to remove')
    .action(async (taskId, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageTaskLabels(ctx.client, ctx.projectId, {
            task_id: taskId,
            add: opts.add,
            remove: opts.remove,
          }),
        (data) => `Labels updated. Current: ${data.labels?.map((l: any) => l.name).join(', ') || 'none'}`,
      );
    });
}
```

- [ ] **Step 3: Implement milestone commands**

```typescript
// src/cli/commands/milestones.ts
import { Command } from 'commander';
import { listMilestones, createMilestone, updateMilestone, shipMilestone } from '../../tools/milestones.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

export function registerMilestoneCommands(program: Command): void {
  const ms = program
    .command('milestones')
    .description('Manage milestones');

  ms.command('list')
    .description('List milestones')
    .option('--shipped', 'Show shipped milestones only')
    .option('--planning', 'Show planning milestones only')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          listMilestones(ctx.client, ctx.projectId, {
            shipped: opts.shipped ? true : opts.planning ? false : undefined,
          }),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'Name', width: 30 },
            { key: 'shipped_at', header: 'Shipped', transform: (v: string | null) => formatDate(v) },
          ]),
      );
    });

  ms.command('create')
    .description('Create a milestone')
    .requiredOption('--name <name>', 'Milestone name')
    .option('--description <text>', 'Description')
    .option('--release-notes <text>', 'Release notes')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          createMilestone(ctx.client, ctx.projectId, {
            name: opts.name,
            description: opts.description,
            release_notes: opts.releaseNotes,
          }),
        (data) => `Created milestone: ${data.name}`,
      );
    });

  ms.command('update')
    .description('Update a milestone')
    .argument('<id>', 'Milestone ID')
    .option('--name <name>', 'New name')
    .option('--description <text>', 'New description')
    .action(async (id, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateMilestone(ctx.client, ctx.projectId, { milestone_id: id, name: opts.name, description: opts.description }),
        (data) => `Updated milestone: ${data.name}`,
      );
    });

  ms.command('ship')
    .description('Ship a milestone (archive it)')
    .argument('<id>', 'Milestone ID')
    .action(async (id) => {
      await runCommand(
        program.opts(),
        async (ctx) => shipMilestone(ctx.client, ctx.projectId, { milestone_id: id }),
        (data) => `Shipped milestone: ${data.name}`,
      );
    });
}
```

- [ ] **Step 4: Implement cycle commands**

```typescript
// src/cli/commands/cycles.ts
import { Command } from 'commander';
import { listCycles, createCycle, updateCycle } from '../../tools/cycles.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';

export function registerCycleCommands(program: Command): void {
  const cycles = program
    .command('cycles')
    .description('Manage cycles');

  cycles.command('list')
    .description('List all cycles')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => listCycles(ctx.client, ctx.projectId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'name', header: 'Name', width: 25 },
            { key: 'start_date', header: 'Start', transform: (v: string) => formatDate(v) },
            { key: 'end_date', header: 'End', transform: (v: string) => formatDate(v) },
            { key: 'status', header: 'Status' },
          ]),
      );
    });

  cycles.command('create')
    .description('Create the first cycle (subsequent ones are auto-created)')
    .requiredOption('--name <name>', 'Cycle name')
    .requiredOption('--start <date>', 'Start date (YYYY-MM-DD)')
    .requiredOption('--end <date>', 'End date (YYYY-MM-DD)')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          createCycle(ctx.client, ctx.projectId, {
            name: opts.name,
            start_date: opts.start,
            end_date: opts.end,
          }),
        (data) => `Created cycle: ${data.name}`,
      );
    });

  cycles.command('update')
    .description('Update a cycle')
    .argument('<id>', 'Cycle ID')
    .option('--name <name>', 'New name')
    .option('--end <date>', 'New end date')
    .action(async (id, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateCycle(ctx.client, ctx.projectId, { cycle_id: id, name: opts.name, end_date: opts.end }),
        (data) => `Updated cycle: ${data.name}`,
      );
    });
}
```

- [ ] **Step 5: Update CLI entry point, build, verify**

Add all four imports and register calls. Run:

```bash
npm run build
node dist/bin/harmony.js epics --help
node dist/bin/harmony.js labels --help
node dist/bin/harmony.js milestones --help
node dist/bin/harmony.js cycles --help
```

Expected: Each shows correct subcommands.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/epics.ts src/cli/commands/labels.ts src/cli/commands/milestones.ts src/cli/commands/cycles.ts src/cli/index.ts
git commit -m "feat: add epic, label, milestone, and cycle commands"
```

---

### Task 12: Document commands

**Files:**
- Create: `src/cli/commands/docs.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement document commands**

```typescript
// src/cli/commands/docs.ts
import { Command } from 'commander';
import {
  listProjectDocuments,
  getProjectDocument,
  createProjectDocument,
  updateProjectDocument,
} from '../../tools/documents.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatDate } from '../formatter.js';

export function registerDocCommands(program: Command): void {
  const docs = program
    .command('docs')
    .description('Manage project documents');

  docs.command('list')
    .description('List project documents')
    .action(async () => {
      await runCommand(
        program.opts(),
        async (ctx) => listProjectDocuments(ctx.client, ctx.projectId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'title', header: 'Title', width: 40 },
            { key: 'updated_at', header: 'Updated', transform: (v: string) => formatDate(v) },
          ]),
      );
    });

  docs.command('get')
    .description('Get a document by ID or title')
    .argument('<id-or-title>', 'Document ID or title')
    .action(async (idOrTitle) => {
      await runCommand(
        program.opts(),
        async (ctx) => getProjectDocument(ctx.client, ctx.projectId, { document_id: idOrTitle }),
        (data) =>
          formatDetail([
            { label: 'Title', value: data.title },
            { label: 'Updated', value: formatDate(data.updated_at) },
            { label: '', value: '' },
            { label: 'Content', value: data.content },
          ]),
      );
    });

  docs.command('create')
    .description('Create a project document')
    .requiredOption('--title <title>', 'Document title')
    .requiredOption('--content <content>', 'Document content (markdown)')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          createProjectDocument(ctx.client, ctx.projectId, ctx.userId, {
            title: opts.title,
            content: opts.content,
          }),
        (data) => `Created document: ${data.title}`,
      );
    });

  docs.command('update')
    .description('Update a project document')
    .argument('<id>', 'Document ID')
    .option('--title <title>', 'New title')
    .option('--content <content>', 'New content')
    .action(async (id, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          updateProjectDocument(ctx.client, ctx.projectId, { document_id: id, title: opts.title, content: opts.content }),
        (data) => `Updated document: ${data.title}`,
      );
    });
}
```

- [ ] **Step 2: Update CLI entry point, build, verify**

Add import and register call. Run `npm run build && node dist/bin/harmony.js docs --help`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/docs.ts src/cli/index.ts
git commit -m "feat: add harmony docs list|get|create|update commands"
```

---

### Task 13: Subtask, acceptance criteria, and test case commands

**Files:**
- Create: `src/cli/commands/subtasks.ts`
- Create: `src/cli/commands/acceptance-criteria.ts`
- Create: `src/cli/commands/test-cases.ts`
- Modify: `src/cli/index.ts`

These three follow the identical pattern (list + manage with add/update/delete).

- [ ] **Step 1: Implement subtask commands**

```typescript
// src/cli/commands/subtasks.ts
import { Command } from 'commander';
import { listSubtasks, manageSubtasks } from '../../tools/subtasks.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
import chalk from 'chalk';

export function registerSubtaskCommands(program: Command): void {
  const sub = program
    .command('subtasks')
    .description('Manage subtasks');

  sub.command('list')
    .description('List subtasks for a task')
    .argument('<task-id>', 'Task ID')
    .action(async (taskId) => {
      await runCommand(
        program.opts(),
        async (ctx) => listSubtasks(ctx.client, ctx.projectId, taskId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'title', header: 'Title', width: 40 },
            { key: 'completed', header: 'Done', transform: (v: boolean) => v ? chalk.green('yes') : 'no' },
          ]),
      );
    });

  sub.command('add')
    .description('Add subtasks to a task')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--title <titles...>', 'Subtask title(s)')
    .action(async (taskId, opts) => {
      const add = (Array.isArray(opts.title) ? opts.title : [opts.title]).map((t: string) => ({ title: t }));
      await runCommand(
        program.opts(),
        async (ctx) => manageSubtasks(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, add }),
        (data) => `Added ${data.added.length} subtask(s).`,
      );
    });

  sub.command('update')
    .description('Update a subtask')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <id>', 'Subtask ID')
    .option('--title <title>', 'New title')
    .option('--done', 'Mark as completed')
    .option('--not-done', 'Mark as not completed')
    .action(async (taskId, opts) => {
      const completed = opts.done ? true : opts.notDone ? false : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageSubtasks(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            update: [{ id: opts.id, title: opts.title, completed }],
          }),
        () => `Subtask updated.`,
      );
    });

  sub.command('delete')
    .description('Delete subtask(s)')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <ids...>', 'Subtask ID(s) to delete')
    .action(async (taskId, opts) => {
      const ids = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageSubtasks(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, delete: ids }),
        (data) => `Deleted ${data.deleted.length} subtask(s).`,
      );
    });
}
```

- [ ] **Step 2: Implement acceptance criteria commands**

```typescript
// src/cli/commands/acceptance-criteria.ts
import { Command } from 'commander';
import { listAcceptanceCriteria, manageAcceptanceCriteria } from '../../tools/acceptance-criteria.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
import chalk from 'chalk';

export function registerAcceptanceCriteriaCommands(program: Command): void {
  const ac = program
    .command('ac')
    .description('Manage acceptance criteria');

  ac.command('list')
    .description('List acceptance criteria for a task')
    .argument('<task-id>', 'Task ID')
    .action(async (taskId) => {
      await runCommand(
        program.opts(),
        async (ctx) => listAcceptanceCriteria(ctx.client, ctx.projectId, taskId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'description', header: 'Criteria', width: 50 },
            { key: 'completed', header: 'Met', transform: (v: boolean) => v ? chalk.green('yes') : 'no' },
          ]),
      );
    });

  ac.command('add')
    .description('Add acceptance criteria')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--desc <descriptions...>', 'Criteria description(s)')
    .action(async (taskId, opts) => {
      const add = (Array.isArray(opts.desc) ? opts.desc : [opts.desc]).map((d: string) => ({ description: d }));
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, add }),
        (data) => `Added ${data.added.length} acceptance criteria.`,
      );
    });

  ac.command('update')
    .description('Update an acceptance criterion')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <id>', 'Criterion ID')
    .option('--desc <description>', 'New description')
    .option('--met', 'Mark as met')
    .option('--not-met', 'Mark as not met')
    .action(async (taskId, opts) => {
      const completed = opts.met ? true : opts.notMet ? false : undefined;
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            update: [{ id: opts.id, description: opts.desc, completed }],
          }),
        () => `Acceptance criterion updated.`,
      );
    });

  ac.command('delete')
    .description('Delete acceptance criteria')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <ids...>', 'Criterion ID(s)')
    .action(async (taskId, opts) => {
      const ids = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageAcceptanceCriteria(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, delete: ids }),
        (data) => `Deleted ${data.deleted.length} acceptance criteria.`,
      );
    });
}
```

- [ ] **Step 3: Implement test case commands**

```typescript
// src/cli/commands/test-cases.ts
import { Command } from 'commander';
import { listTestCases, manageTestCases } from '../../tools/test-cases.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
import chalk from 'chalk';

export function registerTestCaseCommands(program: Command): void {
  const tests = program
    .command('tests')
    .description('Manage test cases');

  tests.command('list')
    .description('List test cases for a task')
    .argument('<task-id>', 'Task ID')
    .action(async (taskId) => {
      await runCommand(
        program.opts(),
        async (ctx) => listTestCases(ctx.client, ctx.projectId, taskId),
        (data) =>
          formatTable(data, [
            { key: 'id', header: 'ID' },
            { key: 'title', header: 'Title', width: 35 },
            { key: 'status', header: 'Status' },
          ]),
      );
    });

  tests.command('add')
    .description('Add test cases')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--title <titles...>', 'Test case title(s)')
    .action(async (taskId, opts) => {
      const add = (Array.isArray(opts.title) ? opts.title : [opts.title]).map((t: string) => ({ title: t }));
      await runCommand(
        program.opts(),
        async (ctx) => manageTestCases(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, add }),
        (data) => `Added ${data.added.length} test case(s).`,
      );
    });

  tests.command('update')
    .description('Update a test case')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <id>', 'Test case ID')
    .option('--title <title>', 'New title')
    .option('--status <status>', 'New status')
    .action(async (taskId, opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageTestCases(ctx.client, ctx.projectId, ctx.userId, {
            task_id: taskId,
            update: [{ id: opts.id, title: opts.title, status: opts.status }],
          }),
        () => `Test case updated.`,
      );
    });

  tests.command('delete')
    .description('Delete test case(s)')
    .argument('<task-id>', 'Task ID')
    .requiredOption('--id <ids...>', 'Test case ID(s)')
    .action(async (taskId, opts) => {
      const ids = Array.isArray(opts.id) ? opts.id : [opts.id];
      await runCommand(
        program.opts(),
        async (ctx) =>
          manageTestCases(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, delete: ids }),
        (data) => `Deleted ${data.deleted.length} test case(s).`,
      );
    });
}
```

- [ ] **Step 4: Update CLI entry point, build, verify**

Add all three imports and register calls. Run:

```bash
npm run build
node dist/bin/harmony.js subtasks --help
node dist/bin/harmony.js ac --help
node dist/bin/harmony.js tests --help
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/subtasks.ts src/cli/commands/acceptance-criteria.ts src/cli/commands/test-cases.ts src/cli/index.ts
git commit -m "feat: add subtask, acceptance criteria, and test case commands"
```

---

### Task 14: Bulk operation commands

**Files:**
- Create: `src/cli/commands/bulk.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement bulk commands**

```typescript
// src/cli/commands/bulk.ts
import { Command } from 'commander';
import { bulkCreateTasks } from '../../tools/tasks.js';
import { bulkUpdateTasks } from '../../tools/bulk-update.js';
import { runCommand } from '../run-command.js';

export function registerBulkCommands(program: Command): void {
  const tasks = program.commands.find((c) => c.name() === 'tasks');
  if (!tasks) return;

  tasks
    .command('bulk-create')
    .description('Create multiple tasks from a JSON array')
    .requiredOption('--data <json>', 'JSON array of task objects (each with at least "title")')
    .action(async (opts) => {
      const tasksData = JSON.parse(opts.data);
      await runCommand(
        program.opts(),
        async (ctx) => bulkCreateTasks(ctx.client, ctx.projectId, ctx.userId, { tasks: tasksData }),
        (data) => `Created ${data.length} task(s).`,
      );
    });

  tasks
    .command('bulk-update')
    .description('Bulk update tasks')
    .requiredOption('--ids <ids...>', 'Task IDs to update')
    .option('--status <status>', 'New status')
    .option('--priority <priority>', 'New priority')
    .option('--assignee <id>', 'New assignee (null to unassign)')
    .option('--archived', 'Archive tasks')
    .action(async (opts) => {
      await runCommand(
        program.opts(),
        async (ctx) =>
          bulkUpdateTasks(ctx.client, ctx.projectId, {
            task_ids: opts.ids,
            status: opts.status,
            priority: opts.priority,
            assignee_id: opts.assignee,
            archived: opts.archived,
          }),
        (data) => `Updated ${data.length} task(s).`,
      );
    });
}
```

- [ ] **Step 2: Update CLI entry point, build, verify**

Add import and register call. Run `npm run build && node dist/bin/harmony.js tasks bulk-create --help`.

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/bulk.ts src/cli/index.ts
git commit -m "feat: add bulk create and bulk update task commands"
```

---

### Task 15: Final CLI entry point — register all commands, verify complete --help

**Files:**
- Modify: `src/cli/index.ts` (final version with all imports)

- [ ] **Step 1: Finalize CLI entry point with all command registrations**

Replace `src/cli/index.ts` with the full version shown in Task 5 Step 2 (the one with all imports uncommented).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Clean build with no errors.

- [ ] **Step 3: Verify top-level --help**

Run: `node dist/bin/harmony.js --help`

Expected output should show all command groups:
```
Usage: harmony [options] [command]

Harmony project management CLI

Options:
  -V, --version   output the version number
  --json          Output results as JSON (default: false)
  -h, --help      display help for command

Commands:
  login           Add a project by providing an API token
  logout          Remove a project from the CLI
  projects        List all logged-in projects
  project         Project info and switching
  tasks           Manage tasks
  subtasks        Manage subtasks
  ac              Manage acceptance criteria
  tests           Manage test cases
  epics           Manage epics
  labels          Manage labels
  milestones      Manage milestones
  cycles          Manage cycles
  members         Workspace members
  activity        Show project activity timeline
  docs            Manage project documents
  help [command]  display help for command
```

- [ ] **Step 4: Verify nested command help**

Run: `node dist/bin/harmony.js tasks --help`
Expected: Shows list, get, create, update, query, comments, comment, bulk-create, bulk-update.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing MCP tests + new config/formatter tests).

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: register all CLI commands and verify complete help output"
```

---

### Task 16: Integration test — end-to-end login + list tasks

**Files:**
- Create: `src/cli/integration.test.ts`

This is a smoke test that verifies the CLI can boot and parse commands. It does NOT hit a real Supabase instance.

- [ ] **Step 1: Write integration smoke test**

```typescript
// src/cli/integration.test.ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const CLI = path.resolve(__dirname, '../../dist/bin/harmony.js');

describe('CLI smoke tests', () => {
  it('shows help with exit code 0', () => {
    const output = execFileSync('node', [CLI, '--help'], { encoding: 'utf-8' });
    expect(output).toContain('Harmony project management CLI');
    expect(output).toContain('tasks');
    expect(output).toContain('login');
  });

  it('shows version', () => {
    const output = execFileSync('node', [CLI, '--version'], { encoding: 'utf-8' });
    expect(output.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('shows tasks subcommand help', () => {
    const output = execFileSync('node', [CLI, 'tasks', '--help'], { encoding: 'utf-8' });
    expect(output).toContain('list');
    expect(output).toContain('get');
    expect(output).toContain('create');
    expect(output).toContain('update');
    expect(output).toContain('query');
  });

  it('errors without auth when running a command', () => {
    try {
      execFileSync('node', [CLI, 'tasks', 'list'], {
        encoding: 'utf-8',
        env: { ...process.env, HARMONY_CONFIG_DIR: '/tmp/harmony-nonexistent' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: any) {
      expect(err.stderr || err.stdout).toContain('No active project');
    }
  });
});
```

- [ ] **Step 2: Build first (tests need compiled JS)**

Run: `npm run build`

- [ ] **Step 3: Run integration tests**

Run: `npm test -- src/cli/integration.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/integration.test.ts
git commit -m "test: add CLI integration smoke tests"
```

---

### Task 17: Update plugin version and CLAUDE.md

**Files:**
- Modify: `.claude-plugin/plugin.json` (bump version)
- Modify: `CLAUDE.md` (document CLI)

- [ ] **Step 1: Bump plugin version**

Read `.claude-plugin/plugin.json` and bump the version (following the repo's versioning convention).

- [ ] **Step 2: Update CLAUDE.md to document the CLI**

Add a new section after the MCP Server section:

```markdown
## CLI

The `harmony` CLI provides the same functionality as the MCP server for direct terminal use.

- **Binary:** `harmony` (via `npx @harmony/cli` or local `node dist/bin/harmony.js`)
- **Config:** `~/.harmony/config.json` (multi-project auth tokens)
- **Output modes:** Human-readable tables (default) or `--json` for scripting
- **Help:** `harmony --help`, `harmony <command> --help`

### Quick start

```bash
harmony login --token <your-api-token>
harmony tasks list
harmony tasks get B-42
harmony tasks create --title "New task" --priority high
```
```

- [ ] **Step 3: Commit**

```bash
git add .claude-plugin/plugin.json CLAUDE.md
git commit -m "docs: update CLAUDE.md with CLI docs, bump plugin version"
```

---

## Self-Review

**Spec coverage:**
- CLI mirroring MCP server: All 33 tools mapped to CLI commands across Tasks 8-14.
- Text + JSON output modes: Task 4 (formatter) + Task 7 (runCommand helper with --json flag).
- Multi-project auth with ~/.harmony/: Task 2 (config), Task 3 (auth bridge), Task 6 (login/logout/projects commands).
- --help for all commands: Commander provides this automatically. Task 15 verifies.
- npx installable: Task 1 (package.json bin entry + npm package name).
- TypeScript: Entire codebase is TypeScript.

**Placeholder scan:** No TBDs, TODOs, or "fill in" placeholders found.

**Type consistency:** All handler function imports match the existing exports in `src/tools/*.ts`. The `runCommand` helper signature is used consistently across all command files. `formatTable`, `formatDetail`, `formatPriority`, `formatStatus`, `formatDate` are defined in Task 4 and used identically everywhere.

**Gap found:** The `manage` subcommands for subtasks/AC/test-cases were split into `add`, `update`, `delete` for better CLI UX (single `manage` with add/update/delete arrays doesn't translate well to CLI flags). This is a deliberate CLI improvement, not a gap.
