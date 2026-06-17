import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTrustLevel, type TrustLevel } from './trust-model.js';

export const getProjectTool = {
  name: 'get_project',
  description: 'Get project details including workflow mode (manual|opinionated), statuses, field definitions, epics, and the owning workspace\'s agent-trust dial (level + safety-rail overrides).',
  inputSchema: { type: 'object' as const, properties: {} },
};

// Columns selected from `projects`, plus the owning-workspace `agent_trust` jsonb via an embed.
// The dial is a WORKSPACE-level setting, but the MCP server is PROJECT-scoped, so we surface the
// project's own owning workspace's `agent_trust` through get_project (no separate workspace query).
const PROJECT_COLS =
  'id, name, key, description, mode, custom_statuses, field_definitions, archived, workspace:workspaces!projects_workspace_id_fkey(agent_trust)';

interface AgentTrustResolved {
  // The dial's effective level (mirrors web trustModel.ts); empty `{}` jsonb => 'balanced'.
  level: TrustLevel;
  // The raw safety-rail overrides as stored (empty when the dial uses all defaults).
  overrides: Record<string, unknown>;
}

// The shape consumers (CLI, resolve-task-id) depend on: the project columns + the resolved dial.
// Index signature keeps dynamic field access (e.g. field_definitions) working as before.
type ProjectWithTrust = {
  id: string;
  name: string;
  key: string;
  description: string | null;
  mode: string;
  custom_statuses: unknown;
  field_definitions: unknown;
  archived: boolean;
  agent_trust: AgentTrustResolved;
  [k: string]: unknown;
};

export async function getProject(client: SupabaseClient, projectId: string): Promise<ProjectWithTrust> {
  const { data, error } = await client
    .from('projects')
    .select(PROJECT_COLS)
    .eq('id', projectId)
    .single();
  if (error) throw error;

  // The embed returns the owning workspace as either an object or a single-element array depending
  // on PostgREST's FK introspection; normalize, then resolve the dial to its effective level.
  const row = data as unknown as Record<string, unknown> & {
    workspace?: { agent_trust?: unknown } | { agent_trust?: unknown }[] | null;
  };
  const ws = Array.isArray(row.workspace) ? row.workspace[0] : row.workspace;
  const rawTrust = (ws?.agent_trust ?? {}) as { level?: unknown; overrides?: Record<string, unknown> };

  const agent_trust: AgentTrustResolved = {
    level: resolveTrustLevel(rawTrust),
    overrides: (rawTrust.overrides ?? {}) as Record<string, unknown>,
  };

  // Strip the raw embed and surface a clean, resolved `agent_trust` field.
  const { workspace: _workspace, ...project } = row;
  return { ...project, agent_trust } as unknown as ProjectWithTrust;
}
