# Architecture Gap: Subagent Context Injection

**Date:** 2026-03-17
**Status:** Documented
**Priority:** Medium

---

## Issue

Subagent runs via `sessions_spawn` only receive `AGENTS.md` + `TOOLS.md` in their pre-loaded context. They do NOT receive:

- `MEMORY.md`
- `SOUL.md`
- `USER.md`
- `HEARTBEAT.md`
- `memory/` folder files

## Source

`~/dev/operator1/docs/tools/subagents.md` line 293:

> "Sub-agent context only injects `AGENTS.md` + `TOOLS.md` (no `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, or `BOOTSTRAP.md`)."

## Impact

Agents running as subagents don't automatically have their memory/persona loaded. They must actively fetch it via `memory_search` + `memory_get`.

## Workaround Applied

Updated all C-suite agent `AGENTS.md` files with explicit "FIRST ACTION" section:

```markdown
## ⚡ FIRST ACTION (Every Session - Including Subagent Runs)

**Before any work, load your memory via memory_search:**

memory_search(query: "relevant keywords", maxResults: 10)

Then use memory_get to pull specific files...
```

### Agents Updated

- [x] Trinity (CFO) — `~/.openclaw/workspace-trinity/AGENTS.md`
- [x] Neo (CTO) — `~/.openclaw/workspace-neo/AGENTS.md`
- [x] Morpheus (CMO) — `~/.openclaw/workspace-morpheus/AGENTS.md`

## Recommended Future Fix

Add config option to OpenClaw:

```json5
agents: {
  defaults: {
    subagents: {
      injectMemory: true,  // Also load MEMORY.md
      injectSoul: true,    // Also load SOUL.md
    }
  }
}
```

This would make subagent behavior consistent with the operator1 design intent: "All agents and subagents tier1 and tier2 should load their core content."

---

_Documented by Operator1_
