import { it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
it("launcher reads only pinned token versions, and rejects an unhealthy connection before any read", () => {
  const dir = mkdtempSync(join(tmpdir(), "figma-launch-"));
  try {
    const context = {
      state: "connected",
      connections_enabled: true,
      access_expires_at: "2099-01-01T00:00:00Z",
      access_version:
        "projects/harmony-conductor/secrets/harmony-figma-ws-11111111-1111-4111-8111-111111111111-access/versions/7",
      pat_version:
        "projects/harmony-conductor/secrets/harmony-figma-ws-11111111-1111-4111-8111-111111111111-pat/versions/3",
    };
    const log = join(dir, "reads");
    const gcloud = join(dir, "gcloud");
    writeFileSync(
      gcloud,
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$READ_LOG"\nfor arg; do case "$arg" in --out-file=*) printf fixture > "${arg#--out-file=}";; esac; done\n',
    );
    chmodSync(gcloud, 0o700);
    const script = `source "${resolve("container/figma/launch-context.sh")}"; node() { if [ "$1" = fake/dist/bin/harmony.js ]; then printf '%s' "$TEST_CONTEXT"; else command node "$@"; fi; }; figma_launch_context && figma_read_tokens "$TOKEN_DIR"`;
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      HARMONY_PLUGIN_DIR: "fake",
      TEST_CONTEXT: JSON.stringify(context),
      READ_LOG: log,
      TOKEN_DIR: dir,
    };
    expect(spawnSync("bash", ["-c", script], { env }).status).toBe(0);
    const reads = readFileSync(log, "utf8");
    expect(reads).toContain("versions access 7");
    expect(reads).toContain("versions access 3");
    expect(reads).not.toMatch(/grant|latest/);
    rmSync(log);
    for (const enabled of [false, undefined]) {
      expect(
        spawnSync("bash", ["-c", script], {
          env: {
            ...env,
            TEST_CONTEXT: JSON.stringify({
              ...context,
              connections_enabled: enabled,
            }),
          },
        }).status,
      ).toBe(0);
      expect(() => readFileSync(log)).toThrow();
    }
    const failed = spawnSync("bash", ["-c", script], {
      env: {
        ...env,
        TEST_CONTEXT: JSON.stringify({ ...context, state: "reconnect" }),
      },
    });
    expect(failed.status).not.toBe(0);
    expect(() => readFileSync(log)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
