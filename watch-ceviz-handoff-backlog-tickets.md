# Watch Ceviz Handoff Backlog Tickets

This breaks `watch-ceviz-handoff-task-slice.md` into implementation tickets.

## P0, must-have for V1

### HC-01, Define handoff/report response contract

**Owner:** Backend
**Goal:** Freeze the payload shape for phone handoff and rich report rendering.

**Deliverables**

- `requires_phone_handoff`
- `handoff_reason`
- `deep_link`
- `report_meta`
- `preview_sections`
- `report_sections`
- `next_actions`

**Acceptance**

- stub JSON examples exist
- watch and phone can both consume the same response shape

---

### HC-02, Implement backend handoff classifier

**Owner:** Backend
**Status:** Done
**Goal:** Decide deterministically when the phone is required.

**Rules should include**

- code/log presence
- response too long for watch
- approval required
- low confidence
- too many next actions
- failure needs diagnosis

**Acceptance**

- classifier rules are deterministic
- test cases cover watch-safe vs phone-required outputs

---

### HC-03, Implement `ceviz://job/{id}` deep-link handler

**Owner:** iPhone
**Goal:** Open directly into the correct job detail screen.

**Acceptance**

- app opens from deep-link
- correct job screen resolves by id
- stale data triggers refresh
- missing job state is handled gracefully

---

### HC-04, Build rich phone job detail screen

**Owner:** iPhone
**Goal:** Render the report as a product-grade depth surface.

**UI blocks**

- title / status / severity
- summary
- preview sections
- full report sections
- code/log section rendering
- next-action buttons

**Acceptance**

- markdown renders cleanly
- code/log blocks remain readable
- empty/loading/error states exist

---

### HC-05, Wire watch `Open on Phone` action

**Owner:** Watch + iPhone
**Goal:** One-tap transition from watch to phone.

**Acceptance**

- watch shows `Open on Phone` only when appropriate
- tapping it lands on the correct phone screen
- copy stays short and watch-safe

---

### HC-06, Connect backend formatter to phone detail screen

**Owner:** Backend + iPhone
**Goal:** Replace stub data with real structured reports.

**Acceptance**

- phone renders backend-produced sections
- section ordering is stable
- malformed/missing optional sections fail gracefully

## P1, should-have soon after V1 cut

### HC-07, Add handoff push / nudge

**Owner:** Backend + iPhone + Watch
**Goal:** Prompt phone continuation when handoff is required.

**Acceptance**

- user gets a clear nudge when phone continuation matters
- notification does not spam on repeated refreshes

---

### HC-08, Add next-action buttons on phone

**Owner:** iPhone + Backend
**Goal:** Make reports actionable, not just readable.

**Acceptance**

- retry / continue / approve actions are visible when available
- unavailable actions are hidden or disabled intentionally

---

### HC-09, Improve recovery UX

**Owner:** iPhone + Watch
**Goal:** Clean handling for network problems and missing data.

**Acceptance**

- offline copy is clear
- retry path is obvious
- partial report state is still usable

## Suggested implementation order

1. HC-01
2. HC-03
3. HC-04 with stub data
4. HC-02
5. HC-06
6. HC-05
7. HC-07
8. HC-08
9. HC-09

## Best first demo path

- HC-01 -> HC-03 -> HC-04 -> HC-02 -> HC-06 -> HC-05

That sequence gets to the first product-grade watch-to-phone demo fastest.
