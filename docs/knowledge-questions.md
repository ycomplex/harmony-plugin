# Unresolved knowledge questions

A question is an existing specification entry with versioned `madr.question`
metadata. `question_state` is **open**, **parked**, or **decided**. Acceptance
acknowledges that the question exists; it does not supply an answer. A question
never claims that its theme shipped. Its realization stays `agreed`.
Question writes use the shared portable claim envelope. Pass `--claim` to author
a one-sentence claim; omitted claims are explicitly derived proposals. Import
previews carry derived claims and retain their source excerpts. Content edits
preserve an existing authored claim unless explicitly replaced.

Create a question with explicit scope. Subject domains default to `product`;
pass `--domain engineering,data` when those are the question’s subjects. Domain
filters apply before search ranking and limits; scope remains a separate axis:

```sh
harmony knowledge questions save --state open --scope product \
  --title 'How should several schedulers share work?' --content 'The routing policy is undecided.'
harmony knowledge list --question-state open
harmony knowledge list --search 'several schedulers'
```

Search uses the existing hybrid retrieval route. Within the returned page, open
or parked questions precede other matches in the same bookkeeping partition,
and carry `answer: "not yet decided"`. This transitional page-local ordering
cannot guarantee topic relevance or priority before the result limit. It does
not manufacture scores. B-1223 owns relevance-gated question ranking and
composed search filters in the single shared candidate pool (acceptance criterion
`e97dafdb-264d-4e55-bd69-c23ab683d08d`).

Read a question immediately before changing it. Use its `updated_at` token:

```sh
harmony knowledge get <question-id>
harmony knowledge questions save --id <question-id> --state decided \
  --expected-updated-at '<read timestamp>' --decision <accepted-decision-id>
```

The resulting decision must already be Accepted, be a non-question, and belong
to the same project. State and the existing `superseded_by` edge change in one
transaction. A decided question is Superseded; the decision's realization is
untouched. Existing supersession history and stale-reference behavior apply.
To reopen a decided question, pass `--reopen` and a fresh timestamp. This removes
its resulting link atomically while retaining event history.

MCP exposes the same shared handlers through `save_knowledge_question`,
`preview_knowledge_questions`, and `import_knowledge_questions`.
`query_knowledge` supports `question_state` on structured lists. Combining
`search` with `question_state` fails explicitly and names B-1223; use a
filter-only list until shared ranking lands. `get_knowledge_entry` shows the
question state, answer and resulting decision. Existing search RPC signatures
and ordinary array result shapes remain unchanged; question fields are additive.
Question save/import fail visibly when their database capability is absent.
Permission and transport errors remain errors. No alternate question search
route or coverage-warning callback is introduced.

## Reviewed milestone ingestion

```sh
harmony --json knowledge questions preview <milestone-id> > preview.json
# Review every source excerpt. Edit selected entries to approved:true; adjust
# their scope/title/content/state if needed. Keep only unresolved themes approved.
harmony --json knowledge questions import preview.json
```

Preview reads only its project milestone and writes nothing. Bullet themes become
proposals, initially parked and unapproved. Historical roadmap prose can contain
themes since decided or delivered; the preview explicitly calls this out.
An approval is an operator's review of that residue, not an automatic conclusion
from milestone placement. No production manifest is applied by a migration.

The database checks the project's milestone source fingerprint and each exact
excerpt. Source keys make replay idempotent; a changed, manually decided or
otherwise conflicting question is refused rather than overwritten. An import
is one transaction, so a later conflict rolls back earlier items. New authored
tags are not invented or automatically registered. Scope is explicit in question
metadata; existing metadata/tag validation continues to govern ordinary writes.

`examples/b1242-big-future-themes.preview.json` is an inspectable historical
preview with every item unapproved, not a declaration that those themes remain
undecided today. Generate a fresh preview before applying it. The database suite
also imports a different milestone into a second project using the same API.

Run the database suite from harmony-web:

```sh
bash scripts/test-b1242-knowledge-questions-db.sh
```
