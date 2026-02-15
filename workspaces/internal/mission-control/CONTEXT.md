# Mission Control — CONTEXT

## Project
Mission Control is a local-first operations dashboard for managing work items and automation visibility.

Current state (Phase 1 / V1):
- Next.js app router UI with:
  - Realtime tasks view (SSE stream)
  - Local JSON persistence for tasks (no external DB)
  - Ops metrics endpoint (placeholder / local polling)

## Phase 2 goal
Add an app shell with left navigation and two new pages:
- **Goals**: Peter’s goals (local file)
- **Calendar**: scheduled jobs/cron tracking (local file)

## Constraints / non-goals (Phase 2)
- No external database.
- No actual cron execution.
- UI + local data models only.
- Must continue to work via LAN (192.168.5.0) and localhost.

## Data sources (Phase 2)
- Goals: `data/goals.json` (or `content/goals.json` — pick one; default to `data/`).
- Schedules: `data/schedules.json`.

## Navigation requirements
Persistent left-side nav with links:
- Dashboard (existing)
- Goals (new)
- Calendar (new)
- Any other existing pages (currently only Dashboard)
