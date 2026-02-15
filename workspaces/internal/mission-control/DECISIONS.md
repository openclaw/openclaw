# Mission Control — DECISIONS

## 2026-02-15 — Phase 2 information architecture

Decision: Add a persistent **left navigation app shell** and split the UI into three primary routes:
- `/` — Dashboard (existing)
- `/goals` — Goals (local file)
- `/calendar` — Calendar / schedules (local file)

Rationale:
- Keeps Mission Control usable as it grows beyond a single dashboard.
- Creates a clean place to expand “2nd brain” and automation tracking without complicating the dashboard.

## 2026-02-15 — Data storage for Phase 2

Decision: Store Phase 2 data in local JSON files under `data/`:
- `data/goals.json`
- `data/schedules.json`

Rationale:
- Local-first, versionable, simple.
- Matches the Phase 1 approach (tasks stored locally).

## 2026-02-15 — Ticketing approach

Decision: Keep Phase 2 as **6–10 Antfarm-ready tickets**, with Ticket 1 being a **vertical slice**:
- Left nav + one new page + local data + build passes.

Non-goals:
- No cron execution.
- No external DB.
