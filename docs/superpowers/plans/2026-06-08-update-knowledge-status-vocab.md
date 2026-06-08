# update_knowledge_entry / create_knowledge_entry status-vocab fix (B-415) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `update_knowledge_entry` / `create_knowledge_entry` from silently dropping (or mis-defaulting) the status when a caller passes v1-capitalized vocab, and make the tools' return value reflect what actually persisted.

**Architecture:** Both handlers write through the `workspace_knowledge` compat VIEW, whose INSTEAD-OF triggers map status with a `CASE` that only recognizes **legacy lowercase** vocab (`'draft'|'accepted'|'superseded'`). v1-capitalized vocab (`'Accepted'`, …) falls through: the UPDATE trigger keeps the old status (silent no-op), the INSERT trigger defaults to `'Asserted'` — and both `RETURN NEW`, so the handler echoes the caller's input back as a false success. Fix is **plugin-only** (consistent with B-401): a `toLegacyStatus()` normalizer translates the caller's status into the legacy vocab the view expects (and **rejects** unrecognized values loudly), wired into both handlers before the view write. Then both handlers **re-read** the persisted row via the existing `getKnowledgeEntry()` so the return is authoritative.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, vitest, esbuild (committed `dist/`).

---

## Background — the bug (B-415)

Reproduced live on prod (probe since retired). `update_knowledge_entry(status:'Accepted')` returned `status:'Accepted'` but a fresh read showed the entry was **still `draft`** (Asserted). Lowercase `'accepted'` worked (control). The view's UPDATE trigger (`migration 20260602171200_workspace_knowledge_compat_view.sql:48-50`):
```sql
status = CASE NEW.status
           WHEN 'draft' THEN 'Asserted' WHEN 'accepted' THEN 'Accepted'
           WHEN 'superseded' THEN 'Superseded' ELSE status END
```
The INSERT trigger (same migration, lines 30-32) is worse — its `ELSE` is `'Asserted'`, so `create_knowledge_entry(status:'Accepted')` silently creates the entry as `Asserted`.

## Design decisions (pinned)

1. **Normalize + reject** (plugin-only) — not a base-table status write, not a DB-trigger change. Lowest risk, single write path, keeps the legacy-vocab `23505` handling intact.
2. **Both** `update_knowledge_entry` and `create_knowledge_entry` (confirmed same trap).
3. **Re-read and return** the persisted row (Task 4) so the tool's contract is honest — kills the residual stale-`updated_at` echo and future-proofs against any trigger transform. (Normalization alone already removes the silent-promotion harm; Task 4 is the separable "authoritative return" piece.)
4. **Plugin-only** — DB-trigger hardening (accept v1 vocab / `RAISE` on unknown) overlaps B-402's territory and is out of scope here.

`'Archived'` (v1) has no legacy equivalent the view can express, so it is **rejected** with a clear message (strictly better than today's silent no-op).

## File Structure

- **Modify** `src/tools/knowledge.ts`
  - Add private helper `toLegacyStatus(status)` after `embedDecisionById` (~line 269).
  - `updateKnowledgeEntry` (line 488): normalize status into `updates`.
  - `createKnowledgeEntry` (line 420): normalize status into `record`.
  - Task 4: both handlers return `getKnowledgeEntry(client, projectId, { entry_id })` instead of the echoed row.
- **Modify** `src/tools/knowledge.test.ts` — new behavior tests (reuse `buildEmbedAwareClient`).
- **Modify** `.claude-plugin/plugin.json` — version bump (patch).
- **Rebuild** `dist/`.

---

### Task 1: `toLegacyStatus` helper + wire into `updateKnowledgeEntry`

**Files:**
- Modify: `src/tools/knowledge.ts` (add helper after `embedDecisionById`; edit `updateKnowledgeEntry:488`)
- Test: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Add failing tests** in the `updateKnowledgeEntry` describe block:

```ts
it('normalizes v1-capitalized status to the legacy vocab the view expects (B-415)', async () => {
  const updated = { ...sampleFullEntry, status: 'accepted' };
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: updated } });

  await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Accepted' });

  // the value written to the compat view must be lowercase 'accepted', not 'Accepted'
  expect(viewChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
});

it('passes legacy lowercase status through unchanged', async () => {
  const updated = { ...sampleFullEntry, status: 'superseded' };
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: updated } });

  await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'superseded' });

  expect(viewChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'superseded' }));
});

it('rejects an unrecognized status instead of silently dropping it', async () => {
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: sampleFullEntry } });

  await expect(
    updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Archived' }),
  ).rejects.toThrow(/Unsupported status/);
  expect(viewChain.update).not.toHaveBeenCalled();   // never reaches the view write
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/knowledge.test.ts -t "normalizes v1-capitalized"`
Expected: FAIL — `viewChain.update` receives `status: 'Accepted'` (raw), and `'Archived'` does not throw.

- [ ] **Step 3: Add the helper** — insert after `embedDecisionById` (after its closing brace, ~line 269):

```ts
/**
 * Normalize a caller-supplied status into the LEGACY lowercase vocab the
 * `workspace_knowledge` compat view's INSTEAD-OF triggers understand (B-415).
 *
 * Why: those triggers map status with a CASE that only recognizes
 * 'draft' | 'accepted' | 'superseded' (migration 20260602171200…sql). Any v1-
 * capitalized value ('Accepted', …) falls through ELSE → the UPDATE silently keeps
 * the old status (no-op) and the INSERT defaults to 'Asserted' — while the trigger's
 * RETURN NEW echoes the caller's input back as a false success. The rest of the
 * knowledge layer speaks v1-capitalized vocab, so callers naturally pass 'Accepted'.
 *
 * We translate v1 → legacy here (and pass legacy through). Anything unrecognized —
 * including v1 'Archived', which the legacy view cannot express — is REJECTED loudly
 * rather than silently dropped.
 */
function toLegacyStatus(status: string): string {
  const map: Record<string, string> = {
    draft: 'draft', accepted: 'accepted', superseded: 'superseded',
    Asserted: 'draft', Accepted: 'accepted', Superseded: 'superseded',
  };
  const legacy = map[status];
  if (!legacy) {
    throw new Error(
      `Unsupported status "${status}". Use Asserted/draft, Accepted/accepted, or Superseded/superseded ` +
      `(Archived is not settable via this tool — it writes the legacy compat view).`,
    );
  }
  return legacy;
}
```

- [ ] **Step 4: Wire into `updateKnowledgeEntry`** — change line 488 from:

```ts
  if (args.status !== undefined) updates.status = args.status;
```
to:
```ts
  if (args.status !== undefined) updates.status = toLegacyStatus(args.status);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts -t "updateKnowledgeEntry"`
Expected: PASS (new tests + all pre-existing updateKnowledgeEntry tests, incl. B-401's re-embed tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "fix(knowledge): normalize update_knowledge_entry status to legacy vocab + reject unknown [B-415]"
```

---

### Task 2: Wire normalizer into `createKnowledgeEntry`

**Files:**
- Modify: `src/tools/knowledge.ts:420` (`createKnowledgeEntry`)
- Test: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Add failing tests** in the `createKnowledgeEntry` describe block:

```ts
it('normalizes v1-capitalized status to legacy vocab on insert (B-415 sibling)', async () => {
  const created = { ...sampleFullEntry, id: 'ke-new', status: 'accepted' };
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: created } });

  await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention', status: 'Accepted' });

  // without normalization the INSERT trigger's ELSE would create this as 'Asserted'
  expect(viewChain.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
});

it('rejects an unrecognized status on create', async () => {
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: sampleFullEntry } });

  await expect(
    createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention', status: 'bogus' }),
  ).rejects.toThrow(/Unsupported status/);
  expect(viewChain.insert).not.toHaveBeenCalled();
});

it('defaults to draft when no status is given (unchanged)', async () => {
  const created = { ...sampleFullEntry, id: 'ke-new' };
  const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: created } });

  await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });

  expect(viewChain.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/knowledge.test.ts -t "normalizes v1-capitalized status to legacy vocab on insert"`
Expected: FAIL — insert receives `status: 'Accepted'`.

- [ ] **Step 3: Wire into `createKnowledgeEntry`** — change line 420 from:

```ts
    status: args.status ?? 'draft',
```
to:
```ts
    status: args.status !== undefined ? toLegacyStatus(args.status) : 'draft',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts -t "createKnowledgeEntry"`
Expected: PASS (new tests + pre-existing createKnowledgeEntry tests, incl. B-401's embed tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "fix(knowledge): normalize create_knowledge_entry status to legacy vocab [B-415]"
```

---

### Task 3: Re-read persisted row so the return is authoritative (the echo-lie)

**Files:**
- Modify: `src/tools/knowledge.ts` (`createKnowledgeEntry` tail line 445; `updateKnowledgeEntry` tail line 527)
- Test: `src/tools/knowledge.test.ts`

> This is the separable "authoritative return" piece. The compat-view triggers `RETURN NEW`, so the handler's `.select()` echoes the caller's *input*, not the persisted row (e.g. a stale `updated_at`). Re-reading via `getKnowledgeEntry` returns the true persisted state.

- [ ] **Step 1: Add failing tests.** `buildEmbedAwareClient`'s array `viewResult` form feeds successive `.single()` calls — element 0 = the echoed write result, element 1 = the authoritative re-read.

```ts
it('returns the authoritative persisted row, not the trigger echo (B-415)', async () => {
  const echoed      = { ...sampleFullEntry, id: 'ke-1', status: 'accepted', updated_at: '2026-01-01T00:00:00Z' }; // stale echo
  const persisted   = { ...sampleFullEntry, id: 'ke-1', status: 'accepted', updated_at: '2026-06-08T12:00:00Z' }; // real
  const { client } = buildEmbedAwareClient({ viewResult: [{ data: echoed }, { data: persisted }] });

  const result = await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Accepted' });

  expect(result.updated_at).toBe('2026-06-08T12:00:00Z');   // came from the re-read, not the echo
});

it('create returns the authoritative persisted row', async () => {
  const echoed    = { ...sampleFullEntry, id: 'ke-new', status: 'accepted' };
  const persisted = { ...sampleFullEntry, id: 'ke-new', status: 'accepted', title: 'persisted title' };
  const { client } = buildEmbedAwareClient({ viewResult: [{ data: echoed }, { data: persisted }] });

  const result = await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });

  expect(result.title).toBe('persisted title');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/knowledge.test.ts -t "authoritative persisted row"`
Expected: FAIL — handlers currently return the echoed (element 0) row.

- [ ] **Step 3: Implement the re-read.**

In `createKnowledgeEntry`, change the tail (currently `return created;` at line 445) to:
```ts
  await embedDecisionById(client, workspaceId, projectId, created.id, created.title, created.content);
  // The view's INSTEAD-OF INSERT trigger RETURN NEWs the input, so `created` echoes what we
  // sent (incl. status vocab/timestamps). Re-read for the authoritative persisted row (B-415).
  return getKnowledgeEntry(client, projectId, { entry_id: created.id });
```

In `updateKnowledgeEntry`, change the tail (currently `return updated;` at line 527) to:
```ts
  // Re-read for the authoritative persisted row — the view UPDATE trigger RETURN NEWs the
  // caller's input (stale updated_at, echoed status), not what actually landed (B-415).
  return getKnowledgeEntry(client, projectId, { entry_id: updated.id });
```

(Leave the `const updated = data as KnowledgeEntryFull;` and the `embedDecisionById` call above it unchanged — the embed correctly uses the new title/content from the echoed row.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts`
Expected: PASS — full knowledge suite. (Pre-existing create/update tests that assert on the returned row may need their mock switched to `buildEmbedAwareClient` with an array `viewResult`, OR their single `viewResult` is returned for BOTH the write and the re-read `.single()` calls — the queue returns the last element when only one is supplied, so a single-element `viewResult` still yields the same row on the re-read. Confirm; only adjust a test if it genuinely breaks.)

- [ ] **Step 5: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "fix(knowledge): return authoritative re-read from create/update instead of trigger echo [B-415]"
```

---

### Task 4: Full verification, version bump, dist rebuild, PR

**Files:**
- Modify: `.claude-plugin/plugin.json` (version)
- Rebuild: `dist/`

- [ ] **Step 1: Full suite + gates green.**

```bash
npm test            # full vitest suite (was 292; now +~8)
npm run typecheck
npm run lint        # eslint --max-warnings=0
```
If any fail, STOP and fix before proceeding.

- [ ] **Step 2: Bump the version.** `node -p "require('./.claude-plugin/plugin.json').version"`, then bump the PATCH (e.g. `0.11.2` → `0.11.3`) in `.claude-plugin/plugin.json`.

- [ ] **Step 3: Rebuild + verify dist.**

```bash
npm run build && npm run verify:dist   # must pass
```

- [ ] **Step 4: Commit dist + version + plan doc.**

```bash
git add dist/ .claude-plugin/plugin.json docs/superpowers/plans/2026-06-08-update-knowledge-status-vocab.md
git commit -m "chore(knowledge): rebuild dist + bump version + plan doc for B-415 status-vocab fix"
```

- [ ] **Step 5: Push + open PR (do NOT merge).**

```bash
git push -u origin fix/update-knowledge-status-vocab
gh pr create --title "fix(knowledge): normalize status vocab + authoritative return for create/update_knowledge_entry [B-415]" --body "<summary + test plan>"
```
Then move B-415 → **In Review**, comment the PR URL. STOP — do not run finish-work until the user says so.

---

## Self-Review

- **Spec coverage:** status no-op fix = Tasks 1 (update) + 2 (create); echo-lie/authoritative return = Task 3; reject-unknown = Tasks 1+2; ship = Task 4. ✓
- **Sibling audit:** only `createKnowledgeEntry` + `updateKnowledgeEntry` pass caller status to the view; `supersedeKnowledgeEntry` already passes legacy `'accepted'`/`'superseded'` (unaffected, but now flows through `toLegacyStatus` as a pass-through); `record_decision`/`assert_fact`/`supersedeDecision` write the base table with v1 vocab (unaffected). ✓
- **No regression:** `'Archived'` now throws instead of silently no-opping (strictly better); legacy vocab unchanged; `23505` duplicate-title handling untouched. ✓
- **Type/name consistency:** `toLegacyStatus(status: string): string` — same private-helper pattern as `embedText`/`embedDecisionById`; tested via the public handlers. `getKnowledgeEntry(client, projectId, { entry_id })` matches its existing signature (line 359). ✓
- **Placeholder scan:** none — all steps carry real code + commands. ✓
