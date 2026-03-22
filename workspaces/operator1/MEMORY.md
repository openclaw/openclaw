# MEMORY.md - Long-Term Memory

---

## User Profile

- **Name:** Rohit Sharma
- **Telegram:** @Mast_g0g0
- **Location:** Waldkirch, 79183, Germany
- **Timezone:** Europe/Berlin (GMT+1)
- **Preferences:** Self-hosted over cloud, docs-first, concise responses

---

## OpenClaw Setup

- **Provider:** `zai/glm-5` | **Channel:** Telegram
- **Workspace:** `~/.openclaw/workspace/`
- **Projects:** `~/dev/operator1/Projects/`
- **Config:** `~/.openclaw/openclaw.json`

---

## Department Agents

| Agent    | Role | Department  |
| -------- | ---- | ----------- |
| Neo      | CTO  | Engineering |
| Morpheus | CMO  | Marketing   |
| Trinity  | CFO  | Finance     |

---

## QMD Memory System

- **Backend:** QMD v1.0.0 (3 GGUF models, ~2.2GB)
- **Critical:** Gateway needs explicit PATH in `~/.openclaw/.env` (doesn't inherit shell config)
- **Cold start:** First query may timeout; subsequent work fine
- **Verify:** `memory_search` returns `provider: "qmd"` with scores 0.88-0.93

---

## Key Lessons

1. **Email checking** — never use browser; use MCP tools only
2. **Verbosity** — user prefers short responses
3. **Skills check** — use `openclaw skills list` CLI, not filesystem search
4. **QMD PATH** — must be set in `.env`, not shell config
5. **Memory isolation** — sub-agents have separate memory contexts
6. **Progress reporting** — use `message()`, not `sessions_send()`
7. **Project scaffolding** — `projects.add` only registers; scaffold RPC needed separately
8. **Telegram images** — copy to workspace before processing
9. **NotebookLM** — use `infographic` type for visuals; `mind_map` is JSON-only
10. **Dirty git blocks gateway** — uncommitted changes prevent gateway restart; MCP tools can fail with module import errors

_Details archived in `memory/archive-2026-q1.md`_

---

## Pending

- [ ] Personal life management approach decision
- [ ] Consider adding second LLM provider as fallback
- [ ] Add WordPress credentials when ready for assisted publishing
- [ ] **AutoResearchClaw skill** — try when v0.2.0+ matures

---

_Last updated: 2026-03-22_
