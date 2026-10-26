import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Build-tooling script (lives in scripts/, outside src/). B-1295: the plugin is proprietary, but its
// bundle inlines third-party open-source packages whose licenses must travel with every copy. The
// generator writes dist/THIRD_PARTY_NOTICES from the esbuild metafile at build time; these tests pin
// its path mapping, its template fallback, its failure modes, its determinism and its cross-check.
import {
  packageFromInputPath,
  packagesFromMeta,
  packageNamesFromBundle,
  buildNotices,
  spdxTemplate,
  crossCheck,
  declaredLicense,
  authorString,
  findLicenseFile,
} from "../scripts/generate-third-party-notices.mjs";

const RECONSTRUCTED = "License text reconstructed from package metadata (declared license: ";

function record(overrides: Record<string, unknown> = {}) {
  return {
    name: "pkg",
    version: "1.0.0",
    license: "MIT",
    author: null,
    repository: null,
    licenseText: "Own license text\n",
    noticeText: null,
    ...overrides,
  };
}

describe("packageFromInputPath", () => {
  it("maps an unscoped package", () => {
    expect(packageFromInputPath("node_modules/chalk/source/index.js")).toEqual({
      name: "chalk",
      root: "node_modules/chalk",
      canonicalRoot: "node_modules/chalk",
    });
  });

  it("maps a scoped package", () => {
    expect(packageFromInputPath("node_modules/@supabase/auth-js/dist/module/index.js")).toEqual({
      name: "@supabase/auth-js",
      root: "node_modules/@supabase/auth-js",
      canonicalRoot: "node_modules/@supabase/auth-js",
    });
  });

  it("uses the LAST node_modules/ segment for a nested copy", () => {
    expect(packageFromInputPath("node_modules/a/node_modules/@s/b/lib/x.js")).toEqual({
      name: "@s/b",
      root: "node_modules/a/node_modules/@s/b",
      canonicalRoot: "node_modules/a/node_modules/@s/b",
    });
  });

  it("strips a leading ../ run from the canonical root but keeps it in the on-disk root", () => {
    expect(packageFromInputPath("../../node_modules/zod/lib/index.mjs")).toEqual({
      name: "zod",
      root: "../../node_modules/zod",
      canonicalRoot: "node_modules/zod",
    });
  });

  it("returns null for a non-node_modules path", () => {
    expect(packageFromInputPath("src/index.ts")).toBeNull();
  });

  it("dedupes metafile inputs to package roots", () => {
    const meta = {
      inputs: {
        "src/index.ts": {},
        "node_modules/zod/a.js": {},
        "../../node_modules/zod/b.js": {},
        "node_modules/@x/y/c.js": {},
      },
    };
    expect(packagesFromMeta(meta).map((p: { name: string }) => p.name)).toEqual(["@x/y", "zod"]);
  });

  it("reads package names from dist boundary comments", () => {
    const bundle = [
      "// node_modules/commander/esm.mjs",
      "var x = 1;",
      "// node_modules/a/node_modules/@s/b/index.js",
      "// src/index.ts",
      '  "node_modules/ajv/dist/core.js"(exports) {',
    ].join("\n");
    expect([...packageNamesFromBundle(bundle)].sort()).toEqual(["@s/b", "commander"]);
  });
});

describe("package metadata", () => {
  it("reads license, the legacy license object and the legacy licenses array", () => {
    expect(declaredLicense({ license: "MIT" })).toBe("MIT");
    expect(declaredLicense({ license: { type: "ISC" } })).toBe("ISC");
    expect(declaredLicense({ licenses: [{ type: "BSD-3-Clause" }] })).toBe("BSD-3-Clause");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "(MIT OR Apache-2.0)",
    );
    expect(declaredLicense({})).toBeNull();
  });

  it("renders a string author verbatim and an object author npm-style", () => {
    expect(authorString("Jane <j@x.io>")).toBe("Jane <j@x.io>");
    expect(authorString({ name: "Jane", email: "j@x.io", url: "x.io" })).toBe("Jane <j@x.io> (x.io)");
    expect(authorString(undefined)).toBeNull();
  });

  it("finds a license file case-insensitively under LICENSE, LICENCE or COPYING", () => {
    expect(findLicenseFile(["README.md", "license"], ["LICENSE", "LICENCE", "COPYING"])).toBe("license");
    expect(findLicenseFile(["README.md", "Licence.txt"], ["LICENSE", "LICENCE", "COPYING"])).toBe(
      "Licence.txt",
    );
    expect(findLicenseFile(["COPYING"], ["LICENSE", "LICENCE", "COPYING"])).toBe("COPYING");
    expect(findLicenseFile(["README.md"], ["LICENSE", "LICENCE", "COPYING"])).toBeNull();
  });

  it("never treats a code or data file with a license-ish name as license text", () => {
    for (const code of ["license.js", "License.mjs", "licence.cjs", "LICENSE.ts", "license.json", "LICENSE.js.map"]) {
      expect(findLicenseFile(["README.md", code], ["LICENSE", "LICENCE", "COPYING"])).toBeNull();
    }
    expect(findLicenseFile(["license.js", "LICENSE"], ["LICENSE", "LICENCE", "COPYING"])).toBe("LICENSE");
  });

  it("fails, naming the package and the files, when more than one license file matches", () => {
    expect(() =>
      findLicenseFile(["LICENSE-MIT", "LICENSE-APACHE"], ["LICENSE", "LICENCE", "COPYING"], "dual-pkg"),
    ).toThrow(/dual-pkg.*LICENSE-APACHE, LICENSE-MIT/);
    expect(() => findLicenseFile(["COPYING", "LICENSE"], ["LICENSE", "LICENCE", "COPYING"], "two-pkg")).toThrow(
      /two-pkg.*COPYING, LICENSE/,
    );
  });
});

describe("template fallback", () => {
  it("has a template for every supported SPDX id and none for others", () => {
    for (const id of ["MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "BlueOak-1.0.0"]) {
      expect(spdxTemplate(id, "Holder")).toContain("Holder");
    }
    expect(spdxTemplate("BlueOak-1.0.0", "H")).toContain("# Blue Oak Model License");
    expect(spdxTemplate("Apache-2.0", "H")).toBeNull();
  });

  it("reconstructs MIT with a string author and marks it", () => {
    const out = buildNotices([record({ licenseText: null, author: "Supabase" })]);
    expect(out).toContain(`${RECONSTRUCTED}MIT); the package ships no license file.`);
    expect(out).toContain("Copyright (c) Supabase\n");
    expect(out).toContain("Permission is hereby granted, free of charge");
  });

  it("reconstructs MIT with an object author and marks it", () => {
    const author = authorString({ name: "Sindre Sorhus", email: "s@x.io" });
    const out = buildNotices([record({ licenseText: null, author })]);
    expect(out).toContain(RECONSTRUCTED);
    expect(out).toContain("Copyright (c) Sindre Sorhus <s@x.io>\n");
  });

  it("falls back to '<name> contributors' when there is no author", () => {
    const out = buildNotices([record({ name: "nobody", licenseText: null })]);
    expect(out).toContain("Copyright (c) nobody contributors\n");
  });

  it("does not mark a package that ships its own license file", () => {
    const out = buildNotices([record()]);
    expect(out).not.toContain(RECONSTRUCTED);
    expect(out).toContain("Own license text\n");
  });

  it("fails, naming the package, on an SPDX id with no template", () => {
    expect(() =>
      buildNotices([record({ name: "weird", license: "Apache-2.0", licenseText: null })]),
    ).toThrow(/weird@1\.0\.0.*Apache-2\.0/);
  });

  it("fails, naming the package, when there is no license file and no declared license", () => {
    expect(() => buildNotices([record({ name: "bare", license: null, licenseText: null })])).toThrow(
      /bare@1\.0\.0 ships no license file and declares no license/,
    );
  });
});

describe("determinism", () => {
  const records = [
    record({ name: "zeta", version: "1.10.0", repository: "https://github.com/z/z" }),
    record({ name: "@scope/alpha", licenseText: null, author: "A" }),
    record({ name: "zeta", version: "1.9.0" }),
    record({ name: "beta", licenseText: "B\r\nlicense\r\n", noticeText: "Notice text" }),
  ];

  it("gives an identical string for the same input twice", () => {
    expect(buildNotices(records)).toBe(buildNotices(records));
  });

  it("gives an identical string when the input order is shuffled", () => {
    const shuffled = [records[2], records[0], records[3], records[1]];
    expect(buildNotices(shuffled)).toBe(buildNotices(records));
  });

  it("sorts by name then version, uses LF only and ends with one newline", () => {
    const out = buildNotices(records);
    const heads = out.split("\n").filter((l: string) => /^[@a-z].*@\d/.test(l));
    expect(heads).toEqual(["@scope/alpha@1.0.0", "beta@1.0.0", "zeta@1.9.0", "zeta@1.10.0"]);
    expect(out).not.toContain("\r");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out).toContain("NOTICE:\n\nNotice text\n");
    expect(out).toContain("Repository: https://github.com/z/z\n");
  });
});

describe("crossCheck", () => {
  it("passes on equal sets", () => {
    expect(crossCheck(["a", "b"], new Set(["b", "a"]))).toEqual({
      ok: true,
      onlyInMeta: [],
      onlyInDist: [],
    });
  });

  it("fails on a package only in the metafile", () => {
    expect(crossCheck(["a", "b"], ["a"])).toEqual({ ok: false, onlyInMeta: ["b"], onlyInDist: [] });
  });

  it("fails on a package only in the dist comments", () => {
    expect(crossCheck(["a"], ["a", "c"])).toEqual({ ok: false, onlyInMeta: [], onlyInDist: ["c"] });
  });
});

describe("dist/THIRD_PARTY_NOTICES (integration, after a real build)", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const metaPath = join(root, ".build", "meta.json");
  const noticesPath = join(root, "dist", "THIRD_PARTY_NOTICES");
  const built = existsSync(join(root, "dist", "index.js")) && existsSync(metaPath);

  it.runIf(built)("exists and lists every package from the metafile", () => {
    expect(existsSync(noticesPath)).toBe(true);
    const notices = readFileSync(noticesPath, "utf8");
    const packages = packagesFromMeta(JSON.parse(readFileSync(metaPath, "utf8")));
    expect(packages.length).toBeGreaterThan(0);
    for (const p of packages) {
      expect(notices).toMatch(new RegExp(`^${p.name.replace(/[/.]/g, "\\$&")}@\\S+$`, "m"));
    }
  });

  it.runIf(built)(
    "marks each @supabase section reconstructed exactly when the package ships no license file",
    () => {
      const notices = readFileSync(noticesPath, "utf8");
      const packages = packagesFromMeta(JSON.parse(readFileSync(metaPath, "utf8"))).filter(
        (p: { name: string }) => p.name.startsWith("@supabase/"),
      );
      expect(packages.map((p: { name: string }) => p.name)).toContain("@supabase/supabase-js");
      const sections = notices.split(/^={78}$/m);
      for (const p of packages) {
        const section = sections.find((s: string) => s.startsWith(`\n${p.name}@`));
        expect(section, p.name).toBeDefined();
        const hasOwnFile =
          findLicenseFile(readdirSync(join(root, p.root)), ["LICENSE", "LICENCE", "COPYING"]) !== null;
        expect(section!.includes(RECONSTRUCTED), p.name).toBe(!hasOwnFile);
      }
      // The umbrella client ships no license file today; pin that it is reconstructed, not dropped.
      const umbrella = sections.find((s: string) => s.startsWith("\n@supabase/supabase-js@"));
      expect(umbrella).toContain(RECONSTRUCTED);
    },
  );
});
