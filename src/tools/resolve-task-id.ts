import type { SupabaseClient } from '@supabase/supabase-js';
import { getProject } from './project.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_NUMBER_RE = /^\d+$/;
const VISUAL_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

const PG_INT_MAX = 2_147_483_647;

export async function resolveTaskId(
  client: SupabaseClient,
  projectId: string,
  input: string,
): Promise<string> {
  // Fast path: UUID
  if (UUID_RE.test(input)) {
    return input;
  }

  let taskNumber: number;

  const bareMatch = BARE_NUMBER_RE.test(input);
  const visualMatch = input.match(VISUAL_ID_RE);

  if (bareMatch) {
    taskNumber = parseInt(input, 10);
  } else if (visualMatch) {
    const [, inputKey, numStr] = visualMatch;
    taskNumber = parseInt(numStr, 10);

    // Validate project key matches
    const project = await getProject(client, projectId);
    if (inputKey.toUpperCase() !== project.key.toUpperCase()) {
      throw new Error(
        `Task ${inputKey.toUpperCase()}-${taskNumber} not found — this token is scoped to project ${project.key}. Did you mean ${project.key}-${taskNumber}?`
      );
    }
  } else {
    throw new Error(
      `Invalid task identifier '${input}'. Use a UUID, task number (e.g., 43), or visual ID (e.g., B-43).`
    );
  }

  // Validate number range
  if (taskNumber <= 0 || taskNumber > PG_INT_MAX || !Number.isSafeInteger(taskNumber)) {
    throw new Error(
      `Invalid task number: ${input}. Must be between 1 and ${PG_INT_MAX}.`
    );
  }

  // Look up task by number
  const { data, error } = await client
    .from('tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('task_number', taskNumber)
    .single();

  if (error || !data) {
    throw new Error(`No task with number ${taskNumber} in this project`);
  }

  return data.id;
}

type Classified = { kind: 'uuid'; id: string } | { kind: 'number'; taskNumber: number };

export async function resolveTaskIds(
  client: SupabaseClient,
  projectId: string,
  inputs: string[],
): Promise<string[]> {
  // Classify and fully validate every input before touching the tasks table,
  // so bad input fails the same way it does in resolveTaskId (before any query).
  // The project is fetched at most once, only when a visual ID needs its key checked.
  const classified: Classified[] = [];
  let projectKey: string | undefined;

  for (const input of inputs) {
    if (UUID_RE.test(input)) {
      classified.push({ kind: 'uuid', id: input });
      continue;
    }

    let taskNumber: number;
    const visualMatch = input.match(VISUAL_ID_RE);

    if (BARE_NUMBER_RE.test(input)) {
      taskNumber = parseInt(input, 10);
    } else if (visualMatch) {
      const [, inputKey, numStr] = visualMatch;
      taskNumber = parseInt(numStr, 10);

      if (projectKey === undefined) {
        projectKey = (await getProject(client, projectId)).key as string;
      }
      if (inputKey.toUpperCase() !== projectKey.toUpperCase()) {
        throw new Error(
          `Task ${inputKey.toUpperCase()}-${taskNumber} not found — this token is scoped to project ${projectKey}. Did you mean ${projectKey}-${taskNumber}?`
        );
      }
    } else {
      throw new Error(
        `Invalid task identifier '${input}'. Use a UUID, task number (e.g., 43), or visual ID (e.g., B-43).`
      );
    }

    if (taskNumber <= 0 || taskNumber > PG_INT_MAX || !Number.isSafeInteger(taskNumber)) {
      throw new Error(
        `Invalid task number: ${input}. Must be between 1 and ${PG_INT_MAX}.`
      );
    }
    classified.push({ kind: 'number', taskNumber });
  }

  const neededNumbers = [
    ...new Set(classified.flatMap(c => (c.kind === 'number' ? [c.taskNumber] : []))),
  ];

  const idByNumber = new Map<number, string>();
  if (neededNumbers.length > 0) {
    const { data, error } = await client
      .from('tasks')
      .select('id, task_number')
      .eq('project_id', projectId)
      .in('task_number', neededNumbers);
    if (error) throw error;

    for (const row of data ?? []) idByNumber.set(row.task_number, row.id);

    const missing = neededNumbers.filter(n => !idByNumber.has(n));
    if (missing.length > 0) {
      throw new Error(`No task(s) with number(s) ${missing.join(', ')} in this project`);
    }
  }

  return classified.map(c => (c.kind === 'uuid' ? c.id : idByNumber.get(c.taskNumber)!));
}
