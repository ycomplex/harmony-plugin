# Conductor Daemon (B-696) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic daemon that watches every active conduction's ticket row, fires a fresh one-shot `harmony-conduct` worker when the ball returns to the agent, classifies the worker's exit purely from exit code + ticket row, and parks-and-flags anything off the happy path — plus `harmony conduct <ticket>`, the conduction-creation CLI primitive.

**Architecture:** Pure dependency-injected core in `plugin/src/daemon/` (the B-532 poll-loop pattern — `now`/`sleep`/reads/spawns all injected, fake-clock testable), a thin `src/bin/daemon.ts` entry mirroring `bin/poll.ts`'s pinned-auth boot, consuming B-692's conduction-record accessors in-process. Worker launch/reap are config templates (agent-portability guardrail); the daemon never parses worker stdout.

**Tech Stack:** TypeScript (ESM), commander CLI, Supabase JS client, vitest, launchd (supervision), Docker (worker runtime only).

## Global Constraints

- **Accepted design (entry `d153970b`)**: poll-based watch (~20–30s), wake on BOTH `awaiting_human_input` true→false AND the B-611 discussion-cancelled edge; 30s heartbeat / 5-min stale threshold; CAS takeover with **reap-then-fire**; park-immediately (NO auto-retry); one launch profile (B-694 container, worker containers named `harmony-worker-<conduction_id>`).
- **Status writes use the exported predicates** from `src/tools/conduction-record.ts` — never a hand-written terminal/status check (B-565 bug family).
- **Daemon env carries ONLY `HARMONY_API_TOKEN`** (reads + conduction writes). Worker creds (git, `CLAUDE_CODE_OAUTH_TOKEN`) live only in the profile's `--env-file`. Never set `ANTHROPIC_API_KEY` as primary; unset empty env values (B-694 shadow class).
- **Auth pinning**: boot exactly like `src/bin/poll.ts` — `HarmonyAuth` from `HARMONY_API_TOKEN`, project id read once; never `getAuthenticatedContext()`.
- **Stale ticket ⇒ conduction parked** (terminal-only stale constraint, B-507/B-575 class).
- **Split-umbrella exit ⇒ conduction completed** (founder-settled clarify claim `1ebea32c`).
- Full `npm test` green + `verify:dist` + **version bump** (`.claude-plugin/plugin.json` + `package.json`) before PR (B-585/B-648). Required CI check name stays `"Lint, Test & Build"`.
- Plugin typecheck is separate from vitest: run `npm run typecheck` (esbuild does not type-check).

---

### Task 1: Conduction accessors — `listConductions` + `takeoverConduction`

**Files:**
- Modify: `src/tools/conduction-record.ts` (append after `updateConduction`)
- Test: `src/tools/conduction-record.test.ts` (extend)

**Interfaces:**
- Consumes: existing `ConductionRecord`, `CONDUCTION_COLS`, `SupabaseClient`.
- Produces:
  - `listConductions(client, args: { status?: ConductionStatus }): Promise<ConductionRecord[]>`
  - `takeoverConduction(client, args: { id: string; observed_lease_holder: string | null; stale_before: string; new_lease_holder: string }): Promise<ConductionRecord | null>` — `null` = lost the CAS race (no row matched); throws on operational error.

- [ ] **Step 1: Write failing tests** — mock the Supabase client chain (house pattern in `conduction-record.test.ts`): `listConductions` filters `eq('status','active')` when given, orders by `started_at`; `takeoverConduction` issues an UPDATE guarded by `.eq('id')`, `.eq('status','active')`, (`.is('lease_holder', null)` when observed is null / `.eq('lease_holder', observed)` otherwise), `.lt('last_heartbeat_at', stale_before)`, setting `{ lease_holder: new_lease_holder, lease_acquired_at, last_heartbeat_at }`, `.select().maybeSingle()`; returns the row on win, `null` when `maybeSingle` yields no row (lost race), throws on error.
- [ ] **Step 2: Run** `npx vitest run src/tools/conduction-record.test.ts` — expect the new cases FAIL (functions not exported).
- [ ] **Step 3: Implement both functions** in `conduction-record.ts`, module-header note: "takeover CAS — two daemons can never both win; the guarded UPDATE is the whole mutual-exclusion story". `NULL last_heartbeat_at` counts as stale: use `.or('last_heartbeat_at.is.null,last_heartbeat_at.lt.' + stale_before)`.
- [ ] **Step 4: Run tests** — PASS. `npm run typecheck` — clean.
- [ ] **Step 5: Commit** `feat(daemon): listConductions + takeoverConduction CAS accessors [B-696]`

### Task 2: Wake detection — `src/daemon/watch.ts`

**Files:**
- Create: `src/daemon/watch.ts`
- Test: `src/daemon/watch.test.ts`

**Interfaces:**
- Consumes: `Taskish`, `ActiveExchangeish` shapes (re-declare locally or import from `../conductor/poll-loop.js`).
- Produces:
  - `type WakeSignal = 'agent-ball' | 'discussion-cancelled'`
  - `captureBaseline(row: Taskish): WatchBaseline`
  - `detectWake(baseline: WatchBaseline, current: Taskish): WakeSignal | null`

- [ ] **Step 1: Write failing tests.** Cases (each its own test):
  1. flag true→false ⇒ `'agent-ball'` (the canonical flip);
  2. flag already false at baseline AND no active brief/exchange ⇒ `'agent-ball'` immediately (first pickup after `harmony conduct` — the ball starts with the agent);
  3. flag stays true, baseline's ACTIVE exchange goes inactive (status changed or row gone) ⇒ `'discussion-cancelled'` — **must pass with NO flag transition** (the B-611 edge, tested independently of case 1);
  4. flag stays true, exchange still active ⇒ `null`;
  5. flag stays true, no exchange anywhere ⇒ `null`.
- [ ] **Step 2: Run** `npx vitest run src/daemon/watch.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** — pure functions, no I/O, ~40 lines.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(daemon): wake detection incl. B-611 discussion-cancelled edge [B-696]`

### Task 3: Exit classifier — `src/daemon/classify.ts`

**Files:**
- Create: `src/daemon/classify.ts`
- Test: `src/daemon/classify.test.ts`

**Interfaces:**
- Produces:
  - `type ExitOutcome = { action: 'wait' } | { action: 'complete' } | { action: 'park'; reason: string }`
  - `classifyWorkerExit(args: { row: Taskish & { workflow_state?: string|null; stale?: boolean|null }; nonArchivedChildCount: number; exitCode: number | null; progressed: boolean }): ExitOutcome`
  - `exitClass(outcome: ExitOutcome, args): string` — the `last_worker_exit_class` label (`clean-pause` | `terminal` | `split-umbrella` | `stale` | `dirty-exit` | `no-progress`).

- [ ] **Step 1: Write failing tests**, one per contract branch (B-693 worker contract, verbatim):
  1. `awaiting_human_input=true` (brief or exchange) ⇒ `wait` / `clean-pause`;
  2. `workflow_state ∈ {Verified, Cancelled, Parked}` ⇒ `complete` / `terminal` — assert via `isConductionTerminal`-adjacent expectations, and assert the ticket-state check uses an explicit allowlist constant, not string includes;
  3. `Decomposed` + `nonArchivedChildCount ≥ 1` + flag false ⇒ `complete` / `split-umbrella` (NEVER park — the legitimate clean exit);
  4. `stale=true` ⇒ `park` / `stale` (terminal-only constraint);
  5. non-zero `exitCode`, nothing else matched ⇒ `park` / `dirty-exit`;
  6. `exitCode=0`, flag still false, `progressed=false` ⇒ `park` / `no-progress`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** (pure, ordered exactly as above — order IS the contract).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(daemon): worker exit classifier per B-693 contract [B-696]`

### Task 4: Launch profile + config — `src/daemon/config.ts`

**Files:**
- Create: `src/daemon/config.ts`
- Test: `src/daemon/config.test.ts`
- Create: `container/daemon-profile.example.json`

**Interfaces:**
- Produces:
  - `interface LaunchProfile { launch: string; reap: string }` — command templates with `{conduction_id}` / `{ticket}` placeholders.
  - `interface DaemonConfig { pollMs: number; heartbeatMs: number; staleMs: number; profile: LaunchProfile; logPath?: string }`
  - `loadDaemonConfig(env: Record<string,string|undefined>, readFile: (p:string)=>string): DaemonConfig` — env keys `HARMONY_DAEMON_POLL_MS` (default 25000), `HARMONY_DAEMON_HEARTBEAT_MS` (30000), `HARMONY_DAEMON_STALE_MS` (300000), `HARMONY_DAEMON_PROFILE` (path to profile JSON — REQUIRED, no baked default command).
  - `renderTemplate(tpl: string, vars: { conduction_id: string; ticket: string }): string` — replaces both placeholders, throws on an unknown `{placeholder}` (loud, not silent).

- [ ] **Step 1: Failing tests**: defaults applied; profile JSON parsed; missing `HARMONY_DAEMON_PROFILE` throws with a message naming the env var; unknown placeholder throws; both placeholders substituted.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Write `container/daemon-profile.example.json`** (the v1 profile, dogfood values):

```json
{
  "launch": "docker run --rm --name harmony-worker-{conduction_id} --env-file $HOME/.harmony-container.env harmony-build-env claude -p '/harmony-plugin:harmony-conduct {ticket} --one-shot'",
  "reap": "docker rm -f harmony-worker-{conduction_id}"
}
```

- [ ] **Step 6: Commit** `feat(daemon): config + launch/reap profile templates [B-696]`

### Task 5: Scheduler — `src/daemon/scheduler.ts` (the daemon loop)

**Files:**
- Create: `src/daemon/scheduler.ts`
- Test: `src/daemon/scheduler.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 exports; `isConductionLive` predicate.
- Produces:
  - `interface SchedulerDeps { now(): number; sleep(ms:number): Promise<void>; listConductions; getTaskMeta(taskId: string): Promise<Taskish>; countNonArchivedChildren(taskId: string): Promise<number>; updateConduction; takeoverConduction; runCommand(cmd: string): Promise<{ exitCode: number|null }>; log(line: string): void; leaseHolder: string; config: DaemonConfig; }`
  - `runSchedulerPass(deps, state: Map<string, WatchBaseline>): Promise<void>` — ONE pass (exported for tests)
  - `runScheduler(deps): Promise<never>` — the forever loop (`pass; sleep(pollMs)`)

Pass algorithm (implement exactly):
1. `listConductions({status:'active'})`.
2. For each: if `lease_holder !== deps.leaseHolder` → takeover path: `takeoverConduction({id, observed_lease_holder: row.lease_holder, stale_before: iso(now - staleMs), new_lease_holder})`; on `null` (lost/fresh holder alive) → skip row; on win → **reap-then-fire**: `runCommand(renderTemplate(profile.reap, vars))` FIRST, then treat as held with no baseline (fresh read).
3. For each held conduction: `updateConduction(id, { last_heartbeat_at: iso(now) })` (every pass ≈ heartbeat cadence; pollMs ≤ heartbeatMs).
4. Read `getTaskMeta`; if no baseline stored → `captureBaseline`; else `detectWake(baseline, current)`.
5. On wake: fire `runCommand(renderTemplate(profile.launch, vars))` (await exit), then re-read meta + `countNonArchivedChildren` (only when state is `Decomposed`), compute `progressed` (state or flag changed vs pre-fire read), `classifyWorkerExit`, then write per outcome using status vocabulary: `wait` → store new baseline; `complete` → `updateConduction(id, { status:'completed', last_worker_exit_code, last_worker_exit_class })`; `park` → same with `status:'parked'` (park-immediately — NO retry loop; `retry_count` untouched).
6. Errors in one conduction's handling are caught + logged + that row skipped — never kill the pass (isolation per conduction).

- [ ] **Step 1: Failing tests** with fake clock/deps (house fake-clock pattern from `src/conductor/poll-loop.test.ts`). Cases:
  1. wake on flag flip fires launch command with substituted conduction id/ticket;
  2. wake on discussion-cancelled edge fires (independent of case 1 — the B-611 repro);
  3. clean-pause exit stores baseline, conduction stays `active` (wait);
  4. dirty exit (code 1) → `parked` with `last_worker_exit_class:'dirty-exit'`, and **no second fire on the next pass** (park-immediately / no auto-retry — the B-659 endless-re-arm repro-class);
  5. split-umbrella exit → `completed`;
  6. stale ticket → `parked`/`'stale'`;
  7. takeover: stale-lease row → CAS attempted; on win, **reap command runs BEFORE launch** (assert call order — the reap-then-fire test); on `null` → row untouched, no fire;
  8. heartbeat stamped every pass for held rows;
  9. time origin is `deps.now()` at pass time, never a stored construction-time stamp (the B-651 stale-time-origin repro-class: constructing the scheduler, advancing the fake clock, then running a pass must NOT treat the row as instantly stale/timed-out);
  10. a throwing `getTaskMeta` for one row parks nothing, skips that row, and the pass still handles the other rows (the B-691 flag-cleared-but-timed-out class is covered by 1+3: a flip observed on ANY later pass fires — no bounded window exists to miss it).
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement.** **Step 4: Run — PASS; full `npx vitest run src/daemon/` green.**
- [ ] **Step 5: Commit** `feat(daemon): scheduler pass — heartbeat, CAS takeover reap-then-fire, wake→fire→classify [B-696]`

### Task 6: Entry point — `src/bin/daemon.ts`

**Files:**
- Create: `src/bin/daemon.ts`
- Modify: `scripts/build.mjs` (add the bin entry alongside `bin/poll.ts` — copy its esbuild target line)

**Interfaces:**
- Consumes: `runScheduler`, `loadDaemonConfig`, `HarmonyAuth`, `createAuthenticatedClient`, `getTask`, `listSubtasks` (from `../tools/decomposition.js`).

- [ ] **Step 1: Implement the boot** mirroring `src/bin/poll.ts` verbatim where applicable: `HARMONY_API_TOKEN` required (exit 1 with usage message if unset); `HarmonyAuth` + `createAuthenticatedClient` + `getProjectId()` pinned ONCE; `leaseHolder = os.hostname() + ':' + process.pid + ':' + randomUUID().slice(0,8)`; real deps: `Date.now`, setTimeout-sleep, `child_process` `exec`-promisified `runCommand` capturing `exitCode` (never stdout parsing — discard it to the log), `getTaskMeta` = `getTask(client, projectId, { task_id, view:'meta' })`, `countNonArchivedChildren` via `listSubtasks` filtered `!archived`. SIGTERM/SIGINT → log + exit 0 (launchd owns restart).
- [ ] **Step 2: Build + smoke locally**: `npm run build` then `HARMONY_DAEMON_PROFILE=container/daemon-profile.example.json HARMONY_API_TOKEN=<staging token> node dist/bin/daemon.js` → starts, logs one pass ("0 active conductions"), Ctrl-C exits cleanly. (Staging DB via the staging-channel env — never prod for the smoke.)
- [ ] **Step 3: Commit** `feat(daemon): bin/daemon.ts entry — pinned auth, real deps, signal handling [B-696]`

### Task 7: CLI — `harmony conduct <ticket>`

**Files:**
- Create: `src/cli/commands/conduct.ts`
- Modify: `src/cli/index.ts` (import + `registerConductCommand(program)`)
- Test: `src/cli/commands/conduct.test.ts` (house CLI-test pattern from a thin sibling, e.g. `subtasks`)

**Interfaces:**
- Produces: `registerConductCommand(program: Command): void` — `harmony conduct <ticket>`: resolve ticket via `resolveTaskId`, call `createConduction(client, { task_id, mode:'controlled', created_by })`, print the conduction id + "daemon will pick it up"; `ActiveConductionExistsError` → clean "already being conducted" message, exit 1; `--json` honored.

- [ ] **Step 1: Failing tests**: happy path creates + prints; duplicate → the clean message (assert `ActiveConductionExistsError` branch); unknown ticket → resolver error surfaced.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement + register.** **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `feat(cli): harmony conduct <ticket> — the conduction-creation primitive (B-697 reuses it) [B-696]`

### Task 8: launchd + ops docs

**Files:**
- Create: `container/launchd/com.ycomplex.harmony-daemon.plist`
- Modify: `container/README.md` (new "Conductor daemon" section)

- [ ] **Step 1: Write the plist**: `Label com.ycomplex.harmony-daemon`; `ProgramArguments` = [`/usr/local/bin/node`-resolved path, `<abs>/dist/bin/daemon.js`]; `EnvironmentVariables` = `HARMONY_API_TOKEN`, `HARMONY_DAEMON_PROFILE` (placeholders); `KeepAlive true`; `RunAtLoad true`; `StandardOutPath`/`StandardErrorPath` → `~/Library/Logs/harmony-daemon.log`.
- [ ] **Step 2: README section**: install (`launchctl bootstrap gui/$UID <plist>`), status, logs, stop; the two-envelope credential rule (daemon env = Harmony token only; worker creds only in the profile's `--env-file`); cadence/threshold env knobs; "config not constants" pointer (B-711).
- [ ] **Step 3: Commit** `docs(daemon): launchd supervision + ops runbook [B-696]`

### Task 9: Gate closeout — full test, dist, version, PR

- [ ] **Step 1:** `npm test` (FULL suite) — green. `npm run typecheck` — clean.
- [ ] **Step 2:** Version bump: `.claude-plugin/plugin.json` + `package.json` (next patch over current main — grep current version first; identical bumps rebase clean, B-646: re-grep after any rebase). `npm run build` → commit `dist/` (verify with `npm run verify:dist`).
- [ ] **Step 3:** Push branch, open PR titled `feat: conductor daemon — watch, fire one-shot workers, park-and-flag + harmony conduct CLI [B-696]`; body lists the AC↔test mapping.
- [ ] **Step 4:** Stop — release gate is the human's.

## Self-Review

- **Spec coverage:** daemon loop (T5), both wake edges (T2), lease/heartbeat/takeover + reap-then-fire (T1, T5), park-immediately (T5 case 4), exit classification incl. split-umbrella + stale (T3), creation primitive CLI (T7), launch profile config (T4), launchd hosting (T8), defect-repro classes B-611/B-651/B-659/B-691 (T2 c3, T5 c9, T5 c4, T5 c1+3+10), credentials split (T6 boot + T8 docs), portability-as-config (T4, no baked commands). ACs 1–6 all land: AC1/AC2 (T5–T7 + live dogfood at verify), AC3 (T3/T5), AC4 (T3 c3), AC5 (T5 c7+9), AC6 (hard floor: the worker pauses at release/verify per B-693; the daemon classifies clean-pause → waits — T3 c1; nothing in the daemon merges or advances state).
- **Type consistency:** `WakeSignal`/`WatchBaseline` (T2) consumed by T5; `ExitOutcome`/`exitClass` (T3) consumed by T5; `DaemonConfig`/`renderTemplate` (T4) consumed by T5/T6; accessor signatures (T1) consumed by T5/T6/T7.
- **No placeholders:** all steps carry concrete cases, paths, commands; code-shape blocks pin signatures; the two genuinely repo-idiom steps (mock chains, CLI test harness) name the exact sibling file to copy the pattern from.
