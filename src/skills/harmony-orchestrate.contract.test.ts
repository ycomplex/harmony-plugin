import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-orchestrate skill contract', () => {
  const skill = readSkill('harmony-orchestrate');
  // Prose in the skill body line-wraps at ~80-100 chars; collapse all whitespace runs
  // (including newlines) to a single space before pinning multi-word phrases, so a phrase
  // that happens to straddle a line break in the markdown source still matches.
  const flat = skill.body.replace(/\s+/g, ' ').toLowerCase();

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-orchestrate');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it("resolves forward gates with agent-synthesized provenance; release/verify stay the human's (hard floor)", () => {
    expect(referencedHarmonyTools(skill.body)).toContain('resolve_brief');
    expect(skill.body).toContain('agent-synthesized:<your-mode>');
    expect(flat).toMatch(/release and verify accepts are the human'?s/);
    expect(flat).toContain('hard floor');
  });

  it('the merge-already-done exception: human-in-session provenance + a remark telling the release leg the merge is done', () => {
    expect(skill.body).toContain("provenance:'human-in-session'");
    expect(flat).toMatch(/merge is (already )?done/);
    expect(flat).toMatch(/confirm, don'?t re-merge/);
  });

  it('answers elicitations with submit_elicitation_answers, never conclude_elicitation', () => {
    const tools = referencedHarmonyTools(skill.body);
    expect(tools).toContain('submit_elicitation_answers');
    expect(flat).toMatch(/never `?mcp__harmony__conclude_elicitation`?/);
  });

  it('a founder-reserved question is still answered, but flagged as a derivation with the veto open', () => {
    expect(flat).toMatch(/reserved for the human/);
    expect(flat).toMatch(/flag it/);
    expect(flat).toMatch(/veto open/);
  });

  it('never mints tickets on its own judgment — filing requests go to the human as a filing word', () => {
    expect(flat).toMatch(/never mint tickets? on (its |your )?own judgment/);
    expect(flat).toMatch(/filing word/);
    expect(referencedHarmonyTools(skill.body)).toContain('get_task');
  });

  it('remark vs detail vs iterate: a remark rides exactly one next leg; detail is inert; ordering feedback is an iterate', () => {
    expect(flat).toMatch(/a `?remark`? rides an accept and is consumed by exactly one next leg/);
    expect(flat).toMatch(/`?detail`? is inert/);
    expect(flat).toMatch(/never a remark/);
  });

  it('discloses every direct board write in its next message', () => {
    expect(flat).toMatch(/disclose every direct board write/);
  });

  describe('PR-pipeline serialization (§4)', () => {
    it('one ticket building per repo at a time; a both-repo ticket needs both lanes', () => {
      expect(flat).toMatch(/one ticket building per repo at a time/);
      expect(flat).toMatch(/both.repo ticket needs both lanes/);
    });

    it('hold means not resolving the plan brief', () => {
      expect(flat).toMatch(/hold = don'?t resolve the plan brief/);
    });

    it('the identical-bump trap: exactly one unmerged plugin PR at a time', () => {
      expect(flat).toMatch(/same version merge cleanly and the second silently never ships/);
      expect(flat).toMatch(/exactly one unmerged plugin pr at a time/);
    });
  });

  describe('release-brief verification (§5)', () => {
    it('CI is judged by conclusion, never by watching exit codes', () => {
      expect(flat).toMatch(/ci by conclusion/);
      expect(skill.body).toContain('--json conclusion');
      expect(flat).toMatch(/never watch exit codes, never/);
      expect(skill.body).toContain('--exit-status');
    });

    it('branch ahead/behind + gutted-rebase-by-diff-stat check', () => {
      expect(flat).toMatch(/ahead\/behind/);
      expect(flat).toMatch(/gutted rebase/);
      expect(flat).toMatch(/diff stat/);
    });

    it('plugin bump freshness checked every time', () => {
      expect(flat).toMatch(/plugin bump freshness/);
    });

    it('files vs plan surfaces investigated for surplus or missing files', () => {
      expect(flat).toMatch(/files vs plan/);
      expect(flat).toMatch(/surplus or missing file/);
    });

    it('evidence block scrutiny: executed vs walk-at-verify vs unproven', () => {
      expect(flat).toMatch(/executed tests vs walk-at-verify vs unproven/);
      expect(flat).toMatch(/unexecuted "?coverage"? is not evidence/);
    });

    it('the drain requires every follow-up item to be terminal, with live filed/folded destinations', () => {
      expect(flat).toMatch(/every follow-up item must be terminal/);
      expect(referencedHarmonyTools(skill.body)).toContain('get_task');
    });
  });

  describe('watch mechanics (§6)', () => {
    it('daemon-log clean-pause + park greps are the primary signal, covering held/human-held tickets too', () => {
      expect(flat).toMatch(/clean-pause/);
      expect(flat).toContain('park|no-progress|error|failed');
      expect(flat).toMatch(/including the held and human-held ones/);
    });

    it('cursor advances to the last PROCESSED line, never to "now"', () => {
      expect(flat).toMatch(/advanced to the last line you processed/);
      expect(flat).toMatch(/never to "now"/);
    });

    it('the watch runs harness-backgrounded, never a shell `&` orphan', () => {
      expect(flat).toMatch(/run_in_background/);
      expect(flat).toMatch(/orphan dies with its shell/);
    });

    it('held/human-held briefs are excluded from awaiting-polls but always present in the parks-grep', () => {
      expect(flat).toMatch(/never poll the awaiting flag of a brief you are deliberately holding/);
      expect(flat).toMatch(/holds live in the parks-grep only/);
    });
  });

  describe('re-invocation semantics (B-917 design-gate addition)', () => {
    it('SAME-SESSION re-invocation piggybacks the ONE existing watch loop — never a second watch', () => {
      expect(flat).toMatch(/same-session re-invocation/);
      expect(flat).toMatch(/piggyback by design/);
      expect(flat).toMatch(/merge into the one existing watch loop'?s grep sets and single cursor/);
    });

    it('states plainly that parallel watch loops on the same daemon log are forbidden', () => {
      expect(flat).toMatch(/parallel watch loops on the same daemon log are forbidden/);
    });

    it('the duplicate-conduction guard makes an overlapping create_conduction call refuse cleanly, so re-listing an already-shepherded ticket is harmless', () => {
      const tools = referencedHarmonyTools(skill.body);
      expect(tools).toContain('create_conduction');
      expect(flat).toMatch(/duplicate-conduction guard/);
      expect(flat).toMatch(/refuses cleanly/);
      expect(flat).toMatch(/harmless/);
    });

    it('SECOND-SESSION invocation on the same board is UNGUARDED and dangerous — states the one-orchestrator-seat-per-board rule prominently, in both §1 and §6', () => {
      const occurrences = flat.match(/one orchestrator seat per board/g) ?? [];
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
      expect(flat).toMatch(/currently unguarded and dangerous/);
      expect(flat).toMatch(/two seats race reviews and resolves on the same briefs/);
    });

    it('records a successor note: a future session lease/lock mechanizes the one-orchestrator-seat-per-board rule', () => {
      expect(flat).toMatch(/session lease\/lock/);
      expect(flat).toMatch(/mechanizes the one-orchestrator-seat-per-board rule/);
    });

    it('also records the two draft successor notes (repo-lane lock; awaiting-you feed), unchanged from the draft', () => {
      expect(flat).toMatch(/a future daemon-enforced repo-lane lock supersedes this section'?s prose/);
      expect(flat).toMatch(/a future daemon\/board "?awaiting-you"? feed supersedes this section'?s log-grep watching/);
    });
  });

  it('§3 (reviewing a brief) explicitly disclaims being an enumeration/checklist — it is a discretion norm, not a checklist to pin', () => {
    expect(flat).toMatch(/illustrations of the kind of scrutiny, not an enumeration to walk/);
    expect(flat).toMatch(/each brief earns its own questions from its own content/);
  });
});
