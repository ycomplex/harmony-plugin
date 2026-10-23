import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { initProseSources, proseRefreshWorkflow, RELEASED_PROSE_CLI } from './prose-init.js';
import { declarationSchema, extractProse } from './prose-ingestion.js';
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'prose-init-')); roots.push(root); return root; };
const options = { repository: 'another-org/project', branch: 'trunk', cliCommit: RELEASED_PROSE_CLI, key: 'project-guide', include: ['guide/**/*.md'], exclude: [], kind: 'document' as const, scope: 'product' as const, domain: ['product' as const] };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('portable prose setup', () => {
  it('creates a second-project declaration usable by the immutable source extractor', () => {
    const root = temp();
    const result = initProseSources(root, options);
    const declaration = declarationSchema.parse(JSON.parse(readFileSync(join(root, result.files[0]), 'utf8')));
    expect(declaration.repository).toBe('https://github.com/another-org/project');
    expect(declaration.ref).toBe('HEAD');
    mkdirSync(join(root, 'guide')); writeFileSync(join(root, 'guide/start.md'), '# Project guide\n\nSearchable prose.\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args]);
    git('init', '-q'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'initial');
    const extracted = extractProse(root, 'HEAD', declaration.sources[0].selectors);
    expect(extracted.diagnostics).toEqual([]);
    expect(extracted.chunks).toEqual([expect.objectContaining({ path: 'guide/start.md', heading: 'Project guide', scope: 'product' })]);
    expect(result.instructions).toContain('gh secret set HARMONY_PROSE_INDEX_TOKEN --repo another-org/project');
    expect(result.instructions.join('\n')).toContain('commit and push them to trunk');
    expect(result.instructions.join('\n')).toContain('gh workflow run prose-index.yml --repo another-org/project --ref trunk');
  });
  it('pins a released prebuilt CLI and refreshes on the chosen branch or manual dispatch', () => {
    const content = proseRefreshWorkflow('trunk');
    const workflow = parse(content);
    expect(workflow.on).toEqual({ push: { branches: ['trunk'] }, workflow_dispatch: {} });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.refresh.steps[1].with.ref).toBe(RELEASED_PROSE_CLI);
    expect(content).not.toMatch(/npm ci|npm run build|ref: main/);
    expect(workflow.jobs.refresh.steps.at(-1).run).toContain('knowledge sync-prose --root "$GITHUB_WORKSPACE" --commit "$GITHUB_SHA"');
    expect(content).toContain('secrets.HARMONY_PROSE_INDEX_TOKEN');
    expect(content).toContain('::warning::');
  });
  it.each(['.harmony/prose-sources.json', '.github/workflows/prose-index.yml'])('preserves existing %s and writes no other target', file => {
    const root = temp(); mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), 'existing');
    expect(() => initProseSources(root, options)).toThrow('Already exists');
    expect(readFileSync(join(root, file), 'utf8')).toBe('existing');
    const other = file.startsWith('.harmony/') ? '.github/workflows/prose-index.yml' : '.harmony/prose-sources.json';
    expect(existsSync(join(root, other))).toBe(false);
  });
  it.each([{ repository: 'org/repo;echo x' }, { cliCommit: 'main' }, { include: ['../secret.md'] }, { branch: 'main\nrun: echo x' }, { scope: 'guessed' }])('rejects invalid options before writing: %j', change => {
    const root = temp(); expect(() => initProseSources(root, { ...options, ...change } as typeof options)).toThrow();
    expect(existsSync(join(root, '.harmony'))).toBe(false);
  });
  it('refuses symlinked destinations and supports explicit unresolved scope', () => {
    const root = temp(), outside = temp(); symlinkSync(outside, join(root, '.harmony'));
    expect(() => initProseSources(root, options)).toThrow('Refusing symlink');
    expect(existsSync(join(outside, 'prose-sources.json'))).toBe(false);
    const fresh = temp(); initProseSources(fresh, { ...options, scope: 'unresolved' });
    expect(JSON.parse(readFileSync(join(fresh, '.harmony/prose-sources.json'), 'utf8')).sources[0].selectors[0].scope).toBeNull();
  });
});
