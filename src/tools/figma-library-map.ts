// Pure builder for the Figma library component map (B-1321). No imports: shared verbatim
// with the plugin repo, which pins the same output hash in a parity test.
export const LIBRARY_MAP_VERSION = 2;
export const SET_SEPARATOR = " :: ";

export interface LibraryComponent {
  key: string;
  name: string;
  containing_frame?: {
    name?: string;
    pageName?: string;
    containingStateGroup?: { name?: string } | null;
  } | null;
}
export interface LibraryCandidate {
  key: string;
  frame: string;
  page: string;
}
export interface LibraryMap {
  library_components: Record<string, string>;
  library_ambiguous: Record<string, LibraryCandidate[]>;
}

export class LibraryMapError extends Error {
  duplicates: string[];
  constructor(duplicates: string[]) {
    super(
      `Library map has duplicate keys: ${duplicates.join(", ")}`,
    );
    this.name = "LibraryMapError";
    this.duplicates = duplicates;
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildLibraryMap(components: LibraryComponent[]): LibraryMap {
  const library_components: Record<string, string> = {};
  const duplicates = new Set<string>();
  const standalones = new Map<string, Map<string, LibraryCandidate>>();

  for (const c of components) {
    const set = c.containing_frame?.containingStateGroup?.name;
    if (typeof set === "string" && set !== "") {
      const qualified = `${set}${SET_SEPARATOR}${c.name}`;
      if (
        Object.prototype.hasOwnProperty.call(library_components, qualified) &&
        library_components[qualified] !== c.key
      )
        duplicates.add(qualified);
      else library_components[qualified] = c.key;
    } else {
      let byKey = standalones.get(c.name);
      if (!byKey) standalones.set(c.name, (byKey = new Map()));
      byKey.set(c.key, {
        key: c.key,
        frame: c.containing_frame?.name ?? "",
        page: c.containing_frame?.pageName ?? "",
      });
    }
  }

  const library_ambiguous: Record<string, LibraryCandidate[]> = {};
  for (const [name, byKey] of standalones) {
    if (byKey.size === 1) {
      if (Object.prototype.hasOwnProperty.call(library_components, name))
        duplicates.add(name);
      else library_components[name] = [...byKey.keys()][0];
    } else {
      library_ambiguous[name] = [...byKey.values()].sort(
        (a, b) => cmp(a.frame, b.frame) || cmp(a.key, b.key),
      );
    }
  }

  if (duplicates.size) throw new LibraryMapError([...duplicates].sort(cmp));
  return { library_components, library_ambiguous };
}
