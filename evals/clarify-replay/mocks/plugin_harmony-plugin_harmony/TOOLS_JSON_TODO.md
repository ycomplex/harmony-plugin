# `_tools.json` — not generated here (B-1037)

This suite has no `_tools.json` (a saved real `tools/list` response, used by `claude plugin eval`
to type-check mocked calls against the real MCP server's schemas). Generating it requires running
`claude plugin eval` against a REAL server — no credentials exist in this build container for
either the fixture project (FX) or production, and this file's generation is explicitly out of
scope for this build (see the B-1037 ticket's mocks-recording section, item (c)).

**Founder/orchestrator TODO**, alongside the mocks-recording pass in RUNBOOK.md: run the suite once
with `--mocks off --allow-real-servers` (the RUNBOOK.md §5 hand-pass invocation) and capture the
real `tools/list` response the plugin's MCP server returns, saving it as
`evals/clarify-replay/mocks/plugin_harmony-plugin_harmony/_tools.json`. No mock file is needed to
capture it — it is the real server's own response, saved verbatim. Its absence does not block a
mocked run (`_tools.json` is optional — see the "Mock file format" section this ticket's own build
notes quote); it only means mocked calls are validated against the plugin's `inputSchema` at type
level rather than against a captured real response's exact shape.

Delete this file once `_tools.json` is generated for real.
