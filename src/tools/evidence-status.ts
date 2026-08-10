import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

// ===========================================================================
// CONDUCTOR BUILD-EVIDENCE STATUS (B-560).
//
// The CANONICAL, single-source-of-truth definition of "does this conducted
// ticket carry the build evidence we require by Verified?" — a deterministic,
// read-only derivation over the ticket's own records (test cases, acceptance
// criteria, comments, children). It is NOT a judgment and never writes.
//
// WHY a tool (the GUARANTEE half of B-560): the gate SKILLS instruct the main
// session to LAND the evidence (record test cases + check ACs at build; comment
// the PR→merge→deploy trail at release; comment the verify result at verify).
// But a skill instruction is only as reliable as the session reading it. This
// tool makes the requirement self-enforcing: finish-work's verify brief ALWAYS
// renders an evidence-status line computed from here — mechanical by
// construction, exactly like the B-516 release-brief risk signal. So a missing
// piece is surfaced on the brief the human accepts at the (always-controlled)
// verify gate, regardless of delegation mode.
//
// UMBRELLA EXEMPTION (AC4): a ticket with >=1 non-archived child is an umbrella
// — its build evidence is carried by its children (the B-471 roll-up reaches a
// split umbrella to Deployed without it doing its own build), so the evidence
// requirement does NOT apply. `complete` is true and `exempt_reason` explains
// why. A leaf ticket (no children) that carries its own build is `complete`
// only when it has test cases AND every AC is checked AND a verified pushed-PR
// reference is recorded (`field_values.build_pr`).
//
// PUSHED-PR KEYING (B-722): completeness keys on `has_pushed_pr` — a structured
// reference the build gate records in `tasks.field_values.build_pr` ONLY from
// live-verified push/PR outputs (start-work O3's artefact step). The old
// comment-keyword gate false-greened B-713's phantom build (the word "PR" in an
// unrelated comment passed a ticket with zero persisted code). This derivation
// cannot call GitHub — the recorded ref is the DB-visible proof — so the step
// that opens the PR and the check that verifies it are one mechanism.
// `has_comment_trail` is still computed and reported, but it is informational
// and no longer gates `complete`.
//
// DECISION-ONLY EXEMPTION (B-681): a ticket carrying the `decision-only` label
// has no PR/tests by design — it completes via the deliverable-gate fast-forward
// (Clarified/Designed → Verified) and its evidence IS the Accepted decision
// knowledge. Same exemption shape as the umbrella; umbrella keeps precedence
// when both apply (children carrying evidence is the more specific claim).
//
// Reusable by the Decision Trail: the same derivation can render the evidence
// status anywhere the trail wants it, without re-implementing the definition.
// ===========================================================================

// A comment counts as part of the build→release→verify trail when its body mentions a
// PR / pull request / merge / deploy / CI signal or references a PR number (#123).
//
// NOTE on the regex (vs the B-560 design's literal `/\b(pr|pull request|merg|deploy|ci|#\d+)\b/i`):
// the literal form's TRAILING `\b` defeats its own stated intent — `merg\b` / `deploy\b` do
// NOT match "merged" / "deployed" / "deploying" (a letter follows the stem, so there is no word
// boundary), which are the exact words a real trail uses. We implement the design's INTENT: `pr`
// / `pull request` / `ci` are whole tokens (bounded both ends, so `ci` never trips on "specific"),
// while `merg`/`deploy` are STEMS that carry inflections (`merg\w*` / `deploy\w*`). `#\d+` keeps
// matching a PR-number reference adjacent to a word char (e.g. "PR#421"). Verified by running the
// detector over real trail phrasings (true positives) + benign comments (no false positives).
const COMMENT_TRAIL_RE = /\b(?:prs?|pull requests?|ci|merg\w*|deploy\w*|#\d+)\b/i;

/**
 * B-747 — the CONTRACT this tool depends on from harmony-web's `task_criteria_floor_status`.
 *
 * The acceptance-criteria floor is enforced in TWO places that must agree: the substrate trigger
 * (`tasks_workflow_guard`, which calls this function directly) and this tool (which reads it for
 * `has_acceptance_criteria`, and which every gate pre-check consults). "One definition" is only true if
 * the plugin's dependency on that definition is PINNED — otherwise a rename on the SQL side degrades this
 * tool to its local fallback and the two silently stop agreeing.
 *
 * So the dependency is named here rather than inlined as string literals, `criteria-floor-contract.test.ts`
 * asserts every field of it, and `readCriteriaPresence` THROWS when a returned row does not match.
 *
 * The counterpart assertions live in harmony-web `supabase/tests/b747_criteria_floor.test.sql` (run via
 * `npm run test:db:b747-criteria-floor`). That pair — this file's test and that SQL test — IS the contract
 * test. Note the residual honestly: the two case tables are kept in step by whoever edits either side, not
 * by a mechanism, because the repos are separate. What IS mechanical is that a shape divergence throws
 * here instead of degrading.
 */
export const CRITERIA_FLOOR_CONTRACT = {
  /** The SQL function that is the single authority. */
  rpc: 'task_criteria_floor_status',
  /** Its only argument. */
  arg: 'p_task_id',
  /** The column this tool reads. A rename here MUST break a test, never degrade silently. */
  presenceColumn: 'has_criteria',
  /** Read by the gate pre-checks to honour an exemption without re-deriving it. */
  exemptColumn: 'is_exempt',
  exemptReasonColumn: 'exempt_reason',
  /**
   * Presence means >=1 criterion, checked state IRRELEVANT. It is emphatically NOT "all checked" —
   * that is B-560's deliberately deferred evidence predicate, and flooring on it would refuse every
   * legitimately in-progress build (B-747 itself would have blocked its own build).
   */
  presenceCountsUncheckedCriteria: true,
  /** When a ticket is both an umbrella and decision-only, umbrella wins in `exempt_reason`. */
  exemptPrecedence: ['umbrella', 'decision-only'],
  /** The ONE SQLSTATE that may degrade to a local read: the function is absent (pre-migration). */
  degradableSqlState: '42883',
} as const;

export interface BuildEvidenceStatus {
  task_id: string;
  /** Task has >=1 non-archived child → it is an umbrella; evidence is carried by the children. */
  is_umbrella: boolean;
  /** Task carries the `decision-only` label → its evidence is the Accepted decision knowledge (B-681). */
  is_decision_only: boolean;
  /** >=1 test case recorded on the task. */
  has_test_cases: boolean;
  /** >=1 acceptance criterion AND every one of them is checked. */
  all_acs_checked: boolean;
  /**
   * B-747 — PRESENCE only: >=1 acceptance criterion, checked state IRRELEVANT. This is the criteria
   * FLOOR's predicate, and it is deliberately distinct from `all_acs_checked`: that stricter test is
   * B-560's explicitly DEFERRED evidence predicate, and flooring on it would refuse every legitimately
   * in-progress build. Read from the `task_criteria_floor_status` SQL function — the same authority the
   * substrate guard calls — so the floor cannot mean two different things in two places.
   */
  has_acceptance_criteria: boolean;
  /** >=1 comment whose body matches the PR/merge/deploy/CI trail pattern. Informational — no longer gates `complete` (B-722). */
  has_comment_trail: boolean;
  /** A verified pushed-PR reference is recorded: `field_values.build_pr` with non-empty branch + head_sha + pr_url (B-722). */
  has_pushed_pr: boolean;
  /** Umbrella or decision-only ⇒ true (exempt); else has_test_cases && all_acs_checked && has_pushed_pr. */
  complete: boolean;
  /** Why the ticket is exempt from the evidence requirement, or null when it is not. */
  exempt_reason: string | null;
  /** Human-readable list of the missing pieces (only when !complete && !is_umbrella). */
  missing: string[];
}

export const getBuildEvidenceStatusTool = {
  name: 'get_build_evidence_status',
  description:
    "Read-only. The CANONICAL definition (single source of truth) of whether a conducted ticket carries the build evidence required by Verified. Derives — never writes — from the ticket's own records: `has_test_cases` (>=1 test case), `all_acs_checked` (>=1 acceptance criterion AND every one checked), `has_pushed_pr` (a verified pushed-PR reference recorded by the build gate in `tasks.field_values.build_pr` — non-empty branch + head_sha + pr_url; B-722), and `has_comment_trail` (>=1 comment mentioning a PR/merge/deploy/CI signal — INFORMATIONAL only; it no longer gates completeness, killing the B-713 keyword false-green). `is_umbrella` is true when the task has >=1 non-archived child; an umbrella is EXEMPT (its evidence is carried by its children — e.g. a B-471 split-umbrella roll-up), so `complete` is true and `exempt_reason` is set. `is_decision_only` is true when the task carries the `decision-only` label; it is likewise EXEMPT (B-681 — the ticket completes via the deliverable-gate fast-forward and its evidence IS the Accepted decision knowledge); umbrella keeps precedence in `exempt_reason` when both apply. For a leaf ticket carrying its own build, `complete` = has_test_cases && all_acs_checked && has_pushed_pr, and `missing` lists the gaps in human-readable form. Used by finish-work's verify brief to render a mechanical evidence-status line (like the B-516 release-brief risk signal) and reusable by the Decision Trail. B-747 adds `has_acceptance_criteria` — PRESENCE only (>=1 criterion, checked state irrelevant), read from the `task_criteria_floor_status` SQL function that the substrate transition guard also calls, so the acceptance-criteria FLOOR has one definition rather than two. It is deliberately NOT `all_acs_checked` (that stricter predicate is B-560's deferred evidence test and would refuse every in-progress build); the build and verify gates pre-check THIS field before attempting their transition, so a refusal reaches the human as an answerable question instead of a raised database exception.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
    },
    required: ['task_id'],
  },
};

export async function getBuildEvidenceStatus(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
): Promise<BuildEvidenceStatus> {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);

  // The six reads are independent — fire them in parallel (mirrors get_task's enrichment).
  const [childrenRes, taskRowRes, testCasesRes, acsRes, commentsRes, labelsRes] = await Promise.all([
    client.from('tasks').select('id, archived').eq('parent_task_id', resolvedId),
    client.from('tasks').select('field_values').eq('id', resolvedId),
    client.from('test_cases').select('id').eq('task_id', resolvedId),
    client.from('acceptance_criteria').select('id, checked').eq('task_id', resolvedId),
    client.from('task_comments').select('content').eq('task_id', resolvedId),
    client.from('task_labels').select('labels(name)').eq('task_id', resolvedId),
  ]);
  if (childrenRes.error) throw childrenRes.error;
  if (taskRowRes.error) throw taskRowRes.error;
  if (testCasesRes.error) throw testCasesRes.error;
  if (acsRes.error) throw acsRes.error;
  if (commentsRes.error) throw commentsRes.error;
  if (labelsRes.error) throw labelsRes.error;

  const children = (childrenRes.data ?? []) as Array<{ id: string; archived: boolean | null }>;
  const taskRows = (taskRowRes.data ?? []) as Array<{ field_values: Record<string, unknown> | null }>;
  const testCases = (testCasesRes.data ?? []) as Array<{ id: string }>;
  const acs = (acsRes.data ?? []) as Array<{ id: string; checked: boolean | null }>;
  const comments = (commentsRes.data ?? []) as Array<{ content: string | null }>;
  // supabase-js types the to-one `labels(name)` embed as an array — cast through unknown (house pattern).
  const labelRows = (labelsRes.data ?? []) as unknown as Array<{ labels: { name: string | null } | null }>;

  const is_umbrella = children.some((c) => c.archived !== true);
  const is_decision_only = labelRows.some((l) => l.labels?.name === 'decision-only');
  const has_test_cases = testCases.length >= 1;
  const all_acs_checked = acs.length >= 1 && acs.every((a) => a.checked === true);
  const has_comment_trail = comments.some((c) => typeof c.content === 'string' && COMMENT_TRAIL_RE.test(c.content));

  // B-722: the pushed-PR reference the build gate records from live-verified outputs.
  // Well-formed = non-empty branch + head_sha + pr_url; anything less reads as absent.
  const buildPr = taskRows[0]?.field_values?.['build_pr'] as
    | { branch?: unknown; head_sha?: unknown; pr_url?: unknown }
    | null
    | undefined;
  const has_pushed_pr =
    typeof buildPr?.branch === 'string' &&
    buildPr.branch.length > 0 &&
    typeof buildPr?.head_sha === 'string' &&
    buildPr.head_sha.length > 0 &&
    typeof buildPr?.pr_url === 'string' &&
    buildPr.pr_url.length > 0;

  // B-747 — the criteria FLOOR's presence bit, read from the SQL function that is also what
  // `tasks_workflow_guard` calls, so the floor has exactly one definition across the substrate and the
  // plugin. Degrades to the local computation on SQLSTATE 42883 (undefined_function) ONLY — see
  // readCriteriaPresence for why a broader catch would fail OPEN.
  const has_acceptance_criteria = await readCriteriaPresence(client, resolvedId, acs.length >= 1);

  const exempt = is_umbrella || is_decision_only;
  const complete = exempt ? true : has_test_cases && all_acs_checked && has_pushed_pr;
  // Umbrella keeps precedence when both apply — children carrying evidence is the more specific claim.
  const exempt_reason = is_umbrella
    ? 'umbrella — evidence carried by children'
    : is_decision_only
      ? 'decision-only — the Accepted decision knowledge is the evidence'
      : null;

  const missing: string[] = [];
  if (!complete && !exempt) {
    if (!has_test_cases) missing.push('test cases');
    if (!all_acs_checked) {
      const unchecked = acs.filter((a) => a.checked !== true).length;
      if (acs.length === 0) {
        missing.push('acceptance criteria (none created)');
      } else {
        missing.push(`${unchecked} unchecked acceptance criteria`);
      }
    }
    if (!has_pushed_pr) missing.push('pushed PR reference (no verified branch/PR recorded)');
  }

  return {
    task_id: resolvedId,
    is_umbrella,
    is_decision_only,
    has_test_cases,
    all_acs_checked,
    has_acceptance_criteria,
    has_comment_trail,
    has_pushed_pr,
    complete,
    exempt_reason,
    missing,
  };
}

/**
 * B-747 — read the criteria-floor presence bit from `task_criteria_floor_status`, the single authority
 * the substrate guard also calls.
 *
 * FAIL-CLOSED ERROR HANDLING, and the distinction matters. Exactly ONE condition may degrade to the
 * caller's locally-computed value: SQLSTATE **42883** (`undefined_function`), which means this
 * environment predates the B-747 migration. That degrade is required rather than optional — the
 * Conductor Daemon runs plugin `main` against the PROD board by default (`HARMONY_PLUGIN_POSTURE`
 * defaulting to `main`, `HARMONY_TARGET=prod` in container/entrypoint.sh + provision.sh), bypassing the marketplace pin that
 * normally enforces B-383, so this code legitimately runs against a database that lacks the function
 * during the merge-to-promote window.
 *
 * EVERY other error propagates. A generic catch here would swallow a `42501` privilege denial, or an
 * error raised inside the function, and report "criteria present" for a ticket the authority would have
 * blocked — turning the floor into a hole at precisely the moment something is wrong. A floor that opens
 * when it malfunctions is not a floor.
 *
 * The local fallback is free: the caller has already queried the criteria rows.
 */
async function readCriteriaPresence(
  client: SupabaseClient,
  taskId: string,
  localPresence: boolean,
): Promise<boolean> {
  const { data, error } = await client.rpc(CRITERIA_FLOOR_CONTRACT.rpc, {
    [CRITERIA_FLOOR_CONTRACT.arg]: taskId,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '42883') return localPresence; // pre-migration environment — no floor to enforce yet
    throw error;
  }

  // RETURNS TABLE ⇒ an array of one row.
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;

  // NO ROW: the function ran and said nothing about this task. Degrade to the local read rather than
  // inventing a `false` that would refuse a ticket the authority never actually judged.
  if (row === null || row === undefined) return localPresence;

  // A ROW WITH THE WRONG SHAPE IS A CONTRACT VIOLATION, NOT A DEGRADE. If the presence column is ever
  // renamed or dropped on the SQL side, silently substituting the local read would hide the break: the
  // plugin would keep answering plausibly while no longer consulting the authority at all — a floor that
  // has quietly stopped being one. Throw, so the divergence is visible the first time it happens.
  const presence = row[CRITERIA_FLOOR_CONTRACT.presenceColumn];
  if (typeof presence !== 'boolean') {
    throw new Error(
      `${CRITERIA_FLOOR_CONTRACT.rpc} returned a row without a boolean \`` +
        `${CRITERIA_FLOOR_CONTRACT.presenceColumn}\` (got ${JSON.stringify(row)}). The plugin and the SQL ` +
        `function have DIVERGED — reconcile against harmony-web ` +
        `supabase/migrations/*_b747_acceptance_criteria_floor.sql and its ` +
        `supabase/tests/b747_criteria_floor.test.sql.`,
    );
  }
  return presence;
}
