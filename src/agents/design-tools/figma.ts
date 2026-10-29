import { readFileSync } from "node:fs";

export const FIGMA_MCP_URL = "https://mcp.figma.com/mcp";
export const FIGMA_ACCESS_ENV = "FIGMA_MCP_ACCESS_TOKEN";
export const FIGMA_MOUNT = "/secrets/figma";

export interface FigmaMetadata {
  state: "disconnected" | "connected" | "reconnect";
  connections_enabled?: boolean;
  workspace_id?: string;
  generation?: number;
  handle?: string;
  library_file_key?: string;
  /** B-1325: the project's Figma working file (the only file a design leg may write to); absent/null = none set. */
  working_file_key?: string | null;
  component_map?: Record<string, string>;
  library_components?: Record<string, string>;
  access_expires_at?: string;
  access_version?: string;
  pat_version?: string;
}

export function assertFigmaReady(meta: FigmaMetadata, now: number): void {
  if (meta.state === "disconnected") return;
  const expiry = Date.parse(meta.access_expires_at ?? "");
  if (
    meta.connections_enabled !== true ||
    meta.state !== "connected" ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    !meta.access_version ||
    !meta.pat_version
  ) {
    throw new Error(
      "Figma needs reconnection. Ask the workspace owner to run harmony figma connect.",
    );
  }
}

export function readMountedFigmaToken(
  path = `${FIGMA_MOUNT}/access-token`,
): string {
  const token = readFileSync(path, "utf8").trim();
  if (!token || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
    throw new Error("Invalid Figma access-token mount; reconnect Figma.");
  return token;
}

/** Called only inside the worker. Token-bearing output must go directly to a private file. */
export function renderFigmaMcp(
  adapter: "claude-code" | "codex",
  accessToken?: string,
): string {
  if (adapter === "codex")
    return '\n[mcp_servers.figma]\nurl = "https://mcp.figma.com/mcp"\nbearer_token_env_var = "FIGMA_MCP_ACCESS_TOKEN"\nrequired = true\ndefault_tools_approval_mode = "auto"\n';
  if (!accessToken) throw new Error("Figma access-token mount required");
  return JSON.stringify({
    type: "http",
    url: FIGMA_MCP_URL,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}
