import { proseTools, readProse, configureProse, setDefinedIn } from './knowledge-prose.js';
import { knowledgeNameTools, readKnowledgeNames, renameKnowledgeConcept, previewKnowledgeMerge, mergeKnowledgeConcepts } from './knowledge-names.js';
import { surfaceRecordTools, captureSurfaceRecord, readSurfaceRecords } from './surface-records.js';
import { featureAccountTools, createFeatureAccount, readFeatureAccounts, previewFeatureAmendment, proposeFeatureAmendment, applyFeatureAmendment } from './feature-accounts.js';
import { sourceTools, publishSourceInventory, readSourceInventory, comparePublishedCoverage } from './knowledge-sources.js';
import { saveKnowledgeQuestionTool, saveKnowledgeQuestion, previewKnowledgeQuestionsTool, previewKnowledgeQuestions, importKnowledgeQuestionsTool, importKnowledgeQuestions } from './knowledge-questions.js';
import { listKnowledgeTagsTool, registerKnowledgeTagTool, listKnowledgeTags, registerKnowledgeTag } from './knowledge-metadata.js';
import { setClaimContext, setClaimContextTool } from './claim-context.js';
import { publishDefinition, publishDefinitionTool, type PublishDefinitionArgs } from './knowledge-definitions.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getProjectTool, getProject } from './project.js';
import { listEpicsTool, listEpics, createEpicTool, createEpic, updateEpicTool, updateEpic } from './epics.js';
import {
  listTasksTool, listTasks,
  getTaskTool, getTask,
  createTaskTool, createTask,
  updateTaskTool, updateTask,
  bulkCreateTasksTool, bulkCreateTasks,
} from './tasks.js';
import { listLabels, createLabel, listLabelsTool, createLabelTool } from './labels.js';
import { listChecklistItemsTool, listChecklistItems, manageChecklistItemsTool, manageChecklistItems } from './checklist-items.js';
import { queryTasksTool, queryTasks } from './query-tasks.js';
import { searchTasksTool, searchTasks } from './search-tasks.js';
import { findRelatedTicketsTool, findRelatedTickets } from './find-related-tickets.js';
import { subsumeTaskTool, subsumeTask } from './subsume-task.js';
import { listCommentsTool, listComments, addCommentTool, addComment } from './comments.js';
import { manageTaskLabelsTool, manageTaskLabels } from './task-labels.js';
import { bulkUpdateTasksTool, bulkUpdateTasks } from './bulk-update.js';
import { listActivityTool, listActivity } from './activity.js';
import { listWorkflowTransitionsTool, listWorkflowTransitions } from './workflow-transitions.js';
import { listMembersTool, listMembers } from './members.js';
import {
  queryKnowledgeTool, queryKnowledge,
  searchTicketIntentsTool, searchTicketIntents,
  getKnowledgeEntryTool, getKnowledgeEntry,
  createKnowledgeEntryTool, createKnowledgeEntry,
  updateKnowledgeEntryTool, updateKnowledgeEntry,
  supersedeKnowledgeEntryTool, supersedeKnowledgeEntry,
  recordDecisionTool, recordDecision,
  supersedeDecisionTool, supersedeDecision,
  queryFactsTool, queryFacts,
  assertFactTool, assertFact,
  invalidateFactTool, invalidateFact,
  queryEntitiesTool, queryEntities,
  createEntityTool, createEntity,
  updateEntityTool, updateEntity,
  reconcileEntityTool, reconcileEntity,
} from './knowledge.js';
import {
  listMilestonesTool, listMilestones,
  createMilestoneTool, createMilestone,
  updateMilestoneTool, updateMilestone,
  shipMilestoneTool, shipMilestone,
} from './milestones.js';
import { listCyclesTool, listCycles, createCycleTool, createCycle, updateCycleTool, updateCycle } from './cycles.js';
import { listAcceptanceCriteriaTool, listAcceptanceCriteria, manageAcceptanceCriteriaTool, manageAcceptanceCriteria } from './acceptance-criteria.js';
import { listTestCasesTool, listTestCases, manageTestCasesTool, manageTestCases } from './test-cases.js';
import { listDependenciesTool, listDependencies, manageDependenciesTool, manageDependencies } from './dependencies.js';
import { listSubtasksTool, listSubtasks, listParentTool, listParent, manageSubtasksTool, manageSubtasks } from './decomposition.js';
import {
  composeBrief, composeBriefTool,
  getBrief, getBriefTool,
  listBriefs, listBriefsTool,
  resolveBrief, resolveBriefTool,
  reshapeBrief, reshapeBriefTool,
  consumeAcceptRemark, consumeAcceptRemarkTool,
} from './briefs.js';
import { flagReleaseApprovalPending, flagReleaseApprovalPendingTool } from './release-approval.js';
import { requestConductionReap, requestConductionReapTool } from './request-conduction-reap.js';
import { listConductions as listConductionsEntry, listConductionsTool } from './list-conductions.js';
import {
  startElicitationTool, startElicitation,
  fileElicitationRoundTool, fileElicitationRound,
  getElicitationTool, getElicitation,
  concludeElicitationTool, concludeElicitation,
  submitElicitationAnswersTool, submitElicitationAnswers,
} from './elicitation.js';
import {
  advanceWorkflowTool, advanceWorkflow,
  referenceKnowledgeTool, referenceKnowledge,
  listTicketKnowledgeTool, listTicketKnowledge,
  linkTicketEntitiesTool, linkTicketEntities,
} from './workflow.js';
import {
  downloadAttachmentTool, downloadAttachment,
  attachFileTool, attachFile,
} from './attachments.js';
import {
  getBuildEvidenceStatusTool, getBuildEvidenceStatus,
} from './evidence-status.js';
import {
  createConductionTool, createConduction as createConductionEntry,
} from './create-conduction.js';
import { projectAck } from './ack-projection.js';
import {
  consumePendingAcceptanceEventTool, consumePendingAcceptanceEventToolHandler,
  consumeAcceptanceEventTool, consumeAcceptanceEventToolHandler,
} from './acceptance-events.js';
import { writeGateSlotTool, writeGateSlotToolHandler } from './gate-slots.js';
import { recordTool, recordToolHandler } from './record-walk.js';

// B-692 Phase 2: the conduction record's shared-core accessors + canonical status axis. Deliberately
// NOT registered as an MCP tool and NOT wired into src/cli/commands/ — the future conductor daemon
// consumes these in-process, exactly as src/bin/poll.ts consumes getTask. Barrel export only.
// (B-758: createConduction/ActiveConductionExistsError/ConductorExcludedError/assertNotExcluded are
// ALSO consumed directly by the create_conduction MCP tool (create-conduction.ts) and by the CLI's
// `conduct` command — those import straight from conduction-record.js, not via this barrel; the
// re-export here remains for the daemon's in-process consumers.)
export {
  createConduction,
  getConduction,
  getActiveConduction,
  updateConduction,
  ActiveConductionExistsError,
  ConductionInsertDeniedError,
  ConductorExcludedError,
  assertNotExcluded,
  CONDUCTION_LIVE_STATUSES,
  CONDUCTION_HUMAN_OWNED_STATUSES,
  CONDUCTION_TERMINAL_STATUSES,
  CONDUCTION_STATUSES,
  CONDUCTION_PATCHABLE_FIELDS,
  isConductionLive,
  isConductionHumanOwned,
  isConductionTerminal,
  type ConductionRecord,
  type ConductionStatus,
  type ConductionPatch,
  type CreateConductionArgs,
} from './conduction-record.js';

// B-916: the per-INVOCATION leg-cost record's shared-core accessors + the claude-specific result
// parse. Same convention as conduction-record.js above — NOT registered as MCP tools, barrel export
// only. Their one consumer today is the CLI accessor (src/cli/commands/leg-cost.ts), which
// container/provision.sh calls between claude invocations; nothing in src/daemon/ imports either
// module, and nothing ever may (the B-718 agent-neutrality seam — see leg-cost-record.ts's header).
export {
  recordLegCost,
  listLegCosts,
  resolveLegCostContext,
  type LegCostRecord,
  type LegCostSource,
  type RecordLegCostArgs,
} from './leg-cost-record.js';

// B-720 (replacement capture): the per-leg WORKER-OUTPUT record's shared-core accessors. Same
// convention again — NOT registered as MCP tools, barrel export only. Two consumers: the CLI
// accessor (src/cli/commands/leg-output.ts), which container/provision.sh calls after every claude
// invocation to record `source='worker'` rows, and — for the launcher rows ONLY — src/daemon/
// scheduler.ts through an injected SchedulerDeps write. The daemon WRITES here and never reads:
// nothing it decides may depend on a byte of captured output (the B-718 agent-neutrality seam —
// see leg-output-record.ts's header).
export {
  recordLegOutput,
  listLegOutput,
  boundedTail,
  LEG_OUTPUT_TAIL_BYTES,
  type LegOutputRecord,
  type LegOutputSource,
  type RecordLegOutputArgs,
} from './leg-output-record.js';
export {
  parseClaudeResultJson,
  deriveCostUsd,
  resolveCost,
  resolvePricing,
  MODEL_PRICING,
  type ClaudeResultUsage,
  type ModelPricing,
  type ParsedClaudeResult,
} from './claude-result-parse.js';

export function registerTools(disabledFeatures?: Record<string, boolean>) {
  const tools = [
    ...featureAccountTools,
    ...surfaceRecordTools,
    // Core tools (always visible)
    getProjectTool, listTasksTool, getTaskTool, createTaskTool, updateTaskTool,
    bulkCreateTasksTool, bulkUpdateTasksTool, queryTasksTool, searchTasksTool,
    findRelatedTicketsTool, subsumeTaskTool,
    listCommentsTool, addCommentTool,
    listActivityTool,
    listWorkflowTransitionsTool,
    listMembersTool,
    ...proseTools, setClaimContextTool, ...sourceTools, saveKnowledgeQuestionTool, previewKnowledgeQuestionsTool, importKnowledgeQuestionsTool,
    listKnowledgeTagsTool, registerKnowledgeTagTool, publishDefinitionTool, ...knowledgeNameTools, queryKnowledgeTool, searchTicketIntentsTool, getKnowledgeEntryTool, createKnowledgeEntryTool, updateKnowledgeEntryTool, supersedeKnowledgeEntryTool,
    recordDecisionTool, supersedeDecisionTool, queryFactsTool, assertFactTool, invalidateFactTool, queryEntitiesTool,
    createEntityTool, updateEntityTool, reconcileEntityTool,
    composeBriefTool, getBriefTool, listBriefsTool, resolveBriefTool, reshapeBriefTool, consumeAcceptRemarkTool,
    flagReleaseApprovalPendingTool,
    startElicitationTool, fileElicitationRoundTool, getElicitationTool, concludeElicitationTool,
    submitElicitationAnswersTool,
    advanceWorkflowTool,
    referenceKnowledgeTool,
    listTicketKnowledgeTool,
    linkTicketEntitiesTool,
    getBuildEvidenceStatusTool,
    createConductionTool,
    listConductionsTool,
    requestConductionReapTool,
    consumePendingAcceptanceEventTool,
    consumeAcceptanceEventTool,
    writeGateSlotTool,
    recordTool,
  ];

  if (!disabledFeatures?.epics) tools.push(listEpicsTool, createEpicTool, updateEpicTool);
  if (!disabledFeatures?.labels) tools.push(listLabelsTool, createLabelTool, manageTaskLabelsTool);
  if (!disabledFeatures?.subtasks) tools.push(listChecklistItemsTool, manageChecklistItemsTool);
  if (!disabledFeatures?.cycles) tools.push(listCyclesTool, createCycleTool, updateCycleTool);
  if (!disabledFeatures?.milestones) tools.push(listMilestonesTool, createMilestoneTool, updateMilestoneTool, shipMilestoneTool);
  if (!disabledFeatures?.acceptance) tools.push(listAcceptanceCriteriaTool, manageAcceptanceCriteriaTool, listTestCasesTool, manageTestCasesTool);
  if (!disabledFeatures?.dependencies) tools.push(listDependenciesTool, manageDependenciesTool);
  if (!disabledFeatures?.decomposition) tools.push(listSubtasksTool, listParentTool, manageSubtasksTool);
  // B-449: attachment tools ship dark — present only when the attachments module
  // is on (workspaces.disabled_features.attachments !== true). Module-off ⇒ the
  // tools are absent from the list (not errored). Reuses the existing per-feature
  // gating path; get_task's attachment metadata is RLS/feature-scoped at the DB.
  if (!disabledFeatures?.attachments) tools.push(downloadAttachmentTool, attachFileTool);

  return tools;
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  client: SupabaseClient,
  projectId: string,
  userId: string,
) {
  try {
    let result: unknown;
    switch (name) {
      case 'get_project':
        result = await getProject(client, projectId);
        break;
      case 'list_epics':
        result = await listEpics(client, projectId);
        break;
      case 'list_tasks':
        result = await listTasks(client, projectId, args as any);
        break;
      case 'get_task':
        result = await getTask(client, projectId, args as any);
        break;
      case 'create_task':
        result = await createTask(client, projectId, userId, args as any);
        break;
      case 'update_task':
        result = await updateTask(client, projectId, args as any);
        break;
      case 'bulk_create_tasks':
        result = await bulkCreateTasks(client, projectId, userId, args as any);
        break;
      case 'create_epic':
        result = await createEpic(client, projectId, userId, args as any);
        break;
      case 'update_epic':
        result = await updateEpic(client, projectId, args as any);
        break;
      case 'list_labels':
        result = await listLabels(client, projectId);
        break;
      case 'create_label':
        result = await createLabel(client, projectId, userId, args as any);
        break;
      case 'list_checklist_items':
        result = await listChecklistItems(client, projectId, args as any);
        break;
      case 'manage_checklist_items':
        result = await manageChecklistItems(client, projectId, userId, args as any);
        break;
      case 'query_tasks':
        result = await queryTasks(client, projectId, args as any);
        break;
      case 'search_tasks':
        result = await searchTasks(client, projectId, args as any);
        break;
      case 'find_related_tickets':
        result = await findRelatedTickets(client, projectId, args as any);
        break;
      case 'subsume_task':
        result = await subsumeTask(client, projectId, args as any);
        break;
      case 'list_comments':
        result = await listComments(client, projectId, args as any);
        break;
      case 'add_comment':
        result = await addComment(client, projectId, userId, args as any);
        break;
      case 'list_activity':
        result = await listActivity(client, projectId, args as any);
        break;
      case 'list_workflow_transitions':
        result = await listWorkflowTransitions(client, projectId, args as any);
        break;
      case 'list_members':
        result = await listMembers(client, projectId);
        break;
      case 'manage_labels':
        result = await manageTaskLabels(client, projectId, args as any);
        break;
      case 'bulk_update_tasks':
        result = await bulkUpdateTasks(client, projectId, args as any);
        break;
      case 'capture_surface_record': result = await captureSurfaceRecord(client,projectId,args); break;
      case 'read_surface_records': result = await readSurfaceRecords(client,projectId,args); break;
      case 'create_feature_account': result = await createFeatureAccount(client,projectId,args); break;
      case 'read_feature_accounts': result = await readFeatureAccounts(client,projectId,args); break;
      case 'preview_feature_amendment': result = await previewFeatureAmendment(client,projectId,args); break;
      case 'propose_feature_amendment': result = await proposeFeatureAmendment(client,projectId,args); break;
      case 'apply_feature_amendment': result = await applyFeatureAmendment(client,projectId,args); break;
      case 'publish_source_inventory':
        result = await publishSourceInventory(client, projectId, args as any);
        break;
      case 'read_source_inventory':
        result = await readSourceInventory(client, projectId, args as any);
        break;
      case 'compare_source_coverage':
        result = await comparePublishedCoverage(client, projectId, args as any);
        break;
      case 'save_knowledge_question':
        result = await saveKnowledgeQuestion(client, projectId, args as any);
        break;
      case 'preview_knowledge_questions':
        result = await previewKnowledgeQuestions(client, projectId, args as any);
        break;
      case 'import_knowledge_questions':
        result = await importKnowledgeQuestions(client, projectId, args as any);
        break;
      case 'list_knowledge_tags':
        result = await listKnowledgeTags(client, projectId);
        break;
      case 'register_knowledge_tag':
        result = await registerKnowledgeTag(client, projectId, args.name as string, args.description as string);
        break;
      case 'read_prose_sources': result = await readProse(client, projectId, args.entry_ids as string[] | undefined); break;
      case 'configure_prose_source': result = await configureProse(client, projectId, args as any); break;
      case 'set_defined_in': result = await setDefinedIn(client, projectId, args as any); break;
      case 'set_claim_context':
        result = await setClaimContext(client, projectId, args as any);
        break;
      case 'read_concept_names':
        result = await readKnowledgeNames(client, projectId, args as any); break;
      case 'rename_concept':
        result = await renameKnowledgeConcept(client, projectId, args as any); break;
      case 'preview_concept_merge':
        result = await previewKnowledgeMerge(client, projectId, args as any); break;
      case 'merge_concepts':
        result = await mergeKnowledgeConcepts(client, projectId, args as any); break;

      case 'publish_definition':
        result = await publishDefinition(client, projectId, args as unknown as PublishDefinitionArgs);
        break;
      case 'query_knowledge':
        result = await queryKnowledge(client, projectId, args as any);
        break;
      case 'search_ticket_intents':
        result = await searchTicketIntents(client, projectId, args as any);
        break;
      case 'get_knowledge_entry':
        result = await getKnowledgeEntry(client, projectId, args as any);
        break;
      case 'create_knowledge_entry':
        result = await createKnowledgeEntry(client, projectId, userId, args as any);
        break;
      case 'update_knowledge_entry':
        result = await updateKnowledgeEntry(client, projectId, args as any);
        break;
      case 'supersede_knowledge_entry':
        result = await supersedeKnowledgeEntry(client, projectId, userId, args as any);
        break;
      case 'record_decision':
        result = await recordDecision(client, projectId, userId, args as any);
        break;
      case 'supersede_decision':
        result = await supersedeDecision(client, projectId, userId, args as any);
        break;
      case 'query_facts':
        result = await queryFacts(client, projectId, args as any);
        break;
      case 'assert_fact':
        result = await assertFact(client, projectId, userId, args as any);
        break;
      case 'invalidate_fact':
        result = await invalidateFact(client, projectId, args as any);
        break;
      case 'query_entities':
        result = await queryEntities(client, projectId, args as any);
        break;
      case 'create_entity':
        result = await createEntity(client, projectId, args as any);
        break;
      case 'update_entity':
        result = await updateEntity(client, projectId, args as any);
        break;
      case 'reconcile_entity':
        result = await reconcileEntity(client, projectId, args as any);
        break;
      case 'list_milestones':
        result = await listMilestones(client, projectId, args as any);
        break;
      case 'create_milestone':
        result = await createMilestone(client, projectId, userId, args as any);
        break;
      case 'update_milestone':
        result = await updateMilestone(client, projectId, args as any);
        break;
      case 'ship_milestone':
        result = await shipMilestone(client, projectId, args as any);
        break;
      case 'list_cycles':
        result = await listCycles(client, projectId, args as any);
        break;
      case 'create_cycle':
        result = await createCycle(client, projectId, userId, args as any);
        break;
      case 'update_cycle':
        result = await updateCycle(client, projectId, args as any);
        break;
      case 'list_acceptance_criteria':
        result = await listAcceptanceCriteria(client, projectId, args as any);
        break;
      case 'manage_acceptance_criteria':
        result = await manageAcceptanceCriteria(client, projectId, userId, args as any);
        break;
      case 'list_test_cases':
        result = await listTestCases(client, projectId, args as any);
        break;
      case 'manage_test_cases':
        result = await manageTestCases(client, projectId, userId, args as any);
        break;
      case 'list_dependencies':
        result = await listDependencies(client, projectId, args as any);
        break;
      case 'manage_dependencies':
        result = await manageDependencies(client, projectId, userId, args as any);
        break;
      case 'list_subtasks':
        result = await listSubtasks(client, projectId, args as any);
        break;
      case 'list_parent':
        result = await listParent(client, projectId, args as any);
        break;
      case 'manage_subtasks':
        result = await manageSubtasks(client, projectId, userId, args as any);
        break;
      case 'compose_brief':
        result = await composeBrief(client, projectId, userId, args as any);
        break;
      case 'get_brief':
        result = await getBrief(client, projectId, args as any);
        break;
      case 'list_briefs':
        result = await listBriefs(client, projectId, args as any);
        break;
      case 'resolve_brief':
        result = await resolveBrief(client, projectId, args as any);
        break;
      case 'reshape_brief':
        result = await reshapeBrief(client, projectId, args as any);
        break;
      case 'consume_accept_remark':
        result = await consumeAcceptRemark(client, projectId, args as any, userId);
        break;
      case 'consume_pending_acceptance_event':
        result = await consumePendingAcceptanceEventToolHandler(client, projectId, args as any);
        break;
      case 'consume_acceptance_event':
        result = await consumeAcceptanceEventToolHandler(client, args as any);
        break;
      case 'write_gate_slot':
        result = await writeGateSlotToolHandler(client, projectId, args as any);
        break;
      case 'record':
        result = await recordToolHandler(client, projectId, userId, args as any);
        break;
      case 'flag_release_approval_pending':
        result = await flagReleaseApprovalPending(client, projectId, args as any);
        break;
      case 'start_elicitation':
        result = await startElicitation(client, projectId, userId, args as any);
        break;
      case 'file_elicitation_round':
        result = await fileElicitationRound(client, projectId, args as any);
        break;
      case 'get_elicitation':
        result = await getElicitation(client, projectId, args as any);
        break;
      case 'conclude_elicitation':
        result = await concludeElicitation(client, projectId, args as any);
        break;
      case 'submit_elicitation_answers':
        result = await submitElicitationAnswers(client, projectId, args as any);
        break;
      case 'advance_workflow':
        result = await advanceWorkflow(client, projectId, args as any);
        break;
      case 'reference_knowledge':
        result = await referenceKnowledge(client, projectId, args as any);
        break;
      case 'list_ticket_knowledge':
        result = await listTicketKnowledge(client, projectId, args as any);
        break;
      case 'link_ticket_entities':
        result = await linkTicketEntities(client, projectId, args as any);
        break;
      case 'get_build_evidence_status':
        result = await getBuildEvidenceStatus(client, projectId, args as any);
        break;
      case 'create_conduction':
        result = await createConductionEntry(client, projectId, userId, args as any);
        break;
      case 'list_conductions':
        result = await listConductionsEntry(client, projectId, args as any);
        break;
      case 'request_conduction_reap':
        result = await requestConductionReap(client, args as any);
        break;
      case 'download_attachment':
        result = await downloadAttachment(client, args as any);
        break;
      case 'attach_file':
        result = await attachFile(client, projectId, args as any);
        break;
      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    // B-683: boundary-only mutation-ack projection (write tools stop echoing the caller-sent
    // record; reads pass through) + compact JSON for ALL tool results. Both apply ONLY at this
    // MCP boundary — the CLI and in-process callers use the handler functions directly and keep
    // full-fidelity results. Do NOT strip nulls: `pending_resolution: null` is the poll signal.
    return { content: [{ type: 'text' as const, text: JSON.stringify(projectAck(name, result, args)) }] };
  } catch (err: any) {
    const message = err.message ?? 'Unknown error';
    if (message.includes('permission denied') || message.includes('RLS')) {
      return { content: [{ type: 'text' as const, text: "You don't have access to this resource." }], isError: true };
    }
    if (message.includes('not found') || message.includes('no rows')) {
      return { content: [{ type: 'text' as const, text: `Not found: ${message}` }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
  }
}
