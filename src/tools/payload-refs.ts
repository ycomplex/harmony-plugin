// B-810 — the canonical ref scheme for a brief's `doc.payload` (AcceptanceEventPayloadItem[]).
// Every compose_brief call site that authors a structured payload (clarify, decompose,
// design-decide, start-work) derives its items' `ref` from THIS module — never reinvented
// per site — so the stable-ref discipline `applyAcceptanceEventPayload`'s idempotent
// (event_id, write_kind, external_ref) ledger depends on is enforced in exactly one place.

/** Deterministic, human-legible slug: lowercase, non-alphanumeric runs collapsed to a single
 *  `-`, leading/trailing `-` trimmed, then prefixed `"<prefix>-<slug>"` and clamped to
 *  `maxLen` characters (trimming a trailing `-` left by the clamp). A `text` with no
 *  alphanumeric content degrades to the bare `prefix` (never a dangling `"<prefix>-"`). */
export function slugRef(prefix: string, text: string, maxLen = 40): string {
  const slug = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  let ref = slug ? `${prefix}-${slug}` : prefix;
  if (ref.length > maxLen) {
    ref = ref.slice(0, maxLen).replace(/-+$/g, '');
  }
  return ref;
}

/** Disambiguate a same-payload `ref` collision with a deterministic `-2`, `-3`, ... suffix,
 *  IN ITEM ORDER — the first occurrence of a given ref is left unchanged; every later
 *  occurrence is suffixed with the lowest integer ≥2 not already in use (so a ref that
 *  collides with an already-disambiguated suffix, e.g. two independent items separately
 *  producing `"ac-x"` and `"ac-x-2"`, still resolves to distinct refs). Never mutates the
 *  input; returns a new array. */
export function dedupeRefs<T extends { ref: string }>(items: T[]): T[] {
  const used = new Set<string>();
  return items.map((item) => {
    if (!used.has(item.ref)) {
      used.add(item.ref);
      return item;
    }
    let n = 2;
    while (used.has(`${item.ref}-${n}`)) n++;
    const ref = `${item.ref}-${n}`;
    used.add(ref);
    return { ...item, ref };
  });
}
