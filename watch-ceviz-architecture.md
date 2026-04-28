# Watch Ceviz Architecture: Apple Watch V1

## Architectural Principles

1. **The Watch is Dumb, the Backend is Smart:** The Apple Watch does no local LLM processing or complex state management. It is purely a sensor (mic) and an actuator (speaker/screen).
2. **Aggressive Summarization Layer:** OpenClaw must implement a specific middleware that intercepts agent outputs and uses Gemini to compress them into "Watch-optimized" payloads (< 200 chars, plain text/SSML) before sending them over the wire.
3. **Deterministic Handoffs:** The decision to send data to the watch vs. the phone is made by the backend, not the client.

## Layer 1 — Apple Watch App (SwiftUI)

- **UI:** Push-to-talk button, minimalist `List` of agent sessions, basic `DetailView` with action buttons.
- **Audio:** Records PCM/AAC audio, streams/sends to Companion. Plays back TTS audio.
- **State:** Maintains a local, ephemeral cache of the agent list to ensure fast UI rendering. Receives push updates (via APNs or WatchConnectivity).

## Layer 2 — iPhone Companion App (Swift)

- **Role:** Secure proxy and rich display.
- **Connectivity:** Uses `WatchConnectivity` (WCSession) to pass audio and small JSON payloads between the Watch and the internet.
- **Rich Views:** Handles deep-links from the Watch (e.g., `ceviz://job/123/logs`) to render markdown, code blocks, and full agent threads.

## Layer 3 — OpenClaw / Ceviz Orchestrator (Backend)

- **Audio Processing:** Receives audio, pipes to STT (e.g., Whisper/Gemini Audio).
- **Intent Router:** Analyzes the transcript. If it's a command for an agent, it dispatches via ACP.
- **Watch Payload Formatter:** Crucial component. Takes raw ACP outputs and prompts Gemini: _"Summarize this result in 1 sentence suitable for a smartwatch audio response. If it contains code or complex data, flag 'requires_phone_handoff: true'."_
- **Push Controller:** Triggers silent pushes to the phone/watch to update the live agent list status.

## Data Flows

### A. The "Do Something" Flow

1. User holds PTT on Watch -> speaks command.
2. Watch sends audio -> iPhone -> OpenClaw.
3. OpenClaw STT -> Gemini interprets -> Triggers ACP Job.
4. OpenClaw returns immediate ACK -> iPhone -> Watch (shows "Started").

### B. The "Summarize In-Flight Job" Flow

1. User taps "Summarize" on a running job on Watch.
2. Watch sends request -> iPhone -> OpenClaw.
3. OpenClaw fetches tail of job logs -> Gemini compresses to 1 sentence.
4. OpenClaw returns text -> iPhone -> Watch.
5. Watch displays text and plays TTS.

### C. The "Complex Result" Flow

1. ACP Job finishes with a 50-line diff.
2. OpenClaw intercepts -> Gemini flags as `requires_phone_handoff`.
3. OpenClaw generates short summary: "Job complete, review the diff on your phone."
4. OpenClaw sends summary + deep-link -> iPhone.
5. iPhone forwards summary to Watch -> Watch plays TTS. iPhone generates local notification with the deep-link.
