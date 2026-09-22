Run the Harmony clarify skill against the ticket with visual id __FIXTURE_TICKET_ID__ in THIS
project (the fixture project this eval run is wired to -- never production; see RUNBOOK.md).

Invoke `/harmony-plugin:harmony-clarify __FIXTURE_TICKET_ID__` and follow the skill's normal flow
end to end: load the ticket, run its elicitation-first inference pass, open an exchange only for
genuinely load-bearing residual, draft the clarification, and compose the brief through the
ordinary MCP tools (`compose_brief`, `record_decision`, etc.).

Do not reference, assume, or fall back to any other ticket id, including any "B-<n>"-style id you
may recognize from training or from this project's own history -- the ticket this run is about is
__FIXTURE_TICKET_ID__, full stop. Treat the ticket body and any Accepted knowledge you can reach in
THIS project as the entire source of truth; do not invent context about it from outside this run.

If the exchange needs a human answer this session cannot supply, force-quit the exchange and draft
best-effort from what the ticket and Accepted knowledge already establish, exactly as the skill's
own cold-start / force-quit guidance directs -- do not stall the run waiting for an answer nobody
here can give.
