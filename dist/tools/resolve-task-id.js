import { getProject } from './project.js';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_NUMBER_RE = /^\d+$/;
const VISUAL_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;
const PG_INT_MAX = 2_147_483_647;
export async function resolveTaskId(client, projectId, input) {
    // Fast path: UUID
    if (UUID_RE.test(input)) {
        return input;
    }
    let taskNumber;
    const bareMatch = BARE_NUMBER_RE.test(input);
    const visualMatch = input.match(VISUAL_ID_RE);
    if (bareMatch) {
        taskNumber = parseInt(input, 10);
    }
    else if (visualMatch) {
        const [, inputKey, numStr] = visualMatch;
        taskNumber = parseInt(numStr, 10);
        // Validate project key matches
        const project = await getProject(client, projectId);
        if (inputKey.toUpperCase() !== project.key.toUpperCase()) {
            throw new Error(`Task ${inputKey.toUpperCase()}-${taskNumber} not found — this token is scoped to project ${project.key}. Did you mean ${project.key}-${taskNumber}?`);
        }
    }
    else {
        throw new Error(`Invalid task identifier '${input}'. Use a UUID, task number (e.g., 43), or visual ID (e.g., B-43).`);
    }
    // Validate number range
    if (taskNumber <= 0 || taskNumber > PG_INT_MAX || !Number.isSafeInteger(taskNumber)) {
        throw new Error(`Invalid task number: ${input}. Must be between 1 and ${PG_INT_MAX}.`);
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
//# sourceMappingURL=resolve-task-id.js.map