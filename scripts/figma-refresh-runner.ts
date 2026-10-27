// Executed only by the dedicated CronJob, never imported into a worker launch.
import { getAuthenticatedContext } from "../src/cli/auth.js";
import {
  type FigmaGrant,
  type RefreshWork,
  refreshWorkspaceSafely,
} from "../src/tools/figma-refresh.js";

const ctx = await getAuthenticatedContext();
const { data: queue, error } = await ctx.client.rpc("figma_refresh_queue");
if (error) throw new Error("Refresh operator is not provisioned");
const metadata = await fetch(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
  { headers: { "Metadata-Flavor": "Google" } },
);
if (!metadata.ok) throw new Error("Refresh Workload Identity unavailable");
const access = ((await metadata.json()) as { access_token: string })
  .access_token;
const headers = {
  Authorization: `Bearer ${access}`,
  "Content-Type": "application/json",
};
const call = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(
    "https://secretmanager.googleapis.com/v1/" + path,
    { ...init, headers, signal: AbortSignal.timeout(20000) },
  );
  if (!response.ok) throw new Error("Secret operation failed");
  return response.json() as Promise<Record<string, any>>;
};
for (
  const work of (queue ?? []) as (RefreshWork & {
    library_refresh_requested: boolean;
    pat_version: string;
    library_file_key: string;
    refresh_due: boolean;
  })[]
) {
  if (work.library_refresh_requested && !work.in_flight) {
    try {
      if (
        !/^projects\/harmony-conductor\/secrets\/harmony-figma-ws-[a-f0-9-]{36}-pat\/versions\/\d+$/
          .test(
            work.pat_version,
          ) ||
        !/^[-_a-zA-Z0-9]+$/.test(work.library_file_key)
      ) {
        throw new Error("Invalid library references");
      }
      const encoded = await call(work.pat_version + ":access");
      const pat = Buffer.from(encoded.payload.data, "base64").toString();
      const response = await fetch(
        `https://api.figma.com/v1/files/${work.library_file_key}/components`,
        {
          headers: { "X-Figma-Token": pat },
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok) throw new Error("Library refresh failed");
      const components = (await response.json()) as {
        meta: { components: Array<{ name: string; key: string }> };
      };
      const { error: e } = await ctx.client.rpc("figma_refresh_transition", {
        p_workspace_id: work.workspace_id,
        p_generation: work.generation,
        p_action: "library",
        p_data: {
          library_components: Object.fromEntries(
            components.meta.components.map((c) => [c.name, c.key]),
          ),
        },
      });
      if (e) throw new Error("Library cache publication failed");
    } catch {
      console.log(
        JSON.stringify({
          workspace_id: work.workspace_id,
          result: "library-refresh-failed",
        }),
      );
    }
  }
  if (!work.refresh_due && !work.in_flight) continue;
  const outcome = await refreshWorkspaceSafely(
    work,
    {
      transition: async (w, action, data) => {
        const { data: ok, error: e } = await ctx.client.rpc(
          "figma_refresh_transition",
          {
            p_workspace_id: w.workspace_id,
            p_generation: w.generation,
            p_action: action,
            p_data: data ?? {},
          },
        );
        if (e) throw new Error("Refresh state write failed");
        console.log(
          JSON.stringify({
            workspace_id: w.workspace_id,
            generation: w.generation,
            phase: action,
            applied: ok === true,
            at: new Date().toISOString(),
          }),
        );
        return ok === true;
      },
      readGrant: async (version) => {
        if (
          !/^projects\/harmony-conductor\/secrets\/harmony-figma-ws-[a-f0-9-]{36}-grant\/versions\/\d+$/
            .test(
              version,
            )
        ) {
          throw new Error("Invalid grant reference");
        }
        const data = await call(version + ":access");
        return JSON.parse(
          Buffer.from(data.payload.data, "base64").toString(),
        ) as FigmaGrant;
      },
      refresh: async (grant) => {
        if (grant.token_endpoint !== "https://api.figma.com/v1/oauth/token") {
          throw new Error("Untrusted OAuth endpoint");
        }
        const g = grant as FigmaGrant & {
          client_secret?: string;
          token_endpoint_auth_method?: string;
        };
        const basic = g.token_endpoint_auth_method === "client_secret_basic";
        const r = await fetch(grant.token_endpoint, {
          method: "POST",
          headers: basic
            ? {
              Authorization: "Basic " +
                Buffer.from(
                  `${encodeURIComponent(grant.client_id)}:${
                    encodeURIComponent(g.client_secret ?? "")
                  }`,
                ).toString("base64"),
            }
            : {},
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: grant.refresh_token,
            ...(!basic
              ? {
                client_id: grant.client_id,
                ...(g.client_secret ? { client_secret: g.client_secret } : {}),
              }
              : {}),
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!r.ok) throw new Error("OAuth refresh failed");
        return r.json();
      },
      append: async (w, kind, value) => {
        const base =
          `projects/harmony-conductor/secrets/harmony-figma-ws-${w.workspace_id}-${kind}`;
        const data = await call(base + ":addVersion", {
          method: "POST",
          body: JSON.stringify({
            payload: { data: Buffer.from(value).toString("base64") },
          }),
        });
        const version = String(data.name).match(/\/versions\/(\d+)$/)?.[1];
        if (!version) throw new Error("Publication reference missing");
        console.log(
          JSON.stringify({
            workspace_id: w.workspace_id,
            phase: kind === "grant"
              ? "stored-rotated-grant"
              : "stored-access-token",
            version: `${base}/versions/${version}`,
            at: new Date().toISOString(),
          }),
        );
        return `${base}/versions/${version}`;
      },
    },
    Date.now(),
  );
  console.log(
    JSON.stringify({
      workspace_id: work.workspace_id,
      generation: work.generation,
      result: outcome,
    }),
  );
}
