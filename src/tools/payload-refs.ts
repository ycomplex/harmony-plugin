// B-810 — the canonical ref scheme for a brief's structured `doc.payload` (AcceptanceEventPayloadItem[],
// acceptance-events.ts). Every compose_brief call site that authors payload items MUST derive its `ref`
// through `slugRef` + dedupe through `dedupeRefs` here — never reinvent the scheme per site. A ref is a
// deterministic, CONTENT-derived slug (never a positional index), so an unchanged item reproduces the
// identical ref across an in-place `iterate` recompose — that stability is what lets a retried apply
// re-derive the SAME external_ref for the SAME logical write (acceptance-events.ts's idempotency ledger).

/** Kebab-case a piece of authored text: lowercase, collapse any run of non-alphanumeric characters to a
 *  single hyphen, trim leading/trailing hyphens, then truncate to `maxLen` characters — trimming any
 *  trailing hyphen the truncation itself introduces (a cut mid-word must never leave a dangling `-`). */
function kebabSlug(text: string, maxLen: number): string {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return full.slice(0, maxLen).replace(/-+$/g, '');
}

/** `<prefix>-<kebab-slug of text, ≤maxLen chars>` — the one ref scheme every payload author uses.
 *  `text` should be the item's OWN content (an AC's content, a child's title, a plan step's title —
 *  never a positional index), so the ref is stable across an in-place iterate recompose of an
 *  unchanged item. Empty/all-punctuation text degrades to the literal slug `item` rather than emitting
 *  a bare trailing hyphen. */
export function slugRef(prefix: string, text: string, maxLen = 40): string {
  const slug = kebabSlug(text ?? '', maxLen) || 'item';
  return `${prefix}-${slug}`;
}

/**
 * Guarantee ref uniqueness WITHIN one payload. A content-derived slug can collide (two items with
 * identically-worded, or identically-sliced-to-`maxLen`, text) — this is a within-payload dedup pass
 * over already-computed refs: the FIRST occurrence of a ref is left untouched, every later collision
 * gets a deterministic `-2`, `-3`, ... suffix, assigned in item (array) order. Pure and generic over any
 * item shape carrying a `ref: string` field — payload authors call this AFTER computing every item's ref
 * via `slugRef`, right before handing the array to `compose_brief`.
 */
export function dedupeRefs<T extends { ref: string }>(items: T[]): T[] {
  const seenCounts = new Map<string, number>();
  return items.map((item) => {
    const count = (seenCounts.get(item.ref) ?? 0) + 1;
    seenCounts.set(item.ref, count);
    return count === 1 ? item : { ...item, ref: `${item.ref}-${count}` };
  });
}
