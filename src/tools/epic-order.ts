/** Same ordering contract and golden fixture in web and plugin. No locale defaults. */
export function sortEpics<T extends { id: string; name: string; retired_at?: string | null }>(epics: T[]): T[] {
  const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return [...epics].sort((a, b) => Number(!!a.retired_at) - Number(!!b.retired_at)
    || lexical(a.name.toLowerCase(), b.name.toLowerCase()) || lexical(a.id, b.id));
}
