import { describe, expect, it, vi } from "vitest";
import {
  type LibraryPorts,
  type RefreshPorts,
  refreshPass,
  refreshWorkspace,
  refreshWorkspaceSafely,
} from "./figma-refresh.js";

const work = {
  workspace_id: "workspace",
  generation: 7,
  grant_version: "grant/versions/1",
  in_flight: false,
};
const now = Date.parse("2026-10-27T12:00:00Z");
function setup() {
  const events: string[] = [];
  const ports: RefreshPorts = {
    transition: vi.fn(async (_w, action) => {
      events.push(action);
      return true;
    }),
    readGrant: vi.fn(async () => ({
      access_token: "old-access",
      refresh_token: "old-refresh",
      expires_at: now + 1000,
      client_id: "client",
      token_endpoint: "https://api.figma.com/v1/oauth/token",
    })),
    refresh: vi.fn(async () => ({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      extra: "preserved",
    })),
    append: vi.fn(async (_w, kind) => {
      events.push(kind);
      return `${kind}/versions/2`;
    }),
  };
  return { ports, events };
}
describe("single refresh owner", () => {
  it("durably claims, stores complete rotated grant, then publishes access/health", async () => {
    const { ports, events } = setup();
    expect(await refreshWorkspace(work, ports, now)).toBe("ok");
    expect(events).toEqual(["claim", "grant", "access", "publish"]);
    const saved = JSON.parse(vi.mocked(ports.append).mock.calls[0][2]);
    expect(saved).toMatchObject({
      refresh_token: "new-refresh",
      client_id: "client",
      extra: "preserved",
      expires_at: now + 3600000,
    });
  });
  it("a crash marker never reads or spends the token again", async () => {
    const { ports } = setup();
    expect(
      await refreshWorkspace({ ...work, in_flight: true }, ports, now),
    ).toBe("reconnect");
    expect(ports.readGrant).not.toHaveBeenCalled();
    expect(ports.refresh).not.toHaveBeenCalled();
  });
  it("timeout is ambiguous and is never retried", async () => {
    const { ports, events } = setup();
    vi.mocked(ports.refresh).mockRejectedValue(new Error("timeout"));
    expect(await refreshWorkspace(work, ports, now)).toBe("reconnect");
    expect(ports.refresh).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["claim", "ambiguous"]);
  });
  it("failed full-grant storage cannot publish access", async () => {
    const { ports, events } = setup();
    vi.mocked(ports.append).mockRejectedValue(new Error("write failure"));
    expect(await refreshWorkspace(work, ports, now)).toBe("reconnect");
    expect(ports.append).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["claim", "ambiguous"]);
  });
  it("lost claim cannot touch a grant; disconnected generation cannot be revived", async () => {
    const { ports } = setup();
    vi.mocked(ports.transition).mockResolvedValue(false);
    expect(await refreshWorkspace(work, ports, now)).toBe("skipped");
    expect(ports.refresh).not.toHaveBeenCalled();
  });
  it.each(["old-refresh", undefined])(
    "keeps a valid existing refresh token when response is %s",
    async (refreshToken) => {
      const { ports, events } = setup();
      vi.mocked(ports.refresh).mockResolvedValue({
        access_token: "new",
        expires_in: 3600,
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      });
      expect(await refreshWorkspace(work, ports, now)).toBe("ok");
      expect(events).toEqual(["claim", "grant", "access", "publish"]);
      expect(JSON.parse(vi.mocked(ports.append).mock.calls[0][2]).refresh_token)
        .toBe("old-refresh");
    },
  );
});

it("a failed ambiguous health write does not prevent the next workspace from refreshing", async () => {
  const first = setup();
  const second = setup();
  vi.mocked(first.ports.refresh).mockRejectedValue(new Error("timeout"));
  vi.mocked(first.ports.transition).mockImplementation(async (_w, action) => {
    if (action === "ambiguous") throw new Error("board unavailable");
    return true;
  });
  const outcomes = [];
  for (const ports of [first.ports, second.ports]) {
    outcomes.push(await refreshWorkspaceSafely(work, ports, now));
  }
  expect(outcomes).toEqual(["refresh-state-write-failed", "ok"]);
  expect(first.ports.refresh).toHaveBeenCalledTimes(1);
  expect(second.events).toEqual(["claim", "grant", "access", "publish"]);
});

describe("library step (B-1321)", () => {
  const comp = (name: string, key: string, set?: string, frame = "24") => ({
    key,
    name,
    containing_frame: {
      name: set ?? frame,
      pageName: "P",
      ...(set ? { containingStateGroup: { name: set } } : {}),
    },
  });
  function libSetup(components: unknown = [
    comp("V", "k1", "Button"),
    comp("V", "k2", "Tag"),
    comp("Star", "s1", undefined, "16"),
    comp("Star", "s2", undefined, "48"),
  ]) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const logs: Record<string, unknown>[] = [];
    const library: LibraryPorts = {
      fetchComponents: vi.fn(async () => {
        if (components instanceof Error) throw components;
        return components as never;
      }),
      transition: vi.fn(async (_w, action, data) => {
        calls.push([action, data]);
        return true;
      }),
      log: (e) => logs.push(e),
    };
    return { library, calls, logs };
  }
  const due = { ...work, library_refresh_requested: false, refresh_due: true };

  it("publishes version 2 with the ambiguous candidates", async () => {
    const { library, calls } = libSetup();
    const t = setup();
    expect(await refreshPass({ ...due, library_map_version: 1 }, library, t.ports, now))
      .toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("library");
    expect(calls[0][1]).toMatchObject({
      library_components: { "Button :: V": "k1", "Tag :: V": "k2" },
      library_ambiguous: {
        Star: [
          { key: "s1", frame: "16", page: "P" },
          { key: "s2", frame: "48", page: "P" },
        ],
      },
      library_map_version: 2,
    });
  });

  it("a LibraryMapError records library_failed, publishes no map, and the token refresh still runs", async () => {
    const { library, calls, logs } = libSetup([
      comp("V", "k1", "Button"),
      comp("V", "k2", "Button"),
    ]);
    const t = setup();
    expect(await refreshPass({ ...due, library_refresh_requested: true }, library, t.ports, now))
      .toBe("ok");
    expect(calls.map((c) => c[0])).toEqual(["library_failed"]);
    expect(String(calls[0][1].error)).toContain("Button :: V");
    expect(logs[0]).toMatchObject({ result: "library-refresh-failed" });
    expect(t.events).toEqual(["claim", "grant", "access", "publish"]);
  });

  it("a REST failure behaves the same with a fixed message", async () => {
    const { library, calls } = libSetup(new Error("403 https://api.figma.com secret-token"));
    const t = setup();
    expect(await refreshPass({ ...due, library_refresh_requested: true }, library, t.ports, now))
      .toBe("ok");
    expect(calls).toEqual([["library_failed", { error: "Library refresh failed" }]]);
    expect(t.events).toEqual(["claim", "grant", "access", "publish"]);
  });

  it("a failing publish transition is reported as library_failed and the token refresh runs", async () => {
    const { library, calls } = libSetup();
    vi.mocked(library.transition).mockImplementation(async (_w, action, data) => {
      calls.push([action, data]);
      if (action === "library") throw new Error("write failed");
      return true;
    });
    const t = setup();
    await refreshPass({ ...due, library_refresh_requested: true }, library, t.ports, now);
    expect(calls.map((c) => c[0])).toEqual(["library", "library_failed"]);
    expect(t.events).toEqual(["claim", "grant", "access", "publish"]);
  });

  it("a failure of the library_failed write itself does not stop the token refresh", async () => {
    const { library, logs } = libSetup(new Error("boom"));
    vi.mocked(library.transition).mockRejectedValue(new Error("board down"));
    const t = setup();
    expect(await refreshPass({ ...due, library_refresh_requested: true }, library, t.ports, now))
      .toBe("ok");
    expect(logs.map((l) => l.result)).toContain("library-failure-write-failed");
    expect(t.events).toEqual(["claim", "grant", "access", "publish"]);
  });

  it("version 2 without the flag does no library work; version 1 or absent does", async () => {
    for (const [v, expected] of [[2, 0], [1, 1], [undefined, 1], [null, 1]] as const) {
      const { library } = libSetup();
      await refreshPass(
        { ...due, library_map_version: v, library_refresh_requested: false },
        library,
        setup().ports,
        now,
      );
      expect(library.fetchComponents).toHaveBeenCalledTimes(expected);
    }
  });

  it("an in-flight item does no library work", async () => {
    const { library } = libSetup();
    await refreshPass(
      { ...due, in_flight: true, library_refresh_requested: true, library_map_version: 1 },
      library,
      setup().ports,
      now,
    );
    expect(library.fetchComponents).not.toHaveBeenCalled();
  });
});
