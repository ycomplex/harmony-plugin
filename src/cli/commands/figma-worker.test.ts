import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerFigmaCommands } from "./figma.js";
import { getAuthenticatedContext } from "../auth.js";
vi.mock("../auth.js", () => ({ getAuthenticatedContext: vi.fn() }));
beforeEach(() => {
  vi.stubEnv(
    "HARMONY_FIGMA_CONTEXT_B64",
    Buffer.from(JSON.stringify({ state: "connected" })).toString("base64"),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});
it.each([{ state: "disconnected" }, { state: "reconnect" }, {
  state: "connected",
  access_expires_at: "2000-01-01T00:00:00Z",
}])("worker skips Figma installation for %j", async (meta) => {
  vi.mocked(getAuthenticatedContext).mockResolvedValue(
    { client: { rpc: async () => ({ data: meta, error: null }) } } as never,
  );
  const program = new Command();
  registerFigmaCommands(program);
  await program.parseAsync([
    "figma",
    "install-worker",
    "--adapter",
    "codex",
    "--plugin-dir",
    "/nonexistent",
  ], { from: "user" });
  expect(process.exitCode ?? 0).toBe(0);
});
it("auth or context transport failure cannot abort an unrelated worker", async () => {
  vi.mocked(getAuthenticatedContext).mockRejectedValue(
    new Error("unavailable"),
  );
  const program = new Command();
  registerFigmaCommands(program);
  await program.parseAsync([
    "figma",
    "install-worker",
    "--adapter",
    "codex",
    "--plugin-dir",
    "/nonexistent",
  ], { from: "user" });
  expect(process.exitCode ?? 0).toBe(0);
});
