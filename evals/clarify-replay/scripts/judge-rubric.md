Compare the FRESH clarify brief this run produced (its frame.solving / frame.in_scope /
frame.not_solving, its `recommend`, and the acceptance_criterion items in its doc.payload) against
the RATIFIED label in baseline_file (field_values.gate_slots.clarify, plus every retained brief
revision where present — for a multi-revision lineage, the LAST retained revision is the one that
converged and is the one to compare against). Score PASS only if all four checks below hold;
otherwise FAIL, and name every check that broke.

1. SAME PROBLEM STATEMENT — frame.solving states substantially the same outcome-shaped problem as
   the label's ratified intent. Paraphrase, different wording, and different emphasis are fine; a
   materially different problem is not.
2. SAME BOUNDARIES — frame.in_scope / frame.not_solving draw the same in/out line the label drew.
   Different wording for the same boundary is fine. Something the label excluded that the fresh
   brief now includes (or the reverse) is a boundary miss and fails this check.
3. SAME RECOMMENDATION — the fresh brief's `recommend` reaches the same call the label's ratified
   recommendation reached.
4. NO INVENTED ACS — every acceptance_criterion payload item in the fresh brief is traceable to
   something the label or the ticket body actually asked for. An AC describing a requirement
   neither the label nor the ticket body supports is an invention, and fails this check even when
   checks 1-3 all pass.

Ignore heading order, section labels, prose length, and formatting differences entirely: score
substance only, never template or structural similarity (a holistic/template-similarity score
hides real differences — see the accepted design this suite implements).

Worked negative example (fails check 4 only, checks 1-3 pass): the label's ratified brief says
"the export button produces a PDF that matches the on-screen layout" and files one AC — "the
exported PDF preserves column order." A fresh brief that also adds an AC reading "the export
includes a digitally-signed hash of the PDF for tamper detection" — a real, plausible-sounding
capability, but one the label and the ticket body never asked for — FAILS check 4, even though the
problem statement, boundaries, and recommendation all match cleanly, because the brief now
promises something nobody ratified.
