import { describe, it, expect } from 'vitest';
import { readSkill } from './skill-contract.js';

// B-1034 — the accept-time double-write regression. B-1029 swapped harmony-clarify §5 branch A,
// start-work O2, harmony-decompose §4 step 5, and harmony-design-decide §5's ADD-only product-track
// payloads from the commit-only `consume_acceptance_event` to the payload-APPLYING
// `consume_pending_acceptance_event`, without removing the pre-existing manual
// `manage_acceptance_criteria`/`manage_checklist_items`/`manage_subtasks` write that used to be the
// ONLY writer on that path. Once the ledger also files the same payload item, the manual write and the
// ledgered insert land TWO rows for the same accept (the ledger's `ON CONFLICT` key —
// `(event_id, write_kind, external_ref)` — has no way to see a write it didn't make itself).
//
// The fix (decided at design/plan): drop the manual write, let the ledgered consume be the SINGLE
// writer, for exactly the four accept-path shapes covered below. design-decide's SHARPEN/drop branch is
// the one deliberate exception — `acceptance_criterion_update`/`acceptance_criterion_delete` are
// outside `KNOWN_WRITE_KINDS`, so the ledger can never auto-apply that shape and the manual write there
// remains the only writer, unchanged.
//
// DELIBERATELY GENERIC — matches on real tool-call text (`mcp__harmony__<tool>(`), scoped to each
// skill's accept-path SECTION, never a whole-file check (a legitimate, differently-justified manual
// write can coexist elsewhere in the same file — e.g. a self-heal fallback that runs only when the
// ledger's own apply never touches the event at all).

/** Slice `body` from one markdown heading up to the next heading at the same-or-shallower level
 *  (mirrors harmony-inception.contract.test.ts's own `section()`). `heading` must start with `#`. */
function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) throw new Error(`section not found: ${heading}`);
  const level = heading.match(/^#+/)![0].length;
  const rest = body.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** Slice `body` between two literal anchor strings (both exclusive of `end`), for scoping to a single
 *  bullet/branch that has no heading of its own. */
function between(body: string, startAnchor: string, endAnchor: string): string {
  const start = body.indexOf(startAnchor);
  if (start === -1) throw new Error(`start anchor not found: ${startAnchor}`);
  const end = body.indexOf(endAnchor, start + startAnchor.length);
  if (end === -1) throw new Error(`end anchor not found (after start): ${endAnchor}`);
  return body.slice(start, end);
}

/** Count real MCP tool CALLS (`mcp__harmony__<tool>(`), never a bare prose mention of the tool name. */
function countCalls(text: string, toolName: string): number {
  const re = new RegExp(`mcp__harmony__${toolName}\\(`, 'g');
  return (text.match(re) ?? []).length;
}

describe('B-1034: accept-time manual write removed where the ledger already applies the same payload', () => {
  it('harmony-clarify §5 branch A no longer manually files ACs — the ledger is the sole writer', () => {
    const skill = readSkill('harmony-clarify');
    const branchA = between(skill.body, '**A. This brief', '**B. This brief');
    expect(countCalls(branchA, 'manage_acceptance_criteria')).toBe(0);

    const branchAContinued = between(skill.body, '**A (continued)', '**B (continued)');
    expect(countCalls(branchAContinued, 'manage_acceptance_criteria')).toBe(0);
    // The ledgered apply + the re-keyed filing-pass marker are still there.
    expect(countCalls(branchAContinued, 'consume_pending_acceptance_event')).toBeGreaterThan(0);
    expect(branchAContinued).toMatch(/AC-FILING-PASS brief_id=\$\{brief\.id\} filed=\$\{by_write_kind\.acceptance_criterion \?\? 0\}/);

    // Branch B (label_add) was already correct pre-B-1034 and must stay untouched: it still never
    // calls manage_acceptance_criteria directly, and still says so explicitly.
    const branchB = between(skill.body, '**B. This brief', '**The confirmed feature-entity name');
    expect(countCalls(branchB, 'manage_acceptance_criteria')).toBe(0);
    expect(branchB).toMatch(/do NOT ALSO run `manage_acceptance_criteria`/);

    // Whole-file floor: harmony-clarify never calls manage_acceptance_criteria anywhere any more (the
    // clarify-filing self-heal that used it lives in harmony-design-decide, not here).
    expect(countCalls(skill.body, 'manage_acceptance_criteria')).toBe(0);
  });

  it('start-work O2 no longer manually materializes the checklist on accept — the ledger is the sole writer', () => {
    const skill = readSkill('start-work');
    const o2 = section(skill.body, '### O2. Plan (Designed → Planned)');
    // O2's own accept action must not add checklist items directly any more.
    expect(o2).not.toMatch(/manage_checklist_items\(\{ task_id, add:/);
    expect(countCalls(o2, 'consume_pending_acceptance_event')).toBeGreaterThan(0);
    expect(countCalls(o2, 'resolve_brief')).toBeGreaterThan(0);

    // The false "you already filed the checklist directly, and the ledger just idempotently skips
    // the duplicate" claim must be gone from O2 itself, not merely supplemented — that claim was false
    // (there was no idempotent skip; there was a second row).
    expect(o2).not.toMatch(/you already (filed|made)[\s\S]{0,40}idempotently skipped/);
  });

  it('start-work O2 checklist-completion (`update:`) writes are untouched — only the accept-time `add:` write moved', () => {
    const skill = readSkill('start-work');
    // The per-step "mark this step done" write during the build (O3) is a different operation
    // (`update:`, not `add:`) and legitimately remains a direct call.
    expect(skill.body).toMatch(/manage_checklist_items\(\{ task_id, update: \[\{ id, completed: true \}\] \}\)/);
  });

  it('start-work O3 self-heal fallback keeps its OWN direct manage_checklist_items add — a genuinely different, still-legitimate manual write', () => {
    const skill = readSkill('start-work');
    const o3 = section(skill.body, '### O3. Build (Planned → Built)');
    // This is the `payload-unrecognized` route: the ledger's own apply never ran for this event, so a
    // manual write here is NOT the B-1034 double-write hazard — it is the only writer.
    expect(countCalls(o3, 'manage_checklist_items')).toBeGreaterThan(0);
    expect(o3).toMatch(/NOT the B-1034\s+double-write hazard/);
  });

  it('harmony-decompose §4 accept no longer manually mints children or transfers ACs — the ledger is the sole writer', () => {
    const skill = readSkill('harmony-decompose');
    // `section()` already stops at the next same-or-shallower heading (§5), so this is just §4's text.
    const accept = section(skill.body, '### 4. Display + resolve');

    expect(countCalls(accept, 'manage_subtasks')).toBe(0);
    expect(countCalls(accept, 'manage_acceptance_criteria')).toBe(0);
    expect(countCalls(accept, 'consume_pending_acceptance_event')).toBeGreaterThan(0);
    expect(countCalls(accept, 'resolve_brief')).toBeGreaterThan(0);

    // The B-646 existence-check read remains essential (no title-dedupe on the ledger's own mint RPC).
    expect(skill.body).toContain('list_subtasks');
    expect(skill.body).toMatch(/REMAINS\s+ESSENTIAL/);

    // Decompose has no filing-pass-style marker to re-key — flagged as an open gap, not invented.
    expect(skill.body).toMatch(/no existing marker mechanism analogous to clarify's `AC-FILING-PASS`/);
  });

  it('harmony-decompose §2 self-heal keeps its OWN direct manage_subtasks/manage_acceptance_criteria calls — a genuinely different, still-legitimate manual write', () => {
    const skill = readSkill('harmony-decompose');
    const s2 = section(skill.body, '### 2. Query knowledge + propose the hierarchy');
    const selfHeal = between(s2, '**Self-heal fallback', 'Query `engineering`');
    expect(countCalls(selfHeal, 'manage_subtasks')).toBeGreaterThan(0);
    expect(countCalls(selfHeal, 'manage_acceptance_criteria')).toBeGreaterThan(0);
    expect(selfHeal).toMatch(/NOT the B-1034\s+double-write hazard/);
  });

  it('harmony-design-decide §5 product-track ADD-only branch does not manually write ACs — the ledger is the sole writer', () => {
    const skill = readSkill('harmony-design-decide');
    const addOnlyBullet = between(
      skill.body,
      "**This round's edits are ADD-only**",
      "**This round's edits carry a SHARPEN",
    );
    expect(countCalls(addOnlyBullet, 'manage_acceptance_criteria')).toBe(0);
    expect(addOnlyBullet).toMatch(/do NOT call `manage_acceptance_criteria`/);
  });

  it('harmony-design-decide §5 product-track SHARPEN/drop branch KEEPS the manual AC write, unchanged — deliberately untouched', () => {
    const skill = readSkill('harmony-design-decide');
    const sharpenBullet = between(
      skill.body,
      "**This round's edits carry a SHARPEN",
      '### 3. Draft the typed decision',
    );
    // No literal mcp__harmony__ call exists in this prose (as before B-1034 — never a code block here),
    // but the instruction to execute the manual write directly must still be present, and must NOT be
    // negated the way the ADD-only branch is.
    expect(sharpenBullet).toMatch(/execute every add\/update\/delete yourself via\s*\n?\s*`manage_acceptance_criteria`/);
    expect(sharpenBullet).not.toMatch(/do NOT call `manage_acceptance_criteria`/);
    expect(sharpenBullet).toMatch(/unchanged, intentionally/);

    // KNOWN_WRITE_KINDS exclusion is the documented reason this branch is safe to leave alone.
    expect(skill.body).toContain('KNOWN_WRITE_KINDS');
    expect(skill.body).toContain('acceptance_criterion_update');
    expect(skill.body).toContain('acceptance_criterion_delete');
  });

  it('harmony-visual-handoff needs no B-1034 change — confirmed: no manual manage_* write on its accept path', () => {
    const skill = readSkill('harmony-visual-handoff');
    expect(countCalls(skill.body, 'manage_acceptance_criteria')).toBe(0);
    expect(countCalls(skill.body, 'manage_checklist_items')).toBe(0);
    expect(countCalls(skill.body, 'manage_subtasks')).toBe(0);
  });
});
