import type { SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  metadataCapable,
  surfaceTags,
  repositoryPrefix,
  type KnowledgeScope,
} from './knowledge-metadata.js';

interface PrEvidence {
  repo: string;
  number: number;
  paths: string[];
  unavailable?: string;
}
interface RepairEntry {
  id: string;
  fingerprint: string;
  title: string;
  content: string;
  current_scope: KnowledgeScope | null;
  reviewed: boolean;
  scope: KnowledgeScope | null;
  evidence: string[];
  state: 'proposed' | 'mixed' | 'uncertain';
  surfaces: string[];
  prs: PrEvidence[];
  tags_before: number;
}
export interface RepairManifest {
  version: 1;
  project_id: string;
  manifest_id: string;
  entries: RepairEntry[];
  counts: Record<string, number>;
}
/** GitHub is the authority for paths, including removed files. Never infer surfaces from prose. */
export function verifiedPrPaths(repo: string, number: number): PrEvidence {
  if (
    !/^[-\w]+\/[-\w.]+$/.test(repo) ||
    !Number.isSafeInteger(number) ||
    number < 1
  )
    throw new Error('Invalid PR identity');
  const pr = JSON.parse(
    execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'state,files,url',
      ],
      { encoding: 'utf8' },
    ),
  );
  if (pr.state !== 'MERGED') throw new Error(`PR ${pr.url} is not merged`);
  const prefix = repositoryPrefix(repo);
  // gh view has a 100-file ceiling on some versions. Use paginated REST for complete evidence.
  const pages = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${repo}/pulls/${number}/files`,
      '--jq',
      '.[].filename',
    ],
    { encoding: 'utf8' },
  );
  return {
    repo,
    number,
    paths: pages
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((p: string) => `${prefix}/${p}`),
  };
}
export async function previewMetadataRepair(
  client: SupabaseClient,
  projectId: string,
): Promise<RepairManifest> {
  if (!(await metadataCapable(client)))
    throw new Error('Metadata repair unavailable until schema promotion.');
  const { data, error } = await client.rpc('knowledge_metadata_preview', {
    p_project_id: projectId,
  });
  if (error) throw new Error(error.message);
  const entries: RepairEntry[] = [];
  for (const d of data ?? []) {
    const text = `${d.title}\n${d.content}`;
    const operations =
      /promote-prod|container\/|\.github\/workflows|staging.*(?:job|host)|\bdeployment\b/i.test(
        text,
      );
    const product = /\b(user|reader|author|product)\b/i.test(text);
    const prs: PrEvidence[] = [];
    const { data: refs, error: refsError } = await client
      .from('ticket_references_knowledge')
      .select('task_id')
      .eq('decision_id', d.id);
    if (refsError) throw new Error(refsError.message);
    const taskIds = [
      ...new Set([
        ...(d.source_task_id ? [d.source_task_id] : []),
        ...(refs ?? []).map((ref: any) => ref.task_id),
      ]),
    ];
    for (const taskId of taskIds) {
      const { data: task, error: taskError } = await client
        .from('tasks')
        .select('field_values')
        .eq('id', taskId)
        .eq('project_id', projectId)
        .maybeSingle();
      if (taskError) throw new Error(taskError.message);
      for (const ref of [
        task?.field_values?.build_pr,
        task?.field_values?.prerequisite_pr,
      ]) {
        const match = ref?.pr_url?.match(
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/,
        );
        if (
          !match ||
          prs.some(
            (pr) => pr.repo === match[1] && pr.number === Number(match[2]),
          )
        )
          continue;
        try {
          prs.push(verifiedPrPaths(match[1], Number(match[2])));
        } catch (e) {
          prs.push({
            repo: match[1],
            number: Number(match[2]),
            paths: [],
            unavailable: (e as Error).message,
          });
        }
      }
    }
    entries.push({
      id: d.id,
      fingerprint: d.fingerprint,
      title: d.title,
      content: d.content,
      current_scope: d.scope ?? null,
      reviewed: false,
      scope: d.scope ?? (operations && !product ? 'deployment' : null),
      evidence: operations
        ? [
            'Deployment path or operation mentioned; review the claim before assigning scope.',
          ]
        : [],
      state:
        operations && product ? 'mixed' : operations ? 'proposed' : 'uncertain',
      surfaces: surfaceTags(
        prs.filter((pr) => !pr.unavailable).flatMap((pr) => pr.paths),
      ),
      prs,
      tags_before: d.tags?.length ?? 0,
    });
  }
  return {
    version: 1,
    project_id: projectId,
    manifest_id: randomUUID(),
    entries,
    counts: {
      entries: entries.length,
      product_before: entries.filter((e) => e.current_scope === 'product')
        .length,
      deployment_before: entries.filter((e) => e.current_scope === 'deployment')
        .length,
      unresolved_before: entries.filter((e) => !e.current_scope).length,
      proposed: entries.filter((e) => e.scope).length,
      mixed: entries.filter((e) => e.state === 'mixed').length,
      uncertain: entries.filter((e) => e.state === 'uncertain').length,
      missing_pr: entries.filter((e) => !e.prs.some((pr) => !pr.unavailable))
        .length,
      tags_before: entries.reduce((n, e) => n + e.tags_before, 0),
    },
  };
}
export async function applyMetadataRepair(
  client: SupabaseClient,
  projectId: string,
  manifest: RepairManifest,
) {
  if (manifest.version !== 1 || manifest.project_id !== projectId)
    throw new Error('Manifest does not belong to this project');
  if (!(await metadataCapable(client)))
    throw new Error('Metadata repair unavailable until schema promotion.');
  const counts = {
    applied: 0,
    replayed: 0,
    skipped: 0,
    missing_pr: 0,
    tags_before: 0,
    tags_after: 0,
    product_after: 0,
    deployment_after: 0,
    unresolved_after: 0,
  };
  for (const item of manifest.entries) {
    if (!item.reviewed) {
      counts.skipped++;
      continue;
    }
    // Re-fetch evidence at apply: editable manifest paths are never trusted.
    const paths = item.prs
      .filter((pr) => !pr.unavailable)
      .flatMap((pr) => verifiedPrPaths(pr.repo, pr.number).paths);
    if (!paths.length) counts.missing_pr++;
    const { data, error } = await client.rpc(
      'knowledge_apply_metadata_repair',
      {
        p_project_id: projectId,
        p_manifest_id: manifest.manifest_id,
        p_entry_id: item.id,
        p_fingerprint: item.fingerprint,
        p_scope: item.scope,
        p_surface_tags: surfaceTags(paths),
      },
    );
    if (error) throw new Error(`${item.id}: ${error.message}`);
    if (data?.applied) {
      counts.applied++;
      counts.tags_before += data.tags_before ?? 0;
      counts.tags_after += data.tags_after ?? 0;
      if (data.scope === 'product') counts.product_after++;
      else if (data.scope === 'deployment') counts.deployment_after++;
      else counts.unresolved_after++;
    } else counts.replayed++;
  }
  return counts;
}
export async function tagReleasedKnowledge(
  client: SupabaseClient,
  projectId: string,
  taskId: string,
  repo: string,
  pr: number,
) {
  const evidence = verifiedPrPaths(repo, pr);
  const tags = surfaceTags(evidence.paths);
  const { data: refs, error } = await client
    .from('ticket_references_knowledge')
    .select('decision_id')
    .eq('task_id', taskId);
  if (error) throw new Error(error.message);
  let tagged = 0;
  for (const ref of refs ?? []) {
    const { data: rows, error: readError } = await client
      .from('knowledge_decisions')
      .select('id,tags')
      .eq('project_id', projectId)
      .eq('id', ref.decision_id);
    if (readError) throw new Error(readError.message);
    const entry = (rows ?? []).find((d: any) => d.id === ref.decision_id);
    if (!entry) continue;
    const { error: writeError } = await client.rpc(
      'knowledge_update_knowledge_entry',
      {
        p_project_id: projectId,
        p_entry_id: entry.id,
        p_tags: [...new Set([...(entry.tags ?? []), ...tags])],
      },
    );
    if (writeError) throw new Error(writeError.message);
    tagged++;
  }
  return { available: true, tagged, tags };
}
