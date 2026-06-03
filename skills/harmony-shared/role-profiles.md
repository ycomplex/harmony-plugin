# Role-scoped capability profiles (agent-model §3)

v1 enforces capability boundaries through Claude Code skill frontmatter (`allowed-tools` pre-approves;
`disallowed-tools` *revokes* the tool while the skill runs). Container-level enforcement is v2.

| Profile | Skills | Pre-approved (`allowed-tools`) | Revoked (`disallowed-tools`) |
|---|---|---|---|
| **harmony-discovery** | clarify, decompose, design-decide, research, queue, next | `mcp__harmony__*`, `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` | `Write`, `Edit`, `NotebookEdit`, `Bash(git commit *)`, `Bash(git push *)`, `Bash(git merge *)` |
| **harmony-build** | build (`start-work`, opinionated path) | `mcp__harmony__*`, `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Bash` | `mcp__harmony__record_decision`, `mcp__harmony__supersede_decision`, `mcp__harmony__update_knowledge_entry` |
| **harmony-release** | release (`finish-work`, opinionated path) | `mcp__harmony__*`, `Read`, `Grep`, `Glob`, `Bash`, `Bash(gh *)` | `mcp__harmony__record_decision`, `mcp__harmony__supersede_decision`, `mcp__harmony__update_knowledge_entry` |
| **harmony-verify** | (folded into release for v1) | production observability read-only | filesystem writes, commit |

Why: a `designing` skill must not be able to commit code ("helpfully starting to implement" before the
decision is locked); a `building` skill must not silently overwrite design knowledge (scope drift
mid-build). `assert_fact` stays allowed for build/release — facts from build are expected
(knowledge-model-v1 §7). Profiles are advisory at the permission layer; treat the revocations as the
boundary you operate within.
