// B-1305: a brief's PROJECT SECTIONS — the extra sections a project asks the briefs at a gate to carry
// (declared in `.harmony/project.yml`'s `brief_sections`, read by src/config/brief-sections.ts).
//
// compose_brief checks the sections on the document THIS call received (never the merged document, so a
// revision must carry them again), stamps each with the declaration's title, repository, commit and
// freshness, and renders them in their own area AFTER everything the standard brief renders. They are
// additive only: they never change the decision, recommendation, criteria or what accepting does, and
// they are never copied into the knowledge entry an accept promotes (renderEntry) nor the ticket's gate
// slot (renderSlot) — both of those build from named doc fields and never read `sections`.

import {
  hasEnforcedSections,
  readBriefSectionDeclarations,
  type BriefSectionDeclarations,
} from '../config/brief-sections.js';
import { BRIEF_SECTION_GATES, BRIEF_SECTION_LIMITS, type BriefSectionGate } from '../config/project-manifest.js';
import { describeScanFinding, scanSectionText } from './brief-section-scan.js';

/** One filled section as stored on the brief. Title, commit and freshness come from the declaration. */
export interface BriefProjectSection {
  repository: string;
  id: string;
  title: string;
  markdown: string;
  commit: string;
  fresh: boolean;
}

/** Why a brief carries no project sections even though it might have. */
export type BriefSectionsOmitted =
  | { reason: 'mechanical' }
  | { reason: 'declarations-unreadable'; detail: string };

/** What the agent supplies: `repository` may be omitted when only one repository declares the id. */
export interface BriefSectionInput {
  repository?: string;
  id: string;
  markdown: string;
}

export type BriefSectionReader = (gate: BriefSectionGate) => Promise<BriefSectionDeclarations>;

let defaultReader: BriefSectionReader = (gate) => readBriefSectionDeclarations(gate);

/** The reader compose_brief and read_brief_sections use when none is passed. Replaceable so the test
 *  suite's setup can keep every unrelated compose test off git and the network. */
export function getDefaultBriefSectionReader(): BriefSectionReader {
  return defaultReader;
}
export function setDefaultBriefSectionReader(reader: BriefSectionReader): void {
  defaultReader = reader;
}

export const NOT_APPLICABLE_LINE = 'Not applicable to this ticket';

type Declared = Extract<BriefSectionDeclarations, { kind: 'declared' }>;

/**
 * Check the sections this call supplied against the declarations. Returns the stamped sections in
 * declaration order, or a refusal message listing every problem. Never includes a matched credential.
 */
export function checkBriefSections(
  supplied: unknown,
  declared: Declared,
  env: Record<string, string | undefined> = process.env,
): { ok: true; sections: BriefProjectSection[] } | { ok: false; message: string } {
  const problems: string[] = [];
  const items: unknown[] = supplied === undefined || supplied === null ? [] : Array.isArray(supplied) ? supplied : [];
  if (supplied !== undefined && supplied !== null && !Array.isArray(supplied)) {
    problems.push('doc.sections must be a list of { repository?, id, markdown }');
  }

  const owners = new Map<string, string[]>();
  for (const repo of declared.repos) {
    for (const s of repo.sections) owners.set(s.id, [...(owners.get(s.id) ?? []), repo.repository]);
  }
  const key = (repository: string, id: string) => `${repository}\0${id}`;
  const filled = new Map<string, string>();

  for (const [i, raw] of items.entries()) {
    const item = raw as Partial<BriefSectionInput> | null;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.markdown !== 'string') {
      problems.push(`doc.sections[${i}] must be { repository?, id, markdown } with string id and markdown`);
      continue;
    }
    if (item.repository !== undefined && typeof item.repository !== 'string') {
      problems.push(`doc.sections[${i}].repository must be a string`);
      continue;
    }
    const declaredBy = owners.get(item.id) ?? [];
    let repository = item.repository;
    if (repository === undefined) {
      if (declaredBy.length === 1) repository = declaredBy[0];
      else if (declaredBy.length > 1) {
        problems.push(`section '${item.id}' is declared by ${declaredBy.join(' and ')}: name its repository`);
        continue;
      }
    }
    if (repository === undefined || !declaredBy.includes(repository)) {
      problems.push(
        `section '${item.id}'${repository ? ` for ${repository}` : ''} is not declared for this gate — remove it`,
      );
      continue;
    }
    const k = key(repository, item.id);
    if (filled.has(k)) {
      problems.push(`section '${item.id}' for ${repository} is supplied twice`);
      continue;
    }
    if (item.markdown.trim() === '') continue; // reported as missing below
    if (item.markdown.length > BRIEF_SECTION_LIMITS.markdownChars) {
      problems.push(
        `section '${item.id}' for ${repository} is ${item.markdown.length} characters — at most ${BRIEF_SECTION_LIMITS.markdownChars}`,
      );
      filled.set(k, item.markdown);
      continue;
    }
    const finding = scanSectionText(item.markdown, env);
    if (finding) {
      problems.push(`section '${item.id}' for ${repository} was refused: ${describeScanFinding(finding)}. Remove it and describe it instead`);
      filled.set(k, item.markdown);
      continue;
    }
    filled.set(k, item.markdown);
  }

  for (const repo of declared.repos) {
    for (const s of repo.sections) {
      if (!filled.has(key(repo.repository, s.id))) {
        problems.push(
          `missing section '${s.id}' for ${repo.repository} — "${s.title}": ${s.instruction} ` +
            `(a repository this ticket does not touch may say '${NOT_APPLICABLE_LINE}')`,
        );
      }
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      message:
        "compose_brief: this project's brief sections for this gate are not complete " +
        '(supply doc.sections as [{ repository, id, markdown }] on every compose, revisions included):\n- ' +
        problems.join('\n- '),
    };
  }

  const sections: BriefProjectSection[] = [];
  for (const repo of declared.repos) {
    for (const s of repo.sections) {
      sections.push({
        repository: repo.repository,
        id: s.id,
        title: s.title,
        markdown: filled.get(key(repo.repository, s.id))!,
        commit: repo.commit,
        fresh: repo.fresh,
      });
    }
  }
  return { ok: true, sections };
}

/** The outcome compose_brief applies to the doc: set the two keys, clear them, or leave the doc alone. */
export type SectionsOutcome =
  | { kind: 'set'; sections: BriefProjectSection[] | null; omitted: BriefSectionsOmitted | null; warnings: string[] }
  | { kind: 'clear'; warnings: string[] };

/**
 * Decide the sections outcome for one compose. Throws (before any write) when declared sections are
 * missing or refused. `gate` undefined means the reason carries no sections.
 */
export async function resolveSectionsForCompose(opts: {
  gate: BriefSectionGate | undefined;
  supplied: unknown;
  mechanical?: boolean;
  reader?: BriefSectionReader;
  env?: Record<string, string | undefined>;
}): Promise<SectionsOutcome> {
  if (!opts.gate) return { kind: 'clear', warnings: [] };
  const declarations = await (opts.reader ?? defaultReader)(opts.gate);
  if (opts.mechanical) {
    // A mechanical compose is marked only when this gate positively enforces a section. With nothing
    // declared, nothing enforced, or declarations that cannot be read (normal where no repository
    // exists, e.g. the conductor's own process), the brief stays exactly as today: no line, no warning.
    if (hasEnforcedSections(declarations)) {
      return { kind: 'set', sections: null, omitted: { reason: 'mechanical' }, warnings: [] };
    }
    return { kind: 'clear', warnings: [] };
  }
  if (declarations.kind === 'unreadable') {
    return {
      kind: 'set',
      sections: null,
      omitted: { reason: 'declarations-unreadable', detail: declarations.detail },
      warnings: [`brief sections: the project's declarations could not be read (${declarations.detail}); the brief carries none`],
    };
  }
  const warnings = declarations.kind === 'declared' ? [...declarations.warnings] : [];
  if (!hasEnforcedSections(declarations)) {
    if (Array.isArray(opts.supplied) && opts.supplied.length > 0) {
      warnings.push('doc.sections ignored: this project declares no brief sections for this gate');
    }
    return { kind: 'clear', warnings };
  }
  const checked = checkBriefSections(opts.supplied, declarations, opts.env ?? process.env);
  if (!checked.ok) throw new Error(checked.message);
  for (const repo of declarations.repos) {
    if (!repo.fresh) {
      warnings.push(`brief sections: ${repo.repository}'s default branch could not be fetched; its declarations were read from the last-fetched copy`);
    }
  }
  return { kind: 'set', sections: checked.sections, omitted: null, warnings };
}

/**
 * Apply an outcome to a doc. `prior` is the previous revision's doc (null on a first compose). Returns the
 * input by identity when nothing changes, so a project that declares nothing keeps today's doc exactly.
 * A key the prior revision carried is cleared with an explicit null (the database merge would otherwise
 * carry it forward); a key it never carried is removed.
 */
export function applySectionsOutcome<T extends object>(doc: T, prior: object | null | undefined, outcome: SectionsOutcome): T {
  const d = doc as Record<string, unknown>;
  const p = (prior ?? {}) as Record<string, unknown>;
  const want: Record<'sections' | 'sections_omitted', unknown> =
    outcome.kind === 'set'
      ? { sections: outcome.sections, sections_omitted: outcome.omitted }
      : { sections: null, sections_omitted: null };
  let out: Record<string, unknown> | null = null;
  for (const k of ['sections', 'sections_omitted'] as const) {
    const value = want[k];
    if (value === null) {
      if (k in p) {
        if (d[k] !== null) (out ??= { ...d })[k] = null;
      } else if (k in d) {
        out ??= { ...d };
        delete out[k];
      }
    } else {
      (out ??= { ...d })[k] = value;
    }
  }
  return (out ?? d) as T;
}

/** The sections area, appended AFTER the standard brief. Empty string when the doc carries neither key. */
export function renderProjectSectionsArea(doc: { sections?: BriefProjectSection[] | null; sections_omitted?: BriefSectionsOmitted | null }): string {
  const omitted = doc.sections_omitted;
  if (omitted?.reason === 'mechanical') {
    return "\n\n---\n\n_This project's brief sections were not produced: this brief was composed with no agent writing it._";
  }
  if (omitted?.reason === 'declarations-unreadable') {
    return `\n\n---\n\n_This project's brief section declarations could not be read: ${omitted.detail}._`;
  }
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (sections.length === 0) return '';
  const parts: string[] = [
    '\n\n---\n\n## Project sections\n\n_Written by the agent at this project\'s request. Not checked by Harmony._',
  ];
  let current: string | null = null;
  for (const s of sections) {
    if (s.repository !== current) {
      current = s.repository;
      const stale = s.fresh ? '' : ' (may be out of date: the default branch could not be fetched)';
      parts.push(`\n\n### ${s.repository} — declared at ${String(s.commit).slice(0, 7)}${stale}`);
    }
    parts.push(`\n\n#### ${s.title}\n\n${s.markdown}`);
  }
  return parts.join('');
}

// ——— the read surface: read_brief_sections (MCP) and `harmony brief sections <gate>` (CLI) ———————————

export interface ReadBriefSectionsArgs {
  gate: string;
}

export type ReadBriefSectionsResult = { gate: BriefSectionGate } & BriefSectionDeclarations;

/** The one core both surfaces call: the declarations for a gate, with repository, commit and freshness,
 *  or the none / unreadable result. Read-only; never touches the board. */
export async function readBriefSections(
  args: ReadBriefSectionsArgs,
  reader: BriefSectionReader = defaultReader,
): Promise<ReadBriefSectionsResult> {
  const gate = args?.gate;
  if (!(BRIEF_SECTION_GATES as readonly string[]).includes(gate)) {
    throw new Error(`gate must be one of: ${BRIEF_SECTION_GATES.join(', ')}`);
  }
  const declarations = await reader(gate as BriefSectionGate);
  return { gate: gate as BriefSectionGate, ...declarations };
}

/** Human-readable form of the read, for the CLI. */
export function formatBriefSections(r: ReadBriefSectionsResult): string {
  if (r.kind === 'none') return `No brief sections are declared for the ${r.gate} gate.`;
  if (r.kind === 'unreadable') return `The brief section declarations could not be read: ${r.detail}`;
  const lines: string[] = [];
  if (r.repos.length === 0) lines.push(`No brief sections are enforced for the ${r.gate} gate.`);
  for (const repo of r.repos) {
    lines.push(`${repo.repository} — declared at ${repo.commit.slice(0, 7)}${repo.fresh ? '' : ' (may be out of date: the default branch could not be fetched)'}`);
    for (const s of repo.sections) lines.push(`  ${s.id}: ${s.title}`, `    ${s.instruction}`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

export const readBriefSectionsTool = {
  name: 'read_brief_sections',
  description:
    "B-1305 — read the extra brief sections this project declares for a gate (`brief_sections` in each repository's .harmony/project.yml, read from the repository's DEFAULT BRANCH, never the working tree). Call it before composing a brief at clarify, decompose, design, plan, release or verify. Returns { gate, kind: 'none' } (nothing declared — compose as usual), { gate, kind: 'unreadable', detail } (compose as usual; the brief notes it), or { gate, kind: 'declared', repos: [{ repository, commit, fresh, sections: [{ id, title, instruction }] }], warnings } — then fill every section as compose_brief doc.sections items { repository, id, markdown }. Read-only.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      gate: { type: 'string', enum: [...BRIEF_SECTION_GATES], description: 'The gate whose brief you are about to compose' },
    },
    required: ['gate'],
  },
};
