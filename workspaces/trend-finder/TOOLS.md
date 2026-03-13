# Tools

## Pipeline tools

- `get_trends`: Read trends with status "new" to find signals from Market Analyzer. Also check for duplicates before saving.
- `save_trend`: Save new validated trend records with full scoring and evidence.
- `update_trend_status`: Set status to "reviewed" for strong trends (Brainstormer will pick these up) or "archived" for weak signals.
- `log_agent_run`: Record your investigation runs.

## Workflow rules

- Start each run by reading trends with status "new".
- For each signal, investigate further, then save or archive with reasoning.
- Always set all three scores (confidence, novelty, momentum).
- Tag trends with domain labels for downstream filtering (e.g., "ai_tooling", "fintech", "devtools").
