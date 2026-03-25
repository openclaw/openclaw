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

1. **Cross-agent session access** — requires both `tools.sessions.visibility=all` AND `tools.agentToAgent.enabled=true` (two separate configs)
2. **MCP configuration** — native MCP in OpenClaw, configured at `~/.openclaw/mcp/servers.yaml`; all MCP calls go through the gateway's native `mcp_search` tool (mcporter is fully deprecated and removed)
3. **Email checking** — never use browser; use MCP tools only
4. **Verbosity** — user prefers short responses
5. **Skills check** — use `openclaw skills list` CLI, not filesystem search
6. **QMD PATH** — must be set in `.env`, not shell config
7. **Memory isolation** — sub-agents have separate memory contexts
8. **Progress reporting** — use `message()`, not `sessions_send()`
9. **Project scaffolding** — `projects.add` only registers; scaffold RPC needed separately
10. **Telegram images** — copy to workspace before processing
11. **NotebookLM** — use `infographic` type for visuals; `mind_map` is JSON-only
12. **Dirty git blocks gateway** — uncommitted changes prevent gateway restart; MCP tools can fail with module import errors
13. **QMD search mode** — default is `search` (FTS/BM25), not `vsearch` (vector); configurable via `agents.*.memorySearch.qmd.searchMode`

_Details archived in `memory/archive-2026-q1.md`_

---

## Pending

### Active Blockers (Mar 23)

- [ ] **Interstellar email auth** — broken since Mar 21
- [ ] **LinkedIn InMail** — Jonathan Jowett, awaiting review since Mar 21
- [x] ~~MCP tools down~~ — ✅ Fixed (gateway restart Mar 23)

### Backlog

- [ ] **Task delegation polling** — Main agent polls sub-agents during heartbeats; timeout triggers follow-up
- [ ] Personal life management approach decision
- [ ] Consider adding second LLM provider as fallback
- [ ] Add WordPress credentials when ready for assisted publishing
- [ ] **AutoResearchClaw skill** — try when v0.2.0+ matures

---

_Last updated: 2026-03-24_
