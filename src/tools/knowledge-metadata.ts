import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
export type KnowledgeScope = 'product' | 'deployment';
/** Only a positively missing capability permits legacy operations. Transport/auth errors propagate. */
export async function metadataCapable(
  client: SupabaseClient,
): Promise<boolean> {
  const { data, error } = await client.rpc('knowledge_metadata_capable');
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) return false;
    throw new Error(error.message);
  }
  if (data === true || data === false) return data;
  throw new Error(
    'Invalid knowledge metadata capability response; legacy fallback refused.',
  );
}
export async function metadataRpc(
  client: SupabaseClient,
  operation: string,
  scope: KnowledgeScope | undefined,
  args: Record<string, unknown>,
) {
  const capable = await metadataCapable(client);
  if (scope !== undefined && !['product', 'deployment'].includes(scope))
    throw new Error('scope must be product or deployment');
  if (scope !== undefined && !capable)
    throw new Error(
      'Knowledge scope unavailable until the schema is promoted; nothing was saved.',
    );
  if (
    capable &&
    (operation === 'knowledge_record_decision' ||
      operation === 'knowledge_supersede_knowledge_entry' ||
      (operation === 'knowledge_supersede_decision' && args.p_type)) &&
    !scope
  )
    throw new Error(
      'New knowledge requires product or deployment scope. Separate mixed claims.',
    );
  const result = await client.rpc(
    capable ? `${operation}_metadata` : operation,
    { ...args, ...(capable ? { p_scope: scope ?? null } : {}) },
  );
  if (result.error?.details)
    result.error.message += `\n${result.error.details}`;
  return result;
}
export async function listKnowledgeTags(
  client: SupabaseClient,
  projectId: string,
) {
  if (!(await metadataCapable(client)))
    throw new Error(
      'Project tag vocabulary unavailable until the schema is promoted.',
    );
  const { data, error } = await client.rpc('knowledge_list_tags', {
    p_project_id: projectId,
  });
  if (error) throw new Error(error.message);
  return data;
}
export async function registerKnowledgeTag(
  client: SupabaseClient,
  projectId: string,
  name: string,
  description: string,
) {
  if (!(await metadataCapable(client)))
    throw new Error(
      'Project tag vocabulary unavailable until the schema is promoted.',
    );
  const { data, error } = await client.rpc('knowledge_register_tag', {
    p_project_id: projectId,
    p_name: name,
    p_description: description,
  });
  if (error) throw new Error(error.message);
  return data;
}
/** Paths must come from verified PR files (including removed files), already repo-prefixed. */
export function surfaceTags(paths: string[]): string[] {
  return [
    ...new Set(
      paths
        .map((path) => path.replace(/^\.\//, ''))
        .filter(
          (path) =>
            /^[A-Za-z0-9_.-]+\//.test(path) &&
            !path.split('/').some((part) => part === '..' || part === ''),
        )
        .map((path) => `surface:${path.slice(0, path.lastIndexOf('/'))}`),
    ),
  ].sort();
}

export const listKnowledgeTagsTool = {
  name: 'list_knowledge_tags',
  description:
    'List the project authored tag vocabulary. Generated ticket/surface namespaces are reserved. Type is advisory.',
  inputSchema: { type: 'object', properties: {} },
};
export const registerKnowledgeTagTool = {
  name: 'register_knowledge_tag',
  description:
    'Explicitly register an authored project tag, separately from entry saves. Existing knowledge writers may register tags.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, description: { type: 'string' } },
    required: ['name', 'description'],
  },
};

/** Use the project's declared checkout name, keeping Harmony's own aliases out of product code.
 * Projects without a conductor declaration use the actual GitHub repository name. */
export function repositoryPrefix(repo: string): string {
  let directory = process.cwd();
  for (;;) {
    const file = join(directory, '.harmony', 'conductor.json');
    if (existsSync(file)) {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      const match = (config.repos ?? []).find((item: any) => {
        const name = String(item.url ?? '')
          .replace(/\.git$/, '')
          .replace(/^.*github\.com[/:]/, '');
        return name === repo || name.split('/').pop() === repo;
      });
      if (match) {
        const prefix = basename(match.path);
        if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(prefix))
          throw new Error('Invalid declared repository directory');
        return prefix;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const prefix = repo.split('/').pop()!;
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(prefix))
    throw new Error('Invalid repository prefix');
  return prefix;
}
