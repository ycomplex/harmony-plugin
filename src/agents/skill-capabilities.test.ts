// B-1150 parity: every skill's AUTHORED `capabilities:` key is the source of truth; its `allowed-tools` /
// `disallowed-tools` lines are a GENERATED Claude projection of it (claude-code.ts claudeSkillTools). The
// lines stay in SKILL.md only because Claude Code reads the raw file. Never hand-edit them: change
// `capabilities:` and copy the rendered line this test prints on failure.
//
// Two pins, so neither half can drift alone:
//   1. the line in the file is byte-for-byte what `capabilities:` renders;
//   2. the rendered SET equals the pre-B-1150 baseline below (origin/main before B-1150). A mapping change
//      in claude-code.ts that alters any skill's tools fails here even when the files were regenerated.

import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill } from '../skills/skill-contract.js';
import { classProblems, parseCapabilities, type CapabilityClass } from './capabilities.js';
import { claudeCodeAdapter, claudeSkillTools } from './claude-code.js';
import { codexAdapter, renderCodexSkillRules } from './codex.js';

/** The pre-B-1150 tool sets — `git show origin/main:skills/<name>/SKILL.md` at c550f5f. */
const BASELINE: Record<string, { allowed: string; disallowed?: string }> = {
  'finish-work': { allowed: 'mcp__harmony__* Read Grep Glob Bash Bash(gh *)', disallowed: 'mcp__harmony__supersede_decision' },
  'harmony-clarify': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  'harmony-conduct': { allowed: 'mcp__harmony__* Read Grep Glob Bash(node *)' },
  'harmony-decompose': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  'harmony-design-decide': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  'harmony-fasttrack': { allowed: 'mcp__harmony__* Read Edit Write Bash Glob Grep' },
  'harmony-inception': { allowed: 'mcp__harmony__* Read Grep Glob Write Edit' },
  'harmony-next': { allowed: 'mcp__harmony__* Read Grep Glob' },
  'harmony-orchestrate': { allowed: 'mcp__harmony__* Read Grep Glob Bash(gh *) Bash(git *) Bash(node *)', disallowed: 'NotebookEdit' },
  'harmony-queue': { allowed: 'mcp__harmony__* Read Grep Glob' },
  'harmony-research': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  'harmony-revise-scope': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  'harmony-stale-patch': { allowed: 'mcp__harmony__* Read Grep Glob WebSearch WebFetch' },
  // B-1201 intentionally extends the historical envelope for the native Figma MCP and budget CLI.
  'harmony-visual-handoff': { allowed: 'mcp__harmony__* mcp__figma__* Read Grep Glob WebSearch WebFetch Write Bash(open *) Bash(mkdir *) Bash(node *)' },
  'start-work': {
    allowed: 'mcp__harmony__* Read Grep Glob Write Edit Bash',
    disallowed: 'mcp__harmony__record_decision mcp__harmony__supersede_decision',
  },
};

const SKILLS = readdirSync(join(process.cwd(), 'skills'))
  .filter((n) => existsSync(join(process.cwd(), 'skills', n, 'SKILL.md')))
  .sort();

const set = (line: string | undefined) => [...new Set((line ?? '').split(/\s+/).filter(Boolean))].sort();

function classesOf(name: string): CapabilityClass[] {
  const parsed = parseCapabilities(readSkill(name).frontmatter.capabilities);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.problems.join('; ')}`);
  return parsed.classes;
}

describe('skill capability classes (B-1150)', () => {
  it('covers every skill with a SKILL.md — all fifteen, each in the baseline', () => {
    expect(SKILLS).toHaveLength(15);
    expect(SKILLS).toEqual(Object.keys(BASELINE).sort());
  });

  it.each(SKILLS.map((s) => [s]))('%s: authors a valid capabilities key', (name) => {
    expect(parseCapabilities(readSkill(name).frontmatter.capabilities)).toMatchObject({ ok: true });
  });

  it.each(SKILLS.map((s) => [s]))('%s: allowed-tools / disallowed-tools are byte-for-byte the generated projection', (name) => {
    const fm = readSkill(name).frontmatter;
    const gen = claudeCodeAdapter.skillCapabilities.project(name, classesOf(name)).frontmatter;
    expect(fm['allowed-tools'], `regenerate: allowed-tools: ${gen['allowed-tools']}`).toBe(gen['allowed-tools']);
    expect(fm['disallowed-tools'], `regenerate: disallowed-tools: ${gen['disallowed-tools']}`).toBe(gen['disallowed-tools']);
  });

  it.each(SKILLS.map((s) => [s]))('%s: the generated sets equal the pre-B-1150 baseline (and a disallowed line exists iff it did)', (name) => {
    const { allowed, disallowed } = claudeSkillTools(classesOf(name));
    expect(set(allowed)).toEqual(set(BASELINE[name].allowed));
    expect(disallowed === null).toBe(BASELINE[name].disallowed === undefined);
    expect(set(disallowed ?? undefined)).toEqual(set(BASELINE[name].disallowed));
  });

  it('every generated line except harmony-fasttrack is byte-identical to the baseline (fasttrack was re-ordered into class order)', () => {
    for (const name of SKILLS) {
      const { allowed } = claudeSkillTools(classesOf(name));
      if (name === 'harmony-fasttrack') expect(allowed).toBe('mcp__harmony__* Read Grep Glob Edit Write Bash');
      else expect(allowed, name).toBe(BASELINE[name].allowed);
    }
  });

  it('harmony-conduct declares NO disallowed-tools (B-1114 / B-1117)', () => {
    expect(readSkill('harmony-conduct').frontmatter['disallowed-tools']).toBeUndefined();
    expect(classesOf('harmony-conduct').some((c) => c.startsWith('forbid:'))).toBe(false);
  });

  it('positive control: a changed class mapping changes a generated line (the parity pin bites)', () => {
    const classes = classesOf('harmony-next');
    const mutated = classes.map((c) => (c === 'read' ? 'web' : c)) as CapabilityClass[];
    expect(claudeSkillTools(mutated).allowed).not.toBe(BASELINE['harmony-next'].allowed);
  });
});

describe('the capability vocabulary', () => {
  it('accepts the fixed classes, shell:<prefix> and forbid:<tool>', () => {
    for (const c of ['harmony-mcp', 'read', 'web', 'edit', 'write', 'shell', 'shell:gh', 'forbid:NotebookEdit', 'forbid:harmony-mcp:record_decision']) {
      expect(classProblems(c), c).toEqual([]);
    }
  });
  it('rejects unknown classes, malformed prefixes, duplicates and a missing harmony-mcp', () => {
    expect(classProblems('bash')).not.toEqual([]);
    expect(classProblems('shell:')).not.toEqual([]);
    expect(classProblems('shell:Git *')).not.toEqual([]);
    expect(classProblems('forbid:')).not.toEqual([]);
    expect(parseCapabilities('harmony-mcp read read')).toMatchObject({ ok: false });
    expect(parseCapabilities('read')).toMatchObject({ ok: false });
    expect(parseCapabilities(undefined)).toMatchObject({ ok: false });
  });
  it('the Claude projection throws on an unknown class', () => {
    expect(() => claudeSkillTools(['harmony-mcp', 'bogus' as CapabilityClass])).toThrow(/not a capability class/);
  });
});

describe('the Codex projection', () => {
  it('enforces no per-skill class: one envelope, no frontmatter', () => {
    const p = codexAdapter.skillCapabilities.project('harmony-next', classesOf('harmony-next'));
    expect(p.frontmatter).toEqual({});
    expect(p.envelope).toMatch(/bypass/);
    expect(p.unenforcedForbids).toEqual([]);
  });
  it('declares every forbid: class of the three denying skills as an unenforced prose rule', () => {
    for (const name of ['start-work', 'finish-work', 'harmony-orchestrate']) {
      const classes = classesOf(name);
      const p = codexAdapter.skillCapabilities.project(name, classes);
      expect(p.unenforcedForbids).toEqual(classes.filter((c) => c.startsWith('forbid:')));
      expect(p.proseRules).toHaveLength(p.unenforcedForbids.length);
      expect(p.unenforcedForbids.length).toBeGreaterThan(0);
    }
    const rules = renderCodexSkillRules(SKILLS.map((name) => ({ name, classes: classesOf(name) })));
    expect(rules).toContain('While running `$harmony-plugin:start-work`, do not call the `harmony` MCP tool `record_decision`.');
    expect(rules).toContain('While running `$harmony-plugin:finish-work`, do not call the `harmony` MCP tool `supersede_decision`.');
    expect(rules).toContain('While running `$harmony-plugin:harmony-orchestrate`, do not call the `NotebookEdit` tool.');
    expect(rules).not.toContain('harmony-conduct');
  });
  it('renders no section when no skill forbids anything', () => {
    expect(renderCodexSkillRules([{ name: 'x', classes: ['harmony-mcp', 'read'] }])).toBe('');
  });
});
