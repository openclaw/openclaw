# Neo — Engineering Memory

## Architecture Decisions

### 2026-03-04: Matrix Landing Page Stack

- **Context:** Landing page for Operator1 with Matrix theme and visitor counter
- **Decision:** Next.js (frontend) + Express.js + SQLite (backend)
- **Ports:** Backend 3001, Frontend 3000
- **Rationale:** Separation of concerns; SQLite for simple visitor counter persistence

## Tech Debt Register

<!-- No entries yet -->

## Active Projects

### Matrix Landing Page

- **Path:** `/Users/rohits/dev/operator1/matrix-landing`
- **Status:** Complete
- **Stack:** Next.js 14 (App Router), Express.js, SQLite
- **Features:**
  - Matrix digital rain animation (Canvas)
  - Visitor counter with API
  - Operator1 org structure content
  - Responsive design with Matrix theme
- **Notes:** Frontend directory is untracked

## Project Work Log

<!-- Tagged entries: [project-id] Task — Date -->
<!-- No entries yet -->

## Key Learnings

### ACP Session Management

- Always use unique labels with timestamp suffix to avoid "label already in use" errors
- ACP sessions run independently — they continue even if the spawning subagent times out
- If ACP fails, try ONE retry with fresh session and NEW unique label before escalating

## Completed Projects

<!-- No entries yet -->
