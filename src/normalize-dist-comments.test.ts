import { describe, it, expect } from "vitest";
// Build-tooling script (lives in scripts/, outside src/). This pins the
// transform that makes the committed dist build cwd-invariant (B-553), so a
// future esbuild output-format change is caught here rather than as a CI red.
// esbuild bakes the cwd-relative node_modules path in TWO forms — a `// ` module
// boundary comment and a `"` module key inside __commonJS/__esm wrappers — and
// both must be canonicalized.
import { normalize } from "../scripts/normalize-dist-comments.mjs";

describe("normalize-dist-comments", () => {
  it("canonicalizes a leaked ../../node_modules/ boundary comment", () => {
    expect(normalize("// ../../node_modules/commander/esm.mjs")).toBe(
      "// node_modules/commander/esm.mjs",
    );
  });

  it("canonicalizes a leaked ../../node_modules/ commonJS module key (the form the first cut missed)", () => {
    expect(
      normalize('  "../../node_modules/ajv/dist/compile/codegen/code.js"(exports) {'),
    ).toBe('  "node_modules/ajv/dist/compile/codegen/code.js"(exports) {');
  });

  it("strips an arbitrary-depth run of ../ before node_modules/ in both forms", () => {
    expect(normalize("// ../../../node_modules/zod/lib/index.mjs")).toBe(
      "// node_modules/zod/lib/index.mjs",
    );
    expect(normalize('"../../../node_modules/zod/lib/index.mjs"')).toBe(
      '"node_modules/zod/lib/index.mjs"',
    );
  });

  it("leaves already-canonical node_modules paths untouched (comment and key)", () => {
    const comment = "// node_modules/ajv/dist/compile/codegen/code.js";
    const key = '"node_modules/ajv/dist/compile/codegen/code.js"(exports) {';
    expect(normalize(comment)).toBe(comment);
    expect(normalize(key)).toBe(key);
  });

  it("leaves src/ paths untouched (comment and key)", () => {
    expect(normalize("// src/index.ts")).toBe("// src/index.ts");
    expect(normalize('"src/index.ts"')).toBe('"src/index.ts"');
  });

  it("is idempotent (a second pass is a no-op)", () => {
    const once = normalize('  "../../node_modules/chalk/source/index.js"(exports) {');
    expect(normalize(once)).toBe(once);
  });

  it("normalizes every leaked occurrence across a multi-line bundle", () => {
    const bundle = [
      "// ../../node_modules/commander/esm.mjs",
      "var require_code = __commonJS({",
      '  "../../node_modules/ajv/dist/compile/codegen/code.js"(exports) {',
      "// src/index.ts",
    ].join("\n");
    expect(normalize(bundle)).toBe(
      [
        "// node_modules/commander/esm.mjs",
        "var require_code = __commonJS({",
        '  "node_modules/ajv/dist/compile/codegen/code.js"(exports) {',
        "// src/index.ts",
      ].join("\n"),
    );
  });
});
