# Conductor Daemon Fixes (B-696 rebuild) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two dogfood-found defects — the shared client's non-refreshing JWT (daemon zombie after ~1h) and the launch profile's wrong container-mode invocation — plus the auth-failure exit backstop and first-fire log polish, per the Accepted v2 design (entry `2cbe1993`).

**Architecture:** Shared-core fix (supabase-js `accessToken` callback in `createAuthenticatedClient`) + daemon-side backstop + config/template fix with a cross-file drift-guard test. No new modules; ships as v0.14.68 in a new PR on top of the merged v0.14.67.

**Tech Stack:** TypeScript (ESM), supabase-js 2.98.0 (`accessToken?: () => Promise<string | null>` — verified in the installed dependency), vitest.

## Global Constraints

- Accepted v2 design (entry `2cbe1993`): shared-client callback (static Authorization header REMOVED — mutually exclusive with the callback); 3 consecutive auth-shaped pass failures → daemon exits non-zero (launchd restarts); launch template mode arg = `headless`; drift guard reads provision.sh's REAL modes; skip reap when observed `lease_holder` is null.
- Full `npm test` + `npm run typecheck` + `npm run lint` green; version bump to **0.14.68** in `.claude-plugin/plugin.json` AND `package.json`; `npm run build` + commit `dist/` + `npm run verify:dist` (B-585/B-648).
- One commit per task; lockfile discipline (`git restore package-lock.json` unless `package.json` changed).
- Do NOT touch ticket state or MCP tools; stop after the PR exists (merge floor is the human's).

---

### Task 1: Shared client — `accessToken` callback

**Files:**
- Modify: `src/supabase.ts` (`createAuthenticatedClient`)
- Test: `src/supabase.test.ts` (create if absent)

**Interfaces:**
- Consumes: `HarmonyAuth.getAccessToken(): Promise<string>` (already caches + re-exchanges within 60s of expiry).
- Produces: `createAuthenticatedClient(auth): Promise<SupabaseClient>` — same signature; the returned client now asks `auth.getAccessToken()` per request instead of holding a static header.

- [ ] **Step 1: Write the failing test.** Mock `@supabase/supabase-js`'s `createClient` (vi.mock, capture args). Cases: (1) options carry an `accessToken` function and NO `global.headers.Authorization`; (2) invoking the captured `accessToken()` twice calls `auth.getAccessToken()` each time and returns its CURRENT value (fake auth returns 'tok1' then 'tok2' — assert both observed, proving per-request refresh); (3) `auth: { persistSession: false, autoRefreshToken: false }` preserved.
- [ ] **Step 2: Run** `npx vitest run src/supabase.test.ts` — FAIL.
- [ ] **Step 3: Implement:**

```ts
export async function createAuthenticatedClient(auth: HarmonyAuth): Promise<SupabaseClient> {
  await auth.getAccessToken(); // fail fast at construction (bad token → loud error now, not first query)
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: () => auth.getAccessToken(),
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
```

- [ ] **Step 4: Run — PASS.** Then FULL `npx vitest run` — the whole suite must stay green (every tool test flows through this client path).
- [ ] **Step 5:** `npm run typecheck`. Commit `fix(auth): self-refreshing client via accessToken callback — retires the long-lived-client JWT zombie class [B-696]`

### Task 2: Scheduler auth-failure exit backstop

**Files:**
- Modify: `src/daemon/scheduler.ts`, `src/bin/daemon.ts`
- Test: `src/daemon/scheduler.test.ts` (extend)

**Interfaces:**
- Produces: `class PersistentAuthFailure extends Error { readonly consecutivePasses: number }` thrown by `runScheduler` (the loop) after **3** consecutive passes in which EVERY attempted conduction handling failed auth-shaped; `isAuthShapedError(e): boolean` matching `/\b401\b|jwt expired|invalid (jwt|token)|token .*expired/i` (exported for tests). `bin/daemon.ts` catches `PersistentAuthFailure` → log + `process.exit(1)`.

- [ ] **Step 1: Failing tests:** (1) three consecutive fake passes whose `getTaskMeta`/`listConductions` reject with `new Error('JWT expired')` → `runScheduler` throws `PersistentAuthFailure` (does NOT loop forever); (2) a successful pass between failures resets the counter (5 passes: fail, fail, ok, fail, fail → still running); (3) non-auth errors (e.g. 'network flake') never trip it (per-conduction isolation unchanged).
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** (counter in `runScheduler`, not the pass — the pass stays single-shot pure). **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(daemon): exit non-zero after 3 consecutive auth-failing passes — restart over zombie [B-696]`

### Task 3: Launch template mode fix + cross-file drift guard

**Files:**
- Modify: `container/daemon-profile.example.json`
- Test: `src/daemon/profile-contract.test.ts` (create)

- [ ] **Step 1: Failing test (the drift guard):** read `container/daemon-profile.example.json` and `container/provision.sh` with `fs.readFileSync`. Extract the token immediately following the image name `harmony-build-env` in the launch template; parse the valid modes from provision.sh's mode handling (the `case`/branch on the first arg — extract the literal mode names, expect `shell` and `headless`). Assert: the profile's mode token ∈ the parsed modes; also assert the parsed set is non-empty (guard the guard). This FAILS against the current template (`claude` is not a mode).
- [ ] **Step 2: Fix the template:**

```json
{
  "launch": "docker run --rm --name harmony-worker-{conduction_id} --env-file $HOME/.harmony-container.env harmony-build-env headless '/harmony-plugin:harmony-conduct {ticket} --one-shot'",
  "reap": "docker rm -f harmony-worker-{conduction_id}"
}
```

- [ ] **Step 3: Run — PASS.**
- [ ] **Step 4: Commit** `fix(daemon): launch profile speaks the entrypoint mode contract (headless) + drift-guard test [B-696]`

### Task 4: First-fire polish — no reap of a never-held conduction, calm first-claim log

**Files:**
- Modify: `src/daemon/scheduler.ts`
- Test: `src/daemon/scheduler.test.ts` (extend/adjust)

- [ ] **Step 1: Failing test:** takeover path where the row's observed `lease_holder` is `null` (fresh conduction, never held) → CAS still attempted, but the reap command is NOT run before the fire; log line reads as a first claim (assert the log dep received a line matching `/claim/i` and NOT `/took over stale lease/i`). Existing reap-then-fire test (non-null observed holder) must still pass unchanged.
- [ ] **Step 2: Run — FAIL.** **Step 3: Implement** (reap only when `observed_lease_holder !== null`). **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** `fix(daemon): skip reap + calm log on first claim of a never-held conduction [B-696]`

### Task 5: Gate closeout

- [ ] **Step 1:** FULL `npm test` green; `npm run typecheck`; `npm run lint`.
- [ ] **Step 2:** Version bump **0.14.68** in both manifests (grep main's current version first; re-grep + re-bump after any rebase — B-646); `npm run build`; commit `dist/`; `npm run verify:dist`.
- [ ] **Step 3:** Push branch; open PR titled `fix: daemon auth refresh (accessToken callback) + launch-profile mode contract [B-696]`; body maps Defect 1/Defect 2 → tasks/tests and ends with the standard generated-with line. Do NOT merge; stop.

## Self-Review

- Defect 2 → Tasks 1+2 (fix + backstop, both tested); Defect 1 → Task 3 (fix + contract-locked guard); dogfood polish fold → Task 4; discipline → Task 5. v2 design covered in full; no placeholders; type/name consistency: `PersistentAuthFailure`/`isAuthShapedError` defined in Task 2 and consumed only by Task 2's bin change.
