# Knowledge search admission

Search applies two distinct relevance checks. Each lexical candidate needs
`word_similarity(query, title + content) >= 0.3`; each semantic candidate needs
cosine distance `<= 0.7`. Admission happens before route ranks are assigned.
Only admitted candidates contribute to reciprocal rank fusion (`k = 60`), whose
secondary score cutoff remains `0.0125`. Equal strengths use source kind and ID;
legacy knowledge RPCs use ID. Bookkeeping precedence remains unchanged.

The initial semantic bound was checked against production on 2026-10-23:
`zxqv plorth wimbleflax` had nearest distance 0.76025 and another nonsense control
had 0.74230. Useful queries had nearest distances 0.49–0.66; a worker-coordination
paraphrase had 0.57665. This is an initial precision/recall bound, not a relevance
probability. The stricter question-priority distance of 0.35 is independent.

`relevance_admission` reports the database's shared numeric policy plus per-route
`enforced`, `unknown`, or `not-run`. Missing policy capability on an older database
leaves search usable and marks enforcement unknown; it never claims the new floor
was applied. `score_cutoff`, coverage and route diagnostics remain separate.
The additive `knowledge_search_admission` RPC supplies policy even for empty
answers. Existing search RPC argument/return shapes are unchanged.

`definitions_included` is true when the definitions route successfully participates
in this answer, including a valid empty definition result. It is false when filters
exclude that class, the route fails, or storage is unavailable. Consult
`routes_tried` to distinguish those cases. `definitions_available` is a deprecated
alias with identical meaning; it is not an installation-wide capability flag.

Land the web migration before the plugin change. The plugin tolerates absent policy
metadata while staging workers still read production, before deliberate promotion.
Candidate ceilings, scheduling and route budgets are outside this change (B-1253).
