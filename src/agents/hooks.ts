// B-1150: the ONE canonical Harmony hook definition, rendered per runtime.
//
// hooks/hooks.json (what Claude Code loads from the plugin) is the Claude rendering of HARMONY_HOOKS —
// src/agents/hooks.test.ts fails when the two disagree. Codex 0.163 runs Claude-compatible hooks from
// $CODEX_HOME/hooks.json (Stop / PreToolUse / SessionStart, Claude-shaped payloads, exit 2 blocks; only
// with --dangerously-bypass-hook-trust), so codex-provision.ts writes the Codex rendering there. Codex
// has no ${CLAUDE_PLUGIN_ROOT}: the placeholder resolves to the absolute plugin root, the same way
// HARMONY_MCP_CONNECTION's args do. Both gate scripts also fall back to `dirname $0` for the root.

import { PLUGIN_ROOT_PLACEHOLDER } from './contract.js';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}
export interface HooksFile {
  hooks: Record<string, HookGroup[]>;
}

/** `{pluginRoot}` marks the plugin checkout's root in every command. */
export const HARMONY_HOOKS: HooksFile = {
  "hooks": {
    "SessionStart": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "if [ ! -f \"{pluginRoot}/dist/index.js\" ]; then cd \"{pluginRoot}\" && npm install --silent && npm run build >&2; fi; echo '{}'",
            "timeout": 180
          }
        ]
      },
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "d=\"${HARMONY_HOME:-$HOME/.harmony}/conduct-sessions\"; mkdir -p \"$d\" 2>/dev/null; i=$(cat 2>/dev/null | tr -d '\\n' | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p'); if [ -n \"$i\" ]; then printf '%s' \"$i\" > \"$d/current-session\"; fi; find \"$d\" -type f -mtime +7 -delete 2>/dev/null; printf '{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"Harmony conduct-session id: %s. A session that drives a Harmony ticket writes its conduct breadcrumb at %s/%s.json (see the harmony-conduct skill).\"}}' \"$i\" \"$d\" \"$i\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "sh \"{pluginRoot}/hooks/stop-gate.sh\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"{pluginRoot}/hooks/pretooluse-gate.sh\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
};

function resolveRoot(def: HooksFile, root: string): HooksFile {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(def.hooks)) {
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) => ({ ...h, command: h.command.split(PLUGIN_ROOT_PLACEHOLDER).join(root) })),
    }));
  }
  return { hooks };
}

/** The Claude Code rendering — exactly hooks/hooks.json. */
export function renderClaudeHooks(def: HooksFile = HARMONY_HOOKS): string {
  return JSON.stringify(resolveRoot(def, '${CLAUDE_PLUGIN_ROOT}'), null, 2) + '\n';
}

/** B-1149: a hook command that runs ONE script, `sh "<path>"` — the shape the preflight checks and
 *  the guard wraps. */
const SCRIPT_COMMAND_RE = /^sh "([^"]+\.sh)"$/;

/** B-1149: every script a hooks definition runs, with `{pluginRoot}` resolved to `pluginRoot`. */
export function hookScriptPaths(pluginRoot: string, def: HooksFile = HARMONY_HOOKS): string[] {
  const out: string[] = [];
  for (const groups of Object.values(resolveRoot(def, pluginRoot).hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const m = SCRIPT_COMMAND_RE.exec(h.command);
        if (m && !out.includes(m[1])) out.push(m[1]);
      }
    }
  }
  return out;
}

/** B-1149: the guarded form of a script command — a script that vanished after the preflight is
 *  skipped (exit 0) instead of failing every turn-end. Written as if/then/else, NOT
 *  `[ -f X ] && sh X || exit 0`: that form would turn the script's own blocking exit 2 into exit 0
 *  and silently disable the gate. */
export function guardScriptCommand(command: string): string {
  const m = SCRIPT_COMMAND_RE.exec(command);
  if (!m) return command;
  return `if [ -f "${m[1]}" ]; then sh "${m[1]}"; else exit 0; fi`;
}

/** The Codex rendering — $CODEX_HOME/hooks.json, with the absolute plugin root. The root is
 *  interpolated inside double quotes in the commands, so it must not carry a quote, `$`, backtick or
 *  backslash. B-1149: each script command is rendered guarded (guardScriptCommand). */
export function renderCodexHooks(pluginRoot: string, def: HooksFile = HARMONY_HOOKS): { fileName: string; content: string } {
  if (!pluginRoot.startsWith('/') || /["$`\\]/.test(pluginRoot)) {
    throw new Error(`plugin root '${pluginRoot}' must be an absolute path with no quote, $, backtick or backslash`);
  }
  const resolved = resolveRoot(def, pluginRoot);
  for (const groups of Object.values(resolved.hooks)) {
    for (const g of groups) g.hooks = g.hooks.map((h) => ({ ...h, command: guardScriptCommand(h.command) }));
  }
  return { fileName: 'hooks.json', content: JSON.stringify(resolved, null, 2) + '\n' };
}
