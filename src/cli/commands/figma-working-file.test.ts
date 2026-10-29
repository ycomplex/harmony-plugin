import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerFigmaCommands } from "./figma.js";
import { getAuthenticatedContext } from "../auth.js";
vi.mock("../auth.js", () => ({ getAuthenticatedContext: vi.fn() }));

const K = "AbCdEfGhIjKlMnOpQrStUv";
const L = "LiBrArYkEyLiBrArYkEyLi";
const UUID = "11111111-1111-4111-8111-111111111111";
const EX = "22222222-2222-4222-8222-222222222222";
let out: string[];

function ctxEnv(meta: unknown) {
  vi.stubEnv("HARMONY_FIGMA_CONTEXT_B64", Buffer.from(JSON.stringify(meta)).toString("base64"));
}
async function run(...args: string[]) {
  const program = new Command();
  registerFigmaCommands(program);
  await program.parseAsync(["figma", "working-file", ...args], { from: "user" });
  expect(out).toHaveLength(1);
  return JSON.parse(out[0]);
}
function rpcCtx(error: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error });
  vi.mocked(getAuthenticatedContext).mockResolvedValue({ client: { rpc }, projectId: "p1", userId: "u1" } as never);
  return rpc;
}

beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c).trim()), true));
  vi.stubEnv("HARMONY_FIGMA_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

it("resolve: unconnected without a context", async () => {
  vi.stubEnv("HARMONY_FIGMA_CONTEXT_B64", "");
  expect(await run("resolve")).toEqual({ status: "unconnected" });
});
it("resolve: disconnected context is unconnected", async () => {
  ctxEnv({ state: "disconnected" });
  expect(await run("resolve")).toEqual({ status: "unconnected" });
});
it("resolve: ask when working_file_key is absent (tolerates the old RPC)", async () => {
  ctxEnv({ state: "connected", library_file_key: L });
  expect(await run("resolve")).toMatchObject({ status: "ask", library_file_key: L });
});
it("resolve: ready and refuse", async () => {
  ctxEnv({ state: "connected", library_file_key: L, working_file_key: K });
  expect(await run("resolve")).toMatchObject({ status: "ready", working_file_key: K });
  out = [];
  ctxEnv({ state: "connected", library_file_key: L, working_file_key: L });
  expect(await run("resolve")).toMatchObject({ status: "refuse" });
});
it("validate: library and malformed input fail without a network call", async () => {
  ctxEnv({ state: "connected", library_file_key: L });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  expect(await run("validate", L)).toMatchObject({ ok: false, reason: "is-library" });
  out = [];
  expect(await run("validate", "nope")).toMatchObject({ ok: false, reason: "bad-key" });
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("save refuses locally without exchange or task", async () => {
  const rpc = rpcCtx(null);
  expect(await run("save", "--file", K, "--task", UUID)).toEqual({ saved: false, reason: "missing-exchange" });
  out = [];
  expect(await run("save", "--file", K, "--exchange", EX)).toEqual({ saved: false, reason: "missing-task" });
  expect(rpc).not.toHaveBeenCalled();
});
it("save refuses the library key and malformed keys locally", async () => {
  ctxEnv({ state: "connected", library_file_key: L });
  const rpc = rpcCtx(null);
  expect(await run("save", "--file", L, "--task", UUID, "--exchange", EX)).toEqual({ saved: false, reason: "is-library" });
  out = [];
  expect(await run("save", "--file", "bad", "--task", UUID, "--exchange", EX)).toEqual({ saved: false, reason: "bad-key" });
  expect(rpc).not.toHaveBeenCalled();
});
it("save calls the RPC with the exact contract", async () => {
  ctxEnv({ state: "connected", library_file_key: L });
  const rpc = rpcCtx(null);
  expect(await run("save", "--file", `https://www.figma.com/design/${K}/x`, "--task", UUID, "--exchange", EX)).toEqual({ saved: true, file_key: K, set_via: "leg" });
  expect(rpc).toHaveBeenCalledWith("set_project_figma_working_file", {
    p_project_id: "p1", p_file_key: K, p_set_via: "leg", p_task_id: UUID, p_exchange_id: EX,
  });
  expect(process.exitCode ?? 0).toBe(0);
});
it.each([
  ["PGRST202", "rpc-absent"],
  ["42883", "rpc-absent"],
  ["42501", "not-owner"],
])("save maps %s to %s with exit 0", async (code, reason) => {
  rpcCtx({ code, message: "m" });
  expect(await run("save", "--file", K, "--task", UUID, "--exchange", EX)).toEqual({ saved: false, reason });
  expect(process.exitCode ?? 0).toBe(0);
});
it("save: any other error reports and exits 1", async () => {
  rpcCtx({ code: "XX000", message: "kaboom" });
  expect(await run("save", "--file", K, "--task", UUID, "--exchange", EX)).toEqual({ saved: false, reason: "error", detail: "kaboom" });
  expect(process.exitCode).toBe(1);
});
