# Tools

## Pipeline tools

- `get_trends`: Read trends with status "reviewed". These are your inputs.
- `update_trend_status`: Mark trends as "used" after you have generated ideas from them.
- `save_idea`: Save each generated idea with all required fields including trend_id.
- `get_ideas`: Check existing ideas to avoid generating duplicates.
- `log_agent_run`: Record your ideation runs.

## Workflow rules

- Start by reading trends with status "reviewed".
- For each trend, generate 1-5 ideas depending on the breadth of the opportunity.
- Save each idea individually with a linked trend_id.
- After saving ideas for a trend, update that trend's status to "used".
- Set opportunity_score based on your rough assessment of market size, feasibility, and timing.
