---
type: fixed
expect:
  task_id: string
---
{
  "id": "{{input.task_id}}",
  "task_number": 0,
  "visual_id": "{{input.task_id}}",
  "title": "Users on the mobile viewport can't tell a saved filter from an ad-hoc one",
  "description": "The filter bar renders every saved filter and every ad-hoc (unsaved) filter combination identically once the viewport narrows below the tablet breakpoint — the desktop layout's distinguishing icon+label pairing collapses to icon-only, and both kinds share the same icon. A user reported applying what they believed was a saved team filter and instead re-running a one-off combination a teammate had left active. Scope this to the filter bar's mobile rendering only; the saved-filter CRUD flows themselves are unaffected.",
  "workflow_state": "Proposed",
  "workflow_activity": "clarifying",
  "field_values": {},
  "labels": [],
  "checklist_items": [],
  "acceptance_criteria": [],
  "test_cases": [],
  "attachments": [],
  "implements_entities": [],
  "awaiting_human_input": false,
  "awaiting_human_reason": null,
  "awaiting_human_ref": null,
  "pending_acceptance_event_id": null,
  "stale": false,
  "stale_ref": null,
  "parent_task_id": null,
  "archived": false,
  "subsumed_by_task_id": null,
  "conductor_excluded_at": null,
  "pending_resolution": null,
  "active_exchange": null,
  "pending_remark": null,
  "risk_classes": [],
  "active_brief_iteration": null,
  "knowledge_reference_count": 0
}
