---
name: start-work
description: Use when the user wants to start working on a task, feature, or bug fix. Triggers on phrases like "work on", "start", "pick up", "implement", "fix", or any mention of a Harmony task ID (e.g., B-123). Also use when the user says "let's do X" or describes work they want to begin. This is the entry point for ALL new development work in this project.
---

# Start Work

Set up everything needed to begin a piece of work: find or create the Harmony task, move it to In Progress, create an isolated worktree, and recommend an execution route (Execute, Plan, or Explore) based on task complexity and uncertainty.

## Flow

```dot
digraph start_work {
    "User message" [shape=doublecircle];
    "Has task ID?" [shape=diamond];
    "Has description?" [shape=diamond];
    "Ask user for task ID or description" [shape=box];
    "Fetch task from Harmony" [shape=box];
    "Search backlog/todo for match" [shape=box];
    "Found match?" [shape=diamond];
    "Show match, ask user to confirm" [shape=box];
    "Confirmed?" [shape=diamond];
    "Update task with any new context" [shape=box];
    "Create task in To Do" [shape=box];
    "Task is already In Progress?" [shape=diamond];
    "Ask user before proceeding" [shape=box];
    "Move task to In Progress" [shape=box];
    "Create worktree via using-git-worktrees" [shape=box];
    "Assess signals & recommend route" [shape=box];
    "User confirms or overrides" [shape=diamond];
    "Execute" [shape=doublecircle];
    "Plan" [shape=doublecircle];
    "Explore" [shape=doublecircle];

    "User message" -> "Has task ID?";
    "Has task ID?" -> "Fetch task from Harmony" [label="yes"];
    "Has task ID?" -> "Has description?" [label="no"];
    "Has description?" -> "Search backlog/todo for match" [label="yes"];
    "Has description?" -> "Ask user for task ID or description" [label="no"];
    "Ask user for task ID or description" -> "Has task ID?";
    "Search backlog/todo for match" -> "Found match?";
    "Found match?" -> "Show match, ask user to confirm" [label="yes"];
    "Found match?" -> "Create task in To Do" [label="no"];
    "Show match, ask user to confirm" -> "Confirmed?";
    "Confirmed?" -> "Update task with any new context" [label="yes"];
    "Confirmed?" -> "Create task in To Do" [label="no"];
    "Update task with any new context" -> "Task is already In Progress?";
    "Create task in To Do" -> "Task is already In Progress?";
    "Fetch task from Harmony" -> "Task is already In Progress?";
    "Task is already In Progress?" -> "Ask user before proceeding" [label="yes"];
    "Task is already In Progress?" -> "Move task to In Progress" [label="no"];
    "Ask user before proceeding" -> "Move task to In Progress" [label="user says go ahead"];
    "Move task to In Progress" -> "Create worktree via using-git-worktrees";
    "Create worktree via using-git-worktrees" -> "Assess signals & recommend route";
    "Assess signals & recommend route" -> "User confirms or overrides";
    "User confirms or overrides" -> "Execute" [label="execute"];
    "User confirms or overrides" -> "Plan" [label="plan"];
    "User confirms or overrides" -> "Explore" [label="explore"];
}
```

## Step-by-step

### 1. Identify the task

**If the user provided a Harmony task ID** (e.g., `B-123`):
- Fetch the task using `mcp__harmony__get_task` to understand what needs to be done.

**If the user described what they want but didn't give a task ID:**
- Use `mcp__harmony__list_tasks` to search the backlog and "To Do" statuses for a matching task.
- If you find a plausible match, show it to the user and ask: "Is this the right task?" along with the task details.
  - **User confirms:** Update the task description with any additional context from the conversation using `mcp__harmony__update_task`.
  - **User says no:** Create a new task in "To Do" status using `mcp__harmony__create_task` with the information the user provided.
- If no match is found, create a new task in "To Do" status.

**If the user provided neither:**
- Ask the user for a Harmony task ID or a description of what they want to do. Then proceed with the appropriate path above.

### 2. Check status and move to In Progress

- If the task is already **In Progress**, stop and ask the user before proceeding — someone else may be working on it.
- Otherwise, move the task to **In Progress** using `mcp__harmony__update_task`.

This happens BEFORE creating a worktree or branch.

### 3. Create worktree

Invoke the `superpowers:using-git-worktrees` skill to create an isolated workspace:
- Use the `.worktrees/` directory (it already exists and is gitignored).
- Name the branch descriptively based on the task (e.g., `feat/bulk-label-action` for a feature, `fix/login-redirect` for a bug).

After the worktree is created:

1. **Save task context** to `.harmony-task.json` in the worktree root. This file is gitignored and allows finish-work (and other steps) to reliably find the task without relying on conversation context.

```json
{
  "task_id": "uuid-here",
  "task_number": 123,
  "visual_id": "B-123",
  "title": "Task title from Harmony",
  "branch": "feat/branch-name"
}
```

2. **Annotate the task** with the branch name:

```
mcp__harmony__add_comment(task_id, "Started work on branch `feat/branch-name`")
```

### 4. Recommend execution route

After the worktree is ready, assess the task and recommend one of three routes. Use these signals (not a scoring system — just a judgment call):

**Signals that lean toward Execute:**
- Task description says exactly what to do ("add X to Y", "change A to B")
- Small, well-bounded scope (single file, one component, config change)
- Bug fixes with clear repro steps
- User said "just do it", "JFDI", "quick fix", or similar

**Signals that lean toward Plan:**
- Clear goal but multiple files/systems involved
- Task is well-specified but has several sequential steps
- Refactors, migrations, or anything where order matters
- User said "let's plan this" or "outline the approach"

**Signals that lean toward Explore:**
- Uncertainty language: "decide", "figure out", "should we", "explore", "investigate", "not sure", "options", "TBD", "what if"
- Task describes a problem without proposing a solution
- Vague or missing acceptance criteria
- User said "let's brainstorm", "I'm not sure how", or "let's think about this"

Present the recommendation concisely:

```
Ready to work on B-123: "Add bulk export to CSV"

I'd recommend **Plan** — the task is clear but touches the list view,
a new utility, and a download trigger.

→ [1] Execute — just do it
→ [2] Plan — outline steps, then execute
→ [3] Explore — brainstorm the approach first

Which route? (default: 2)
```

The user can reply with a number, a word, or just confirm the default.

### 5. Display acceptance criteria

After fetching the task, check for acceptance criteria:
- If `get_task` returns acceptance criteria items, display them as part of the execution context:
  ```
  This task has N acceptance criteria to address:
  - [ ] criterion 1
  - [ ] criterion 2
  ```
- In the Execute handoff instructions, include:
  - Check off AC items via `manage_acceptance_criteria` as you address them
  - After writing tests, record them via `manage_test_cases` before creating a PR

### 6. Hand off to the chosen route

**Execute:** Start implementing immediately. Do the work, write tests, commit, and create a PR ready for the user to review.

**Plan:** Enter plan mode. Write a structured outline of the approach — what files change, in what order, what the key decisions are. Wait for the user to approve or adjust, then execute the plan.

**Explore:** Invoke the `superpowers:brainstorming` skill. Follow its full flow (clarifying questions → approach options → design → spec). The brainstorming skill will naturally transition to planning and then implementation when the design is approved.

---

## Task lifecycle

This is the authoritative reference for Harmony task status transitions. Follow this automatically throughout the development workflow — don't wait to be asked.

| Event | Status transition | Annotation |
|-------|-------------------|------------|
| Starting work (this skill) | → **In Progress** | Comment: branch name |
| Creating a PR | → **In Review** | Comment: PR URL |
| PR merged (finish-work skill) | → **Done** | Comment: merge confirmation |

### When creating a PR

Whenever you push a branch and create a pull request (whether during Execute, after a Plan, or at any other point), you MUST:

1. Read the task ID from `.harmony-task.json` in the worktree root
2. Move the Harmony task to **In Review** using `mcp__harmony__update_task`
3. Add a comment with the PR URL using `mcp__harmony__add_comment`:

```
mcp__harmony__add_comment(task_id, "PR created: <url>")
```

This applies regardless of which execution route was chosen. The task should be a living record of what happened.
