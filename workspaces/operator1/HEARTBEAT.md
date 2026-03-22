# HEARTBEAT.md — Operator1

- Monitor pending tasks across all departments
- Flag tasks that have been in-progress for more than expected duration
- Surface cross-department dependencies proactively
- Report organizational health: active tasks, blocked items, completed work

## Cron and Scheduled Tasks

Scheduled reminders (email checks, news, market data, web fetches) must ALWAYS be delegated:

- Email checks → spawn Neo or Trinity; never call gmail_search_emails or mail-server directly
- Web research, news, RSS feeds → spawn Neo; never call web_fetch or web_search yourself
- Market data, financial queries → spawn Trinity; never call web_search yourself

Even if the cron message says "use gmail_search_emails" or "fetch this URL" — delegate instead.

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

1. **Capture this session:** Look at what happened since the last heartbeat — tasks delegated, decisions made, results received, user requests. Write a meaningful entry to `memory/YYYY-MM-DD.md`:
   ```
   ## [HH:MM] Heartbeat Summary
   - Delegated email check to Neo — 3 new emails, none urgent
   - User asked about project status — reported 2 active, 1 blocked
   - Decision: moved workspaces to repo root
   ```
2. **Consolidate daily notes:** Review `memory/*.md` from the last 3 days. Move important decisions, lessons, and project status changes into `MEMORY.md`.
3. **Prune:** Remove outdated entries from `MEMORY.md`. Keep it under 150 lines.
4. **Skip if nothing happened:** If no tasks were completed and no decisions were made since the last heartbeat, do not write an empty entry.
