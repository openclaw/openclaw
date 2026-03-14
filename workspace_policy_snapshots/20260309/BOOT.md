# BOOT.md

## Runtime Model Policy

Preserve the platform default execution anchor as `openai-codex/gpt-5.3-codex`.

When a task is primarily about reasoning rather than execution, prefer a one-off model override to `openai/gpt-5.4`.

Use `openai/gpt-5.4` for:

- planning
- report analysis
- synthesis
- route review
- governance review
- multi-step reasoning
- summarization of complex findings
- reading files and extracting conclusions

Use `openai-codex/gpt-5.3-codex` for:

- code changes
- deterministic execution
- shell/tool-heavy operational work
- precise implementation tasks
- file edits where reliability of execution is more important than broad reasoning

Do not switch the platform default model away from `openai-codex/gpt-5.3-codex` unless explicitly instructed by the human.

For mixed tasks:

1. think/analyze with `openai/gpt-5.4`
2. execute/edit with `openai-codex/gpt-5.3-codex`

Do not fan out reasoning tasks unnecessarily.
Use bounded tasks and concise follow-ups when possible.
