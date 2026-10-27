import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeFigmaGrant, INVALID_CLAUDE_GRANT } from "./figma-claude-grant.js";
const now = 1793134800000;
const entry = { serverName: "figma", serverUrl: "https://mcp.figma.com/mcp", scope: "mcp:connect",
  accessToken: "SYNTHETIC-ACCESS", refreshToken: "SYNTHETIC-REFRESH", clientId: "client", clientSecret: "SYNTHETIC-SECRET", expiresAt: now + 90000 };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function file(value: unknown) { const dir = mkdtempSync(join(tmpdir(), "figma-test-")); dirs.push(dir); const path = join(dir,"grant"); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; }
it("maps only approved fields and preserves epoch milliseconds", () => {
  const grant = readClaudeFigmaGrant(file({ mcpOAuth: { "figma|random": { ...entry, token_endpoint: "https://evil.invalid", unrelated: "ignore" } } }), now);
  expect(grant).toEqual({ access_token: entry.accessToken, refresh_token: entry.refreshToken, client_id: entry.clientId, client_secret: entry.clientSecret,
    expires_at: entry.expiresAt, token_endpoint: "https://api.figma.com/v1/oauth/token", token_endpoint_auth_method: "client_secret_post" });
});
it.each([
  {}, {mcpOAuth: {}}, {mcpOAuth: {a:entry,b:entry}},
  ...["accessToken","refreshToken","clientId","clientSecret"].flatMap(key => [undefined,"",42].map(v => ({ mcpOAuth: { a:{...entry,[key]:v} } }))),
  ...["bad", now, now / 1000, null].map(expiresAt=>({mcpOAuth:{a:{...entry,expiresAt}}})),
  {mcpOAuth:{a:{...entry,scope:"other"}}}, {mcpOAuth:{a:{...entry,serverUrl:"https://evil.invalid"}}},
])("rejects malformed credentials without including their contents", value => {
  expect(() => readClaudeFigmaGrant(file(value),now)).toThrow(INVALID_CLAUDE_GRANT);
});
it("refuses public, symlink, directory, oversized and invalid JSON inputs",()=>{
  const p=file({mcpOAuth:{a:entry}}); chmodSync(p,0o644); expect(()=>readClaudeFigmaGrant(p,now)).toThrow(INVALID_CLAUDE_GRANT);
  chmodSync(p,0o600); symlinkSync(p,p+"-link"); expect(()=>readClaudeFigmaGrant(p+"-link",now)).toThrow(INVALID_CLAUDE_GRANT);
  expect(()=>readClaudeFigmaGrant(dirs[0],now)).toThrow(INVALID_CLAUDE_GRANT);
  writeFileSync(p," ".repeat(1024*1024+1));expect(()=>readClaudeFigmaGrant(p,now)).toThrow(INVALID_CLAUDE_GRANT);
  writeFileSync(p,"SYNTHETIC-SECRET");expect(()=>readClaudeFigmaGrant(p,now)).toThrow(INVALID_CLAUDE_GRANT);
});

it("the existing refresh normalizer preserves imported client auth when Figma omits refresh_token", async()=>{
  const {rotatedGrant}=await import("../tools/figma-refresh.js");
  const imported=readClaudeFigmaGrant(file({mcpOAuth:{a:entry}}),now);
  const refreshed=rotatedGrant(imported as unknown as Parameters<typeof rotatedGrant>[0],{access_token:"new-synthetic",expires_in:3600},now);
  expect(refreshed).toMatchObject({refresh_token:entry.refreshToken,client_secret:entry.clientSecret,client_id:entry.clientId,token_endpoint_auth_method:"client_secret_post",expires_at:now+3600000});
});
