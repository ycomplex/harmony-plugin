import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-visual-handoff skill contract', () => {
  const skill = readSkill('harmony-visual-handoff');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-visual-handoff');
    expect(skill.frontmatter.description).toBeTruthy();
  });
  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });
  it("B-1204: reconcile a designer's edits — trigger, REST-only read-back, fresh-version anchor, collapse, recompose cause, accept pin, wired flow and compose-time capability refusal", () => {
    const body = skill.body;
    const i = body.indexOf("### 3d. Reconcile a designer's edits (B-1204)");
    expect(i, 'missing the reconcile section').toBeGreaterThan(-1);
    const seg = body.slice(i, body.indexOf('### 4. Iterate', i));
    expect(seg).toContain('edited-in-tool');
    expect(seg).toMatch(/frame\.design_artefact/);
    expect(seg).toMatch(/`file_key`, `version_id`/);
    expect(seg).toMatch(/REST only/);
    expect(seg).toMatch(/zero MCP reads/);
    expect(seg).toMatch(/last-modified/);
    expect(seg).toMatch(/not the press time/);
    expect(seg).toMatch(/File > Save to version history/);
    expect(seg).toMatch(/question item/);
    expect(seg).toMatch(/version-not-found/);
    expect(seg).toMatch(/never "no change"/);
    expect(seg).toMatch(/seven rows edited the same way is one/);
    expect(seg).toMatch(/never dropped/);
    expect(seg).toMatch(/never fall back to latest/i);
    expect(seg).toContain("revision_cause: { source: 'refreshed-inputs'");
    expect(seg).toMatch(/`iterate_feedback` = the designer's note \*\*verbatim, only if one was given\*\*/);
    expect(seg).toContain('What changed in Figma');
    expect(seg).toContain('human-in-tool');
    expect(seg).toMatch(/never the latest\s+at accept time/);
    expect(seg).toContain('reconcileDesign');
    expect(seg).toContain('prepareVersionedPreviews');
    expect(seg).toContain('containerId');
    expect(seg).toContain('mcp__harmony__attach_file');
    expect(seg).toContain('assemblePendingArtefact');
    expect(seg).toContain('markHumanInTool');
    expect(seg).toMatch(/frame\.design_artefact. = the assembled record/);
    expect(seg).toContain('design_artefact_capability');
    expect(seg).toMatch(/refuses with the promote prerequisite/);
    expect(seg).toMatch(/report that rather than working around it/);
    expect(seg).toMatch(/B-1202's accept path records drift; do not reimplement it/);
    expect(seg).not.toMatch(/capabilityPresent|writer refuses until/);
    expect(body).not.toMatch(/does \*\*not\*\* persist a `design_artefact`/);
    expect(seg).toContain('brief-authoring.md');
    expect(seg).toMatch(/Stating the cause of a\s+redraft/);
  });
  it('files the framed ux-ui decision through the gate machinery', () => {
    const tools = referencedHarmonyTools(skill.body);
    for (const t of ['query_knowledge', 'record_decision', 'reference_knowledge', 'compose_brief', 'resolve_brief']) {
      expect(tools, `missing ${t}`).toContain(t);
    }
  });
  it('points at the shared discipline + the surface template', () => {
    expect(skill.body).toContain('harmony-shared/visual-handoff.md');
    expect(skill.body).toContain('templates/visual-surface.html');
  });
  it('guards the locked advance rule + P3 one-brief serialization (F2 — mirrors P4 design-decide)', () => {
    // visual-handoff now OWNS the ux-ui completion accounting, so it must pin the same behaviour P4's
    // design-decide test pins — else a later edit can drop the derivation and the suite stays green while
    // the ticket silently mis-advances (or a ux-ui compose_brief silently overwrites an active sibling brief).
    expect(referencedHarmonyTools(skill.body)).toContain('list_ticket_knowledge');
    expect(skill.body.toLowerCase()).toMatch(/last\s+required\s+sub-track/);
    expect(skill.body.toLowerCase()).toMatch(/one\s+active\s+brief/);
    expect(skill.body.toLowerCase()).toContain('serialized');
  });
  it('enumerates provenance in the captured decision, not just the legend (F3)', () => {
    expect(skill.body.toLowerCase()).toMatch(/enumerate/);
  });
  it('authors deferral knowledge on the defer path (G2 — deferral-as-knowledge, mirrors P4 gate skills)', () => {
    expect(referencedHarmonyTools(skill.body)).toContain('record_decision');
    expect(skill.body).toContain('deferral');             // type: 'deferral'
    expect(skill.body).toContain('review_by');            // the alarm clock
    expect(skill.body.toLowerCase()).toMatch(/still parks|fallback/);   // graceful fallback (F4/B-352)
  });
  it('encodes the B-328 disciplines (route / elicit / framed-decision / residue)', () => {
    expect(skill.body).toMatch(/glanceable\s+in\s+a\s+rendered\s+frame/i);  // D1 routing diagnostic
    expect(skill.body.toLowerCase()).toContain('elicit');                   // D2 elicit-don't-guess
    expect(skill.body).toMatch(/describe\s+the\s+alternative/i);
    expect(skill.body).toMatch(/framed\s+decision/i);                       // capture-back binding
    expect(skill.body).toMatch(/Figma/);                                    // residue pass-through
  });
  it('is Write-capable but tmp-scoped and never commits (role profile)', () => {
    expect(skill.frontmatter['allowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools'] ?? '').not.toMatch(/Edit/);
    expect(skill.frontmatter['disallowed-tools'] ?? '').not.toMatch(/git commit/);
    expect(skill.frontmatter['disallowed-tools'] ?? '').not.toMatch(/git push/);
    expect(skill.frontmatter['disallowed-tools'] ?? '').not.toMatch(/git merge/);     // N2: assert the merge backstop too, not just commit/push
    expect(skill.body).toContain('/tmp/harmony-visual');                    // surface written to tmp only
    // N1: require BOTH guards (was /never\s+.*repo source|throwaway/ — either arm alone kept this green)
    expect(skill.body.toLowerCase()).toMatch(/never\s+write\s+repo\s+source/);
    expect(skill.body.toLowerCase()).toContain('throwaway');
  });

  // B-997: the inline link_ticket_entities call is GONE — the write rides an entity_link payload item
  // through the ledger, with the SAME three-state field_values.implements_entities handling
  // (present/absent/empty) — never a throw, never a warn, never an empty-edge write on the absent/empty
  // paths (the permanent state for every pre-B-977 ticket).
  it('B-997: authors an entity_link payload item at compose, instead of an inline link_ticket_entities call', () => {
    expect(skill.body).toMatch(/write_kind:\s*"entity_link"/);
    // B-1317: the item carries the kind, so a name shared with a concept is never ambiguous.
    expect(skill.body).toMatch(/write_kind:\s*"entity_link"[^}]*kind:\s*"feature"/);
    expect(skill.body).not.toMatch(/mcp__harmony__link_ticket_entities\(/);
    expect(referencedHarmonyTools(skill.body)).not.toContain('link_ticket_entities');
    expect(referencedHarmonyTools(skill.body)).toContain('consume_pending_acceptance_event');
    expect(skill.body).toContain('implements_entities');
    expect(skill.body.toLowerCase()).toContain('absent entirely');
    expect(skill.body.toLowerCase()).toMatch(/no throw,\s+no warn,\s+no\s+empty-edge write/);
  });
});

describe('harmony-visual-handoff: B-1325 working file', () => {
  const body = readSkill('harmony-visual-handoff').body;
  it('names the resolve command, marker, rpc-absent degradation and the exchange-id requirement', () => {
    expect(body).toContain('figma working-file resolve');
    expect(body).toContain('FIGMA-WORKING-FILE-SET');
    expect(body).toContain('rpc-absent');
    expect(body).toMatch(/always records the exchange id/);
    expect(body).toMatch(/never the library/);
  });
});
