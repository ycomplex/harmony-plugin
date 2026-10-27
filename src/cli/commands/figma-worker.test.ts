import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

it("publishes an effective disconnected context for provision after a transport error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-worker-"));
  const path = join(dir, "context");
  vi.stubEnv("HARMONY_FIGMA_WORKER_CONTEXT_FILE", path);
  vi.mocked(getAuthenticatedContext).mockRejectedValue(
    new Error("unavailable"),
  );
  try {
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
    expect(
      JSON.parse(Buffer.from(readFileSync(path, "utf8"), "base64").toString()),
    ).toEqual({ state: "disconnected", connections_enabled: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
