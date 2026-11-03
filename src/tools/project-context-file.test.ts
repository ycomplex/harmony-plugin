import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_BEGIN, CONTEXT_END, renderProjectContext, replaceProjectContext, refreshProjectContextFile, checkProjectContextFile } from './project-context-file.js';
import type { ProjectContext } from './project-context.js';
const context: ProjectContext = { version: 1, project_id: 'project', project_name: 'Example', diagnostics: [], blocks: [
  { key: 'proposition', title: 'What this project is', state: 'accepted', ticket: 'EX-1', source_ids: ['source'], summary: 'Purpose: tokens. Personas: designers. Features: exports.', diagnostics: [] },
  { key: 'data', title: 'Data', state: 'undecided', ticket: 'EX-2', source_ids: [], summary: null, diagnostics: [] },
] };
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), 'context-')); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('guarded project context writes', () => {
  it('preserves unrelated bytes and is idempotent across repeated refreshes', async () => {
    const path = await root(); const file = join(path, 'CLAUDE.md');
    await writeFile(file, '# Rules\nKeep this exactly.\n');
    expect((await checkProjectContextFile(path, context)).stale).toBe(true);
    expect((await refreshProjectContextFile(path, context)).changed).toBe(true);
    const once = await readFile(file, 'utf8');
    expect(once.startsWith('# Rules\nKeep this exactly.\n')).toBe(true);
    expect(once).toContain('Undecided: see EX-2.');
    expect(once).toContain('source entry ids: source');
    expect((await refreshProjectContextFile(path, context)).changed).toBe(false);
    expect((await checkProjectContextFile(path, context)).stale).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(once);
  });
  it('replaces only its span and refuses every malformed marker shape', () => {
    const rendered = renderProjectContext(context);
    expect(replaceProjectContext(`before\n${CONTEXT_BEGIN}\nold\n${CONTEXT_END}\nafter`, rendered)).toBe(`before\n${rendered}\nafter`);
    for (const original of [CONTEXT_BEGIN, CONTEXT_END, CONTEXT_END + CONTEXT_BEGIN, CONTEXT_BEGIN + CONTEXT_BEGIN + CONTEXT_END]) {
      expect(() => replaceProjectContext(original, rendered)).toThrow('markers');
    }
  });
  it('refuses concurrent edits and cleans its temporary file', async () => {
    const path = await root(); const file = join(path, 'CLAUDE.md'); await writeFile(file, 'original');
    await expect(refreshProjectContextFile(path, context, () => writeFile(file, 'concurrent edit'))).rejects.toThrow('changed during');
    expect(await readFile(file, 'utf8')).toBe('concurrent edit');
    expect(await readdir(path)).toEqual(['CLAUDE.md']);
  });
  it('does not commit unresolved snapshots or follow a symlink', async () => {
    const path = await root();
    await expect(refreshProjectContextFile(path, { ...context, diagnostics: ['conflicting source'] })).rejects.toThrow('unresolved');
    expect(await readdir(path)).toEqual([]);
    await writeFile(join(path, 'outside'), 'keep'); await symlink(join(path, 'outside'), join(path, 'CLAUDE.md'));
    await expect(refreshProjectContextFile(path, context)).rejects.toThrow('regular file');
    expect(await readFile(join(path, 'outside'), 'utf8')).toBe('keep');
  });
});
