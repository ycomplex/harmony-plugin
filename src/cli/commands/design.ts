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
}
