import { describe, expect, it } from "vitest";
import { makeLiveShapedComponents } from "./__fixtures__/figma-library-fixture.js";
import { buildLibraryMap } from "./figma-library-map.js";
import { listLibrarySets, resolveLibraryComponent } from "./figma-library.js";

const V = "Variant=Primary, State=Default, Size=Medium";
const fixture = buildLibraryMap(makeLiveShapedComponents());
const sets = {
  [`Button :: ${V}`]: "kb",
  [`Icon Button :: ${V}`]: "ki",
  [`Tag :: ${V}`]: "kt",
  [`Tag :: Solo`]: "ks",
  Logo: "kl",
};

describe("resolveLibraryComponent", () => {
  it("old shape resolves bare names as legacy", async () => {
    const old = { Primary: "k1" };
    expect(await resolveLibraryComponent(old, "Primary")).toMatchObject({
      status: "found",
      key: "k1",
      via: "legacy",
    });
    expect(await resolveLibraryComponent(old, "Primary", { set: "Button" }))
      .toMatchObject({ status: "found", via: "legacy" });
    expect(await resolveLibraryComponent(old, "Nope")).toEqual({ status: "not-found" });
  });
  it("new shape: bare and unique-suffix lookups", async () => {
    expect(await resolveLibraryComponent(sets, "Logo")).toMatchObject({
      status: "found",
      key: "kl",
      via: "bare",
    });
    expect(await resolveLibraryComponent(sets, "Solo")).toMatchObject({
      status: "found",
      key: "ks",
      via: "qualified",
    });
  });
  it("set-qualified exact lookup picks the right set and never falls back in new shape", async () => {
    expect(await resolveLibraryComponent(sets, V, { set: "Icon Button" }))
      .toEqual({ status: "found", key: "ki", name: `Icon Button :: ${V}`, via: "qualified" });
    expect(await resolveLibraryComponent(sets, "Logo", { set: "Tag" })).toEqual({
      status: "not-found",
    });
  });
  it("ambiguous across sets names the sets", async () => {
    const r = await resolveLibraryComponent(sets, V);
    expect(r).toMatchObject({ status: "ambiguous", name: V });
    if (r.status !== "ambiguous") throw new Error("unreachable");
    expect(r.candidates.map((c) => [c.key, c.detail])).toEqual([
      ["kb", "set Button"],
      ["ki", "set Icon Button"],
      ["kt", "set Tag"],
    ]);
  });
  it("ambiguous icons come from the candidates fetcher", async () => {
    const r = await resolveLibraryComponent(sets, "Star", {
      candidates: async () => [
        { key: "s16", frame: "16", page: "Icons" },
        { key: "s48", frame: "48", page: "Icons" },
      ],
    });
    expect(r).toEqual({
      status: "ambiguous",
      name: "Star",
      candidates: [
        { key: "s16", frame: "16", page: "Icons", detail: "frame 16" },
        { key: "s48", frame: "48", page: "Icons", detail: "frame 48" },
      ],
    });
  });
  it("empty or throwing candidates fetcher is not-found", async () => {
    expect(await resolveLibraryComponent(sets, "Star", { candidates: async () => [] }))
      .toEqual({ status: "not-found" });
    expect(
      await resolveLibraryComponent(sets, "Star", {
        candidates: async () => {
          throw new Error("boom");
        },
      }),
    ).toEqual({ status: "not-found" });
    expect(await resolveLibraryComponent(sets, "Star")).toEqual({ status: "not-found" });
  });
});

describe("listLibrarySets", () => {
  it("lists the fixture's 76 sets sorted", () => {
    const out = listLibrarySets(fixture.library_components);
    expect(out).toHaveLength(76);
    expect(out.map((s) => s.set)).toEqual(out.map((s) => s.set).sort());
    expect(out.reduce((n, s) => n + s.variants, 0)).toBe(290);
  });
  it("is empty for the old shape", () => {
    expect(listLibrarySets({ A: "1" })).toEqual([]);
  });
});
