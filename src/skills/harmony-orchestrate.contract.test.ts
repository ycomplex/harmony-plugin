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
    it('harmony watch is the primary signal, armed with --until-event and a max-wait', () => {
      expect(flat).toMatch(/the primary signal is `harmony watch`/);
      expect(skill.body).toContain('harmony watch --milestone <id> --seat <name> --until-event --max-wait 55m --json');
      expect(flat).toMatch(/polling is the truth/);
    });

    it('retires the hand-built signals: no Monitor, restart wrapper, sweep, own subscriber or conductor-log tail', () => {
      expect(flat).toMatch(
        /never use a `monitor`, a restart wrapper, a hand-written sweep, your own realtime subscriber or a tail of the conductor log as the primary signal/,
      );
      expect(flat).not.toMatch(/board-watch subscriber/);
      expect(flat).not.toMatch(/arm a `?monitor`? on/);
      expect(flat).not.toMatch(/fall back to whatever log-tailing option/);
      expect(flat).not.toMatch(/conductor log line/);
    });

    it('the seat writes its profile with session_id first and posts SEAT-START / SEAT-STANDDOWN on the anchor ticket', () => {
      expect(skill.body).toContain('~/.harmony/seats/<name>.yml');
      expect(skill.body).toContain('session_id: <your Claude Code');
      expect(skill.body).toContain('SEAT-START v1 seat=<name> milestone=<id> session=<id>');
      expect(skill.body).toContain('SEAT-STANDDOWN v1 seat=<name> milestone=<id> session=<id>');
      expect(referencedHarmonyTools(skill.body)).toContain('add_comment');
      expect(flat).toMatch(/milestones have no comments, so the anchor carries it/);
    });

    it('documents the exit codes: 0 seat-owned events, 3 max-wait, 2 fatal configuration incl. a held lock', () => {
      expect(flat).toMatch(/`0`: events you own/);
      expect(flat).toMatch(/`3`: the max-wait passed with nothing new/);
      expect(flat).toMatch(/`2`: fatal configuration/);
      expect(flat).toMatch(/a held lock, naming the holder'?s pid/);
    });

    it('re-arms FIRST on every wake, then handles seat-owned lines', () => {
      expect(flat).toMatch(/re-arm first\*?\*?, with the same command, then handle each line whose `owner` is `seat`/);
    });

    it('matches the brief id AND the iteration on a re-read before any resolve', () => {
      expect(flat).toMatch(/before any resolve, re-read the row and match the brief id and the iteration/);
      expect(flat).toMatch(/match the brief id in `awaiting_human_ref`, its iteration and the reason/);
    });

    it('reminders repeat until handled; human-held items never wake the seat; --once lists them with their age', () => {
      expect(flat).toMatch(/reminders repeat\*?\*? every `--remind`/);
      expect(flat).toMatch(/items held for the human never wake you/);
      expect(skill.body).toContain('--once');
    });

    it('failures never end the watch: health offline, recovered and a catch-up from the cursor', () => {
      expect(flat).toMatch(/failures do not end the watch/);
      expect(flat).toMatch(/health offline/);
      expect(flat).toMatch(/health recovered/);
      expect(flat).toMatch(/never ends an `--until-event` wait/);
    });

    it('harmony watch status reports liveness', () => {
      expect(skill.body).toContain('harmony watch status --seat <name>');
    });

    it('the watch runs harness-backgrounded, never a shell `&` orphan', () => {
      expect(flat).toMatch(/run_in_background/);
      expect(flat).toMatch(/orphan dies with its shell/);
    });

    it('a follow tail takes the same lock, so it needs a different seat name', () => {
      expect(flat).toMatch(/`--follow`.*takes the same lock, so it needs a different `--seat` name/);
    });

    it('standing down deletes the seat profile, which turns off the B-1423 seat hooks', () => {
      expect(flat).toMatch(/seat-standdown v1.*then delete your seat profile, which turns off the seat hooks/);
      expect(flat).not.toMatch(/there are none yet/);
    });
  });

  describe('waits and seat hooks (B-1423)', () => {
    it('CI/PR/branch/promote waits use harmony await, with its exit codes and printed probe failures', () => {
      for (const sub of ['ci', 'pr', 'branch', 'promote']) expect(skill.body).toContain(`harmony await ${sub}`);
      expect(flat).toMatch(/\*\*0\*\* met, \*\*1\*\* can no longer be met, \*\*2\*\* fatal, \*\*3\*\* max wait passed/);
      expect(flat).toMatch(/every failed probe is printed/);
      expect(flat).not.toMatch(/until status == completed/);
    });

    it('describes the two seat hooks: session_id scope, write-first, stand-down, re-arm, unwatched rule', () => {
      expect(flat).toMatch(/only for a session named in a seat profile's `session_id:`/);
      expect(flat).toMatch(/write `session_id` first/);
      expect(flat).toMatch(/stand down = delete the profile/);
      expect(skill.body).toContain('harmony watch --seat <name> --milestone <m> --until-event');
      expect(flat).toMatch(/your last line must say this seat is unwatched/);
    });
  });

  describe('re-invocation semantics (B-917 design-gate addition)', () => {
    it('SAME-SESSION re-invocation piggybacks the ONE existing watch — never a second watch', () => {
      expect(flat).toMatch(/same-session re-invocation/);
      expect(flat).toMatch(/piggyback by design/);
      expect(flat).toMatch(/the new ticket joins the one existing watch/);
      expect(flat).toMatch(/never start a second one/);
    });

    it('the duplicate-conduction guard makes an overlapping create_conduction call refuse cleanly, so re-listing an already-shepherded ticket is harmless', () => {
      const tools = referencedHarmonyTools(skill.body);
      expect(tools).toContain('create_conduction');
      expect(flat).toMatch(/duplicate-conduction guard/);
      expect(flat).toMatch(/refuses cleanly/);
      expect(flat).toMatch(/harmless/);
    });

    it('one orchestrator seat per milestone, enforced by the watch lock and the seat-start marker', () => {
      expect(flat).toMatch(/one orchestrator seat per milestone/);
      expect(flat).toMatch(/two seats on the same tickets race reviews and resolves on the same briefs/);
      expect(flat).toMatch(/the watch lock and the seat-start marker enforce it/);
      expect(flat).toMatch(/refuses with exit 2 and names the pid that holds the lock/);
      expect(flat).toMatch(/the warning never blocks/);
    });

    it('the retired discipline-only wording is gone', () => {
      expect(flat).not.toMatch(/currently unguarded and dangerous/);
      expect(flat).not.toMatch(/grep sets and single cursor/);
      expect(flat).not.toMatch(/same conductor log/);
    });

    it('records a successor note: a future conductor-enforced repo-lane lock supersedes this section (§4)', () => {
      expect(flat).toMatch(/a future conductor-enforced repo-lane lock supersedes this section'?s prose/);
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
