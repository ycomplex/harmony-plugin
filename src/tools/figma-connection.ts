// B-1203 — the Figma connection preflight. Every Figma-dependent behaviour (the visual-handoff Figma path,
// clarify's "would a flow sketch settle this?" item, the design gate's product-track coverage check) is
// gated on the SAME preflight. Unconnected means every one of them is absent and behaviour is exactly as
// before.
//
// DEPENDENCY, NOT ASSUMPTION: the connection storage, the saved component map and the shared limiter are
// B-1201's. Until B-1201 lands, the default reader below ALWAYS reports 'unconnected'.

export type FigmaConnection =
  | { state: 'unconnected' }
  | { state: 'connected'; fileKey?: string; componentMapId?: string }
  | { state: 'failing'; reason: string };

/** The port B-1201 will implement over its stored connection. */
export interface FigmaConnectionReader {
  read(): Promise<FigmaConnection>;
}

export type FigmaRoute = 'html' | 'figma' | 'stop';

/** Default reader: no storage exists yet, so absent storage/tool => unconnected. B-1201 replaces this. */
export const defaultFigmaConnectionReader: FigmaConnectionReader = {
  async read() {
    return { state: 'unconnected' };
  },
};

/**
 * unconnected => 'html' (today's path, unchanged); connected => 'figma'; configured-but-failing => 'stop'
 * (the leg stops with a reconnect instruction and NEVER silently falls back to HTML).
 */
export function resolveFigmaRoute(conn: FigmaConnection): FigmaRoute {
  switch (conn.state) {
    case 'connected':
      return 'figma';
    case 'failing':
      return 'stop';
    default:
      return 'html';
  }
}

/** The reconnect instruction a 'stop' route puts on the brief / in the leg's report. */
export function reconnectInstruction(conn: Extract<FigmaConnection, { state: 'failing' }>): string {
  return `The Figma connection is configured but failing (${conn.reason}). Reconnect Figma in project settings, then re-run this gate. Not falling back to the generated-HTML path.`;
}

/** Convenience: preflight through a reader. */
export async function preflightFigma(
  reader: FigmaConnectionReader = defaultFigmaConnectionReader,
): Promise<{ connection: FigmaConnection; route: FigmaRoute }> {
  const connection = await reader.read();
  return { connection, route: resolveFigmaRoute(connection) };
}

/** Every Figma-gated behaviour (clarify sketch item, product-track check) is live ONLY on this route. */
export function figmaBehavioursEnabled(route: FigmaRoute): boolean {
  return route === 'figma';
}
