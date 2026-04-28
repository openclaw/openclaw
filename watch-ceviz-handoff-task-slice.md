# Watch Ceviz Task Slice: Deep-link + Rich Phone Report + Handoff

This is the next product-grade slice after the current watch summary / jobs groundwork.

## Objective

Make the watch-to-phone transition feel intentional and trustworthy.

In V1 terms:

- watch stays short
- phone becomes the depth / approval / recovery surface
- backend decides when handoff is required

## Scope

### In

- `requires_phone_handoff` decision path
- phone deep-link routing to a job detail screen
- rich phone report model and renderer
- watch "Open on Phone" action
- optional automatic push / handoff nudge when phone is required

### Out

- generic full chat on watch
- arbitrary long-form authoring on phone
- workflow builder
- desktop/admin surface

## User flow

1. User triggers or opens a job on watch.
2. Watch receives a short summary.
3. Backend marks the result as either:
   - watch-safe, or
   - `requires_phone_handoff = true`
4. If handoff is needed:
   - watch shows a short explanation
   - user taps `Open on Phone`, or phone gets a handoff push
5. Phone opens directly to the job detail view.
6. Phone renders a structured report with clear next actions.

## Data contract

### Minimal handoff shape

```json
{
  "job_id": "job_123",
  "summary_text": "Deploy failed on staging.",
  "requires_phone_handoff": true,
  "handoff_reason": "logs_and_multiple_actions",
  "deep_link": "ceviz://job/job_123",
  "report_meta": {
    "title": "Deploy Failure",
    "status": "failed",
    "severity": "high"
  },
  "preview_sections": [{ "type": "bullets", "title": "Why it matters" }],
  "report_sections": [
    { "type": "markdown", "title": "Summary", "content": "..." },
    { "type": "code", "title": "Key log excerpt", "content": "..." }
  ],
  "next_actions": [
    { "id": "retry", "label": "Retry deploy" },
    { "id": "open_logs", "label": "Open full logs" }
  ]
}
```

## Backend tasks

### 1. Handoff classifier

Add deterministic rules for `requires_phone_handoff`.

Trigger handoff when:

- logs or code are present
- answer length exceeds watch budget
- approval is required
- confidence is low
- more than 3 actions exist
- failure needs diagnosis

### 2. Report formatter

Produce:

- `report_meta`
- `preview_sections`
- `report_sections`
- `next_actions`

### 3. Deep-link payload generation

Backend always returns canonical job deep-link:

- `ceviz://job/{id}`

## iPhone tasks

### 1. Deep-link handler

Implement:

- `ceviz://job/{id}`

Behavior:

- app opens directly to the matching job detail screen
- if data is stale, app refreshes from backend first

### 2. Rich job detail screen

Render:

- title / status / severity
- summary block
- section list
- code / logs viewer
- next-action buttons
- retry / approval / continue affordances when present

### 3. Recovery states

Handle:

- deep-link points to missing job
- phone offline
- backend refresh failed
- report partially available

## Watch tasks

### 1. Open-on-phone affordance

When `requires_phone_handoff = true`:

- show short explanation
- show `Open on Phone`
- keep summary tiny and readable

### 2. Handoff messaging copy

Examples:

- "Detay telefonda daha net."
- "Loglar uzun, telefonda açalım."
- "Onay gerekiyor, telefonda devam edelim."

## Acceptance criteria

- watch can open the correct job on phone in one tap
- phone opens into a usable rich report, not an empty placeholder
- backend handoff rules are deterministic and testable
- watch summary remains short even when phone handoff is required
- at least 2 demo scenarios work end-to-end

## Recommended build order

1. implement deep-link handler
2. define report payload contract
3. build phone detail renderer with stub data
4. wire backend report formatter
5. wire watch `Open on Phone`
6. add handoff push / nudge if still needed

## Demo targets for this slice

- failed deploy -> phone logs + retry
- PR summary -> phone risk notes + next action
- incident alert -> phone timeline + suggested action
