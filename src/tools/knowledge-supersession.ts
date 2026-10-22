/** Read-only projection of the existing successor FK. Never invent edges from prose. */
export function projectSupersession<T extends { id: string }>(
  entries: T[], edges: Array<{ id: string; superseded_by?: string | null }>,
): Array<T & { superseded_by: string | null; supersedes: string[] }> {
  const successor = new Map(edges.map(e => [e.id, e.superseded_by ?? null]));
  const predecessors = new Map<string, string[]>();
  for (const [id, next] of successor) {
    if (next && next !== id) predecessors.set(next, [...(predecessors.get(next) ?? []), id]);
  }
  const projected = entries.map(e => ({ ...e, superseded_by: successor.get(e.id) ?? null, supersedes: predecessors.get(e.id) ?? [] }));
  const matching = new Set(entries.map(e => e.id));
  const dependencies = new Map<string, Set<string>>();
  for (const entry of entries) {
    const seen = new Set([entry.id]);
    const deps = new Set<string>();
    let next = successor.get(entry.id);
    while (next && !seen.has(next)) {
      seen.add(next);
      if (matching.has(next)) deps.add(next);
      next = successor.get(next);
    }
    dependencies.set(entry.id, deps);
  }
  // Stable topological order: pick the earliest available result. A malformed cycle is
  // broken at its earliest baseline member, deterministically, rather than looping forever.
  const remaining = [...projected];
  const output: typeof projected = [];
  while (remaining.length) {
    const index = remaining.findIndex(e => dependencies.get(e.id)!.size === 0);
    const [entry] = remaining.splice(index < 0 ? 0 : index, 1);
    output.push(entry);
    for (const deps of dependencies.values()) deps.delete(entry.id);
  }
  return output;
}
