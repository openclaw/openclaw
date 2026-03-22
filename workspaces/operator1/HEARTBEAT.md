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

## Memory Maintenance

Every 3rd heartbeat:

1. Check if memory/YYYY-MM-DD.md was written today. If not, write a brief summary of today's work.
2. Review memory/\*.md files from the last 3 days.
3. Update MEMORY.md with key decisions, remove outdated info.
4. Keep MEMORY.md under 150 lines.
