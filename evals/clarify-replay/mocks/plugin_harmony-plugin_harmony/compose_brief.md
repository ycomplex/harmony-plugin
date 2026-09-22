---
type: fixed
expect:
  task_id: string
  reason: string
---
{
  "id": "mock-brief-00000000-0000-0000-0000-000000000001",
  "task_id": "{{input.task_id}}",
  "reason": "{{input.reason}}",
  "status": "active",
  "iteration": 1,
  "created_at": "2026-09-22T00:00:00.000Z"
}
