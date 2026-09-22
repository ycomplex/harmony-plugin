This is a JUDGE-CALIBRATION control case (B-1037) -- it does not run the Harmony clarify skill and
never touches the Harmony MCP server. Its only purpose is to give the suite's LLM judge a
KNOWN-GOOD artifact to grade, so the judge's own agreement with a ground-truth answer can be
verified before its score/threshold gates a pull request.

A file named `fresh-brief.md` is available to you under the `fixtures/` directory in your context.

Read `fixtures/fresh-brief.md` and write its EXACT contents -- byte for byte, no summarizing, no
reformatting, no correcting, no adding or removing anything -- to a NEW file named `fresh-brief.md`
in your current working directory (the run's own workspace, a sibling of `fixtures/`, not inside
it).

Once that file is written, stop. There is nothing else to do in this case.
