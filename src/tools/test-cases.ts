import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

// Single source of truth for the DB constraint:
//   type TEXT NOT NULL CHECK (type IN ('unit','e2e','integration'))
export const TEST_CASE_TYPES = ['unit', 'e2e', 'integration'] as const;
export type TestCaseType = (typeof TEST_CASE_TYPES)[number];

export const listTestCasesTool = {
  name: 'list_test_cases',
  description: 'List test cases for a task',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
    },
    required: ['task_id'],
  },
};

export async function listTestCases(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client
    .from('test_cases')
    .select('id, name, type, position, created_by, created_at')
    .eq('task_id', resolvedId)
    .order('position', { ascending: true });
  if (error) throw error;
  return data;
}

export const manageTestCasesTool = {
  name: 'manage_test_cases',
  description: 'Add, update, or delete test cases on a task. Supports batch operations.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
      add: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Test case name' },
            type: {
              type: 'string',
              enum: [...TEST_CASE_TYPES],
              description: 'Test case kind — one of: unit | e2e | integration',
            },
          },
          required: ['name', 'type'],
        },
        description: 'Test cases to add (appended in order)',
      },
      update: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Test case UUID' },
            name: { type: 'string', description: 'New name' },
            type: {
              type: 'string',
              enum: [...TEST_CASE_TYPES],
              description: 'New test case kind — one of: unit | e2e | integration',
            },
          },
          required: ['id'],
        },
        description: 'Test cases to update',
      },
      delete: {
        type: 'array',
        items: { type: 'string' },
        description: 'Test case UUIDs to delete',
      },
    },
    required: ['task_id'],
  },
};

export async function manageTestCases(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: {
    task_id: string;
    add?: { name: string; type?: string }[];
    update?: { id: string; name?: string; type?: string }[];
    delete?: string[];
  },
) {
  // The schema `enum` isn't enforced by all MCP clients, and this handler is the
  // shared core for MCP + CLI. Guard the type against the DB constraint up front so
  // callers get a clear error instead of a raw Postgres 23514/23502.
  const assertValidType = (type: unknown) => {
    if (type === undefined || !TEST_CASE_TYPES.includes(type as TestCaseType)) {
      throw new Error(
        `manage_test_cases: invalid type ${JSON.stringify(type)} — must be one of: ${TEST_CASE_TYPES.join(', ')}`,
      );
    }
  };

  // Validate every add row BEFORE any DB call (fail fast — nothing partially inserted).
  if (args.add) {
    for (const item of args.add) assertValidType(item.type);
  }

  const resolvedTaskId = await resolveTaskId(client, projectId, args.task_id);
  const results: { added: any[]; updated: any[]; deleted: string[] } = {
    added: [],
    updated: [],
    deleted: [],
  };

  // Get current max position for appending
  let maxPosition = -1;
  if (args.add && args.add.length > 0) {
    const { data: existing } = await client
      .from('test_cases')
      .select('position')
      .eq('task_id', resolvedTaskId)
      .order('position', { ascending: false })
      .limit(1);
    maxPosition = existing?.[0]?.position ?? -1;
  }

  // Add test cases
  if (args.add && args.add.length > 0) {
    const rows = args.add.map((item, i) => ({
      task_id: resolvedTaskId,
      name: item.name,
      type: item.type,
      position: maxPosition + 1 + i,
      created_by: userId,
    }));
    const { data, error } = await client
      .from('test_cases')
      .insert(rows)
      .select();
    if (error) throw error;
    results.added = data ?? [];
  }

  // Update test cases
  if (args.update && args.update.length > 0) {
    for (const item of args.update) {
      const { id, ...updates } = item;
      const payload: Record<string, any> = {};
      if (updates.name !== undefined) payload.name = updates.name;
      if (updates.type !== undefined) {
        assertValidType(updates.type);
        payload.type = updates.type;
      }
      if (Object.keys(payload).length === 0) continue;

      const { data, error } = await client
        .from('test_cases')
        .update(payload)
        .eq('id', id)
        .eq('task_id', resolvedTaskId)
        .select()
        .single();
      if (error) throw error;
      results.updated.push(data);
    }
  }

  // Delete test cases
  if (args.delete && args.delete.length > 0) {
    const { error } = await client
      .from('test_cases')
      .delete()
      .in('id', args.delete)
      .eq('task_id', resolvedTaskId);
    if (error) throw error;
    results.deleted = args.delete;
  }

  return results;
}
