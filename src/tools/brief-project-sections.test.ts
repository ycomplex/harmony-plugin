// B-1305: the project-sections helpers and the read surface (MCP tool + CLI command on one core).
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBriefCommands } from '../cli/commands/briefs.js';
import {
  applySectionsOutcome,
  formatBriefSections,
  readBriefSections,
  readBriefSectionsTool,
  renderProjectSectionsArea,
  resolveSectionsForCompose,
  setDefaultBriefSectionReader,
} from './brief-project-sections.js';
import { handleToolCall, registerTools } from './index.js';

const declared = {
  kind: 'declared' as const,
  warnings: ['acme-co/other:.harmony/project.yml: bad; not enforced'],
  repos: [
    {
      repository: 'acme-co/widget-app',
      commit: '0123456789abcdef0123456789abcdef01234567',
      fresh: false,
      sections: [{ id: 'ears', title: 'Requirements in EARS form', instruction: 'Restate each criterion.' }],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('readBriefSections (the shared core)', () => {
  it('returns the declarations with repository, commit and freshness', async () => {
    const reader = vi.fn(async () => declared);
    expect(await readBriefSections({ gate: 'verify' }, reader)).toEqual({ gate: 'verify', ...declared });
    expect(reader).toHaveBeenCalledWith('verify');
  });
  it('returns none and unreadable as they are', async () => {
    expect(await readBriefSections({ gate: 'plan' }, async () => ({ kind: 'none' }))).toEqual({ gate: 'plan', kind: 'none' });
    expect(await readBriefSections({ gate: 'plan' }, async () => ({ kind: 'unreadable', detail: 'd' }))).toEqual({ gate: 'plan', kind: 'unreadable', detail: 'd' });
  });
  it('refuses a gate that carries no sections', async () => {
    await expect(readBriefSections({ gate: 'stale-patch' }, async () => ({ kind: 'none' }))).rejects.toThrow(/gate must be one of: clarify, decompose, design, plan, release, verify/);
  });
  it('formats each outcome for a terminal', () => {
    expect(formatBriefSections({ gate: 'plan', kind: 'none' })).toBe('No brief sections are declared for the plan gate.');
    const text = formatBriefSections({ gate: 'verify', ...declared });
    expect(text).toContain('acme-co/widget-app — declared at 0123456 (may be out of date');
    expect(text).toContain('  ears: Requirements in EARS form');
    expect(text).toContain('warning: acme-co/other');
  });
});

describe('read_brief_sections MCP tool', () => {
  it('is registered and dispatches to the shared core', async () => {
    expect(registerTools().map((t: { name: string }) => t.name)).toContain('read_brief_sections');
    expect(readBriefSectionsTool.inputSchema.required).toEqual(['gate']);
    setDefaultBriefSectionReader(async () => declared);
    const res = await handleToolCall('read_brief_sections', { gate: 'clarify' }, {} as any, 'p', 'u');
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual({ gate: 'clarify', ...declared });
  });
});

describe('harmony brief sections <gate>', () => {
  it('prints the same core result, as JSON with --json', async () => {
    setDefaultBriefSectionReader(async () => declared);
    const program = new Command().option('--json');
    registerBriefCommands(program);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program.parseAsync(['node', 'harmony', '--json', 'brief', 'sections', 'verify']);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ gate: 'verify', ...declared });
    log.mockClear();
    const p2 = new Command().option('--json');
    registerBriefCommands(p2);
    await p2.parseAsync(['node', 'harmony', 'brief', 'sections', 'verify']);
    expect(log.mock.calls[0][0]).toContain('ears: Requirements in EARS form');
  });
});

describe('resolveSectionsForCompose — mechanical composes', () => {
  const run = (d: unknown) => resolveSectionsForCompose({ gate: 'clarify', supplied: undefined, mechanical: true, reader: async () => d as never });
  it('marks the brief only when this gate positively enforces a section', async () => {
    expect(await run(declared)).toEqual({ kind: 'set', sections: null, omitted: { reason: 'mechanical' }, warnings: [] });
  });
  it('says nothing when nothing is declared, the declarations are unreadable, or nothing is enforced', async () => {
    expect(await run({ kind: 'none' })).toEqual({ kind: 'clear', warnings: [] });
    expect(await run({ kind: 'unreadable', detail: 'no repository could be read' })).toEqual({ kind: 'clear', warnings: [] });
    expect(await run({ kind: 'declared', repos: [], warnings: ['x: bad; not enforced'] })).toEqual({ kind: 'clear', warnings: [] });
  });
});

describe('applySectionsOutcome', () => {
  const s = [{ repository: 'a/b', id: 'x', title: 'T', markdown: 'm', commit: 'c', fresh: true }];
  it('is the identity when nothing applies', () => {
    const doc = { decide: 'd' };
    expect(applySectionsOutcome(doc, null, { kind: 'clear', warnings: [] })).toBe(doc);
  });
  it('removes keys a prior revision never had, nulls keys it had', () => {
    expect(applySectionsOutcome({ decide: 'd', sections: [] }, null, { kind: 'clear', warnings: [] })).toEqual({ decide: 'd' });
    expect(applySectionsOutcome({ decide: 'd', sections: s }, { sections: s }, { kind: 'clear', warnings: [] })).toEqual({ decide: 'd', sections: null });
  });
  it('sets stamped sections and the omission reason', () => {
    expect(applySectionsOutcome({ decide: 'd' }, null, { kind: 'set', sections: s, omitted: null, warnings: [] })).toEqual({ decide: 'd', sections: s });
    expect(applySectionsOutcome({ decide: 'd' }, null, { kind: 'set', sections: null, omitted: { reason: 'mechanical' }, warnings: [] }))
      .toEqual({ decide: 'd', sections_omitted: { reason: 'mechanical' } });
  });
});

describe('renderProjectSectionsArea', () => {
  it('renders one ### per repository and one #### per section', () => {
    const area = renderProjectSectionsArea({
      sections: [
        { repository: 'a/web', id: 'x', title: 'X', markdown: 'mx', commit: '1234567890', fresh: true },
        { repository: 'a/web', id: 'y', title: 'Y', markdown: 'my', commit: '1234567890', fresh: true },
        { repository: 'a/api', id: 'x', title: 'X', markdown: 'Not applicable to this ticket', commit: 'abcdef0123', fresh: true },
      ],
    });
    expect(area).toBe(
      "\n\n---\n\n## Project sections\n\n_Written by the agent at this project's request. Not checked by Harmony._" +
        '\n\n### a/web — declared at 1234567\n\n#### X\n\nmx\n\n#### Y\n\nmy' +
        '\n\n### a/api — declared at abcdef0\n\n#### X\n\nNot applicable to this ticket',
    );
  });
  it('renders nothing for a doc with neither key', () => {
    expect(renderProjectSectionsArea({})).toBe('');
    expect(renderProjectSectionsArea({ sections: null, sections_omitted: null })).toBe('');
  });
});
