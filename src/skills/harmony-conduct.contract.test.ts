import { describe, it, expect } from 'vitest';
import { readSkill, referencedHarmonyTools } from './skill-contract.js';
import { registerTools } from '../tools/index.js';

const REGISTERED = new Set(registerTools().map((t) => t.name));

describe('harmony-conduct skill contract', () => {
  const skill = readSkill('harmony-conduct');

  it('has valid frontmatter', () => {
    expect(skill.frontmatter.name).toBe('harmony-conduct');
    expect(skill.frontmatter.description).toBeTruthy();
  });

  it('references only real registered MCP tools', () => {
    for (const tool of referencedHarmonyTools(skill.body)) {
      expect(REGISTERED.has(tool), `unknown tool mcp__harmony__${tool}`).toBe(true);
    }
  });

  it('is scoped to the read-only conductor role (no code writes, no git mutation)', () => {
    // The conductor orchestrates plumbing; the gate skills it delegates to own the writes.
    expect(skill.frontmatter['disallowed-tools']).toMatch(/Write/);
    expect(skill.frontmatter['disallowed-tools']).toMatch(/git commit/);
  });

  it('CONTROLLED DEFAULT: the no-flag run pauses at every gate (the core contract, intact in 2b)', () => {
    const body = skill.body.toLowerCase();
    // The default (no flag) route pauses and surfaces every decision — unchanged from phase 2a.
    expect(body).toContain('pause');
    expect(body).toContain('every gate');
    // With no flag the skill does not auto-advance — phase 2b is strictly additive over the 2a default.
    expect(body).toMatch(/no .*--unattended|never.*auto-advance|does not\b.*auto-advance|not auto-advance/);
    // The controlled-default guarantee is stated explicitly.
    expect(body).toMatch(/controlled default|default.*controlled|behaviou?rally identical to phase 2a|identical.*to phase 2a/);
    // The phase boundary is still named so the lineage (2a core) and the later phases are unmistakable.
    expect(body).toContain('2a');
    expect(body).toMatch(/2b|2c|2d/);
    // The deterministic risk-class floor ships in 2c; only the quantitative *score* / breaker-tuning is
    // scoped OUT (2d+). The floor itself is now in-scope, so we assert the deferral is about the SCORE.
    expect(body).toContain('circuit-breaker');
    expect(body).toMatch(/risk score|numeric risk|quantitative risk/);
  });

  it('RISK-CLASS FLOOR (2c): a non-discretionary floor that names the risk classes it detects', () => {
    const body = skill.body.toLowerCase();
    // The four classes are named.
    for (const cls of ['auth', 'data-migration', 'irreversible-destructive', 'shared-core']) {
      expect(body, `risk-class floor missing class ${cls}`).toContain(cls);
    }
    // It reads risk_classes from the ticket and it is a non-discretionary floor (in --escalate).
    expect(body).toContain('risk_classes');
    expect(body).toMatch(/risk-class floor|risk class floor/);
    expect(body).toMatch(/non-discretionary/);
    // In --escalate the floor is dial-independent: fires at every dial level, beats the judgment.
    expect(body).toMatch(/dial-independent|every dial level|at every (dial )?level|regardless of .*dial/);
    // When it pauses (in --escalate), the pause names the class that tripped it.
    expect(body).toMatch(/name.*the class|which class|name the class\(es\)|name the risk class/);
  });

  it('B-516 FLOOR SCOPING: the floor PAUSES only in --escalate; in --unattended/--pause-at it is a RELEASE-BRIEF signal, not a mid-run pause', () => {
    const body = skill.body.toLowerCase();
    // The B-516 lineage is named.
    expect(skill.body).toContain('B-516');
    // The floor pauses ONLY in --escalate.
    expect(body).toMatch(/pauses?.*only in `?--escalate`?|only in `?--escalate`?.*pause|floor.*pauses? a delegated gate only in `?--escalate`?/);
    // In --unattended / --pause-at it does NOT pause mid-run.
    expect(body).toMatch(/does\s*\*?\*?not\*?\*?\s*pause|not.*pause mid-run|won'?t (stop|pause)/);
    expect(body).toMatch(/--unattended|--pause-at/);
    // Instead it is recorded + surfaced on the release brief.
    expect(body).toMatch(/release[- ]brief|release brief signal|surfaced? on the release brief|carried.*release brief/);
    // No exceptions — not even irreversible-destructive gets a mid-run pause in --unattended.
    expect(body).toMatch(/no exceptions/);
    expect(body).toMatch(/not even.*irreversible|even.*irreversible-destructive/);
    // The rationale is encoded: the hard floor (release+verify) already covers irreversibility.
    expect(body).toMatch(/nothing executes irreversibly before release|hard floor.*already.*irreversib|already covers irreversib/);
    // The release-brief signal is computed from the build's changed_paths (path-based, high-precision).
    expect(skill.body).toContain('changed_paths');
    expect(body).toMatch(/path-based|path-derived|high-precision/);
  });

  it('ESCALATE MODE (2c): --escalate auto-advances but surfaces gates worth a human opinion; cautious vetoes it', () => {
    const body = skill.body.toLowerCase();
    // The flag exists and is mutually exclusive with the other delegating flags.
    expect(body).toContain('--escalate');
    expect(body).toMatch(/--escalate.*mutually exclusive|mutually exclusive.*--escalate|--pause-at.*--unattended.*--escalate/);
    // It forms a qualitative judgment (no numeric threshold) over the drafted brief.
    expect(body).toMatch(/worth (a |an )?(human )?opinion|worth your (eyes|opinion)/);
    expect(body).toMatch(/qualitative|no numeric threshold|no.*threshold|no score/);
    // Judgment guidance signals are spelled out.
    expect(body).toMatch(/low-confidence|knowledge gap|closely-matched|near-tie|novel|precedent|stale.*knowledge|blast radius/);
    // Routine gate → decide-and-record via the SAME accept path (parity, no new write path).
    expect(body).toMatch(/decide-and-record|no new write path|same .*accept path|same routing/);
    // cautious forbids --escalate (kill-switch), announced.
    expect(body).toMatch(/cautious.*(forbid|veto|ignoring `--escalate`)|--escalate.*(forbid|veto)|vetoes? it/);
    // The floor sits UNDER the judgment: a risk-class hit floors a gate judged routine.
    expect(body).toMatch(/floor.*(under|beneath|beats).*judgment|judged routine.*still surfaced|floor beats judgment/);
  });

  it('PHASE-2B SELECTOR: opt-in per-run delegation via --pause-at / --unattended, never the system\'s call', () => {
    const body = skill.body.toLowerCase();
    // The two opt-in delegation flags exist.
    expect(body).toContain('--unattended');
    expect(body).toContain('--pause-at');
    // Delegation is opt-in per run — it is the human's conscious choice, never the conductor's inference.
    expect(body).toMatch(/opt-in per run|opt-in per-run|per-run delegation|human pass(ed|es) an explicit flag|conscious per-run choice/);
    // An auto-advanced gate synthesizes the human's accept and records the SAME decision a controlled run would.
    expect(body).toMatch(/synthesi[sz]e.*accept|auto-advance/);
    expect(body).toMatch(/same accepted|records? the same|identical to a human accept|parity/);
    // Bad input is an ERROR, never a silent delegation (the contract-1 guard).
    expect(body).toMatch(/mutually exclusive/);
    expect(body).toMatch(/unknown.*gate|misspelled.*gate|error.*never a silent|never a silent delegation/);
  });

  it('HARD FLOOR: release + verify are never auto-advanced, even unattended', () => {
    const body = skill.body;
    expect(body.toLowerCase()).toContain('hard floor');
    // Release and verify always require a human regardless of any flag.
    expect(body.toLowerCase()).toMatch(/release.*verify.*(never|always human|stay human|hard floor)|never auto-resolved/);
    expect(body.toLowerCase()).toMatch(/even .*--unattended|even unattended|always.*human/);
  });

  it('DIAL CEILING: a cautious workspace dial is a kill-switch that forbids all delegation (announced)', () => {
    const body = skill.body.toLowerCase();
    // The conductor reads the resolved workspace agent-trust dial via get_project.
    expect(referencedHarmonyTools(skill.body)).toContain('get_project');
    expect(body).toContain('agent_trust');
    // Cautious = kill-switch: forbids all delegation, run goes controlled, and it is ANNOUNCED (no silent no-op).
    expect(body).toContain('cautious');
    expect(body).toMatch(/kill-switch|forbids? all delegation|forbid.*delegation/);
    expect(body).toMatch(/announce|never silently|never a silent/);
    // The dial can only restrict (it is a ceiling), never expand the per-run flag.
    expect(body).toMatch(/ceiling|restrict-only|only restrict|never.*expand/);
  });

  it('NEVER resolves a brief itself — the human owns the decision at each gate', () => {
    // The conductor delegates resolution to the gate skills; it must not call resolve_brief.
    // The body explicitly states it never does so, but it must also not actually reference the tool
    // as something it calls. Assert the prohibition prose is present AND the tool is described as
    // delegated, not invoked by the conductor.
    expect(skill.body.toLowerCase()).toMatch(/never calls .*resolve_brief|does not (call|resolve)|conductor.*never.*resolve_brief|never.*resolve_brief/);
    expect(skill.body).toContain('resolve_brief'); // it references the concept (to forbid calling it)
  });

  it('is state-driven and resumable — memory lives in the ticket row, not the session', () => {
    const body = skill.body.toLowerCase();
    expect(body).toContain('resumable');
    expect(body).toMatch(/state-driven|ticket row|no state in the session|stateless between pauses/);
    // It re-reads the ticket to reconstitute, and re-running resumes.
    expect(referencedHarmonyTools(skill.body)).toContain('get_task');
    expect(skill.body).toContain('workflow_state');
    expect(skill.body).toContain('awaiting_human_input');
  });

  it('B-545: reads the canonical routing from harmony-shared/gate-routing.md (not a hand-copied map)', () => {
    // The routing FACTS (owning skill per gate, pure/side-effecting, hard floor) live in the shared
    // SSoT and are asserted in shared.test.ts. Here we assert the conductor REFERENCES that doc rather
    // than restating the gate table inline — removing the B-526 drift hazard B-545 targets.
    expect(skill.body).toContain('harmony-shared/gate-routing.md');
    // It reads that table keyed by workflow_state (its projection) and still names the forward path.
    expect(skill.body).toContain('workflow_state');
    for (const state of ['Proposed', 'Clarified', 'Decomposed', 'Designed', 'Planned', 'Built', 'Deployed', 'Verified']) {
      expect(skill.body, `missing forward state ${state}`).toContain(state);
    }
  });

  it('B-545: keeps its conduct-SPECIFIC handling inline (the deliberate divergence from harmony-next is NOT shared)', () => {
    const body = skill.body.toLowerCase();
    // Captured → auto-advance proposing as plumbing (the OPPOSITE of harmony-next's triage-stop).
    expect(skill.body).toContain('proposing');
    expect(body).toMatch(/auto-advance.*proposing|proposing.*plumbing|plumbing, not a pause/);
    // Decomposed split-umbrella → report-and-stop (the B-471/B-506 branch).
    expect(body).toMatch(/report-and-stop|split umbrella|report and stop/);
  });

  it('routes a Stale ticket to the patch author rather than advancing it', () => {
    expect(skill.body).toContain('harmony-stale-patch');
    expect(skill.body.toLowerCase()).toContain('stale');
  });

  it('B-519 REVISE-SCOPE: recognizes a back-up verb at a controlled pause AND surfaces an agent-proposed back-up on iterate — never reverts state itself', () => {
    const body = skill.body.toLowerCase();
    // The lineage is named.
    expect(skill.body).toContain('B-519');
    // It delegates to the revise-scope skill (both the gate-pause verb and the agent-proposed iterate path).
    expect(skill.body).toContain('harmony-revise-scope');
    expect(body).toMatch(/revise-scope|revise scope|back up|back-up/);
    // Gate-pause verb: alongside accept/edit/iterate/defer at the controlled pause.
    expect(body).toMatch(/back up.*at this pause|revise-scope.*\/ "?back up"?|alongside accept/);
    // Agent-proposed path: a recommendation the human accepts like any other — conductor never reverts state.
    expect(body).toMatch(/recommend|recommendation/);
    expect(body).toMatch(/conductor never reverts state|never reverts state itself|only a human accept executes/);
  });

  it('auto-advances proposing on a Captured ticket — plumbing, not a pause (B-490 F2)', () => {
    const body = skill.body;
    // Captured must be handled (it is the inbox state freshly-created tickets land in).
    expect(body).toContain('Captured');
    // The conductor advances proposing itself via advance_workflow — it does NOT compose a brief / pause.
    expect(referencedHarmonyTools(body)).toContain('advance_workflow');
    expect(body).toContain('proposing');
    // Scope the assertion to the Captured-handling step so a stray token elsewhere can't satisfy it:
    // the SAME paragraph must tie Captured → proposing → advance_workflow and frame it as no-pause plumbing.
    const capIdx = body.indexOf("workflow_state === 'Captured'");
    expect(capIdx).toBeGreaterThan(-1);
    const seg = body.slice(capIdx, capIdx + 900);
    expect(seg).toContain('proposing');
    expect(seg).toContain('advance_workflow');
    expect(seg.toLowerCase()).toMatch(/no .*pause|not a pause|plumbing/);
    // It must NOT try to file a clarifying brief from Captured (the transition-table gap that broke B-487).
    expect(seg).toContain('clarifying');
  });

  it('handles the null-brief verification-ack-pending umbrella without choking (B-471)', () => {
    const body = skill.body;
    expect(body).toContain('verification-ack-pending');
    expect(body.toLowerCase()).toContain('umbrella');
    expect(body).toContain('umbrella-auto-verify');
    // The verify gate delegates to finish-work, which composes the missing brief.
    expect(body).toContain('finish-work');
  });

  it('terminates on Verified / Parked / Cancelled and pauses everywhere else', () => {
    for (const terminal of ['Verified', 'Parked', 'Cancelled']) {
      expect(skill.body).toContain(terminal);
    }
    expect(skill.body.toLowerCase()).toMatch(/terminal/);
  });

  it('renders the progress overview INLINE — no TodoWrite dependency (F1)', () => {
    // F1: inline rendering is the design. TodoWrite is NOT an allowed tool — the conduct session
    // doesn't reliably have it, and the overview is a read-only derived view that needs no task-list tool.
    expect(skill.frontmatter['allowed-tools']).not.toMatch(/\bTodoWrite\b/);
    // The body must specify inline rendering as the design.
    expect(skill.body.toLowerCase()).toMatch(/render.*inline|inline.*render|print the checklist inline|inline is the design/);
    expect(skill.body.toLowerCase()).toContain('inline');
  });

  it('the progress overview is a DERIVED VIEW from the ticket row, not session-held state', () => {
    const body = skill.body.toLowerCase();
    // It must be explicitly derived/regenerated from the ticket row, and explicitly NOT session state.
    expect(body).toMatch(/derived view|derive(d)? .*from the ticket row|regenerate.*from .*workflow_state/);
    expect(body).toMatch(/not session.?held state|never session state|not.*session-held/);
    // Regeneration each iteration is the mechanism that keeps it resumable / non-drifting.
    expect(body).toMatch(/regenerate|regenerated/);
    expect(body).toContain('workflow_state');
    // A fresh re-run must reconstruct it identically from the ticket — no carried session memory.
    expect(body).toMatch(/identical|fresh re-?run/);
  });

  it('the progress overview renders the fixed forward path as the checklist', () => {
    const body = skill.body.toLowerCase();
    for (const phase of ['clarify', 'decompose', 'design', 'plan', 'build', 'release', 'verify']) {
      expect(body, `progress checklist missing phase ${phase}`).toContain(phase);
    }
    // Each item's status is derived from the current state: before = completed, current = in-progress,
    // later = pending.
    expect(body).toMatch(/in_progress|in-progress/);
    expect(body).toMatch(/completed/);
    expect(body).toMatch(/pending/);
  });

  it('the progress overview is rendered at the top of every loop iteration (after the re-read)', () => {
    const body = skill.body.toLowerCase();
    // It is tied to the get_task re-read at the top of the loop, on every iteration.
    expect(body).toMatch(/every iteration|each iteration/);
    expect(body).toMatch(/after the .*get_task|after the .*re-read|right after the .*re-read/);
  });

  it('B-485 AUTO-PICKUP: at a controlled pause the live session can bounded-poll get_task and consume a browser resolution', () => {
    const body = skill.body.toLowerCase();
    // The phase is named in the lineage.
    expect(skill.body).toContain('B-485');
    expect(body).toContain('auto-pickup');
    // It is a session-scoped poll-with-backoff (locked param D4). B-532 REFINED D4: a session-/window-scoped
    // background poll that DIES WITH THE SESSION is now permitted (the bundled dist/bin/poll.js, launched via
    // Bash(run_in_background)); a PERSISTENT / cross-session daemon is still excluded (v2). The guarantee the
    // test pins: session-scoped is OK, the watch dies with the session, and a cross-session daemon stays out.
    expect(body).toMatch(/session-held|session-scoped/);
    expect(body).toMatch(/dies with the session/);
    expect(body).toMatch(/persistent\s*\/?\s*cross-session daemon|cross-session daemon|persistent.*daemon.*v2|persistent.*daemon.*still/);
    expect(body).toMatch(/poll|polling/);
    expect(body).toMatch(/backoff/);
    // It polls get_task (the cheap detector) and reads the resolution.
    expect(referencedHarmonyTools(skill.body)).toContain('get_task');
    // On poll-window expiry it degrades to today's persist-and-resume (the no-session degradation).
    expect(body).toMatch(/poll-window expiry|window expir|watch window/);
    expect(body).toMatch(/no-session degradation|persists?.*on the ticket row|next .*run/);
  });

  it("B-485 ORTHOGONALITY: auto-pickup consumes the human's ACTUAL command and never synthesizes a decision", () => {
    const body = skill.body.toLowerCase();
    // Auto-pickup only changes WHERE the human answers (browser) — it does not delegate or decide.
    expect(body).toMatch(/orthogonal/);
    expect(body).toMatch(/actual.*command|actual.*resolution|human.*actual|actual.*browser/);
    expect(body).toMatch(/never makes a decision the human did ?n'?t make|does not.*synthesize|never.*synthesize/);
    // The two detectable browser outcomes: a state-advance (accept/defer) and a pending_resolution (reshape).
    expect(body).toContain('pending_resolution');
    expect(body).toMatch(/state advanced|state-advance|advanced/);
  });

  it('B-485 RESHAPE: a browser reshape runs the LLM iterate (re-compose in place, iteration+1, ball back to the human)', () => {
    const body = skill.body.toLowerCase();
    // The reshape marker shape + the iterate run.
    expect(body).toContain('iterate');
    expect(body).toMatch(/reshape/);
    // The LLM iterate re-composes the brief; the conductor references compose_brief as the gate skill's path.
    expect(skill.body).toContain('compose_brief');
    expect(body).toMatch(/iteration\s*\+?\s*1|iteration\+1|bumps?.*iteration|iteration.*\+/);
    // After the re-compose the ball returns to the human (awaiting_human_input=true ⇒ 'Needs human').
    expect(skill.body).toContain('awaiting_human_input');
    expect(body).toMatch(/needs human/);
    // The marker is cleared so it is not re-consumed.
    expect(body).toMatch(/clear.*pending_resolution|pending_resolution.*clear|not.*re-consumed/);
  });

  it('B-485 HARD FLOOR (AC7): release/verify are consumed ONLY from a human browser resolution, never synthesized; side effects run in-session', () => {
    const body = skill.body.toLowerCase();
    // Even with auto-pickup, release/verify are never conductor-synthesized.
    expect(body).toMatch(/release\/verify|release.*verify/);
    expect(body).toMatch(/only.*human-submitted|human-submitted.*resolution|human browser-accept|human is the one accepting|human .*the one accepting/);
    expect(body).toMatch(/never.*conductor-synthesi[sz]ed|never.*synthesi[sz]e/);
    // A human's browser-accept of a side-effecting gate triggers its side effect in the running session via finish-work.
    expect(skill.body).toContain('finish-work');
    expect(body).toMatch(/in.?session|running session/);
    expect(body).toMatch(/merge \+ deploy|merge\+deploy|merge and deploy/);
  });

  it("B-461 DISCUSS VERB: 'discuss <remark>' joins the controlled-pause verb set and routes to the owning gate skill; brief resolution suspends while a discussion is open", () => {
    const body = skill.body;
    const lower = body.toLowerCase();
    // The lineage is named.
    expect(body).toContain('B-461');
    // The verb joins the §4 enumeration alongside accept/defer/edit/iterate (both prose spots share
    // the slash-list shape; pin the phrase, not a location).
    expect(lower).toMatch(/accept\/defer\/edit\/iterate\/`?discuss/);
    expect(body).toMatch(/discuss\s+<remark>/);
    // Routing: the conductor delegates to the OWNING gate skill to open the exchange, per the ONE
    // canonical home (consumed by reference, never restated).
    expect(lower).toMatch(/owning gate skill/);
    expect(body).toContain('harmony-shared/elicitation-engine.md');
    expect(body).toMatch(/The discuss trigger/);
    // While a discussion is open, brief resolution is suspended — the escapes are offered instead.
    expect(lower).toMatch(/brief resolution is suspended/);
    expect(lower).toMatch(/force-quit/);
    expect(lower).toMatch(/\bcancel\b/);
  });

  it('B-461 CONSUME CASES: §4c classifies BOTH discuss-requested and discussion-cancelled (pinned on the trigger names + semantics, never case numbers)', () => {
    const body = skill.body;
    // discuss-requested: the discuss marker is present → route to the owning gate skill to open the
    // exchange and file round 1 (which consumes the marker). Scope the assertions to the consume-case
    // paragraph (its bolded heading) so a stray token elsewhere can't satisfy them.
    const dr = body.indexOf('**`discuss-requested`');
    expect(dr, 'missing the discuss-requested consume case').toBeGreaterThan(-1);
    const drSeg = body.slice(dr, dr + 900).toLowerCase();
    expect(drSeg).toMatch(/command: 'discuss'/);
    expect(drSeg).toMatch(/owning gate skill/);
    expect(drSeg).toMatch(/open the discussion exchange|open the exchange/);
    expect(drSeg).toMatch(/file round 1/);
    expect(drSeg).toMatch(/consumes the marker|clears `?pending_resolution`?/);
    // discussion-cancelled: a mechanical cancel restored the brief — the ONE exit that fires WITHOUT
    // the flag's true→false transition; consume = re-read, resume the pause on the untouched brief,
    // re-arm the watch.
    const dc = body.indexOf('**`discussion-cancelled`');
    expect(dc, 'missing the discussion-cancelled consume case').toBeGreaterThan(-1);
    const dcSeg = body.slice(dc, dc + 900).toLowerCase();
    expect(dcSeg).toMatch(/without the flag|true→false/);
    expect(dcSeg).toMatch(/re-read/);
    expect(dcSeg).toMatch(/untouched brief/);
    expect(dcSeg).toMatch(/re-arm the watch/);
  });
});
