// B-1183: the two schema fragments that BOTH ~/.harmony/deployment.json (./deployment-config.ts) and the
// conductor project file (./conductor-config.ts) carry, defined once here. They cannot live in either of
// those modules: deployment-config.ts imports conductor-config.ts, so conductor-config.ts importing a value
// back from it would be an import cycle. Moved unchanged from deployment-config.ts.

import { z } from 'zod';

// B-801: declarative, OPTIONAL map of binaries each template invokes — one array per template,
// naming the tools src/daemon/preflight.ts's boot preflight resolves via `command -v` before ANY
// conduction runs. Declarative, NOT shell-parsed: launch/reap/probe are arbitrary `&&`-chained shell
// one-liners, so inferring "every invoked binary" from the string is undecidable in general — the
// profile author already knows what their own template runs (the same "config not constants"
// convention this daemon already applies to launch/reap/probe themselves, B-711).
export const RequiredToolsSchema = z
  .object({
    launch: z.array(z.string().min(1)).optional(),
    reap: z.array(z.string().min(1)).optional(),
    probe: z.array(z.string().min(1)).optional(),
  })
  .partial();

// --- repos: the ordered repo set a deployment declares (B-814) -----------------------------------
// Replaces the old fixed three-slot assumption (WEB_REPO/PLUGIN_REPO/WORKSPACE_REPO baked into
// container/entrypoint.sh) with an arbitrary, ordered list — a team with one repo (no meta-repo
// wrapper), or N repos, can express its own topology instead of being forced into the
// web+plugin+workspace shape. Absent `repos` (feature-detect), every consumer falls back UNCHANGED
// to today's three-slot env-var behavior — zero behavior change for every existing deployment.
//
// `meta_repo_role` marks the (at most one) entry that is the meta-repo/nesting parent — when
// present, that entry is cloned first and every other entry whose `path` falls inside it is cloned
// nested (preserving the CLAUDE.md-ancestry behavior: workspace first, children cloned inside).
// When no entry declares this role, every entry clones as a sibling.
//
// `is_plugin` marks the (at most one) entry that carries the plugin — provisioning is plugin code,
// so container/entrypoint.sh hands off to THAT entry's `container/provision.sh`. For that entry,
// `ref` is NOT read from `repos[].ref`: HARMONY_PLUGIN_POSTURE always supplies/overrides its clone
// ref (the existing posture knob, B-803) — `repos[].ref` governs only non-plugin entries, so it
// never becomes a second, competing ref-selection knob for the plugin repo.
export const RepoEntrySchema = z.object({
  /** Clone URL. */
  url: z.string().min(1),
  /** Clone ref. IGNORED for the is_plugin entry (see header comment) — HARMONY_PLUGIN_POSTURE wins
   *  there. Optional for every other entry; falls back to the container's existing "main" default. */
  ref: z.string().optional(),
  /** In-container clone destination, e.g. "/workspace/workspace/plugin". */
  path: z.string().min(1),
  /** Marks this entry as the meta-repo/nesting parent. At most one entry may set this. */
  meta_repo_role: z.boolean().optional(),
  /** Marks this entry as the one carrying the plugin. At most one entry may set this. */
  is_plugin: z.boolean().optional(),
});

export const ReposSchema = z
  .array(RepoEntrySchema)
  .refine((repos) => repos.filter((r) => r.meta_repo_role).length <= 1, {
    message: 'at most one repos[] entry may set meta_repo_role',
  })
  .refine((repos) => repos.filter((r) => r.is_plugin).length <= 1, {
    message: 'at most one repos[] entry may set is_plugin',
  });
