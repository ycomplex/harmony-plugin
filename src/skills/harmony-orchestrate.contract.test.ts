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

  it('states the generic precedence sentence: the session grant answered at startup overrides workspace policy, which overrides the skill\'s generic defaults', () => {
    expect(flat).toMatch(/the session grant answered at startup overrides this project'?s own written policy/);
    expect(flat).toMatch(/overrides this skill'?s generic defaults/);
  });

  it('states the generic never-delegate rule for release/verify, on any repository, with no Harmony-specific fact named', () => {
    expect(flat).toMatch(/release and verify accepts are never delegable to this seat, on any repository/);
    expect(flat).not.toMatch(/b-944/);
    expect(flat).not.toMatch(/ios (operator )?wave/);
  });

  it('honors a per-ticket hold generically — reviewed and handed over, never resolved, without naming a specific label', () => {
    expect(flat).toMatch(/a project may mark individual tickets whose clarify a human resolves/);
    expect(flat).toMatch(/reviewed and handed over, never resolved/);
    expect(flat).not.toMatch(/`?oversight`?/);
  });

  it('release recording is limited to verifiable facts, verified against the repo host, and never merges', () => {
    expect(flat).toMatch(/release recording is limited to verifiable facts/);
    expect(flat).toMatch(/verified against the repo host/);
    expect(flat).toMatch(/never merge yourself/);
  });

  describe('PR-pipeline serialization (§4)', () => {
    it('lanes are per repository: builds run in parallel across repositories, merges are serial within one', () => {
      expect(flat).toMatch(/builds run in parallel across repositories/);
      expect(flat).toMatch(/merges are serial/);
    });

    it('hold means not resolving the plan brief', () => {
      expect(flat).toMatch(/hold = don'?t resolve the plan brief/);
    });

    it('a plan is held only for same-file overlap with an open PR', () => {
      expect(flat).toMatch(/a plan is held only for same-file overlap with an open pr/);
    });

    it('a project may declare a narrower lane width in its own guidance', () => {
      expect(flat).toMatch(/a project may declare a narrower width in its own guidance/);
    });

    it('the stale plugin-lane phrases are gone', () => {
      expect(flat).not.toMatch(/every plugin pr bumps/);
      expect(flat).not.toMatch(/one ticket building per repo/);
      expect(flat).not.toMatch(/exactly one unmerged/);
    });
  });

  describe('release-brief verification (§5)', () => {
    it('CI is judged by conclusion, never by watching exit codes', () => {
      expect(flat).toMatch(/ci by conclusion/);
      expect(skill.body).toContain('--json conclusion');
      expect(flat).toMatch(/never watch exit codes, never/);
      expect(skill.body).toContain('--exit-status');
    });

    it('branch ahead/behind + gutted-rebase-by-diff-stat check, expressed generically', () => {
      expect(flat).toMatch(/ahead\/behind/);
      expect(flat).toMatch(/gutted rebase/);
      expect(flat).toMatch(/diff stat/);
      expect(skill.body).toContain('git compare <base>...<head>');
    });

    it('version-manifest freshness checked every time, if the project tracks one', () => {
      expect(flat).toMatch(/version-manifest freshness, if the project tracks one/);
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
    it('the board-watch subscriber is the primary signal, replacing the daemon log', () => {
      expect(flat).toMatch(/tools\/orchestrator\/watch-board\.mjs/);
      expect(flat).toMatch(/primary signal/);
    });

    it('documents the four leg-end line categories, covering held/human-held tickets too', () => {
      expect(flat).toMatch(/clean-pause/);
      expect(flat).toMatch(/park \(<reason>\)/);
      expect(flat).toMatch(/complete \(terminal\)/);
      expect(flat).toMatch(/dirty-exit/);
      expect(flat).toMatch(/including the held and human-held ones/);
    });

    it('an awaiting_human_input flip is documented as a HINT, never a pause', () => {
      expect(flat).toMatch(/hint/);
      expect(flat).toMatch(/never as a pause/);
    });

    it('documents the UNAVAILABLE exit and the fallback chain (daemon log, then polling)', () => {
      expect(flat).toMatch(/unavailable/);
      expect(flat).toMatch(/does not retry in-process/);
      expect(flat).toMatch(/fall back to the daemon.s console log/);
    });

    it('the watch runs harness-backgrounded, never a shell `&` orphan', () => {
      expect(flat).toMatch(/run_in_background/);
      expect(flat).toMatch(/orphan dies with its shell/);
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

    it('records a successor note: a future daemon-enforced repo-lane lock supersedes this section (§4)', () => {
      expect(flat).toMatch(/a future daemon-enforced repo-lane lock supersedes this section'?s prose/);
    });
  });

  it('§3 (reviewing a brief) explicitly disclaims being an enumeration/checklist — it is a discretion norm, not a checklist to pin', () => {
    expect(flat).toMatch(/illustrations of the kind of scrutiny, not an enumeration to walk/);
    expect(flat).toMatch(/each brief earns its own questions from its own content/);
  });

  describe('file-wide project-neutrality denylist (B-1042)', () => {
    // Six categories of project-specific instruction that must never appear anywhere in this
    // skill — project facts belong in the adopting project's own guidance, never hardcoded here.
    // Checked line-by-line (not against `flat`) so a hit reports its own line number.
    const DENYLIST: { category: string; patterns: RegExp[] }[] = [
      { category: 'repository/organisation names', patterns: [/ycomplex/i, /harmony-web/i, /harmony-plugin/i, /harmony-workspace/i] },
      { category: 'branch topology', patterns: [/\bmain\b/i, /\bstaging\b/i, /\bprod\b/i] },
      { category: 'version-manifest behaviour', patterns: [/\.claude-plugin\//i, /\bdist\//i, /plugin-version-check/i, /\bbump\w*\b/i] },
      { category: 'label names/ids', patterns: [/\boversight\b/i, /cf539452-d080-40b0-ad9c-a56365f9e8eb/i] },
      { category: 'workspace file paths', patterns: [/orchestrating-a-milestone/i, /\bdocs\//i, /container\//i, /src\/tools/i] },
      { category: 'named person/role', patterns: [/\bfounder\b/i] },
    ];

    const lines = skill.body.split('\n');

    for (const { category, patterns } of DENYLIST) {
      it(`carries no ${category}`, () => {
        const hits: string[] = [];
        lines.forEach((line, i) => {
          for (const pattern of patterns) {
            if (pattern.test(line)) hits.push(`line ${i + 1} (${pattern}): ${line.trim()}`);
          }
        });
        expect(hits, hits.join('\n')).toEqual([]);
      });
    }
  });
});
