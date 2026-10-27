import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";

export const INVALID_CLAUDE_GRANT = "Cannot import this Figma sign-in: required credentials are missing, ambiguous or expired.";
const fail = (): never => { throw new Error(INVALID_CLAUDE_GRANT); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Explicit private file only. Never inspect the operator's default Claude profile. */
export function readClaudeFigmaGrant(path: string, now = Date.now()): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 1024 * 1024) return fail();
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 1024 * 1024) return fail();
    const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (!object(parsed) || !object(parsed.mcpOAuth)) return fail();
    const entries = Object.values(parsed.mcpOAuth).filter(v => object(v) &&
      (v.serverName === "figma" || v.serverUrl === "https://mcp.figma.com/mcp"));
    if (entries.length !== 1 || !object(entries[0])) return fail();
    const e = entries[0];
    if (e.serverName !== "figma" || e.serverUrl !== "https://mcp.figma.com/mcp" || e.scope !== "mcp:connect" ||
        typeof e.expiresAt !== "number" || !Number.isFinite(e.expiresAt) || e.expiresAt <= now) return fail();
    for (const key of ["accessToken", "refreshToken", "clientId", "clientSecret"]) {
      if (typeof e[key] !== "string" || !(e[key] as string).trim()) return fail();
    }
    return { access_token: e.accessToken, refresh_token: e.refreshToken, expires_at: e.expiresAt,
      client_id: e.clientId, client_secret: e.clientSecret,
      token_endpoint: "https://api.figma.com/v1/oauth/token", token_endpoint_auth_method: "client_secret_post" };
  } catch { return fail(); } finally { if (fd !== undefined) closeSync(fd); }
}
