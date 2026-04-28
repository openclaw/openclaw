# Watch Ceviz PRD: Apple Watch V1

## Product Vision

Watch Ceviz V1 is an Apple Watch-first, Gemini-led orchestration remote. It is not a general-purpose trivia assistant; it is a specialized, low-friction wrist interface for triggering, monitoring, and controlling OpenClaw/ACP agents.

## Core V1 Scope Boundaries

- **In Scope:** Push-to-talk agent dispatch, real-time agent status list, lightweight intervention (stop/summarize), and strict handoffs to the iPhone for complex output.
- **Out of Scope:** Multi-turn conversational voice mode, rendering code/diffs/logs on the wrist, creating new agent configurations from the watch.

## Component Split

- **Apple Watch App (The Remote):** Ultra-thin client. Handles push-to-talk audio capture, renders 1-2 sentence text/voice responses, displays a simple list of active/recent agent sessions, and provides 1-tap actions (Stop, Pause, Open on Phone).
- **iPhone Companion (The Bridge & Canvas):** Acts as the authentication bridge and secure tunnel to OpenClaw. Serves as the primary canvas for rich content (logs, diffs, code) handed off from the watch.
- **OpenClaw Backend (The Brain):** Handles STT/TTS routing, intent resolution, ACP job execution, and crucially, the **"Watch-Sized Summarization"** (compressing agent logs/results into < 200 character voice-friendly summaries).

## Top 4 Core User Flows

1. **Quick Status Check (Voice):**
   - _User:_ "Ceviz, did the SolidWorks extraction finish?"
   - _Watch:_ "Yes, it completed with 3 warnings. I've sent the details to your phone."
2. **Agent Dispatch (Voice):**
   - _User:_ "Run the Outlook daily triage."
   - _Watch:_ Shows a haptic confirmation and adds "Outlook Triage" to the active jobs list.
3. **Wrist-Based Intervention (Touch):**
   - _User:_ Opens the app, sees "Windows Bridge Build" is running longer than expected. Taps the job, selects "Summarize Progress".
   - _Watch:_ "It is currently compiling the C# interop layer, 60% done."
4. **Handoff for Approval (Push Notification):**
   - _Watch Notification:_ "Job 'Deploy Watch Ceviz' requires approval to push to production."
   - _User:_ Taps "Open on Phone" to review the deployment plan diff on the larger screen.

## Agent Monitoring & Control UX

To avoid heavy UI on the wrist, monitoring is strictly limited to:

- A flat list of recent/active jobs.
- States: `Queued`, `Running`, `Needs Input`, `Completed`, `Failed`.
- Detail View: Shows elapsed time, the last known 1-sentence state, and basic controls (`Stop`, `Summarize`, `Open on Phone`).

## Voice Reply vs. Phone Fallback Rules

- **Voice Reply Only:** If the agent's output or status can be accurately summarized by Gemini in 2 sentences or less, without losing critical context.
- **Phone Fallback (Hybrid):** If the output contains code, structured data, lists longer than 3 items, or requires detailed user review (like a PR diff). The watch will speak a 1-sentence summary (e.g., "The script failed with a syntax error") and immediately push a deep-link notification to the iPhone companion app.
