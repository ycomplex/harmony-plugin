import {
  buildLibraryMap,
  LIBRARY_MAP_VERSION,
  type LibraryComponent,
  LibraryMapError,
} from "./figma-library-map.js";

/** Single refresh owner. A durable claim precedes ANY read/refresh; never retry an ambiguous grant. */
export interface FigmaGrant {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  client_id: string;
  token_endpoint: string;
}
export interface RefreshWork {
  workspace_id: string;
  generation: number;
  grant_version: string;
  in_flight: boolean;
  /** Absent on an older database: treated as version 1. */
  library_map_version?: number | null;
  library_refresh_requested?: boolean;
}
export interface RefreshPorts {
  transition(
    work: RefreshWork,
    action: "claim" | "publish" | "failed" | "ambiguous",
    data?: Record<string, unknown>,
  ): Promise<boolean>;
  readGrant(version: string): Promise<FigmaGrant>;
  refresh(grant: FigmaGrant): Promise<unknown>;
  append(
    work: RefreshWork,
    kind: "grant" | "access",
    value: string,
  ): Promise<string>;
}

export function rotatedGrant(
  old: FigmaGrant,
  response: unknown,
  now: number,
): FigmaGrant {
  const r = response as Record<string, unknown>;
  if (
    !r ||
    typeof r.access_token !== "string" ||
    !r.access_token ||
    (r.refresh_token !== undefined &&
      (typeof r.refresh_token !== "string" || !r.refresh_token)) ||
    typeof r.expires_in !== "number" ||
    !Number.isFinite(r.expires_in) ||
    r.expires_in <= 0
  ) {
    throw new Error("Incomplete refresh grant");
  }
  return {
    ...old,
    ...r,
    access_token: r.access_token,
    refresh_token: typeof r.refresh_token === "string"
      ? r.refresh_token
      : old.refresh_token,
    expires_at: now + r.expires_in * 1000,
  };
}

export async function refreshWorkspace(
  work: RefreshWork,
  ports: RefreshPorts,
  now: number,
): Promise<"ok" | "skipped" | "reconnect"> {
  // A prior process died after claiming: its token may have been spent. No read, no POST.
  if (work.in_flight) {
    await ports.transition(work, "ambiguous");
    return "reconnect";
  }
  if (!(await ports.transition(work, "claim"))) return "skipped";
  let attempted = false;
  try {
    const grant = await ports.readGrant(work.grant_version);
    if (!grant.refresh_token || !Number.isFinite(grant.expires_at)) {
      throw new Error("Incomplete stored grant");
    }
    attempted = true;
    const next = rotatedGrant(grant, await ports.refresh(grant), now);
    // This order is irreversible: never publish an access token whose rotated full grant is not durable.
    const grantVersion = await ports.append(
      work,
      "grant",
      JSON.stringify(next),
    );
    const accessVersion = await ports.append(work, "access", next.access_token);
    if (
      !(await ports.transition(work, "publish", {
        grant: grantVersion,
        access: accessVersion,
        expires_at: new Date(next.expires_at).toISOString(),
      }))
    ) {
      return "skipped";
    }
    return "ok";
  } catch {
    // Leave the durable in-flight marker if the health write itself fails: the next run fails closed.
    await ports.transition(work, attempted ? "ambiguous" : "failed");
    return "reconnect";
  }
}

/** Queue boundary: a failed state write leaves the durable claim intact, but cannot starve siblings. */
export async function refreshWorkspaceSafely(
  work: RefreshWork,
  ports: RefreshPorts,
  now: number,
): Promise<string> {
  try {
    return await refreshWorkspace(work, ports, now);
  } catch {
    return "refresh-state-write-failed";
  }
}

/** The library step runs when a refresh was requested or the stored map predates the current keying. */
export function libraryRefreshDue(work: RefreshWork): boolean {
  return !work.in_flight &&
    (work.library_refresh_requested === true ||
      (work.library_map_version ?? 1) < LIBRARY_MAP_VERSION);
}

export interface LibraryPorts {
  fetchComponents(work: RefreshWork): Promise<LibraryComponent[]>;
  transition(
    work: RefreshWork,
    action: "library" | "library_failed",
    data: Record<string, unknown>,
  ): Promise<boolean>;
  log(entry: Record<string, unknown>): void;
}

const MAX_ERROR = 300;
/** Short and secret-free: duplicate component keys for a map error, a fixed string otherwise. */
export function libraryErrorMessage(e: unknown): string {
  if (e instanceof LibraryMapError) {
    return `Duplicate library keys: ${e.duplicates.join("; ")}`.slice(0, MAX_ERROR);
  }
  return "Library refresh failed";
}

/**
 * Never throws: a library failure is recorded on the connection (`library_failed`) and must not
 * stop the OAuth token refresh that follows in the same pass.
 */
export async function refreshLibrary(
  work: RefreshWork,
  ports: LibraryPorts,
): Promise<"skipped" | "published" | "failed"> {
  if (!libraryRefreshDue(work)) return "skipped";
  try {
    const built = buildLibraryMap(await ports.fetchComponents(work));
    const ok = await ports.transition(work, "library", {
      library_components: built.library_components,
      library_ambiguous: built.library_ambiguous,
      library_map_version: LIBRARY_MAP_VERSION,
    });
    return ok ? "published" : "skipped";
  } catch (e) {
    const error = libraryErrorMessage(e);
    ports.log({
      workspace_id: work.workspace_id,
      result: "library-refresh-failed",
      error,
    });
    try {
      await ports.transition(work, "library_failed", { error });
    } catch {
      ports.log({
        workspace_id: work.workspace_id,
        result: "library-failure-write-failed",
      });
    }
    return "failed";
  }
}

/**
 * One queue item: the library step first, then the OAuth token refresh exactly as before.
 * The library step never throws, so a map failure cannot starve the token refresh.
 */
export async function refreshPass(
  work: RefreshWork & { refresh_due?: boolean },
  library: LibraryPorts,
  tokens: RefreshPorts,
  now: number,
): Promise<string | null> {
  await refreshLibrary(work, library);
  if (!work.refresh_due && !work.in_flight) return null;
  return refreshWorkspaceSafely(work, tokens, now);
}
