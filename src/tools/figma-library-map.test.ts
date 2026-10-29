import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { makeLiveShapedComponents } from "./__fixtures__/figma-library-fixture.js";
import {
  buildLibraryMap,
  LIBRARY_MAP_VERSION,
  SET_SEPARATOR,
} from "./figma-library-map.js";

const VARIANT = "Variant=Primary, State=Default, Size=Medium";
const inSet = (set: string, name: string, key: string) => ({
  key,
  name,
  containing_frame: {
    name: set,
    pageName: "Components",
    containingStateGroup: { name: set },
  },
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.keys(value as object)
        .sort()
        .map((k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`
        )
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

const live = () => buildLibraryMap(makeLiveShapedComponents());

it("exports version 2 and the separator", () => {
  expect(LIBRARY_MAP_VERSION).toBe(2);
  expect(SET_SEPARATOR).toBe(" :: ");
});

it("resolves identically named variants of Button, Icon Button and Tag to three keys", () => {
  const { library_components } = buildLibraryMap([
    inSet("Button", VARIANT, "kb"),
    inSet("Icon Button", VARIANT, "ki"),
    inSet("Tag", VARIANT, "kt"),
  ]);
  expect(library_components).toEqual({
    [`Button :: ${VARIANT}`]: "kb",
    [`Icon Button :: ${VARIANT}`]: "ki",
    [`Tag :: ${VARIANT}`]: "kt",
  });
});

it("size guard: the compact map stays under 60000 base64 characters", () => {
  const encoded = Buffer.from(
    JSON.stringify({ library_components: live().library_components }),
  ).toString("base64");
  expect(encoded.length).toBeLessThan(60000);
});

it("parity: builder output hash is pinned (same literal in harmony-web)", () => {
  const digest = createHash("sha256").update(stable(live())).digest("hex");
  expect(digest).toBe(
    "b823a6907fcb0619277dbd6fb1d8fe7499ea6f6be21e638c94d8663b2284565e",
  );
});
