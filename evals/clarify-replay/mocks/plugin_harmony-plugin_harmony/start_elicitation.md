---
type: fixed
expect:
  task_id: string
  trigger: string
---
{
  "id": "mock-exchange-00000000-0000-0000-0000-000000000001",
  "task_id": "{{input.task_id}}",
  "trigger": "{{input.trigger}}",
  "status": "active",
  "rounds": []
}
