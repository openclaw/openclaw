# Watch Ceviz V1 Execution Cut

This is the next concrete slice after `watch-ceviz-v1-productization.md`.

## Chosen First Wedge

Recommended first commercial wedge:

- **Developer / Operator Pack**

Why this wedge first:

- strongest fit with the current OpenClaw DNA
- easiest to demo with real urgency
- shortest path from watch trigger to clear business value
- avoids generic assistant positioning

V1 story:

- Trigger work from watch
- Get a reliable short summary
- Move to phone for approval, depth, and recovery

## V1 Cut: Must-have / Should-have / Later

### Must-have for V1

These are the minimum pieces that make the product feel real, not just like a prototype.

- stable push-to-talk trigger flow
- reliable active/recent jobs list
- summarize progress from watch
- cancel/stop from watch
- deterministic `requires_phone_handoff` rules
- open-on-phone deep-link flow
- structured phone report (`report_meta`, `preview_sections`, `report_sections`)
- iPhone rich detail screen for report reading
- reconnect / retry behavior across watch, phone, backend
- 2-3 repeatable demoable task flows

### Should-have shortly after V1 cutoff

These improve product feel, but should not block first product-grade demo.

- next action suggestions on phone
- approval / continue / retry cards on phone
- clearer job state history timeline
- task-pack-specific presets on watch
- better failure copy and recovery affordances

### Later

These are important, but they pull the product toward a broad assistant instead of a sharp V1.

- fully open multi-turn watch assistant
- long-form rendering directly on watch
- generic workflow builder
- separate web or desktop admin surface
- broad consumer assistant positioning

## Recommended Demo Scenarios

Use only scenarios that fit the watch -> phone -> backend model cleanly.

### Demo 1: Deploy / CI check

- watch: "latest deploy status"
- watch returns short summary
- if risky or failed, phone handoff opens rich report
- phone shows logs, failure reason, next action suggestion

### Demo 2: PR review snapshot

- watch: "summarize active PR"
- watch gives 1-sentence risk summary
- phone opens structured report with key files, risk notes, suggested next step

### Demo 3: Incident / alert triage

- watch receives or triggers alert summary
- watch speaks short status and severity
- phone opens incident report with timeline, logs, recommended action

## Product-grade Handoff Rules

Send to phone when any of these are true:

- output contains code or logs
- output exceeds watch-safe length
- action needs approval
- confidence is low
- there are more than 3 actionable items
- failure needs diagnosis, not just notification

Keep on watch when:

- status is simple
- answer fits in one sentence
- no approval is needed
- no rich review is needed

## Immediate Build Order

1. lock V1 cut around the must-have list above
2. polish iPhone handoff so it feels intentional, not fallback-ish
3. harden reconnect / retry behavior across the chain
4. package the first Developer / Operator demo flows end-to-end
5. only then add next-action and approval polish

## Working Rule

If a feature makes the watch feel like a tiny phone, it is probably not V1.
If a feature makes the watch a faster trigger/glance surface, it probably is.
