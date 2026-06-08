# Knowledge Promote/Create Re-embed Fix (B-401) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `update_knowledge_entry` (and the sibling `create_knowledge_entry`) write a fresh embedding to the `knowledge_decisions` base table so promoted/created knowledge is retrievable by semantic search.

**Architecture:** Both `createKnowledgeEntry` and `updateKnowledgeEntry` write through the `workspace_knowledge` compat **VIEW**, whose INSTEAD-OF triggers don't touch the `embedding` column (B-375). The `embed-knowledge` edge function has no DB access — the caller computes the vector and stores it. So after the view write returns the merged row (`id`, final `title`, final `content`), we compute the embedding client-side via the existing `embedText` helper and persist it straight to `knowledge_decisions` by `id`, best-effort (mirroring `recordDecision`). `updateKnowledgeEntry` only re-embeds when `title` or `content` changed (the embed text is `title\ncontent`; status/type/tags don't affect it). `supersedeKnowledgeEntry` heals transitively — it builds its replacement via `createKnowledgeEntry`.

**Tech Stack:** TypeScript, `@supabase/supabase-js`, vitest, esbuild (committed `dist/`).

---

## Background — the bug (B-401)

- `record_decision` / `assert_fact` embed correctly: they write the **base table** and stuff `embedding` into the same insert.
- `update_knowledge_entry` writes the **view** and never calls `embedText()` → after a content-changing promote (`Asserted→Accepted` plus the founder's "why"), the embedding is stale/null.
- `knowledge_search_rrf` filters `status='Accepted' AND embedding IS NOT NULL` → the promoted entry is invisible to vector search.
- Sibling audit found `create_knowledge_entry` has the **same** gap (view insert, no embed); `supersedeKnowledgeEntry`'s replacement inherits it via `createKnowledgeEntry`.

## What we are NOT doing (explicitly deferred)

- **Prod remediation** of the two stale entries (`bfd7eec8…`, `e9a7d933…`) — out of scope per the ticket owner.
- **DB-layer freshness guard** (a base-table trigger that marks `embedding` stale on content change) — defense-in-depth for non-plugin write paths (e.g. the web UI). To be filed as a **separate Tech-Debt ticket** on plan approval; not in this PR.

## File Structure

- **Modify** `src/tools/knowledge.ts`
  - Add a private helper `embedDecisionById(client, workspaceId, projectId, id, title, content)` near `embedText` (~line 237).
  - Wire it into `createKnowledgeEntry` (after the view insert, ~line 411) — always embed.
  - Wire it into `updateKnowledgeEntry` (after the view update, ~line 483) — embed only when title/content changed.
- **Modify** `src/tools/knowledge.test.ts`
  - Add a table-name-keyed mock builder `buildEmbedAwareClient` and behavior tests.
- **Modify** `.claude-plugin/plugin.json` — version bump (patch).
- **Rebuild** `dist/` — committed (esbuild bundle).

---

### Task 1: Shared re-embed helper

**Files:**
- Modify: `src/tools/knowledge.ts` (insert after `embedText`, currently ends line 237)

- [ ] **Step 1: Add the helper**

Insert immediately after the `embedText` function (after line 237):

```ts
/**
 * Re-embed a knowledge decision by id on the BASE table.
 *
 * Why this exists: createKnowledgeEntry / updateKnowledgeEntry write through the
 * `workspace_knowledge` compat VIEW, whose INSTEAD-OF triggers do NOT touch the
 * `embedding` column (B-375 / B-401). A view INSERT or content-changing UPDATE
 * therefore leaves the vector null/stale → the row is invisible to
 * knowledge_search_rrf (which filters `embedding IS NOT NULL`). The embed-knowledge
 * edge fn has no DB access, so we compute the vector client-side and persist it
 * straight to knowledge_decisions, scoped by workspace+project+id.
 *
 * Best-effort, mirroring recordDecision: if embedText returns null (key unset / fn
 * down) we leave the embedding untouched rather than failing the user's write.
 */
async function embedDecisionById(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
  id: string,
  title: string,
  content: string | null,
): Promise<void> {
  const embedding = await embedText(client, `${title}\n${content ?? ''}`);
  if (!embedding) return;
  await client
    .from('knowledge_decisions')
    .update({ embedding })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', id);
}
```

- [ ] **Step 2: Typecheck compiles**

Run: `npm run typecheck`
Expected: PASS (no usages yet — helper is defined; eslint may warn "unused" until Task 2/3 wire it in, so do Step 2 only as a compile check; the unused-var lint is resolved by Task 2).

- [ ] **Step 3: Commit**

```bash
git add src/tools/knowledge.ts
git commit -m "feat(knowledge): add embedDecisionById base-table re-embed helper [B-401]"
```

---

### Task 2: `createKnowledgeEntry` embeds on insert (sibling gap)

**Files:**
- Modify: `src/tools/knowledge.ts:370-412` (`createKnowledgeEntry`)
- Test: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Add the table-aware mock + failing tests**

Add this mock builder once, near the existing `buildWorkspaceAndQueryClient` (after line 113), if not already added by a prior task:

```ts
/**
 * Mock that routes client.from(table) by NAME (not call-order), and mocks
 * functions.invoke for embedText. viewResult may be a single {data,error} or an
 * ARRAY consumed in sequence by successive .single() calls (for multi-write flows
 * like supersedeKnowledgeEntry). embedding:null makes the edge fn return an error
 * (embedText → null), exercising the best-effort path.
 */
function buildEmbedAwareClient(opts: {
  viewResult: { data: any; error?: any } | Array<{ data: any; error?: any }>;
  embedding?: number[] | null;
}) {
  const wsChain: any = {};
  wsChain.select = vi.fn().mockReturnValue(wsChain);
  wsChain.eq = vi.fn().mockReturnValue(wsChain);
  wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });

  const viewQueue = Array.isArray(opts.viewResult) ? [...opts.viewResult] : [opts.viewResult];
  const viewChain: any = {};
  viewChain.select = vi.fn().mockReturnValue(viewChain);
  viewChain.insert = vi.fn().mockReturnValue(viewChain);
  viewChain.update = vi.fn().mockReturnValue(viewChain);
  viewChain.eq = vi.fn().mockReturnValue(viewChain);
  viewChain.single = vi.fn().mockImplementation(() => {
    const next = viewQueue.length > 1 ? viewQueue.shift()! : viewQueue[0];
    return Promise.resolve({ data: next.data, error: next.error ?? null });
  });

  const baseChain: any = {};
  baseChain.update = vi.fn().mockReturnValue(baseChain);
  baseChain.eq = vi.fn().mockReturnValue(baseChain); // terminal — awaited directly, no .single()

  const client: any = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'projects') return wsChain;
      if (table === 'knowledge_decisions') return baseChain;
      return viewChain; // workspace_knowledge
    }),
    functions: {
      invoke: vi.fn().mockResolvedValue(
        opts.embedding === null
          ? { data: null, error: { message: 'down' } }
          : { data: { embedding: opts.embedding ?? [0.1, 0.2] }, error: null },
      ),
    },
  };
  return { client, wsChain, viewChain, baseChain };
}
```

Then add tests in the `createKnowledgeEntry` describe block:

```ts
it('embeds on insert via the base table (sibling of B-401)', async () => {
  const created = { ...sampleFullEntry, id: 'ke-new', title: 'Brand new', content: 'body' };
  const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: created } });

  await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'Brand new', content: 'body', type: 'convention' });

  expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'Brand new\nbody' } });
  expect(client.from).toHaveBeenCalledWith('knowledge_decisions');
  expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
  expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-new');
});

it('returns the created entry even when embedding fails (best-effort)', async () => {
  const created = { ...sampleFullEntry, id: 'ke-new' };
  const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: created }, embedding: null });

  const result = await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });

  expect(result).toEqual(created);
  expect(baseChain.update).not.toHaveBeenCalled(); // null embedding → no base write
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/knowledge.test.ts -t "embeds on insert"`
Expected: FAIL — `baseChain.update` never called (create doesn't embed yet).

- [ ] **Step 3: Wire the helper into `createKnowledgeEntry`**

Replace the tail of `createKnowledgeEntry` (the `return data as KnowledgeEntryFull;` at line 411) with:

```ts
  await embedDecisionById(
    client, workspaceId, projectId,
    (data as { id: string }).id,
    (data as { title: string }).title,
    (data as { content: string | null }).content,
  );
  return data as KnowledgeEntryFull;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts -t "createKnowledgeEntry"`
Expected: PASS (new tests + all pre-existing createKnowledgeEntry tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "fix(knowledge): embed create_knowledge_entry on insert [B-401]"
```

---

### Task 3: `updateKnowledgeEntry` re-embeds on title/content change (the B-401 fix)

**Files:**
- Modify: `src/tools/knowledge.ts:428-484` (`updateKnowledgeEntry`)
- Test: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Add failing tests**

In the `updateKnowledgeEntry` describe block:

```ts
it('re-embeds via the base table when content changes (B-401)', async () => {
  const updated = { ...sampleFullEntry, status: 'accepted', content: 'NEW why-rich content' };
  const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: updated } });

  await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', content: 'NEW why-rich content', status: 'accepted' });

  expect(client.from).toHaveBeenCalledWith('workspace_knowledge');               // legacy view write unchanged
  expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `${updated.title}\nNEW why-rich content` } });
  expect(client.from).toHaveBeenCalledWith('knowledge_decisions');               // base-table embedding write
  expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
  expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-1');
});

it('re-embeds when the title changes', async () => {
  const updated = { ...sampleFullEntry, title: 'Renamed title', content: sampleFullEntry.content };
  const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: updated } });

  await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'Renamed title' });

  expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `Renamed title\n${sampleFullEntry.content}` } });
  expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
});

it('does NOT re-embed when only status changes (no wasted embed call)', async () => {
  const updated = { ...sampleFullEntry, status: 'accepted' };
  const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: updated } });

  await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'accepted' });

  expect(client.from).toHaveBeenCalledWith('workspace_knowledge');   // view update still happens
  expect(client.functions.invoke).not.toHaveBeenCalled();            // no embed
  expect(baseChain.update).not.toHaveBeenCalled();                   // no base write
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/tools/knowledge.test.ts -t "re-embeds"`
Expected: FAIL — embedding never written on update.

- [ ] **Step 3: Wire the helper into `updateKnowledgeEntry`**

Replace the tail of `updateKnowledgeEntry` (the `return data as KnowledgeEntryFull;` at line 483) with:

```ts
  // Re-embed only when the embedded text (title\ncontent) actually changed. The
  // view's INSTEAD-OF UPDATE trigger never touches the embedding column, so without
  // this the promoted/edited row keeps a stale (or null) vector and is invisible to
  // knowledge_search_rrf. embedDecisionById writes the fresh vector to the base table
  // by id, using the merged title/content returned by the view update above.
  if (args.new_title !== undefined || args.content !== undefined) {
    await embedDecisionById(
      client, workspaceId, projectId,
      (data as { id: string }).id,
      (data as { title: string }).title,
      (data as { content: string | null }).content,
    );
  }
  return data as KnowledgeEntryFull;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tools/knowledge.test.ts -t "updateKnowledgeEntry"`
Expected: PASS (new tests + pre-existing updateKnowledgeEntry tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/knowledge.ts src/tools/knowledge.test.ts
git commit -m "fix(knowledge): re-embed update_knowledge_entry on title/content change [B-401]"
```

---

### Task 4: Regression test — `supersedeKnowledgeEntry` replacement is embedded (transitive)

**Files:**
- Test: `src/tools/knowledge.test.ts`

- [ ] **Step 1: Add the test**

In the `supersedeKnowledgeEntry` describe block (sequence: getKnowledgeEntry → createKnowledgeEntry insert → old-entry update):

```ts
it('embeds the replacement entry (transitive via createKnowledgeEntry) [B-401]', async () => {
  const existing = { ...sampleFullEntry, id: 'ke-old' };
  const replacement = { ...sampleFullEntry, id: 'ke-repl', title: 'New ruling', content: 'updated body' };
  const supersededRow = { ...existing, status: 'superseded', superseded_by: 'ke-repl' };
  const { client, baseChain } = buildEmbedAwareClient({
    viewResult: [{ data: existing }, { data: replacement }, { data: supersededRow }],
  });

  const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
    entry_id: 'ke-old', new_title: 'New ruling', new_content: 'updated body',
  });

  expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'New ruling\nupdated body' } });
  expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
  expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-repl');
  expect(result.replacement.id).toBe('ke-repl');
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run src/tools/knowledge.test.ts -t "embeds the replacement"`
Expected: PASS (no source change — Task 2 already wired createKnowledgeEntry). If it FAILS, the supersede path diverged from createKnowledgeEntry — investigate before proceeding.

- [ ] **Step 3: Commit**

```bash
git add src/tools/knowledge.test.ts
git commit -m "test(knowledge): assert supersede replacement is embedded [B-401]"
```

---

### Task 5: Full verification, version bump, dist rebuild

**Files:**
- Modify: `.claude-plugin/plugin.json` (version)
- Rebuild: `dist/`

- [ ] **Step 1: Full test suite green**

Run: `npm test`
Expected: PASS — all suites (was 286 tests at baseline; now +~7).

- [ ] **Step 2: Typecheck + lint clean**

Run: `npm run typecheck && npm run lint`
Expected: PASS, 0 warnings (eslint enforces `--max-warnings=0`). The helper is now used, so no unused-var warning.

- [ ] **Step 3: Bump the plugin version**

Edit `.claude-plugin/plugin.json` — bump the patch version (e.g. `0.11.1` → `0.11.2`). Confirm the current value first:

Run: `node -p "require('./.claude-plugin/plugin.json').version"`

- [ ] **Step 4: Rebuild dist + verify**

Run: `npm run build && npm run verify:dist`
Expected: `verify:dist` PASS (committed `dist/` matches a fresh build).

- [ ] **Step 5: Commit dist + version**

```bash
git add dist/ .claude-plugin/plugin.json
git commit -m "chore: rebuild dist + bump version for B-401 re-embed fix"
```

- [ ] **Step 6: Push + open PR (do NOT merge — wait for user validation)**

```bash
git push -u origin fix/knowledge-promote-reembed
gh pr create --title "fix(knowledge): re-embed create/update_knowledge_entry so promoted knowledge is retrievable [B-401]" --body "<summary + test plan>"
```

Then: move B-401 → **In Review**, comment the PR URL on the ticket. STOP — per workspace rules, do not run finish-work until the user explicitly says so.

---

## Self-Review

- **Spec coverage:** B-401 core (update re-embed) = Task 3; sibling audit (create) = Task 2; sibling (supersede) = Task 4; helper = Task 1; ship = Task 5. ✓
- **Deferred items tracked:** prod remediation (out of scope per owner); DB freshness guard → separate ticket on approval. ✓
- **Type consistency:** helper `embedDecisionById(client, workspaceId, projectId, id, title, content)` — same signature used by both call sites; embed string `\`${title}\n${content ?? ''}\`` matches `recordDecision` (line 552) exactly. ✓
- **Mock realism:** `buildEmbedAwareClient` routes by table name (not call-order) so the new base-table write is observable; existing tests (no `functions` mock) keep passing because `embedText` swallows the missing-`functions` TypeError → null → no base write. ✓
