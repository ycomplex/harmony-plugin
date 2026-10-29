// B-1203 — `harmony design fingerprint take|compare`. The accepted Figma design's content fingerprint is taken
// by the leg that consumes the design accept and compared later by the plan and build gates. The pure core
// (`fingerprintTake`, `fingerprintCompare`) takes injected ports so every path is testable without the board
// or Figma; the thin wrapper supplies the real task tools and the token.
//
// Exit codes: 0 for every EXPECTED state (taken, not-taken, skipped, unchanged, changed, not-checked); one JSON
// line on stdout. Only an unexpected failure (cannot authenticate, task not found, board write refused) exits 1.
// The token comes from HARMONY_FIGMA_TOKEN, else the file /secrets/figma/pat; it is never printed or stored.
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getAuthenticatedContext } from '../auth.js';
import { getTask, updateTask } from '../../tools/tasks.js';
import { readAcceptedDesign } from '../../tools/design-read.js';
import {
  takeFingerprint, fetchNodes, fingerprintFrames, compareFingerprint,
  type FingerprintFetch, type FrameDigest, type NotTakenReason,
} from '../../tools/design-fingerprint.js';

import { listComments } from '../../tools/comments.js';
import {
  findFigmaLinks, classifyFrames, createComponentLookup, DEFAULT_LOOKUP_CAP,
  type FigmaLink, type FrameVerdict, type LookupComponentFile, type ReadNodes, type Sleep,
} from '../../tools/figma-adopt.js';
import { createFigmaRestClient, FigmaRestError, type FigmaNodesResponse } from '../../tools/figma-reconcile.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const FIGMA_PAT_FILE = '/secrets/figma/pat';

export function readFigmaToken(env: NodeJS.ProcessEnv = process.env, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): string | undefined {
  const fromEnv = env.HARMONY_FIGMA_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try { return readFile(FIGMA_PAT_FILE).trim() || undefined; } catch { return undefined; }
}

export interface FingerprintDeps {
  /** The task's field_values (the board read). */
  readFieldValues(taskRef: string): Promise<Obj>;
  /** Merge `design_fingerprint` into the task's field_values (the task update core merges at top level). */
  writeFingerprint(taskRef: string, record: Obj): Promise<void>;
  token: string | undefined;
  fetcher?: FingerprintFetch;
  now?: () => Date;
}

type Read =
  | { ok: true; fileKey: string; frameIds: string[]; acceptedAt: string | null; stored: Obj | null }
  | { ok: false; reason: 'no-accepted-design' | 'not-figma' | 'no-nodes' };

function readDesign(fv: Obj): Read {
  const design = readAcceptedDesign(fv);
  if (design.status !== 'present') return { ok: false, reason: 'no-accepted-design' };
  if (design.tool !== 'figma') return { ok: false, reason: 'not-figma' };
  if (!design.fileKey || design.screens.length === 0) return { ok: false, reason: 'no-nodes' };
  const slot = isObj(fv.gate_slots) && isObj(fv.gate_slots.design) ? fv.gate_slots.design : {};
  const ratified = typeof slot.ratified_at === 'string' && slot.ratified_at ? slot.ratified_at : null;
  return {
    ok: true, fileKey: design.fileKey, frameIds: design.screens.map((s) => s.nodeId), acceptedAt: ratified,
    stored: isObj(fv.design_fingerprint) ? fv.design_fingerprint : null,
  };
}

export async function fingerprintTake(taskRef: string, deps: FingerprintDeps): Promise<Obj> {
  const now = deps.now ?? (() => new Date());
  const read = readDesign(await deps.readFieldValues(taskRef));
  if (!read.ok) return { command: 'take', status: 'skipped', reason: read.reason, wrote: false };
  const r = await takeFingerprint({
    fileKey: read.fileKey, frameIds: read.frameIds, token: deps.token,
    acceptedAt: read.acceptedAt ?? now().toISOString(), now, fetcher: deps.fetcher,
  });
  await deps.writeFingerprint(taskRef, r.record as unknown as Obj);
  return r.status === 'taken'
    ? { command: 'take', status: 'taken', digest: r.record.digest, frames: r.record.frames.length, wrote: true }
    : { command: 'take', status: 'not-taken', reason: r.record.reason, wrote: true };
}

export async function fingerprintCompare(taskRef: string, by: string, deps: FingerprintDeps): Promise<Obj> {
  const now = deps.now ?? (() => new Date());
  const read = readDesign(await deps.readFieldValues(taskRef));
  if (!read.ok) return { command: 'compare', status: 'skipped', reason: read.reason, wrote: false };
  const stored = read.stored;
  if (!stored) return { command: 'compare', status: 'unchecked', reason: 'no-fingerprint', wrote: false };
  const storedFrames = Array.isArray(stored.frames)
    ? stored.frames.filter((f): f is FrameDigest => isObj(f) && typeof f.id === 'string' && typeof f.digest === 'string')
    : [];
  if (stored.status !== 'taken' || storedFrames.length === 0) {
    return { command: 'compare', status: 'unchecked', reason: 'fingerprint-not-taken', wrote: false };
  }
  const checked_at = now().toISOString();
  const earlier = isObj(stored.drift) ? stored.drift : {};
  const write = async (drift: Obj) => deps.writeFingerprint(taskRef, { ...stored, drift });
  const notChecked = async (reason: NotTakenReason | 'malformed-response'): Promise<Obj> => {
    await write({ ...earlier, status: 'not-checked', checked_at, checked_by: by, reason });
    return { command: 'compare', status: 'not-checked', reason, wrote: true };
  };

  const ids = storedFrames.map((f) => f.id);
  const res = await fetchNodes({ fileKey: read.fileKey, frameIds: ids, token: deps.token, fetcher: deps.fetcher });
  if (!res.ok) return notChecked(res.reason);
  // A frame that is gone from the file counts as removed (changed), so digest frame by frame.
  const fresh: FrameDigest[] = [];
  for (const id of ids) {
    const one = fingerprintFrames(res.body, [id]);
    if (one.ok) fresh.push(...one.frames);
  }
  const cmp = compareFingerprint({ frames: storedFrames }, { frames: fresh });
  const changed = [...cmp.changed_frame_ids, ...cmp.removed_frame_ids, ...cmp.added_frame_ids];
  if (cmp.status === 'unchanged') {
    await write({ status: 'unchanged', checked_at, checked_by: by });
    return { command: 'compare', status: 'unchanged', wrote: true };
  }
  await write({ status: 'changed', checked_at, checked_by: by, changed_frame_ids: changed });
  return { command: 'compare', status: 'changed', changed_frame_ids: changed, wrote: true };
}

// B-1320 — `harmony design adopt-check --task <id> [--links-only]`. READ-ONLY: finds the Figma frame links on the
// ticket (description + comments), reads the frames live over REST and says which are library-built and so can be
// adopted as drawn. Writes nothing to the board and nothing to Figma. Exit 0 on every expected state.
export interface AdoptCheckDeps {
  /** The ticket's description and every comment's text. */
  readTexts(taskRef: string): Promise<string[]>;
  /** The workspace library file key, or null when Figma is not connected (or the context is unreadable). */
  readLibraryFileKey(): Promise<string | null>;
  token: string | undefined;
  readNodes: ReadNodes;
  lookupComponentFile: LookupComponentFile;
  sleep?: Sleep;
  cap?: number;
}

export async function adoptCheck(taskRef: string, opts: { linksOnly?: boolean }, deps: AdoptCheckDeps): Promise<Obj> {
  const cap = deps.cap ?? DEFAULT_LOOKUP_CAP;
  const links = findFigmaLinks(await deps.readTexts(taskRef));
  const plain = (l: FigmaLink) => ({ fileKey: l.fileKey, nodeId: l.nodeId, url: l.url });
  if (links.length === 0) return { command: 'adopt-check', status: 'no-links', links: [], frames: [], lookups_used: 0, lookup_cap: cap };
  if (!deps.token) return { command: 'adopt-check', status: 'no-token', links: links.map(plain), frames: [], lookups_used: 0, lookup_cap: cap };

  if (opts.linksOnly) {
    const out: Obj[] = [];
    for (const l of links) {
      if (!l.nodeId) { out.push({ ...plain(l), readable: false, reason: 'the link names no frame' }); continue; }
      try {
        const res = await deps.readNodes(l.fileKey, [l.nodeId]);
        out.push(res.nodes?.[l.nodeId]?.document ? { ...plain(l), readable: true } : { ...plain(l), readable: false, reason: 'the node is absent from the file' });
      } catch (err) {
        out.push({ ...plain(l), readable: false, reason: err instanceof FigmaRestError ? `Figma returned ${err.status}` : 'Figma was unreachable' });
      }
    }
    return { command: 'adopt-check', status: 'ok', links_only: true, links: out, frames: [], lookups_used: 0, lookup_cap: cap };
  }

  const libraryFileKey = await deps.readLibraryFileKey();
  if (!libraryFileKey) return { command: 'adopt-check', status: 'not-connected', links: links.map(plain), frames: [], lookups_used: 0, lookup_cap: cap };
  const r = await classifyFrames({
    links, libraryFileKey, readNodes: deps.readNodes, lookupComponentFile: deps.lookupComponentFile, cap, sleep: deps.sleep,
  });
  return {
    command: 'adopt-check', status: 'ok', links: links.map(plain), frames: r.frames as FrameVerdict[],
    lookups_used: r.lookupsUsed, lookup_cap: r.lookupCap,
  };
}

export function registerDesignCommands(program: Command): void {
  const design = program.command('design').description('Accepted-design helpers (B-1203)');
  const fp = design.command('fingerprint').description('Content fingerprint of the accepted Figma design');

  async function run(fn: (taskRef: string, deps: FingerprintDeps) => Promise<Obj>, task: string): Promise<void> {
    try {
      const ctx = await getAuthenticatedContext();
      const deps: FingerprintDeps = {
        token: readFigmaToken(),
        readFieldValues: async (ref) => {
          const t = (await getTask(ctx.client, ctx.projectId, { task_id: ref })) as { field_values?: Obj | null };
          return t.field_values ?? {};
        },
        writeFingerprint: async (ref, record) => {
          await updateTask(ctx.client, ctx.projectId, { task_id: ref, field_values: { design_fingerprint: record } });
        },
      };
      console.log(JSON.stringify(await fn(task, deps)));
    } catch (err) {
      console.log(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    }
  }

  fp.command('take')
    .description('Take and store the fingerprint of the ticket\'s accepted Figma design (run right after the design accept)')
    .requiredOption('--task <id>', 'Task ID (UUID, number, or B-123)')
    .action(async (opts: { task: string }) => run((t, d) => fingerprintTake(t, d), opts.task));

  fp.command('compare')
    .description('Compare the live design with the stored fingerprint and record the drift verdict')
    .requiredOption('--task <id>', 'Task ID (UUID, number, or B-123)')
    .requiredOption('--by <gate>', 'Who is checking: plan, build, ...')
    .action(async (opts: { task: string; by: string }) => run((t, d) => fingerprintCompare(t, opts.by, d), opts.task));

  design.command('adopt-check')
    .description('Read-only: find the designer\'s Figma frame links on the ticket and say which are library-built (adoptable as drawn)')
    .requiredOption('--task <id>', 'Task ID (UUID, number, or B-123)')
    .option('--links-only', 'Only report the links and whether each names a readable frame (no library check)')
    .action(async (opts: { task: string; linksOnly?: boolean }) => {
      try {
        const ctx = await getAuthenticatedContext();
        const token = readFigmaToken();
        const nodeFetch = (url: string, init?: { method?: string; headers?: Record<string, string> }) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const deps: AdoptCheckDeps = {
          token,
          readTexts: async (ref) => {
            const t = (await getTask(ctx.client, ctx.projectId, { task_id: ref })) as { description?: string | null };
            const comments = (await listComments(ctx.client, ctx.projectId, { task_id: ref })) as Array<{ content?: string | null }> | null;
            return [t.description ?? '', ...(comments ?? []).map((c) => c.content ?? '')];
          },
          readLibraryFileKey: async () => {
            try {
              const { data, error } = await ctx.client.rpc('figma_launch_context', { p_project_id: ctx.projectId });
              if (error || !isObj(data) || data.state === 'disconnected') return null;
              return typeof data.library_file_key === 'string' && data.library_file_key ? data.library_file_key : null;
            } catch { return null; }
          },
          readNodes: async (fileKey, ids): Promise<FigmaNodesResponse> =>
            createFigmaRestClient({ token: token ?? '', fetch: nodeFetch as never, fileKey }).getNodesLive(ids),
          lookupComponentFile: createComponentLookup({ token: token ?? '', fetch: nodeFetch as never }),
        };
        console.log(JSON.stringify(await adoptCheck(opts.task, { linksOnly: opts.linksOnly }, deps)));
      } catch (err) {
        console.log(JSON.stringify({ status: 'error', error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
    });
}
