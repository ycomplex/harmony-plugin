import { getProjectTool, getProject } from './project.js';
import { listEpicsTool, listEpics, createEpicTool, createEpic, updateEpicTool, updateEpic } from './epics.js';
import { listTasksTool, listTasks, getTaskTool, getTask, createTaskTool, createTask, updateTaskTool, updateTask, bulkCreateTasksTool, bulkCreateTasks, } from './tasks.js';
import { listLabels, createLabel, listLabelsTool, createLabelTool } from './labels.js';
import { listSubtasksTool, listSubtasks, manageSubtasksTool, manageSubtasks } from './subtasks.js';
import { queryTasksTool, queryTasks } from './query-tasks.js';
import { listCommentsTool, listComments, addCommentTool, addComment } from './comments.js';
import { manageTaskLabelsTool, manageTaskLabels } from './task-labels.js';
import { bulkUpdateTasksTool, bulkUpdateTasks } from './bulk-update.js';
import { listActivityTool, listActivity } from './activity.js';
import { listMembersTool, listMembers } from './members.js';
import { listProjectDocumentsTool, listProjectDocuments, getProjectDocumentTool, getProjectDocument, createProjectDocumentTool, createProjectDocument, updateProjectDocumentTool, updateProjectDocument, } from './documents.js';
import { listMilestonesTool, listMilestones, createMilestoneTool, createMilestone, updateMilestoneTool, updateMilestone, shipMilestoneTool, shipMilestone, } from './milestones.js';
import { listCyclesTool, listCycles, createCycleTool, createCycle, updateCycleTool, updateCycle } from './cycles.js';
import { listAcceptanceCriteriaTool, listAcceptanceCriteria, manageAcceptanceCriteriaTool, manageAcceptanceCriteria } from './acceptance-criteria.js';
import { listTestCasesTool, listTestCases, manageTestCasesTool, manageTestCases } from './test-cases.js';
export function registerTools(disabledFeatures) {
    const tools = [
        // Core tools (always visible)
        getProjectTool, listTasksTool, getTaskTool, createTaskTool, updateTaskTool,
        bulkCreateTasksTool, bulkUpdateTasksTool, queryTasksTool,
        listCommentsTool, addCommentTool,
        listActivityTool,
        listMembersTool,
        listProjectDocumentsTool, getProjectDocumentTool, createProjectDocumentTool, updateProjectDocumentTool,
    ];
    if (!disabledFeatures?.epics)
        tools.push(listEpicsTool, createEpicTool, updateEpicTool);
    if (!disabledFeatures?.labels)
        tools.push(listLabelsTool, createLabelTool, manageTaskLabelsTool);
    if (!disabledFeatures?.subtasks)
        tools.push(listSubtasksTool, manageSubtasksTool);
    if (!disabledFeatures?.cycles)
        tools.push(listCyclesTool, createCycleTool, updateCycleTool);
    if (!disabledFeatures?.milestones)
        tools.push(listMilestonesTool, createMilestoneTool, updateMilestoneTool, shipMilestoneTool);
    if (!disabledFeatures?.acceptance)
        tools.push(listAcceptanceCriteriaTool, manageAcceptanceCriteriaTool, listTestCasesTool, manageTestCasesTool);
    return tools;
}
export async function handleToolCall(name, args, client, projectId, userId) {
    try {
        let result;
        switch (name) {
            case 'get_project':
                result = await getProject(client, projectId);
                break;
            case 'list_epics':
                result = await listEpics(client, projectId);
                break;
            case 'list_tasks':
                result = await listTasks(client, projectId, args);
                break;
            case 'get_task':
                result = await getTask(client, projectId, args);
                break;
            case 'create_task':
                result = await createTask(client, projectId, userId, args);
                break;
            case 'update_task':
                result = await updateTask(client, projectId, args);
                break;
            case 'bulk_create_tasks':
                result = await bulkCreateTasks(client, projectId, userId, args);
                break;
            case 'create_epic':
                result = await createEpic(client, projectId, userId, args);
                break;
            case 'update_epic':
                result = await updateEpic(client, projectId, args);
                break;
            case 'list_labels':
                result = await listLabels(client, projectId);
                break;
            case 'create_label':
                result = await createLabel(client, projectId, userId, args);
                break;
            case 'list_subtasks':
                result = await listSubtasks(client, projectId, args);
                break;
            case 'manage_subtasks':
                result = await manageSubtasks(client, projectId, userId, args);
                break;
            case 'query_tasks':
                result = await queryTasks(client, projectId, args);
                break;
            case 'list_comments':
                result = await listComments(client, projectId, args);
                break;
            case 'add_comment':
                result = await addComment(client, projectId, userId, args);
                break;
            case 'list_activity':
                result = await listActivity(client, projectId, args);
                break;
            case 'list_members':
                result = await listMembers(client, projectId);
                break;
            case 'manage_labels':
                result = await manageTaskLabels(client, projectId, args);
                break;
            case 'bulk_update_tasks':
                result = await bulkUpdateTasks(client, projectId, args);
                break;
            case 'list_project_documents':
                result = await listProjectDocuments(client, projectId);
                break;
            case 'get_project_document':
                result = await getProjectDocument(client, projectId, args);
                break;
            case 'create_project_document':
                result = await createProjectDocument(client, projectId, userId, args);
                break;
            case 'update_project_document':
                result = await updateProjectDocument(client, projectId, args);
                break;
            case 'list_milestones':
                result = await listMilestones(client, projectId, args);
                break;
            case 'create_milestone':
                result = await createMilestone(client, projectId, userId, args);
                break;
            case 'update_milestone':
                result = await updateMilestone(client, projectId, args);
                break;
            case 'ship_milestone':
                result = await shipMilestone(client, projectId, args);
                break;
            case 'list_cycles':
                result = await listCycles(client, projectId, args);
                break;
            case 'create_cycle':
                result = await createCycle(client, projectId, userId, args);
                break;
            case 'update_cycle':
                result = await updateCycle(client, projectId, args);
                break;
            case 'list_acceptance_criteria':
                result = await listAcceptanceCriteria(client, projectId, args);
                break;
            case 'manage_acceptance_criteria':
                result = await manageAcceptanceCriteria(client, projectId, userId, args);
                break;
            case 'list_test_cases':
                result = await listTestCases(client, projectId, args);
                break;
            case 'manage_test_cases':
                result = await manageTestCases(client, projectId, userId, args);
                break;
            default:
                return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        const message = err.message ?? 'Unknown error';
        if (message.includes('permission denied') || message.includes('RLS')) {
            return { content: [{ type: 'text', text: "You don't have access to this resource." }], isError: true };
        }
        if (message.includes('not found') || message.includes('no rows')) {
            return { content: [{ type: 'text', text: `Not found: ${message}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
}
//# sourceMappingURL=index.js.map