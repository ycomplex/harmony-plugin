import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

const skill = readSkill('harmony-inception');

/** Slice the body from one heading up to the next heading at the same-or-shallower level. */
function section(heading: string): string {
  const start = skill.body.indexOf(heading);
  if (start === -1) throw new Error(`section not found: ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = skill.body.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** Body rows of the first markdown table in `text`, as trimmed cell arrays (header + divider dropped). */
function tableRows(text: string): string[][] {
  const rows = text
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    );
  return rows.filter((r) => !r.every((c) => /^-+$/.test(c) || c === '')).slice(1);
}

/** Strip markdown emphasis and any `S2 ·` / `S3 · ` / `S4 · ` stratum prefix from a node label. */
function bareName(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/^S\d\s*·\s*/, '')
    .trim();
}

describe('harmony-inception skill contract', () => {
  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-inception');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  // --- The genesis DAG: ONE table, cited twice (B-813 / friction-log F5) -------------------
  //
  // F5 was NOT "two edges are missing". The same fact — which decisions a bootstrap umbrella
  // reads — was authored twice, as an edge list in §3d and as description prose in §3c, and the
  // two drifted. These tests pin the de-duplicated structure, so the drift cannot recur silently.

  const s2Categories = new Set(
    tableRows(section('### 3b.'))
      .map((r) => bareName(r[0]))
      .filter((n) => n.startsWith('Decide the')),
  );

  const dagRows = tableRows(section('### 3d.')).map((r) => ({
    node: bareName(r[0]),
    reads: r[1]
      .split('·')
      .map((x) => bareName(x))
      .filter(Boolean),
  }));

  it('§3d names every read-input as a real §3b decision category (no dangling upstream)', () => {
    expect(s2Categories.size).toBeGreaterThan(0);
    expect(dagRows.length).toBeGreaterThan(0);
    for (const row of dagRows) {
      for (const read of row.reads) {
        if (!read.startsWith('Decide the')) continue; // proposition-root, umbrellas
        expect(
          s2Categories.has(read),
          `§3d row "${row.node}" reads "${read}", which is not a §3b category`,
        ).toBe(true);
      }
    }
  });

  it('every S3 umbrella stamped in §3c has a row in the §3d DAG table', () => {
    const umbrellas = [...section('### 3c.').matchAll(/^- \*\*(.+?)\*\*$/gm)].map((m) => m[1].trim());
    expect(umbrellas.length).toBeGreaterThan(0);
    const nodes = new Set(dagRows.map((r) => r.node));
    for (const u of umbrellas) {
      expect(nodes.has(u), `S3 umbrella "${u}" has no §3d DAG row`).toBe(true);
    }
  });

  it('§3c takes its upstream list FROM the §3d row instead of restating one', () => {
    const s3 = section('### 3c.');
    expect(s3).toMatch(/§3d/);
    // The contract template must use the placeholder, not a hard-coded enumeration — a
    // re-typed list here is precisely what drifted from the edge list before.
    expect(s3).toMatch(/<upstream S2 decisions/);
  });

  it('pins the F5 correction: Bootstrap the stack reads all four decisions its description names', () => {
    const bootstrap = dagRows.find((r) => r.node === 'Bootstrap the stack');
    expect(bootstrap, 'no §3d row for Bootstrap the stack').toBeTruthy();
    expect(bootstrap!.reads).toEqual(
      expect.arrayContaining([
        'Decide the architecture',
        'Decide the repo & workspace topology',
        'Decide the data & migration tooling',
        'Decide the coding standards',
      ]),
    );
  });

  it('the S4 roadmap slot depends on the proposition-root only, so it conducts early', () => {
    const s4 = dagRows.find((r) => /roadmap/i.test(r.node));
    expect(s4, 'no §3d row for the S4 roadmap slot').toBeTruthy();
    expect(s4!.reads).toEqual(['the proposition-root']);
  });

  // --- The extended, unconditionally-stamped catalog ---------------------------------------

  it('stamps authentication and design-system decision categories', () => {
    expect([...s2Categories]).toEqual(
      expect.arrayContaining([
        'Decide the authentication & identity approach',
        'Decide the design system',
      ]),
    );
  });

  it('forbids conditional stamping and requires an explicit not-applicable close', () => {
    const s3b = section('### 3b.');
    expect(s3b).toMatch(/UNCONDITIONALLY/);
    expect(s3b).toMatch(/not applicable/i);
    expect(section('## What inception must NEVER do')).toMatch(/conditionally/i);
  });

  it('carries a decision-allocation map with an owning stage and a deferral target per decision', () => {
    const map = tableRows(section('### 3i.'));
    expect(map.length).toBeGreaterThan(5);
    for (const row of map) {
      expect(row).toHaveLength(3); // decision | owning stage | may defer to
      expect(row[1]).not.toBe('');
    }
    expect(section('### 3i.')).toMatch(/Deferral is legal; silence is not/);
  });

  // --- Milestone fence ordering (B-813): the fence must exist BEFORE S1 can de-scope --------

  it('stamps the milestone fence in S0, not with the rest of the scaffold', () => {
    const s0 = section('### 1a.');
    // House style names tools bare in prose (`create_task`, `create_label`) and fully-qualifies
    // them only inside code blocks, so match the bare name — and assert it is a real tool, which
    // the mcp__harmony__-only sweep above cannot do for a prose mention.
    expect(s0).toMatch(/`create_milestone`/);
    expect(REGISTERED.has('create_milestone')).toBe(true);
    expect(s0).toMatch(/de-scope/);
    // §3f specifies the fence but must NOT be where it is created — §3 runs after S1.
    expect(section('### 3f.')).toMatch(/created in \*\*§1a/);
  });

  // --- Repo hygiene: no Bash, and never a blind append -------------------------------------

  it('keeps the skill Bash-free, so repo setup is an Edit and not a script', () => {
    expect(skill.frontmatter['allowed-tools']).toBeTruthy();
    expect(skill.frontmatter['allowed-tools']).not.toMatch(/\bBash\b/);
    const s3g = section('### 3g.');
    expect(s3g).toMatch(/Grep/);
    expect(s3g).toMatch(/Edit/);
    expect(s3g).toMatch(/no `?Bash`?/i);
  });

  it('routes the primary repo-hygiene guarantee through the stamped contracts, not the stamp itself', () => {
    // At stamp time there is usually no repository — repo topology is itself an undecided S2.
    const s3g = section('### 3g.');
    expect(s3g).toMatch(/no repository yet/i);
    expect(section('### 3c.')).toMatch(/\.harmony-task\.json/);
    expect(section('### 3b.')).toMatch(/\.harmony-task\.json/);
  });

  // --- Founder-seeded direction is blessed, but only as a proposal --------------------------

  it('blesses founder-seeded direction while keeping it a proposal, not a decision', () => {
    const s3h = section('### 3h.');
    expect(s3h).toMatch(/proposal, never a decision/i);
    expect(s3h).toMatch(/superpowers:brainstorming/);
    // The named section the founder pastes into is stamped onto every S2 description.
    expect(section('### 3b.')).toMatch(/## Seeded direction \(proposal, not a decision\)/);
  });

  // --- Idempotency: every write has a lookup key -------------------------------------------

  it('gives every created artifact a lookup-before-create key', () => {
    const keys = tableRows(section('## 0.'));
    expect(keys.length).toBeGreaterThan(4);
    const flat = keys.map((r) => r.join(' ')).join('\n');
    expect(flat).toMatch(/inception-scaffold/);
    expect(flat).toMatch(/milestone title/i);
    expect(flat).toMatch(/Grep/);
  });

  it('still forbids the skill from minting feature tickets itself', () => {
    const never = section('## What inception must NEVER do');
    expect(never).toMatch(/Mint feature build tickets itself/i);
    expect(never).toMatch(/graph-seeder/);
  });
});
