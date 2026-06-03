---
name: harmony-research
description: Fill a load-bearing knowledge gap via the v1 human-relayed research hand-off. Triggers on "research X", "harmony research", "I don't know enough about Y", or when a gate skill hits a load-bearing gap. Emits concrete research prompts for the human to run in their tool of choice, then ingests the pasted result as Asserted knowledge (never auto-Accepted).
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Research

Implements the cross-cutting `researching` activity (state-machine §4 item 13; agent-model §7.2; B-329).
It does **not** advance ticket state — it acquires knowledge to *unblock* a gate (`clarifying` /
`designing` / `planning`) when a **load-bearing** gap is present. v1 is a human relay:
*confidently-wrong-from-a-bad-source is worse than "I don't know,"* so researched knowledge enters
**Asserted** with a `review_by` and is promoted to Accepted only by a human/check — never auto-Accepted.

## Flow

### 1. Frame the gap

State precisely what is unknown and which `domain` it sits in, and why it's load-bearing (impact ×
ignorance — agent-model §7.2). If the gap is mild, you probably don't need research: recommend with low
confidence instead and return to the gate skill.

### 2. Emit concrete research prompts (lead with them)

Produce 1–3 specific, runnable research prompts (for Perplexity / a deep-research tool / Claude). Make
them concrete enough to paste verbatim. **Never bury these behind `expand`** — they are the headline.
Display them and ask the human to run them and paste the results back.

```
I don't have enough `operations` knowledge to decide this. Please run these and paste the answers:

1. "How does <project>'s CI handle PRs that target an integration branch vs main? ..."
2. "What is the rollback procedure for a failed Supabase migration deploy? ..."
```

### 3. Ingest the pasted result as Asserted knowledge

Transform the human's pasted answer into knowledge entries with **research provenance** and a freshness
date. A finding that is a durable decision/spec → `record_decision`; a discrete relational fact →
`assert_fact`. Both with `source_type: "research"` and a `review_by`.

v1 default `review_by`: **90 days from today** (researched knowledge decays faster than seeded
operational truth — promote or re-check within the quarter). Compute the ISO date (today + 90 days) and
pass it directly — Phase A Task A4 added `review_by` to both `record_decision` and `assert_fact`. Pick
the entry's `domain` from the gap.

```
mcp__harmony__record_decision({
  type: "specification",
  title: "<subject>: researched finding",
  content: "<the finding, with the source/citation the human pasted>",
  domain: ["operations"],
  source_type: "research",
  status: "Asserted",            // explicit — never Accepted from research
  review_by: "<today + 90 days, ISO>",
  source_activity: "research",
  source_task_id: "<task uuid>",
})
```

For a discrete fact instead:

```
mcp__harmony__assert_fact({
  subject_entity: "<entity>", predicate: "<relation>", object: "<value>",
  source_type: "research", domain: ["data"], confidence: 0.6,
  review_by: "<today + 90 days, ISO>",
})
```

The entry lands **Asserted with a `review_by`** — exactly the invariant the skill exists to uphold
(agent-model §7.2; knowledge-model-v1 §3). It is never auto-Accepted.

### 4. Record the activity (no state change)

```
mcp__harmony__advance_workflow({ task_id, activity: "researching" })
```

This records that researching happened (the guard keeps the state unchanged for `researching`).

### 5. Return to the gate

Tell the calling skill the gap is now filled (Asserted) and it can re-query knowledge and resume its
decision. Remind the human these entries are Asserted — they should be reviewed/promoted before agents
act on them autonomously.
