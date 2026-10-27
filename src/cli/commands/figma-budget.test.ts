import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("retains the active logical budget across a new physical worker leg and closes without deleting counters", () => {
  const home = mkdtempSync(join(tmpdir(), "figma-budget-"));
  const run = (leg: string, args: string[]) => {
    const r = spawnSync(
      process.execPath,
      ["dist/bin/harmony.js", "figma", "budget", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          HARMONY_CONDUCTION_ID: "fixture",
          HARMONY_LEG: leg,
        },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  try {
    expect(JSON.parse(run("1", ["--reserve"]))).toMatchObject({
      allowed: true,
      used: 1,
      source_leg: "1",
    });
    expect(JSON.parse(run("2", ["--reserve"]))).toMatchObject({
      allowed: true,
      used: 2,
      source_leg: "1",
    });
    for (let i = 0; i < 4; i++) run("2", ["--reserve"]);
    expect(JSON.parse(run("3", ["--reserve"]))).toMatchObject({
      allowed: false,
      used: 6,
      reason: "six-call-cap",
    });
    run("3", ["--close"]);
    expect(JSON.parse(run("4", ["--reserve"]))).toMatchObject({
      allowed: true,
      used: 1,
      source_leg: "4",
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
