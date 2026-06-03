# Knowledge-query discipline (agent-model §7)

Every Harmony discovery/build skill rests on this. Follow it before proposing any action.

## The rule

**Before proposing any action in a domain, query workspace knowledge filtered by `domain`. If no
relevant entry exists, surface the gap explicitly — do not silently guess.**

Use `mcp__harmony__query_knowledge({ domain: [...] , search: "..." })`. Pick the domain subset from
what you're deciding about:

| Deciding about… | Query `domain` | Why |
|---|---|---|
| CI / deploy / branches / infra | `operations` | The B-60 deploy-flow failure: acting on a wrong belief. |
| Data / analytics / what-lives-where | `data` | Wrong data knowledge fails *silently* — wrong numbers get acted on. |
| Code architecture / patterns | `engineering` | Keeps code consistent with the codebase. |
| User behaviour / business rules / feature semantics | `product` | Don't infer product behaviour from code. |
| Customer-specific facts | `customer` | Can't be derived from artifacts. |
| How-we-work conventions | `process` | Review style, comms norms. |

The six domains: `engineering`, `operations`, `data`, `product`, `customer`, `process`.

## Surface gaps — and calibrate by impact × ignorance

When you find no entry you *should* be answering from knowledge, flag it. Then calibrate:

- **Mild gap** → recommend with explicit low confidence:
  `**Recommend (low confidence — no \`operations\` knowledge for X yet):** …` and put it in the brief
  `recommend` field with `confidence: 'low'`.
- **Load-bearing gap** (high-impact / Type-1 decision you're genuinely out of depth on) →
  **research-first**: set `load_bearing_gap: true` on the brief doc, put the concrete research prompts
  in `research[]`, mark the decision items `deferred: true`, and **lead with the research ask** — never
  bury it behind `expand`. Then invoke `/harmony-research` to run the relay. (The gate-ui-conductor §3.2
  lint enforces this: a load-bearing brief with no research, or still asking a substantive decision, fails to compose.)

"I don't know" is never the end state: fill the gap (write knowledge), accept the guess as precedent,
or trigger research.

## Deferral is knowledge (§5a — "parked with an alarm clock")

When the human **defers** a brief (the `defer` command), a "not now" is itself a decision worth keeping —
knowledge-model-v1 §5a is locked: a deferral **writes a `knowledge_decisions` deferral entry** (the
rationale + a `review_by`/watch date), so it outlives the ticket and resurfaces. So in **every** skill's
`defer` path, BEFORE calling `resolve_brief({ command: 'defer' })`, author the deferral:

```
const deferral = mcp__harmony__record_decision({
  type: "deferral",
  title: "<ticket>: deferred — <one-line why>",
  content: "<the rationale: what we're NOT doing now, and the condition/date to revisit>",
  review_by: "<watch/revisit date, ISO>",     // the alarm clock; added to record_decision by Task A4
  domain: [ /* the domain(s) the deferral touches */ ],
  source_type: "manual",
  source_activity: "defer",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })   // parks the ticket
```

**Graceful fallback (B-352).** A defer with **no rationale still parks** — never hard-block the human's
"not now." If the human gives no rationale, **prompt once** ("what should we revisit, and when?") but if
they decline, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
'defer' })`. The authoring is best-effort; the park is guaranteed.

**Documented asymmetry (reconciliation contract §4.3 / F4).** The **web** `defer` (P5) is
**mechanical-only** — it parks via `resolve_brief` but does **NOT** author the deferral entry (authoring
needs LLM judgment, which the web doesn't run). So a deferral made from the web queue is lossy in exactly
the §5a sense; only a skill-side `defer` writes the deferral knowledge. This is the known v1 consequence of
"web = mechanical, skill = LLM."
