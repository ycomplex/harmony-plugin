# Run Options extensibility contract (B-743)

Reference doc, not a skill — read by whoever adds the NEXT Run Options control (a per-run choice
the human sets on the Conduct dialog before a run starts, e.g. "which model runs each gate" or
"which gates auto-approve"). B-743 shipped the first two controls (a free-text operator `note` and
a `session_resume` toggle, B-718) through this seam; this doc names the exact files a new control
touches so the next one doesn't have to rediscover the wiring from scratch.

## The seam, end to end

A Run Options control is a `run_config` key: set by the human in the web Conduct dialog, written
into `conductions.run_config` (jsonb) at creation, delivered to the worker as an env var, and read
back out by whichever code needs it — a daemon/shell script, or (new as of B-743) a skill running
inside the worker's `claude` session, via an MCP tool boundary.

## Files every new control touches

1. **`plugin/src/config/run-config.ts`** — add ONE top-level key to `RunConfigSchema` (Zod,
   `.passthrough()` already covers forward-compat) and a small accessor function alongside
   `isSessionResumeEnabled`/`getOperatorNote` (e.g. `getFooBar(runConfig): T | undefined`). This is
   the schema of record — every other file below either writes into it or reads through it.

2. **`plugin/src/tools/conduction-record.ts`** — `CreateConductionArgs.run_config?: RunConfig`
   already exists (B-743) and is generic over the whole schema; a new key needs NO change here
   unless the whole `run_config` plumbing itself changes shape.

3. **The `create_conduction` MCP tool's input schema**
   (`plugin/src/tools/create-conduction.ts`) — same as #2: `run_config` is already a generic
   passthrough object validated against `RunConfigSchema`, so a new key needs no schema change
   here either UNLESS the tool's `inputSchema.properties.run_config.description` should call out
   the new key by name for MCP-client discoverability (recommended, not required).

4. **`web/src/features/workflow/hooks/useCreateConduction.ts`** — the web-side hook that calls
   `create_conduction`; extend its args/payload shape to accept and forward the new control's
   value.

5. **`web/src/features/workflow/components/WorkflowPrimaryAction.tsx`** (or its Conduct dialog) —
   the UI surface where the human actually sets the control. This is normally the biggest half of
   the work for a new control, and is entirely a web-repo concern.

6. **`plugin/src/daemon/scheduler.ts`** — **ONLY IF** the new control needs a brand-new
   launch-template placeholder distinct from `{run_config_json}` (rare — `{run_config_json}`
   already carries the WHOLE `run_config` object, base64-encoded upstream of every launch
   profile's shell boundary since B-743's `runConfigJsonFor` fix, so a control whose only consumer
   is inside `run_config` itself needs NOTHING here). Touch this file only when the control needs
   its own template variable outside the run_config channel entirely.

7. **`plugin/skills/harmony-conduct/SKILL.md`, step 1b + `plugin/src/tools/environment.ts`** —
   **ONLY IF** the new control needs to be READ BY A SKILL** (as opposed to a daemon/shell script
   that already runs before `claude` starts, like `container/entrypoint.sh`'s `session_resume`
   read). `harmony-conduct`'s `allowed-tools` carries no `Bash` — a skill can only reach an env var
   through an MCP tool boundary. B-743 added `environment.conduction_id` /
   `environment.operator_note` to `get_project`'s response (`resolveEnvironment` in
   `environment.ts`) for exactly this reason; a new skill-consumed control key extends the SAME
   `EnvironmentInfo` shape (or, if it does not fit that shape's grain, a new dedicated MCP tool —
   but prefer extending `EnvironmentInfo` first, since it is already the one call every conductor
   run makes at step 1b before anything else).

## Named first consumers of this contract

- **B-772** — which model runs a gate (a per-gate `run_config` key, likely daemon/launch-side only
  — touches #1, #2/#3 trivially, #4/#5, and possibly #6 if model selection needs to reach the
  launch template directly rather than riding inside `run_config`).
- **B-773** — which gates auto-approve (a `run_config` key almost certainly consumed by
  `harmony-conduct` itself, at the delegation test — touches #1, #2/#3 trivially, #4/#5, and #7,
  since the delegation test's auto-advance decision runs inside the skill, not a pre-`claude`
  shell script).
