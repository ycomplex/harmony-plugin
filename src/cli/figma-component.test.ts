import { describe, expect, it, vi } from "vitest";
import { runFigmaComponent } from "./figma-component.js";

const ok = (data: unknown) => ({ data, error: null });
const connected = (map: Record<string, string>) =>
  ok({ state: "connected", library_components: map });
const none = async () => ok([]);

describe("runFigmaComponent", () => {
  it("prints one JSON line for a found component", async () => {
    const out = await runFigmaComponent(
      { name: "V", set: "Button" },
      { context: async () => connected({ "Button :: V": "kb" }), candidates: none },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout?.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(out.stdout as string)).toMatchObject({ status: "found", key: "kb" });
  });
  it("lists sets", async () => {
    const out = await runFigmaComponent(
      { sets: true },
      { context: async () => connected({ "B :: x": "1", "B :: y": "2", "A :: z": "3" }), candidates: none },
    );
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout as string)).toEqual({
      status: "sets",
      sets: [{ set: "A", variants: 1 }, { set: "B", variants: 2 }],
    });
  });
  it("exits 0 on ambiguous icons from the candidates RPC", async () => {
    const candidates = vi.fn(async () => ok([{ key: "s1", frame: "16", page: "Icons" }]));
    const out = await runFigmaComponent(
      { name: "Star" },
      { context: async () => connected({ A: "1" }), candidates },
    );
    expect(candidates).toHaveBeenCalledWith("Star");
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout as string).status).toBe("ambiguous");
  });
  it.each(["PGRST202", "42883"])("treats %s from the candidates RPC as no candidates", async (code) => {
    const out = await runFigmaComponent(
      { name: "Star" },
      {
        context: async () => connected({ A: "1" }),
        candidates: async () => ({ data: null, error: { code } }),
      },
    );
    expect(out.exitCode).toBe(2);
    expect(JSON.parse(out.stdout as string)).toEqual({ status: "not-found" });
  });
  it("any other candidates failure is still a plain miss, not a crash", async () => {
    const out = await runFigmaComponent(
      { name: "Star" },
      {
        context: async () => connected({ A: "1" }),
        candidates: async () => ({ data: null, error: { code: "500" } }),
      },
    );
    expect(out.exitCode).toBe(2);
  });
  it("does not ask for candidates when a set is given", async () => {
    const candidates = vi.fn(none);
    const out = await runFigmaComponent(
      { name: "X", set: "Nope" },
      { context: async () => connected({ A: "1" }), candidates },
    );
    expect(candidates).not.toHaveBeenCalled();
    expect(out.exitCode).toBe(2);
  });
  it("refuses with exit 1 when the context is unavailable or not connected", async () => {
    for (const context of [
      async () => ({ data: null, error: { code: "PGRST202" } }),
      async () => {
        throw new Error("net");
      },
      async () => ok({ state: "reconnect" }),
      async () => ok({ state: "disconnected" }),
    ]) {
      const out = await runFigmaComponent({ name: "X" }, { context, candidates: none });
      expect(out.exitCode).toBe(1);
      expect(out.stdout).toBeUndefined();
      expect(out.stderr).toContain("refusing configured Figma work");
    }
  });
  it("requires a name unless --sets", async () => {
    const out = await runFigmaComponent({}, { context: async () => connected({}), candidates: none });
    expect(out.exitCode).toBe(1);
  });
});
