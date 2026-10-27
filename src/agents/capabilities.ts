// B-1150: runtime-neutral skill capability classes.
//
// Every skills/<name>/SKILL.md carries an AUTHORED `capabilities:` frontmatter key: a space-separated,
// ordered list of the classes below. It is the source of truth for what a skill may do. Each adapter
// projects it onto its own runtime (contract.ts → SkillCapabilitySeam):
//
//   - Claude Code (claude-code.ts) renders the `allowed-tools` / `disallowed-tools` lines. Those lines
//     STAY in SKILL.md — Claude Code reads only the raw file — but they are a GENERATED projection:
//     src/agents/skill-capabilities.test.ts fails when a line differs from what `capabilities:` renders,
//     and pins every skill's set to the pre-B-1150 baseline.
//   - Codex (codex.ts) has one session envelope for every skill (bypass sandbox + approval never), so
//     it enforces no per-skill class; it lists each `forbid:` class as a prose rule in the generated
//     AGENTS.md overlay, declared honestly rather than dropped.
//
// Pure: no I/O.

/** The fixed classes. Order here is documentation only — a skill's own order is what renders. */
export const CAPABILITY_CLASSES = ['harmony-mcp', 'figma-mcp', 'read', 'web', 'edit', 'write', 'shell'] as const;
export type FixedCapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/** `shell:<prefix>` — a shell scoped to one command prefix (Claude: `Bash(<prefix> *)`). */
export const SHELL_PREFIX = 'shell:';
/** `forbid:<tool>` — a tool this skill must not call. `<tool>` is `harmony-mcp:<name>` for a Harmony MCP
 *  tool, or a bare runtime tool name (e.g. `NotebookEdit`). */
export const FORBID_PREFIX = 'forbid:';
/** The Harmony-MCP namespace inside a `forbid:` class. */
export const HARMONY_MCP_FORBID_NS = 'harmony-mcp:';

export type CapabilityClass = FixedCapabilityClass | `shell:${string}` | `forbid:${string}`;

const PREFIX_TOKEN = /^[a-z][a-z0-9._-]*$/;
const TOOL_TOKEN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Problems with one class token, or [] when it is valid. */
export function classProblems(token: string): string[] {
  if ((CAPABILITY_CLASSES as readonly string[]).includes(token)) return [];
  if (token.startsWith(SHELL_PREFIX)) {
    return PREFIX_TOKEN.test(token.slice(SHELL_PREFIX.length)) ? [] : [`'${token}': shell prefix must be a lower-case command name`];
  }
  if (token.startsWith(FORBID_PREFIX)) {
    const tool = token.slice(FORBID_PREFIX.length);
    const name = tool.startsWith(HARMONY_MCP_FORBID_NS) ? tool.slice(HARMONY_MCP_FORBID_NS.length) : tool;
    return TOOL_TOKEN.test(name) ? [] : [`'${token}': forbid needs a tool name`];
  }
  return [`'${token}' is not a capability class`];
}

export type CapabilityParse = { ok: true; classes: CapabilityClass[] } | { ok: false; problems: string[] };

/** Parse a `capabilities:` frontmatter value (space-separated, order preserved). Never throws. */
export function parseCapabilities(value: string | undefined): CapabilityParse {
  if (value === undefined || value.trim() === '') return { ok: false, problems: ['no capabilities declared'] };
  const tokens = value.trim().split(/\s+/);
  const problems = tokens.flatMap(classProblems);
  const seen = new Set<string>();
  for (const t of tokens) {
    if (seen.has(t)) problems.push(`'${t}' is declared twice`);
    seen.add(t);
  }
  if (!tokens.includes('harmony-mcp')) problems.push("'harmony-mcp' is required (a skill reads the board through it)");
  return problems.length ? { ok: false, problems } : { ok: true, classes: tokens as CapabilityClass[] };
}

/** The `forbid:` classes of a list, in order. */
export function forbiddenClasses(classes: readonly CapabilityClass[]): Array<`forbid:${string}`> {
  return classes.filter((c): c is `forbid:${string}` => c.startsWith(FORBID_PREFIX));
}

/** The forbidden tool of a `forbid:` class, split into its namespace. */
export function forbiddenTool(cls: `forbid:${string}`): { harmonyMcp: boolean; name: string } {
  const tool = cls.slice(FORBID_PREFIX.length);
  return tool.startsWith(HARMONY_MCP_FORBID_NS)
    ? { harmonyMcp: true, name: tool.slice(HARMONY_MCP_FORBID_NS.length) }
    : { harmonyMcp: false, name: tool };
}

/** Read the `capabilities:` value out of a raw SKILL.md (single-line frontmatter), or undefined. */
export function capabilitiesFromSkillMd(raw: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) return undefined;
  const line = m[1].split('\n').find((l) => /^capabilities:/.test(l));
  return line === undefined ? undefined : line.slice('capabilities:'.length).trim();
}
