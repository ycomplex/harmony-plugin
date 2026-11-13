# Project brief sections (B-1305)

A project can ask the briefs at a gate to carry extra sections it defines. It declares them under
`brief_sections` in `.harmony/project.yml`; the agent writing a brief fills them; `compose_brief`
checks they are all there and renders them after the standard brief.

## Update the plugin and the conductor before adding this key

`brief_sections` is a new top-level key in a `version: 1` file. A plugin that predates it reads the
key as unrecognised and reports the **whole file** as malformed, so its `build.before_pr`,
`release.before_merge` and `verify.before_ack` steps stop running. Update the plugin in every
session that works on the project, and the conductor (its Update, or `harmony conductor restart`),
before merging a project file that declares it.

## Declaring sections

```yaml
version: 1
brief_sections:
  clarify:
    - id: ears
      title: Requirements in EARS form
      instruction: Restate each acceptance criterion as "When <trigger>, the <system> shall <response>".
  verify:
    - id: e2e-tests
      title: End-to-end tests implemented
      instruction: For each end-to-end test this ticket added or changed, one or two sentences a tester could walk by hand.
```

| Gate key | The brief it applies to |
|---|---|
| `clarify` | the clarification brief (`clarification-draft`) |
| `decompose` | the decomposition brief (`decomposition-proposal`) |
| `design` | the design brief (`design-decision-draft`), on every design track |
| `plan` | the plan brief (`plan-draft`) |
| `release` | the release brief (`release-decision-pending`) |
| `verify` | the verify brief (`verification-ack-pending`) |

The stale-patch and revise-scope review briefs never carry sections.

### Limits

- At most **3 sections per gate, per repository** (per project file).
- `id` matches `^[a-z0-9][a-z0-9-]{0,39}$` and is unique within its gate in that file. Two
  repositories may declare the same id; the brief keeps both, keyed by repository and id.
- `title` is at most **80** characters; `instruction` at most **600**.
- A filled section's markdown is at most **4,000** characters.
- Each section has exactly `id`, `title` and `instruction`.

### A malformed block

A malformed `brief_sections` block never makes the rest of the file malformed and never stops a
build, release or verify step. Its sections are **not enforced**: each brief is filed as usual and
`compose_brief` returns a warning naming the file and the problem.

## Which copy counts: the default branch

Declarations are read from each repository's **default branch** on origin, never from the working
tree or the branch being built, so a declaration only counts once it has merged.

- **Repositories:** every `repos[].path` in the `.harmony/conductor.json` found by walking up from the
  working directory; without one, the git repository holding the working directory. A repository is
  named by its origin URL's `owner/name`. One with no origin remote is skipped with a warning.
- **Default branch:** `refs/remotes/origin/HEAD`, else `main`, else `master`.
- **Freshness:** at most one quiet fetch of that branch per repository per minute (10 s timeout, no
  prompt). If the fetch fails, the last-fetched copy is used and the brief says it may be out of date.
- **Reading:** `git show origin/<branch>:.harmony/project.yml`.

| What was found | What the brief does |
|---|---|
| no repository's default branch has the file, or none declares sections for this gate | exactly today's brief, no warning |
| nothing could be read (no conductor file and not in a git repository, or every repository skipped) | filed as usual, with a closing note that the declarations could not be read |
| a malformed `brief_sections` block | filed as usual; the problem is named in a warning; not enforced |
| declared sections | every declared section must be supplied (below) |

## Filling sections

Before composing, read the declarations: the `read_brief_sections` tool (`{ gate }`) or
`harmony brief sections <gate>` (add `--json` for the raw result). Fill each declared section as a
`compose_brief` `doc.sections` item `{ repository, id, markdown }`; `repository` may be left out when
only one repository declares the id. A repository the ticket does not touch may say
`Not applicable to this ticket`.

`compose_brief` checks the sections **this call** supplied, so every revision must carry them again.
It refuses, before writing anything, when a declared section is missing or empty, an id is not
declared, a section is over 4,000 characters, or a section contains a credential: a known token shape
(the shared list in `src/tools/token-shapes.ts`, without its long-run catch-all) or the value of an
environment variable whose name contains TOKEN, KEY, SECRET, PASSWORD or CREDENTIAL. The refusal
names each missing section with its title and instruction, and names only the shape or the variable,
never the value.

The title, repository, commit and freshness are stamped from the declaration. The sections render in
their own area after everything the standard brief renders, one heading per repository. They never
change the decision, the recommendation, the criteria or what accepting does, and they are never
copied into the knowledge entry an accept promotes or the ticket's gate section.

A brief no agent wrote (a recorded walk) carries no sections and says so in a closing note.
