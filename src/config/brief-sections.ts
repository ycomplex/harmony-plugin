// B-1305: read the brief sections a project declares, from each repository's DEFAULT BRANCH.
//
// A project asks the briefs at a gate to carry extra sections by declaring `brief_sections` in
// `.harmony/project.yml` (schema and limits: parseBriefSections in ./project-manifest.ts). This file
// decides WHICH copy of that file counts and what happens when it cannot be read.
//
// Which repositories: walk up from the working directory to `.harmony/conductor.json` and take every
// `repos[].path` (the same lookup `repositoryPrefix` in src/tools/knowledge-metadata.ts makes). With
// no conductor file, the git repository containing the working directory. A repository is named by its
// origin URL's `owner/name`; one with no origin remote is skipped with a warning.
//
// Which copy: `origin/<default branch>` — the default branch is `refs/remotes/origin/HEAD`, else `main`,
// else `master`. One quiet fetch per repository at most once a minute per process
// (`git fetch --quiet --no-tags origin <branch>`, no terminal prompt, 10 s timeout); a failed fetch marks
// the read `fresh: false` and continues with the last-fetched ref. The file is read with
// `git show origin/<branch>:.harmony/project.yml` — never the working tree or the current branch, so a
// declaration that exists only on a feature branch is not read.
//
// Three distinct outcomes, each its own code path:
//   1. no repository's default branch carries the file, or none declares sections for this gate →
//      `{ kind: 'none' }`, and no warning at all (the brief is exactly today's);
//   2. nothing could be read (no conductor file and not inside a git repository, or every repository
//      skipped) → `{ kind: 'unreadable', detail }`;
//   3. a repository's `brief_sections` block is malformed → a warning naming the file and the problem,
//      and that repository's declarations are NOT enforced.
// Otherwise `{ kind: 'declared', repos, warnings }`; `repos` may be empty when only warnings remain.

import { execFile } from 'node:child_process';
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  PROJECT_MANIFEST_RELATIVE_PATH,
  parseBriefSections,
  type BriefSectionDeclaration,
  type BriefSectionGate,
} from './project-manifest.js';

export const FETCH_INTERVAL_MS = 60_000;
export const FETCH_TIMEOUT_MS = 10_000;

export interface GitResult {
  ok: boolean;
  stdout: string;
}

export interface BriefSectionsIO {
  cwd: () => string;
  existsSync: (path: string) => boolean;
  readFileSync: (path: string) => string;
  /** Run git with `args` in `cwd`. Never throws: a failure is `{ ok: false }`. */
  git: (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<GitResult>;
  now: () => number;
  /** Last fetch attempt per `<repository top>\0<branch>`: when, and whether it succeeded. */
  fetchLog: Map<string, { at: number; ok: boolean }>;
}

export interface DeclaredRepository {
  /** `owner/name` from the origin URL. */
  repository: string;
  /** The default-branch commit the declarations were read at (full SHA). */
  commit: string;
  /** False when this read's fetch failed and the last-fetched copy was used. */
  fresh: boolean;
  sections: BriefSectionDeclaration[];
}

export type BriefSectionDeclarations =
  | { kind: 'none' }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'declared'; repos: DeclaredRepository[]; warnings: string[] };

const processFetchLog = new Map<string, { at: number; ok: boolean }>();

function realGit(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? FETCH_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout) => done({ ok: !err, stdout: String(stdout ?? '') }),
    );
  });
}

export function defaultBriefSectionsIO(): BriefSectionsIO {
  return {
    cwd: () => process.cwd(),
    existsSync: nodeExistsSync,
    readFileSync: (p) => nodeReadFileSync(p, 'utf8'),
    git: realGit,
    now: () => Date.now(),
    fetchLog: processFetchLog,
  };
}

/** `owner/name` from a clone URL (https, ssh or scp-style), or null. */
export function repositoryFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = trimmed.match(/[/:]([^/:]+)\/([^/:]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

interface RepoCandidate {
  /** Where to look for the checkout locally. */
  path: string;
  /** How the repository is named in a warning before its origin is known. */
  label: string;
}

/** Find `.harmony/conductor.json` walking up from `start`; return its directory and repos. */
function findConductorRepos(io: BriefSectionsIO, start: string): { root: string; repos: RepoCandidate[] } | null {
  let directory = start;
  for (;;) {
    const file = join(directory, '.harmony', 'conductor.json');
    if (io.existsSync(file)) {
      let config: { repos?: Array<{ path?: unknown; meta_repo_role?: unknown }> };
      try {
        config = JSON.parse(io.readFileSync(file));
      } catch {
        return { root: directory, repos: [] };
      }
      const entries = Array.isArray(config.repos) ? config.repos : [];
      const meta = entries.find((e) => e && e.meta_repo_role === true && typeof e.path === 'string');
      const repos: RepoCandidate[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
        repos.push({ path: localRepoPath(io, directory, entry.path, meta?.path as string | undefined), label: entry.path });
      }
      return { root: directory, repos };
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** A `repos[].path` is the clone destination inside a worker container. Locally: use it when it exists;
 *  a relative path is relative to the conductor file's directory; an absolute path that does not exist
 *  here but sits inside the meta repository's path is mapped under the conductor file's directory. */
function localRepoPath(io: BriefSectionsIO, root: string, path: string, metaPath: string | undefined): string {
  if (!isAbsolute(path)) return resolve(root, path);
  if (io.existsSync(path)) return path;
  if (metaPath && isAbsolute(metaPath)) {
    const rel = relative(metaPath, path);
    if (rel === '') return root;
    if (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..')) return join(root, rel);
  }
  return path;
}

async function defaultBranch(io: BriefSectionsIO, top: string): Promise<string> {
  const head = await io.git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: top });
  const name = head.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  if (head.ok && name) return name;
  for (const candidate of ['main', 'master']) {
    const r = await io.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${candidate}`], { cwd: top });
    if (r.ok) return candidate;
  }
  return 'main';
}

/** At most one fetch a minute per repository and branch; returns whether the copy is fresh. */
async function quietFetch(io: BriefSectionsIO, top: string, branch: string): Promise<boolean> {
  const key = `${top}\0${branch}`;
  const last = io.fetchLog.get(key);
  if (last && io.now() - last.at < FETCH_INTERVAL_MS) return last.ok;
  const r = await io.git(['fetch', '--quiet', '--no-tags', 'origin', branch], { cwd: top, timeoutMs: FETCH_TIMEOUT_MS });
  io.fetchLog.set(key, { at: io.now(), ok: r.ok });
  return r.ok;
}

type RepoRead =
  | { kind: 'skipped'; warning: string }
  | { kind: 'absent' }
  | { kind: 'malformed'; warning: string }
  | { kind: 'read'; repository: string; commit: string; fresh: boolean; byGate: Partial<Record<BriefSectionGate, BriefSectionDeclaration[]>> };

async function readRepo(io: BriefSectionsIO, candidate: RepoCandidate): Promise<RepoRead> {
  const topR = io.existsSync(candidate.path)
    ? await io.git(['rev-parse', '--show-toplevel'], { cwd: candidate.path })
    : { ok: false, stdout: '' };
  if (!topR.ok) {
    return { kind: 'skipped', warning: `brief sections: ${candidate.label} is not a git checkout here; its declarations were not read` };
  }
  const top = topR.stdout.trim() || candidate.path;
  const origin = await io.git(['remote', 'get-url', 'origin'], { cwd: top });
  const repository = origin.ok ? repositoryFromUrl(origin.stdout) : null;
  if (!repository) {
    return { kind: 'skipped', warning: `brief sections: ${top} has no origin remote; its declarations were not read` };
  }
  const branch = await defaultBranch(io, top);
  const fresh = await quietFetch(io, top, branch);
  const ref = `refs/remotes/origin/${branch}`;
  const commitR = await io.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: top });
  if (!commitR.ok || !commitR.stdout.trim()) {
    return { kind: 'skipped', warning: `brief sections: ${repository} has no readable origin/${branch}; its declarations were not read` };
  }
  const commit = commitR.stdout.trim();
  const listed = await io.git(['ls-tree', '--name-only', commit, '--', PROJECT_MANIFEST_RELATIVE_PATH], { cwd: top });
  if (!listed.ok) {
    return { kind: 'skipped', warning: `brief sections: ${repository} origin/${branch} could not be listed; its declarations were not read` };
  }
  // Case 1: the default branch carries no project file. No warning at all.
  if (listed.stdout.trim() === '') return { kind: 'absent' };
  const shown = await io.git(['show', `${commit}:${PROJECT_MANIFEST_RELATIVE_PATH}`], { cwd: top });
  if (!shown.ok) {
    return { kind: 'skipped', warning: `brief sections: ${repository}'s ${PROJECT_MANIFEST_RELATIVE_PATH} on origin/${branch} could not be read` };
  }
  const file = `${repository}:${PROJECT_MANIFEST_RELATIVE_PATH} (origin/${branch} at ${commit.slice(0, 7)})`;
  let parsed: unknown;
  try {
    parsed = parseYaml(shown.stdout);
  } catch {
    // Only a file that mentions the key is worth a warning here; any other broken file is the
    // gate runner's to report, and this ticket must not add a warning to a project not using it.
    if (!/brief_sections/.test(shown.stdout)) return { kind: 'absent' };
    return { kind: 'malformed', warning: `${file}: brief_sections could not be read (invalid YAML); its sections are not enforced` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('brief_sections' in parsed)) {
    return { kind: 'read', repository, commit, fresh, byGate: {} };
  }
  // Case 3: a malformed block is named, never enforced.
  const result = parseBriefSections((parsed as Record<string, unknown>).brief_sections);
  if (!result.ok) {
    return { kind: 'malformed', warning: `${file}: ${result.problem}; its brief sections are not enforced` };
  }
  return { kind: 'read', repository, commit, fresh, byGate: result.byGate };
}

/** The declarations for one gate, across every repository of the project. Never throws. */
export async function readBriefSectionDeclarations(
  gate: BriefSectionGate,
  io: BriefSectionsIO = defaultBriefSectionsIO(),
): Promise<BriefSectionDeclarations> {
  try {
    const cwd = io.cwd();
    const conductor = findConductorRepos(io, cwd);
    let candidates: RepoCandidate[];
    if (conductor) {
      candidates = conductor.repos;
      if (candidates.length === 0) {
        // Conductor file without repos: fall back to the repository holding the conductor file.
        candidates = [{ path: conductor.root, label: conductor.root }];
      }
    } else {
      const top = await io.git(['rev-parse', '--show-toplevel'], { cwd });
      // Case 2: no conductor file and not inside a git repository.
      if (!top.ok || !top.stdout.trim()) {
        return { kind: 'unreadable', detail: 'no .harmony/conductor.json was found and the working directory is not inside a git repository' };
      }
      candidates = [{ path: top.stdout.trim(), label: top.stdout.trim() }];
    }

    const warnings: string[] = [];
    const repos: DeclaredRepository[] = [];
    let readable = 0;
    // Read every repository at once (each fetch may wait up to its limit), then fold the results in
    // the conductor file's order so repositories and warnings keep that order.
    const reads = await Promise.all(candidates.map((candidate) => readRepo(io, candidate)));
    for (const r of reads) {
      if (r.kind === 'skipped') {
        warnings.push(r.warning);
        continue;
      }
      readable += 1;
      if (r.kind === 'malformed') warnings.push(r.warning);
      else if (r.kind === 'read') {
        const sections = r.byGate[gate];
        if (sections && sections.length > 0) repos.push({ repository: r.repository, commit: r.commit, fresh: r.fresh, sections });
      }
    }
    // Case 2: every repository was skipped.
    if (readable === 0) {
      return { kind: 'unreadable', detail: warnings.join('; ') || 'no repository could be read' };
    }
    if (repos.length === 0 && warnings.length === 0) return { kind: 'none' };
    return { kind: 'declared', repos, warnings };
  } catch (err: unknown) {
    return { kind: 'unreadable', detail: `the declarations could not be read (${(err as Error)?.message ?? String(err)})` };
  }
}

/** True when at least one section is enforced for this gate. */
export function hasEnforcedSections(d: BriefSectionDeclarations): d is Extract<BriefSectionDeclarations, { kind: 'declared' }> {
  return d.kind === 'declared' && d.repos.some((r) => r.sections.length > 0);
}
