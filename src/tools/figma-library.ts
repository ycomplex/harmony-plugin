/** Lookup over the saved Figma library map (B-1321). `key` is always the Figma component key. */
import { SET_SEPARATOR } from "./figma-library-map.js";

export type LibraryMapShape = Record<string, string>;
export interface LibraryCandidate {
  key: string;
  detail: string;
  name?: string;
  frame?: string;
  page?: string;
}
export type LibraryResolution =
  | { status: "found"; key: string; name: string; via: "qualified" | "bare" | "legacy" }
  | { status: "ambiguous"; name: string; candidates: LibraryCandidate[] }
  | { status: "not-found" };
export interface ResolveOptions {
  set?: string;
  /** On-demand read of the stored ambiguous candidates for one bare name. */
  candidates?: (
    name: string,
  ) => Promise<Array<{ key: string; frame?: string; page?: string }>>;
}

const has = (map: LibraryMapShape, k: string) =>
  Object.prototype.hasOwnProperty.call(map, k);

/** Old shape: name -> key with no set-qualified entry anywhere. */
export function isLegacyMap(map: LibraryMapShape): boolean {
  return !Object.keys(map).some((k) => k.includes(SET_SEPARATOR));
}

export async function resolveLibraryComponent(
  map: LibraryMapShape,
  name: string,
  opts: ResolveOptions = {},
): Promise<LibraryResolution> {
  const legacy = isLegacyMap(map);
  if (opts.set !== undefined) {
    const qualified = `${opts.set}${SET_SEPARATOR}${name}`;
    if (has(map, qualified)) {
      return { status: "found", key: map[qualified], name: qualified, via: "qualified" };
    }
    if (legacy && has(map, name)) {
      return { status: "found", key: map[name], name, via: "legacy" };
    }
    return { status: "not-found" };
  }
  if (has(map, name)) {
    return {
      status: "found",
      key: map[name],
      name,
      via: legacy ? "legacy" : "bare",
    };
  }
  const suffix = `${SET_SEPARATOR}${name}`;
  const hits = Object.keys(map).filter((k) => k.endsWith(suffix)).sort();
  if (hits.length === 1) {
    return { status: "found", key: map[hits[0]], name: hits[0], via: "qualified" };
  }
  if (hits.length > 1) {
    return {
      status: "ambiguous",
      name,
      candidates: hits.map((k) => ({
        key: map[k],
        name: k,
        detail: `set ${k.slice(0, k.length - suffix.length)}`,
      })),
    };
  }
  if (opts.candidates) {
    try {
      const rows = await opts.candidates(name);
      if (Array.isArray(rows) && rows.length > 0) {
        return {
          status: "ambiguous",
          name,
          candidates: rows.map((r) => ({
            key: r.key,
            frame: r.frame,
            page: r.page,
            detail: `frame ${r.frame ?? "?"}`,
          })),
        };
      }
    } catch {
      /* an unavailable candidates read is a miss, never a failure */
    }
  }
  return { status: "not-found" };
}

export function listLibrarySets(
  map: LibraryMapShape,
): Array<{ set: string; variants: number }> {
  const counts = new Map<string, number>();
  for (const k of Object.keys(map)) {
    const i = k.indexOf(SET_SEPARATOR);
    if (i < 0) continue;
    const set = k.slice(0, i);
    counts.set(set, (counts.get(set) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([set, variants]) => ({ set, variants }));
}
