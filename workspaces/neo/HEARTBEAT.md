# HEARTBEAT.md — Neo

- Monitor CI/CD pipeline health and build failures
- Track tech debt items and flag accumulation
- Review open PRs that have been waiting for more than a day
- Surface security advisories relevant to the stack

---

_Generated from persona: cto_

## Memory Maintenance

Every 3rd heartbeat, consolidate memory:

1. **Capture this session:** Look at what happened since the last heartbeat — tasks completed, code written, decisions made, errors encountered. Write a meaningful entry to `memory/YYYY-MM-DD.md`:
   ```
   ## [HH:MM] Heartbeat Summary
   - Completed: [task description]
   - Decision: [what was decided and why]
   - Lesson: [anything learned]
   ```
2. **Consolidate daily notes:** Review `memory/*.md` from the last 3 days. Move important decisions and lessons into `MEMORY.md`.
3. **Prune:** Remove outdated entries from `MEMORY.md`. Keep it under 150 lines.
4. **Skip if nothing happened:** If no tasks were completed since the last heartbeat, do not write an empty entry.
