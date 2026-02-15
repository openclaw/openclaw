# Mission Control — TASKS

## Phase 2 — App Shell + Goals + Calendar (UI/data model only)

> Constraints: no external DB, no cron execution. Keep local-first JSON files.

### Ticket 1 (Vertical slice) — App shell nav + Goals page (hardcoded local data) + build passes
**Goal:** Prove the new layout + routing works end-to-end.
- Add persistent left nav (app shell)
  - Links: Dashboard, Goals, Calendar
- Add `/goals` page
  - Reads from a local JSON file (initially committed)
  - Renders a simple list: title + optional description
  - Include placeholders in UI (optional): status, priority, targetDate (non-functional)
- Add `data/goals.json` with initial goals:
  1) Create an income online through SaaS
  2) All those goals we discussed earlier (placeholder umbrella goal; can be expanded later)
- Ensure `npm run build` passes.

### Ticket 2 — Calendar page (schedules) + local schedules model
**Goal:** Provide a clear view of planned automation.
- Add `/calendar` page
- Add `data/schedules.json`
- Display per schedule:
  - name
  - schedule (human readable string)
  - description (what it does)
  - status: planned | active | paused
  - placeholders: lastRun, nextRun (display only, not computed)

### Ticket 3 — Shared UI components for layout + nav
**Goal:** Keep layout consistent and avoid duplication.
- Extract `AppShell` layout component (left nav + content)
- Extract `NavLink` component with active state
- Ensure responsive behaviour (collapsed/stacked on small screens acceptable)

### Ticket 4 — Goals data model v0.1 + validation
**Goal:** Future-proof without adding complexity.
- Define `Goal` TypeScript type in `src/lib/types.ts` (or new `src/lib/goals.ts`)
- Add minimal runtime validation for JSON load (fail gracefully with error state)

### Ticket 5 — Schedules data model v0.1 + validation
**Goal:** Same as goals.
- Define `Schedule` TypeScript type
- Minimal runtime validation + friendly error UI

### Ticket 6 — Dashboard link alignment + cleanup
**Goal:** Ensure Dashboard remains the default landing page.
- Confirm Dashboard route `/` unchanged
- Ensure nav highlights correct active link
- Update copy where needed (Dashboard header etc.)

### Ticket 7 — Documentation + screenshots
**Goal:** Make Phase 2 easy to understand.
- Update README with routes and data files
- Add one screenshot per page (optional) under `OUTPUT/`

### Ticket 8 — Dev port alignment (avoid Antfarm dashboard conflicts)
**Goal:** Ensure Mission Control can run alongside Antfarm dashboard without port clashes.
- Choose and document a default dev port that does **not** conflict with Antfarm dashboard.
- Update scripts/docs to support a configurable port (e.g. `PORT` env var or `--port`).
- Acceptance: both dashboards can be run concurrently without manual port hunting.

---

## Notes / Acceptance criteria
- App loads via:
  - Local: http://localhost:3000 (or next available port)
  - LAN: http://192.168.5.0 (reverse proxy origin allowed)
- No Antfarm execution in this phase; tickets must be ready to run later.
