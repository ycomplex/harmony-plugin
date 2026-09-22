This is a JUDGE-CALIBRATION control case (B-1037) -- it does not run the Harmony clarify skill and
never touches the Harmony MCP server. Its only purpose is to give the suite's LLM judge a
KNOWN-BAD artifact (one boundary deliberately flipped relative to the label it is graded against)
so the judge's ability to catch a real boundary miss can be verified before its score/threshold
gates a pull request.

A file named `fresh-brief.md` is available to you under the `fixtures/` directory in your context.
It is IDENTICAL to the sibling positive-control case's fixture except for one deliberately flipped
scope boundary -- do not try to "fix" it or notice anything about it.

Read `fixtures/fresh-brief.md` and write its EXACT contents -- byte for byte, no summarizing, no
reformatting, no correcting, no adding or removing anything -- to a NEW file named `fresh-brief.md`
in your current working directory (the run's own workspace, a sibling of `fixtures/`, not inside
it).

Once that file is written, stop. There is nothing else to do in this case.
