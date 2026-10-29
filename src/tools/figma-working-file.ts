// B-1325 — the per-project Figma WORKING FILE. Design legs compose ONLY in the project's working file, on a
// page named for the ticket. They NEVER write to the workspace's library file, and never create or choose a
// file themselves. Pure helpers plus one injected-fetch validator; no board access here.

export const FIGMA_KEY_RE = /^[0-9a-zA-Z]{22,128}$/;

const URL_KINDS = new Set(['design', 'file', 'board', 'make', 'slides']);

/** A bare key, or any figma.com /design|file|board|make|slides/<key>/... URL (branch URLs yield the branch key). */
export function parseFigmaFileKey(input: string): string | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  if (FIGMA_KEY_RE.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'figma.com' && !host.endsWith('.figma.com')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || !URL_KINDS.has(parts[0])) return null;
  let key = parts[1];
  if (parts[2] === 'branch' && parts[3]) key = parts[3];
  return FIGMA_KEY_RE.test(key) ? key : null;
}

export type ComposeTarget =
  | { status: 'ready'; fileKey: string }
  | { status: 'ask'; reason: 'no-working-file' }
  | { status: 'refuse'; reason: 'working-file-is-library' };

export function resolveComposeTarget(opts: {
  libraryFileKey?: string | null;
  workingFileKey?: string | null;
}): ComposeTarget {
  const working = opts.workingFileKey?.trim();
  if (!working) return { status: 'ask', reason: 'no-working-file' };
  if (opts.libraryFileKey && working === opts.libraryFileKey) {
    return { status: 'refuse', reason: 'working-file-is-library' };
  }
  return { status: 'ready', fileKey: working };
}

/** The hard rule: a design leg never writes to the library file. */
export function assertNotLibrary(targetKey: string, libraryKey?: string | null): void {
  if (libraryKey && targetKey === libraryKey) {
    throw new Error(
      'Refusing to write: the target is the workspace library file. Design legs compose only in the project working file, never the library.',
    );
  }
}

export type WorkingFileValidation =
  | { ok: true; fileKey: string; name: string }
  | { ok: false; reason: 'bad-key' | 'is-library' | 'not-found' | 'forbidden' | 'rate-limited' | 'network'; detail: string };

export async function validateWorkingFile(opts: {
  input: string;
  libraryFileKey?: string | null;
  token: string | undefined;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): Promise<WorkingFileValidation> {
  const key = parseFigmaFileKey(opts.input);
  if (!key) return { ok: false, reason: 'bad-key', detail: 'Not a Figma file key or a figma.com file link.' };
  if (opts.libraryFileKey && key === opts.libraryFileKey) {
    return { ok: false, reason: 'is-library', detail: 'That is the workspace library file; a working file must be a different file.' };
  }
  if (!opts.token) return { ok: false, reason: 'forbidden', detail: 'No Figma token is available to check the file.' };
  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(`https://api.figma.com/v1/files/${key}?depth=1`, {
      headers: { 'X-Figma-Token': opts.token },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (res.status === 200) {
      let name = '';
      try {
        const body = (await res.json()) as { name?: unknown };
        if (typeof body?.name === 'string') name = body.name;
      } catch { /* a 200 without a JSON body still proves reachability */ }
      return { ok: true, fileKey: key, name };
    }
    if (res.status === 404) return { ok: false, reason: 'not-found', detail: 'Figma reports no such file (404).' };
    if (res.status === 403) return { ok: false, reason: 'forbidden', detail: 'The workspace Figma token cannot open that file (403).' };
    if (res.status === 429) return { ok: false, reason: 'rate-limited', detail: 'Figma rate-limited the check (429); retry shortly.' };
    return { ok: false, reason: 'network', detail: `Unexpected Figma response (${res.status}).` };
  } catch (e) {
    return { ok: false, reason: 'network', detail: e instanceof Error ? e.name : 'request failed' };
  }
}

export function ticketPagePrefix(visualId: string): string {
  return `${visualId} · `;
}

const TITLE_MAX = 40;

export function ticketPageName(visualId: string, title: string): string {
  let t = title.trim().replace(/\s+/g, ' ');
  if (t.length > TITLE_MAX) {
    const cut = t.slice(0, TITLE_MAX + 1);
    const space = cut.lastIndexOf(' ');
    t = (space > 10 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX)).trim();
  }
  return `${ticketPagePrefix(visualId)}${t}`;
}

export function findTicketPage<P extends { id: string; name: string }>(pages: P[], visualId: string): P | null {
  const prefix = ticketPagePrefix(visualId);
  return pages.find((p) => p.name.startsWith(prefix)) ?? null;
}

export function formatWorkingFileSetComment(o: {
  projectKey: string;
  fileKey: string;
  setBy: string;
  exchangeId: string;
  taskId: string;
  via: string;
}): string {
  const one = (v: string) => v.replace(/\s+/g, '_');
  return `FIGMA-WORKING-FILE-SET project=${one(o.projectKey)} file=${one(o.fileKey)} by=${one(o.setBy)} via=${one(o.via)} exchange=${one(o.exchangeId)} task=${one(o.taskId)}`;
}
