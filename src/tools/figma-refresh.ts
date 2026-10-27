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
