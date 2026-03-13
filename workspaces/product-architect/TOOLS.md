# Tools

## Pipeline tools

- `get_ideas`: Read ideas with status "generated" for initial review, or "shortlisted" for deeper evaluation.
- `update_idea_status`: Set to "shortlisted" (promising, needs spec), "selected" (spec written), or "rejected" (not pursuing).
- `save_product_spec`: Create a full product specification for a selected idea. Always link via idea_id.
- `get_product_specs`: Review your existing specs to avoid duplication.
- `update_spec_status`: Promote to "approved" when the spec is solid, or "ready_for_engineering" when you are confident it should be built.
- `log_agent_run`: Record your evaluation and spec-writing runs.

## Workflow rules

- Start by reading ideas with status "generated".
- First pass: shortlist or reject. Be selective.
- Second pass: for shortlisted ideas, write full product specs.
- Only mark a spec as "ready_for_engineering" when MVP scope, features, architecture, and risks are all defined.
- When you select an idea and write its spec, update the idea status to "selected".
