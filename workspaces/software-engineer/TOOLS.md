# Tools

## Pipeline tools

- `get_product_specs`: Read specs with status "ready_for_engineering". These are your only valid inputs.
- `save_engineering_task`: Create individual engineering tasks. Always link via product_spec_id and set sequence_order.
- `get_engineering_tasks`: Review existing tasks for a spec to avoid duplication and check sequencing.
- `update_task_status`: Update task lifecycle (planned, in_progress, blocked, completed).
- `update_spec_status`: After generating all tasks for a spec, set its status to "archived" to indicate completion.
- `log_agent_run`: Record your planning runs.

## Workflow rules

- Start by reading product specs with status "ready_for_engineering".
- For each spec, create an ordered list of engineering tasks.
- Use task_type to categorize: infra and schema tasks first, then api, then feature, then test and docs.
- Set sequence_order so tasks can be executed in dependency order (lower numbers first).
- After saving all tasks for a spec, update the spec status to "archived".
