/** `harmony figma component` core (B-1321): pure over injected reads so it is testable without a network. */
import {
  listLibrarySets,
  type LibraryMapShape,
  resolveLibraryComponent,
} from "../tools/figma-library.js";

export interface RpcResult {
  data: unknown;
  error: { code?: string } | null;
}
export interface ComponentDeps {
  context(): Promise<RpcResult>;
  candidates(name: string): Promise<RpcResult>;
}
export interface ComponentArgs {
  name?: string;
  set?: string;
  sets?: boolean;
}
export interface ComponentOutcome {
  exitCode: 0 | 1 | 2;
  stdout?: string;
  stderr?: string;
}

const ABSENT = new Set(["PGRST202", "42883"]);
const REFUSAL = "Figma context unavailable; refusing configured Figma work.\n";

export async function runFigmaComponent(
  args: ComponentArgs,
  deps: ComponentDeps,
): Promise<ComponentOutcome> {
  if (!args.sets && !args.name) {
    return {
      exitCode: 1,
      stderr: "Usage: harmony figma component <name> [--in <set>] | --sets\n",
    };
  }
  let ctx: Record<string, unknown>;
  try {
    const { data, error } = await deps.context();
    if (error || !data || typeof data !== "object") {
      return { exitCode: 1, stderr: REFUSAL };
    }
    ctx = data as Record<string, unknown>;
  } catch {
    return { exitCode: 1, stderr: REFUSAL };
  }
  if (ctx.state !== "connected") {
    return {
      exitCode: 1,
      stderr: `Figma connection is ${
        typeof ctx.state === "string" ? ctx.state : "unavailable"
      }; refusing configured Figma work.\n`,
    };
  }
  const raw = ctx.library_components;
  const map: LibraryMapShape = raw && typeof raw === "object"
    ? (raw as LibraryMapShape)
    : {};
  if (args.sets) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ status: "sets", sets: listLibrarySets(map) }) + "\n",
    };
  }
  const result = await resolveLibraryComponent(map, args.name as string, {
    set: args.set,
    // Only a bare name can be one of the stored ambiguous standalones.
    candidates: args.set === undefined
      ? async (name) => {
        const { data, error } = await deps.candidates(name);
        if (error) {
          if (error.code && ABSENT.has(error.code)) return [];
          throw new Error("candidates unavailable");
        }
        return Array.isArray(data) ? data : [];
      }
      : undefined,
  });
  return {
    exitCode: result.status === "not-found" ? 2 : 0,
    stdout: JSON.stringify(result) + "\n",
  };
}
