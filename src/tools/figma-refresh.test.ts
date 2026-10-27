import { describe, expect, it, vi } from "vitest";
import {
  type RefreshPorts,
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
