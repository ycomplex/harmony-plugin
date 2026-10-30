// B-1346: the owning workspace's model policy — `workspaces.model_policy jsonb`, shaped
// `{ "allowed_aliases": ["<offer>", ...] }`. A non-empty list restricts which catalog offers a run
// may name; anything else (no client, no row, a null policy, a missing or empty list, or the column
// being absent on this board) means NO restriction. Read the way project.ts reads `agent_trust`: an
// embed of the project's owning workspace, so a project-scoped token needs no workspace query.
//
// Tolerant like every other B-383 prod-before-promote reader: an undefined-column error (42703 /
// PGRST204, via isMissingCatalogColumnError) degrades to "unrestricted". Any other error propagates.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingCatalogColumnError } from './run-config.js';

export interface WorkspaceModelPolicy {
  /** The offers the workspace allows, as stored. Empty = no restriction. */
  allowed: string[];
}

const UNRESTRICTED = (): WorkspaceModelPolicy => ({ allowed: [] });

/** The model policy of `projectId`'s owning workspace. Throws only on a read error that is not a
 *  missing-column error. */
export async function getWorkspaceModelPolicy(
  client: SupabaseClient | null | undefined,
  projectId: string,
): Promise<WorkspaceModelPolicy> {
  if (!client) return UNRESTRICTED();
  const { data, error } = await client
    .from('projects')
    .select('workspace:workspaces!projects_workspace_id_fkey(model_policy)')
    .eq('id', projectId)
    .maybeSingle();
  if (error) {
    if (isMissingCatalogColumnError(error)) return UNRESTRICTED();
    throw new Error((error as { message?: string }).message ?? String(error));
  }
  // The embed arrives as an object or a single-element array depending on FK introspection.
  const row = data as { workspace?: unknown } | null;
  const ws = (Array.isArray(row?.workspace) ? row?.workspace[0] : row?.workspace) as
    | { model_policy?: unknown }
    | null
    | undefined;
  const policy = ws?.model_policy;
  if (!policy || typeof policy !== 'object') return UNRESTRICTED();
  const list = (policy as { allowed_aliases?: unknown }).allowed_aliases;
  if (!Array.isArray(list)) return UNRESTRICTED();
  const allowed = list.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return { allowed };
}
