/** Only deliberately safe setup errors may be shown below the import-failure header. */
export class FigmaSetupError extends Error {}

export function redactFigmaMessage(message: string, secrets: string[] = []): string {
  let safe = message;
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|token|password)([\s"']*[:=][\s"']*)[^\s,;"'}]+/gi, "$1$2[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");
}
