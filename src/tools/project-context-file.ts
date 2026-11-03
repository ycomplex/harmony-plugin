import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { ProjectContext } from './project-context.js';
export const CONTEXT_BEGIN = '<!-- harmony:project-context:begin -->';
export const CONTEXT_END = '<!-- harmony:project-context:end -->';
const line = (value: string): string => value.replace(/[\r\n]/g, ' ').replace(/<!--/g, '&lt;!--');
export function renderProjectContext(context: ProjectContext): string {
  return [CONTEXT_BEGIN, '# Project context', '',
    'Harmony is authoritative. Before planning, query_knowledge({status:"Accepted"}) and read_rule_registry. Read every source entry; a Superseded source loses authority. Refresh with `harmony project context refresh --root <repo>`.',
    ...context.blocks.flatMap(block => ['', `## ${line(block.title)}`,
      block.state === 'accepted' ? line(block.summary!) : block.state === 'undecided' ? `Undecided: see ${block.ticket}.` : `Unresolved: ${block.diagnostics.map(line).join(' ')}`,
      `Harmony: ${block.ticket ?? 'scaffold unavailable'}; source entry ids: ${block.source_ids.join(', ') || 'none'}.`]),
    '', CONTEXT_END].join('\n');
}
export function replaceProjectContext(original: string, rendered: string): string {
  const starts = original.split(CONTEXT_BEGIN).length - 1, ends = original.split(CONTEXT_END).length - 1;
  if (!starts && !ends) return original + (original && !original.endsWith('\n') ? '\n' : '') + (original ? '\n' : '') + rendered + '\n';
  if (starts !== 1 || ends !== 1 || original.indexOf(CONTEXT_END) < original.indexOf(CONTEXT_BEGIN)) throw new Error('Malformed or multiple project-context markers; no file was changed.');
  return original.slice(0, original.indexOf(CONTEXT_BEGIN)) + rendered + original.slice(original.indexOf(CONTEXT_END) + CONTEXT_END.length);
}
async function readContextFile(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CLAUDE.md must be a regular file.');
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export async function checkProjectContextFile(root: string, context: ProjectContext) {
  const path = join(root, 'CLAUDE.md');
  const original = await readContextFile(path);
  const rendered = renderProjectContext(context);
  const next = replaceProjectContext(original ?? '', rendered);
  return { path, stale: original !== next, source_ids: context.blocks.flatMap(b => b.source_ids),
    diagnostics: context.diagnostics, fingerprint: createHash('sha256').update(rendered).digest('hex') };
}
/** Local explicit operation only. Refuse unresolved snapshots and concurrent edits. */
export async function refreshProjectContextFile(root: string, context: ProjectContext,
  beforeReplace?: () => Promise<void>) {
  if (context.diagnostics.length) throw new Error(`Project context unresolved; no file was changed: ${context.diagnostics.join(' ')}`);
  const path = join(root, 'CLAUDE.md'), original = await readContextFile(path);
  const next = replaceProjectContext(original ?? '', renderProjectContext(context));
  if (next === original) return { path, changed: false };
  const temp = join(root, `.CLAUDE.md.${randomUUID()}.tmp`);
  try {
    const mode = original === null ? 0o644 : (await lstat(path)).mode & 0o777;
    await writeFile(temp, next, { flag: 'wx', mode });
    await beforeReplace?.();
    if (await readContextFile(path) !== original) throw new Error('CLAUDE.md changed during refresh; retry from the current file.');
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { path, changed: true };
}
