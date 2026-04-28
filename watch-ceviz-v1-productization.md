# Watch Ceviz V1 Productization Plan

## Product Positioning

Watch Ceviz is not a general-purpose assistant. It is an access layer to OpenClaw.

Core principle:

- Watch = low-friction trigger and glance surface
- iPhone = approval, detail, recovery, rich handoff surface
- OpenClaw = execution and orchestration layer

Short positioning line:

- Saatte kısa, telefonda derin, arkada gerçek iş.

## Ecosystem Model

Yes, this should be treated as a small ecosystem rather than a single watch app.

### User-facing apps in V1

1. Apple Watch app
2. iPhone companion app

### Operational components in V1

3. OpenClaw backend / agent control plane

So the product is likely:

- 2 user-visible apps
- 3 total product components

Not V1 by default:

- separate web app
- separate macOS app
- separate desktop console

Those can become V2+ surfaces if rich review or admin needs grow.

## Monetization Direction

Start with a prosumer / operator product, then expand via task packs.

### V1 monetization

- subscription product
- bundled Watch + iPhone companion + OpenClaw access workflows
- focus on high-value task packs rather than generic chat

### Recommended early packs

- Developer Pack: CI/CD, PR summaries, logs, deploy checks, approvals
- Executive Pack: inbox triage, calendar scan, follow-up prompts, meeting prep
- Ops Pack: alerts, summarize, approve/escalate, incident snapshots

## V1 Roadmap

### Pillar 1: Reliable access and handoff

Goal: make the watch feel dependable.

- push-to-talk command flow stable
- active jobs list reliable
- summarize / cancel / open-on-phone always reachable
- deterministic phone handoff rules
- robust reconnect / retry behavior between watch, phone, backend

### Pillar 2: Watch-safe payload design

Goal: keep the watch small on purpose.

- short voice/text summaries
- consistent report_meta / preview_sections payloads
- confidence-based handoff rules
- “this belongs on phone” classification quality

### Pillar 3: iPhone as the real work canvas

Goal: make handoff worth it.

- rich report screen
- next action cards
- approval / continue / retry actions
- clear state history for jobs

### Pillar 4: Focused task packs

Goal: avoid generic-assistant blur.

- choose 1-2 vertical packs first
- make each pack demoable end-to-end
- prefer trigger → summarize → handoff → continue flows

## Recommended V1 Scope

Include:

- voice trigger from watch
- active/recent jobs
- summarize progress
- cancel/stop
- open on phone
- structured phone report
- next action suggestions

Exclude from V1:

- fully open multi-turn assistant on watch
- long-form content rendering on watch
- fully user-programmable workflow builder
- broad consumer assistant positioning

## Recommended First Commercial Narrative

Watch Ceviz gives power users access to their personal agent workflows without needing to unlock the phone first.

Best-fit message:

- Trigger work from the watch
- Get a trustworthy summary fast
- Move to the phone only when depth or approval is needed

## Immediate Productization Loop

1. Freeze V1 positioning and scope
2. Pick first paid task pack wedge
3. Convert backlog into V1 must-have / should-have / later
4. Make iPhone handoff UX feel product-grade
5. Validate demo narrative with 2-3 repeatable scenarios
6. Only then expand surface area
