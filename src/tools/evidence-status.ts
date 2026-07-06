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
// only when it has test cases AND every AC is checked AND a PR/merge/deploy
// comment trail is present.
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

export interface BuildEvidenceStatus {
  task_id: string;
  /** Task has >=1 non-archived child → it is an umbrella; evidence is carried by the children. */
  is_umbrella: boolean;
  /** >=1 test case recorded on the task. */
  has_test_cases: boolean;
  /** >=1 acceptance criterion AND every one of them is checked. */
  all_acs_checked: boolean;
  /** >=1 comment whose body matches the PR/merge/deploy/CI trail pattern. */
  has_comment_trail: boolean;
  /** Umbrella ⇒ true (exempt); else has_test_cases && all_acs_checked && has_comment_trail. */
  complete: boolean;
  /** Why the ticket is exempt from the evidence requirement, or null when it is not. */
  exempt_reason: string | null;
  /** Human-readable list of the missing pieces (only when !complete && !is_umbrella). */
  missing: string[];
}

export const getBuildEvidenceStatusTool = {
  name: 'get_build_evidence_status',
  description:
    "Read-only. The CANONICAL definition (single source of truth) of whether a conducted ticket carries the build evidence required by Verified. Derives — never writes — from the ticket's own records: `has_test_cases` (>=1 test case), `all_acs_checked` (>=1 acceptance criterion AND every one checked), `has_comment_trail` (>=1 comment mentioning a PR/merge/deploy/CI signal). `is_umbrella` is true when the task has >=1 non-archived child; an umbrella is EXEMPT (its evidence is carried by its children — e.g. a B-471 split-umbrella roll-up), so `complete` is true and `exempt_reason` is set. For a leaf ticket carrying its own build, `complete` = has_test_cases && all_acs_checked && has_comment_trail, and `missing` lists the gaps in human-readable form. Used by finish-work's verify brief to render a mechanical evidence-status line (like the B-516 release-brief risk signal) and reusable by the Decision Trail.",
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

  // The four reads are independent — fire them in parallel (mirrors get_task's enrichment).
  const [childrenRes, testCasesRes, acsRes, commentsRes] = await Promise.all([
    client.from('tasks').select('id, archived').eq('parent_task_id', resolvedId),
    client.from('test_cases').select('id').eq('task_id', resolvedId),
    client.from('acceptance_criteria').select('id, checked').eq('task_id', resolvedId),
    client.from('task_comments').select('content').eq('task_id', resolvedId),
  ]);
  if (childrenRes.error) throw childrenRes.error;
  if (testCasesRes.error) throw testCasesRes.error;
  if (acsRes.error) throw acsRes.error;
  if (commentsRes.error) throw commentsRes.error;

  const children = (childrenRes.data ?? []) as Array<{ id: string; archived: boolean | null }>;
  const testCases = (testCasesRes.data ?? []) as Array<{ id: string }>;
  const acs = (acsRes.data ?? []) as Array<{ id: string; checked: boolean | null }>;
  const comments = (commentsRes.data ?? []) as Array<{ content: string | null }>;

  const is_umbrella = children.some((c) => c.archived !== true);
  const has_test_cases = testCases.length >= 1;
  const all_acs_checked = acs.length >= 1 && acs.every((a) => a.checked === true);
  const has_comment_trail = comments.some((c) => typeof c.content === 'string' && COMMENT_TRAIL_RE.test(c.content));

  const complete = is_umbrella ? true : has_test_cases && all_acs_checked && has_comment_trail;
  const exempt_reason = is_umbrella ? 'umbrella — evidence carried by children' : null;

  const missing: string[] = [];
  if (!complete && !is_umbrella) {
    if (!has_test_cases) missing.push('test cases');
    if (!all_acs_checked) {
      const unchecked = acs.filter((a) => a.checked !== true).length;
      if (acs.length === 0) {
        missing.push('acceptance criteria (none created)');
      } else {
        missing.push(`${unchecked} unchecked acceptance criteria`);
      }
    }
    if (!has_comment_trail) missing.push('PR/merge/deploy comment trail');
  }

  return {
    task_id: resolvedId,
    is_umbrella,
    has_test_cases,
    all_acs_checked,
    has_comment_trail,
    complete,
    exempt_reason,
    missing,
  };
}
