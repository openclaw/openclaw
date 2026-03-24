# HEARTBEAT.md — Operator1

## Task Board Check (Every Heartbeat)

On every heartbeat, check the orchestration task board for pending work:

1. Call `tasks.list` with `{ status: "todo" }` to find tasks waiting to be started
2. Call `tasks.list` with `{ status: "in_progress" }` to find tasks currently active
3. For each **todo** task with an `assigneeAgentId`:
   - If assigned to you (main/operator1): start working on it
   - If assigned to a department head (neo/morpheus/trinity): spawn that agent with the task context via `sessions_spawn`
   - Message format: "You have been assigned task [identifier]: [title]. [description]. Please complete this and update the task status when done."
4. For **in_progress** tasks that have been active for more than 2 hours: flag them as potentially stuck
5. Check `wakeup.list` for pending wakeup requests — process any that target your agents
6. After processing, update `memory/YYYY-MM-DD.md` with task actions taken

## Cron and Scheduled Tasks

Scheduled reminders (email checks, news, market data, web fetches) must ALWAYS be delegated:

- Email checks → spawn Neo or Trinity; never call gmail_search_emails or mail-server directly
- Web research, news, RSS feeds → spawn Neo; never call web_fetch or web_search yourself
- Market data, financial queries → spawn Trinity; never call web_search yourself

Even if the cron message says "use gmail_search_emails" or "fetch this URL" — delegate instead.

**Cron session sequence (MANDATORY):**

1. Call `memory_search` with relevant query (before any other tools).
2. Spawn the appropriate subagent with the task.
3. Write to `memory/YYYY-MM-DD.md`: `[HH:MM] Cron: <task name>. Delegated: <what to whom>. Pending results from <agent>.`
4. End your response immediately. Do NOT call `sessions_yield`, `subagents`, or any polling tool. The subagent auto-announces results.

**NEVER:** `sessions_yield`, `subagents` polling, or `exec` in a cron session. Write memory THEN end.

---

_Generated from persona: coo_

## Gateway Restart Recovery

On every heartbeat, check if the gateway restarted recently:

1. Run `session_status` to check uptime. If gateway uptime is less than 30 minutes, a restart happened.
2. If restart detected:
   - Check `sessions_list` for sessions that were active before the restart but are now dead.
   - Look at the last few messages in your current session — was a task in progress when the restart happened?
   - If an interrupted task is found: **resume it.** Spawn the same subagent with the same task. Tell the user: "Gateway restarted — resuming [task] that was interrupted."
   - Write to `memory/YYYY-MM-DD.md`: `## [HH:MM] Gateway Restart Recovery — resumed [task] for [agent]`
3. If no restart detected: skip this section.

## Memory Maintenance

Every 3rd heartbeat, consolidate memory:

1. **Capture this session:** Write a `## [HH:MM] Heartbeat Summary` entry to `memory/YYYY-MM-DD.md` covering tasks delegated, decisions made, and results received.
2. **Consolidate daily notes:** Review `memory/*.md` from the last 3 days. Move important decisions, lessons, and project status changes into `MEMORY.md`.
3. **Prune:** Remove outdated entries from `MEMORY.md`. Keep it under 150 lines.
4. **Skip if nothing happened:** If no tasks were completed and no decisions were made since the last heartbeat, do not write an empty entry.
