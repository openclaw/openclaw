# Watch Ceviz Backlog: Apple Watch V1

## Productization Cut (aligned with V1 execution plan)

### Must-have for V1

- PTT-to-summary loop works reliably end-to-end
- watch-safe summarization exists and stays under tight size limits
- `requires_phone_handoff` routing is deterministic
- active/recent jobs are visible on watch
- watch can summarize progress and cancel/stop jobs
- phone deep-link opens the right job detail
- phone rich detail screen handles structured report/log output
- watch/phone/backend reconnect-retry path is trustworthy enough for demos

### Should-have soon after V1 cut

- automatic push when phone handoff is needed
- richer next-action / approval affordances on phone
- stronger haptics / recovery copy / failure UX
- better auth/session inheritance polish

### Later

- broad multi-turn assistant behavior on watch
- long-form reading on watch
- generic workflow builder / admin console

## IMMEDIATE PRIORITY: Executable Task Set - Slice 1 (PTT-to-Summary Loop)

_The thinnest, most concrete end-to-end slice. Focus is purely on proving the audio-in to audio-out pipeline. No complex UI, no database state, no real agent dispatch yet._

### Phase 0: Contracts (JSON)

_Dependency: None. Must be completed first._

- [x] **Task 0.1:** Define `WatchCommandRequest` (fields: `audio_data` base64 string, `format` e.g., "m4a").
- [x] **Task 0.2:** Define `WatchCommandResponse` (fields: `transcript` string, `summary_text` string < 200 chars, `tts_audio_data` base64 string).

### Phase 1: OpenClaw Backend (The Brain)

_Dependency: Phase 0. Can be built in parallel with iOS apps._

- [x] **Task 1.1:** Create a mock endpoint `POST /api/v1/watch/command` that accepts `WatchCommandRequest`.
- [x] **Task 1.2:** Implement STT integration (e.g., Whisper API) to decode the incoming audio into text.
- [x] **Task 1.3:** Implement the **Summarization Middleware**: Send the transcript to Gemini with a strict prompt: _"User said: [transcript]. Reply with a friendly, dummy agent status in 1 short sentence under 200 characters."_
- [x] **Task 1.4:** Implement TTS integration (e.g., OpenAI TTS or GCP) to convert the Gemini text into speech.
- [x] **Task 1.5:** Return the completed `WatchCommandResponse` containing the text and base64 audio.

### Phase 2: iPhone Companion (Dumb Proxy)

_Dependency: Phase 0. Requires basic iOS project setup._

- [x] **Task 2.1:** Scaffold iOS App and initialize `WCSession` (WatchConnectivity) in the `AppDelegate` or main App struct.
- [x] **Task 2.2:** Implement an `HTTP POST` client to forward audio data to the backend's `/api/v1/watch/command` endpoint.
- [x] **Task 2.3:** Implement the `WCSessionDelegate` `didReceiveMessageData` method. When audio data arrives from the Watch, pipe it to the HTTP client, await the response, and reply to the Watch using the reply handler.

### Phase 3: Apple Watch App (Client)

_Dependency: Phase 2 (for testing the bridge)._

- [x] **Task 3.1:** Scaffold watchOS App. Build a SwiftUI view with a single, large "Push to Talk" button and a `Text` element for the summary.
- [x] **Task 3.2:** Implement `AVAudioRecorder` to capture voice while the button is pressed (format: m4a/aac to save bandwidth).
- [x] **Task 3.3:** Upon button release, send the audio buffer to the iPhone using `WCSession.default.sendMessageData`.
- [x] **Task 3.4:** Handle the `WatchCommandResponse` data from the iPhone. Render `summary_text` to the UI and play `tts_audio_data` via `AVAudioPlayer`.

---

## Phase 1: Core Plumbing & Watch-Sized Summarization

_The foundation needed before the UI matters._

- [x] **Spike:** WatchConnectivity audio bridging (Watch -> Phone -> Backend).
- [ ] **Backend:** Implement the `WatchPayloadFormatter` in OpenClaw (prompting Gemini to compress agent outputs to <200 chars).
- [x] **Backend:** Implement the routing logic (`requires_phone_handoff` flag based on output complexity).
- [x] **Watch:** Basic PTT UI that can send audio and play back the resulting TTS/text summary.

## Phase 2: Agent Monitoring (Read-Only)

_Providing visibility into OpenClaw from the wrist._

- [x] **Backend:** Expose a lightweight `/api/v1/jobs/active` endpoint returning minimal JSON (ID, Name, Status).
- [x] **Watch:** Implement the `Agent Session List` view (auto-refreshing or push-driven).
- [x] **Watch:** Implement the `Job Detail` view (shows elapsed time, status icon).

## Phase 3: Wrist-Based Intervention (Write)

_Controlling agents without voice._

- [x] **Watch:** Add "Stop/Cancel" button to the Job Detail view. Wire to backend.
- [x] **Watch:** Add "Summarize Progress" button. Wire to backend to trigger an in-flight Gemini summary of the logs.
- [x] **Watch:** Implement haptic feedback for job state changes (e.g., success tap, failure double-tap).

## Phase 4: The Phone Handoff

_Seamless transition for complex tasks._
Reference task slice: `watch-ceviz-handoff-task-slice.md`
Ticket breakdown: `watch-ceviz-handoff-backlog-tickets.md`

- [ ] **Phone:** Implement deep-link handler (`ceviz://job/{id}`).
- [ ] **Phone:** Build the rich detail view capable of rendering Markdown, code blocks, and full agent logs.
- [ ] **Watch/Phone:** Wire up the "Open on Phone" button and the automatic push notifications when `requires_phone_handoff` is true.

## Phase 5: Polish & Edge Cases

- [ ] Handling network drops between Watch and Phone.
- [ ] Fallback TTS if the backend takes too long to generate audio.
- [ ] Secure authentication flow (Watch inheriting session from Phone).
