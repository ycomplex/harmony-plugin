/** Only deliberately safe setup errors may be shown below the import-failure header. */
export class FigmaSetupError extends Error {}

/**
 * B-1310: the save call was definitely refused. The figma-connect function answered 4xx with a JSON `error`,
 * so nothing was published and the existing connection is unchanged. The message is already redacted.
 */
export class FigmaSaveRejected extends FigmaSetupError {}

/** B-1310: the reason the connect function gives when a workspace's slots are not yet provisioned. */
export const UNPROVISIONED_SLOTS_REASON = "provision workspace grant, PAT and access-token slots";

export function redactFigmaMessage(message: string, secrets: string[] = []): string {
  let safe = message;
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|token|password)([\s"']*[:=][\s"']*)[^\s,;"'}]+/gi, "$1$2[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}
