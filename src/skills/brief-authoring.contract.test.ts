import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSharedDoc } from './skill-contract.js';

const SKILLS_ROOT = join(process.cwd(), 'skills');

// B-660: every skill that AUTHORS a brief must point at the shared brief-authoring contract
// (skills/harmony-shared/brief-authoring.md) at its compose step — pointers only, never a
// restated copy. Authoring is detected STRUCTURALLY: an actual compose_brief invocation
// template (`mcp__harmony__compose_brief({`), which only authoring skills carry. Skills that
// merely CONSUME/surface briefs (harmony-conduct, harmony-next, harmony-queue) mention the
// tool in prose but never as a call site, so no exemption list is needed — and a ninth
// authoring skill added later inherits the pointer requirement automatically.
const AUTHORING_CALL_SITE = /mcp__harmony__compose_brief\s*\(\s*\{/;

const skillDirs = readdirSync(SKILLS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS_ROOT, d.name, 'SKILL.md')))
  .map((d) => d.name);

const skillText = (name: string): string =>
  readFileSync(join(SKILLS_ROOT, name, 'SKILL.md'), 'utf8');

const authoringSkills = skillDirs.filter((name) => AUTHORING_CALL_SITE.test(skillText(name)));

describe('brief-authoring pointer wiring (B-660)', () => {
  it('detects the eight known authoring skills (regex sanity — a rewrite must not silently exempt everyone)', () => {
    for (const known of [
      'finish-work', 'harmony-clarify', 'harmony-decompose', 'harmony-design-decide',
      'harmony-revise-scope', 'harmony-stale-patch', 'harmony-visual-handoff', 'start-work',
    ]) {
      expect(authoringSkills, `expected ${known} to be detected as an authoring skill`).toContain(known);
    }
  });

  it('classifies the brief consumers as non-authoring (they surface briefs, never compose them)', () => {
    for (const consumer of ['harmony-conduct', 'harmony-next', 'harmony-queue']) {
      expect(authoringSkills, `${consumer} must not carry a compose_brief call site`).not.toContain(consumer);
    }
  });

  it('every authoring skill points at brief-authoring.md (a ninth authoring skill must add the pointer)', () => {
    for (const name of authoringSkills) {
      expect(
        skillText(name),
        `${name}/SKILL.md authors a brief (compose_brief call site) but never references brief-authoring.md`,
      ).toContain('brief-authoring.md');
    }
  });

  it('each known authoring skill points at its own gate section', () => {
    const sections: Record<string, string[]> = {
      'harmony-clarify': ['§Clarify'],
      'harmony-decompose': ['§Decompose'],
      'harmony-design-decide': ['§Design'],
      'harmony-visual-handoff': ['§Design'],
      'start-work': ['§Plan', '§Release'],
      'finish-work': ['§Verify'],
      'harmony-revise-scope': ['§Auxiliary briefs'],
      'harmony-stale-patch': ['§Auxiliary briefs'],
    };
    for (const [name, tags] of Object.entries(sections)) {
      const text = skillText(name);
      for (const tag of tags) {
        expect(text, `${name}/SKILL.md missing the ${tag} pointer`).toContain(`brief-authoring.md\` ${tag}`);
      }
    }
  });
});

describe('brief-authoring.md structure (B-660)', () => {
  const doc = readSharedDoc('brief-authoring');

  it('carries the shared core, legibility contract, engagement model, per-gate contracts, and auxiliary briefs', () => {
    for (const section of [
      '## Shared core', '## Legibility contract', '## Engagement model',
      '## Per-gate contracts', '## Auxiliary briefs',
    ]) {
      expect(doc, `brief-authoring.md missing section ${section}`).toContain(section);
    }
  });

  it('carries all six per-gate sections', () => {
    for (const gate of ['Clarify', 'Decompose', 'Design', 'Plan', 'Release', 'Verify']) {
      expect(doc, `brief-authoring.md missing the ${gate} gate section`).toMatch(
        new RegExp(`^### ${gate} \\(`, 'm'),
      );
    }
  });

  it('marks release + verify as the hard floor and plan as the only lead-by-system gate', () => {
    expect(doc).toMatch(/### Release .*HARD FLOOR/);
    expect(doc).toMatch(/### Verify .*HARD FLOOR/);
    expect(doc).toMatch(/\*\*Plan\*\* — the\s+only one/);
  });

  it('states the brief-is-the-summary rule (depth lives in the linked decision entry)', () => {
    expect(doc).toContain('depth lives in the linked decision entry');
    expect(doc).toContain('B-669'); // navigation deferred, but the brief still states the rule
  });

  it('encodes the verify runbook and the umbrella integration-check stance', () => {
    expect(doc.toLowerCase()).toContain('runbook');
    expect(doc).toContain('do-X → expect-Y');
    expect(doc).toContain('not a different mode');
  });

  it('speaks the post-B-637 vocabulary (states + gate names)', () => {
    expect(doc).toContain('Proposed → Clarified');
    expect(doc).toContain('Built → Deployed');
    expect(doc).not.toMatch(/\bReleased\b/); // the pre-rename state name must not reappear
  });
});

// B-861: a release brief must say what the repository's checks reported for each PR being merged —
// the failure mode is DRIFT TO SILENCE (one brief named the run + conclusion + head commit; another,
// hours later, said nothing at all while both its PRs were still running), so the fix is a NAMED
// must-have in the shared contract rather than a new mechanism.
//
// LIMIT OF THESE TESTS, stated plainly: they pin the PROSE, not a rendered artefact. A release brief
// is composed by an LLM from this prose; there is no TypeScript renderer to assert a brief against.
// Prose is exactly where the drift happened, so prose is what is pinned here — but a passing test
// means the contract still SAYS this, not that a particular brief obeyed it.
describe("brief-authoring.md §Release check-status must-have (B-861)", () => {
  const doc = readSharedDoc("brief-authoring");

  /** §Release, from its heading to the next gate heading. */
  const releaseSection = (): string => {
    const start = doc.indexOf("### Release (");
    const end = doc.indexOf("### Verify (");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return doc.slice(start, end);
  };

  /** The deployment-specific fence is where host detail is ALLOWED to live. */
  const FENCE =
    /<!-- deployment-specific: begin -->[\s\S]*?<!-- deployment-specific: end -->/g;
  const normativeRelease = (): string => releaseSection().replace(FENCE, "");

  it("names the check-status must-have as a headline must-have of the release brief", () => {
    const normative = normativeRelease();
    expect(normative).toContain("What the repository's checks reported");
    // Per pull request, and never omitted — omission is the observed failure mode.
    expect(normative.toLowerCase()).toMatch(/per pull request/);
    expect(normative).toMatch(/NEVER omitted/);
    expect(normative.toLowerCase()).toMatch(/authorise a merge blind/);
  });

  it("enumerates all four dispositions — concluded, still in flight, none reported, unreadable", () => {
    const normative = normativeRelease();
    for (const disposition of ["Concluded", "Still in flight", "None reported", "Unreadable"]) {
      expect(
        normative,
        `§Release must enumerate the "${disposition}" disposition`,
      ).toContain(`**${disposition}**`);
    }
    // An unreadable surface and an empty one are never conflated (AC6).
    expect(normative.toLowerCase()).toMatch(/never.{0,20}conflated/);
    expect(normative.toLowerCase()).toMatch(/name the error/);
    // No-checks is scoped to the commit + read time, so a just-pushed head is not mislabelled (AC3).
    expect(normative.toLowerCase()).toMatch(/just-pushed head/);
  });

  it("stamps every disposition with the commit read for + the read time, and states a head mismatch in words", () => {
    const normative = normativeRelease();
    expect(normative).toContain("the commit the checks were read for");
    expect(normative.toLowerCase()).toMatch(/when the read was taken|read time/);
    expect(normative.toLowerCase()).toMatch(/never leave the human two commit ids to compare/);
  });

  it("reports a mixed read as in-flight (still naming concluded checks), non-blocking, with an attention line for any non-success", () => {
    const normative = normativeRelease();
    expect(normative.toLowerCase()).toMatch(
      /\*\*mixed\*\* read.{0,120}reports as still in flight/s,
    );
    expect(normative.toLowerCase()).toMatch(/naming each already-concluded check/);
    // Non-blocking: the section informs the approval, it never gates it (B-138 owns the action side).
    expect(normative.toLowerCase()).toMatch(/never blocks the approval/);
    // A non-success conclusion is escalated above the section, never buried in the list.
    expect(normative).toMatch(/attention line ABOVE this section/);
    expect(normative.toLowerCase()).toMatch(/never left as one line item/);
  });

  it("carries the explicitly-fenced \"On this deployment, the concrete read is…\" block, holding the host detail", () => {
    const release = releaseSection();
    expect(release).toContain("<!-- deployment-specific: begin -->");
    expect(release).toContain("<!-- deployment-specific: end -->");
    expect(release).toContain("On this deployment, the concrete read is");
    const fenced = release.match(FENCE)?.join("\n") ?? "";
    expect(fenced).not.toBe("");
    // The fence is where the host specifics live — and it says so about itself.
    expect(fenced.toLowerCase()).toMatch(/not part of the contract above/);
    expect(fenced).toContain("statusCheckRollup");
    expect(fenced).toContain("headRefOid");
    // The disposition is resolved from the parsed payload, NEVER from an exit status: a watch command
    // here has exited zero on a run that concluded failure.
    expect(fenced).toContain("PARSED PAYLOAD");
    expect(fenced.toLowerCase()).toMatch(/never from an exit status/);
    expect(fenced.toLowerCase()).toMatch(/exited zero on a run that concluded `failure`/);
  });

  it("keeps the normative text host-neutral — §Release MINUS the fence carries no VCS-host tokens", () => {
    // Scoped deliberately to VCS-HOST tokens. Deployment-TOPOLOGY tokens (staging, promote-prod) are
    // NOT asserted here: §Release's pre-existing "executed act" must-have carries them by design and
    // predates this ticket.
    const normative = normativeRelease();
    const hostTokens: Array<[string, RegExp]> = [
      ["GitHub", /\bgithub\b/i],
      ["the gh CLI", /\bgh\b/i],
      ["statusCheckRollup", /statuscheckrollup/i],
      ["headRefOid", /headrefoid/i],
      ["check-run", /\bcheck-runs?\b/i],
      ["GitHub Actions", /\bActions\b/],
      ["a named check/job", /\b(verify:dist|typecheck|eslint|vitest|npm run)\b/i],
    ];
    for (const [label, pattern] of hostTokens) {
      expect(
        pattern.test(normative),
        `§Release's normative text must not name ${label} — host detail belongs inside the deployment-specific fence`,
      ).toBe(false);
    }
    // Positive control: the tokens ARE present in §Release once the fence is included, so the
    // assertion above is testing the strip, not an accidentally-empty haystack.
    const release = releaseSection();
    expect(/statuscheckrollup/i.test(release)).toBe(true);
    expect(/\bgithub\b/i.test(release)).toBe(true);
  });

  it("states that the same prose composes a correct brief on a single-repo, no-CI, non-GitHub deployment", () => {
    const normative = normativeRelease();
    expect(normative.toLowerCase()).toMatch(/host-neutral by construction/);
    expect(normative.toLowerCase()).toMatch(/no particular version-control host/);
    expect(normative.toLowerCase()).toMatch(/not even that the repository has any\s+checks at all/);
    // A single-PR release reads as exactly one entry; a multi-PR release reports each separately.
    expect(normative.toLowerCase()).toMatch(/one entry per pull request/);
    expect(normative.toLowerCase()).toMatch(/reports each\s+separately/);
    expect(normative.toLowerCase()).toMatch(/exactly one entry/);
  });
});
