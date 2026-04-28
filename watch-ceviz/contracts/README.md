# Watch Ceviz Contracts (Package B1)

This directory contains the implementation-ready JSON schema contracts for the first slice of Watch Ceviz (the PTT-to-Summary Loop).

## Explicit Decisions

1. **Text-First vs. Audio-First Request Shape**:
   - **Decision: Audio-First.** The watch application is intentionally dumb and acts purely as an audio capture/playback device. The `WatchCommandRequest` expects Base64 encoded audio. The phone merely acts as a proxy, passing this audio to the backend. The backend handles Speech-to-Text (STT) for intent parsing.
2. **Audio Payload Format**:
   - **Decision: `m4a` / `aac`.** To minimize the payload size over `WatchConnectivity` (WCSession) and optimize network transfers, the watch will record and transmit compressed M4A/AAC rather than raw PCM or WAV.
3. **Short Summary Constraints**:
   - **Decision: < 200 Characters Plain Text.** The `WatchCommandResponse` enforces a strict 200 character limit on `summary_text`. This ensures the text fits on the Apple Watch UI without scrolling and guarantees the TTS playback is short and snappy.
4. **Fields for Future Phone Handoff**:
   - **Decision: `requires_phone_handoff` & `handoff_url`.** The response includes a boolean flag (`requires_phone_handoff`) to indicate if the result is too complex for a watch (e.g., contains code, lists). A `handoff_url` (e.g., `ceviz://job/123`) is provided to trigger a rich view in the iPhone companion app.

## Contracts Defined

- `watch-command-request.schema.json`
- `watch-command-response.schema.json`
- `active-jobs-response.schema.json`
- `job-report-response.schema.json`
- `job-summary-response.schema.json`

## Implemented Packages

- **Package B2: Backend Command Endpoint**. A Python-based stub endpoint (`POST /api/v1/watch/command`, `GET /api/v1/jobs/active`, `POST /api/v1/jobs/:id/summarize`) has been implemented in `../backend/main.py`. It validates incoming JSON payloads and serves stable mock responses, unblocking iOS/watchOS client development.
- **Package B3: iPhone Companion Bridge**. A concrete iOS Swift implementation layout (`ios-bridge/`) using `WCSessionDelegate` and `URLSession`.
- **Package B4: Apple Watch App (Client)**. A basic PTT UI loop built in watchOS (`apple-watch/`) connecting to the iOS bridge.
- **Phase 2: Read-Only Agent Monitoring**. Both backend, bridge and watch endpoints are built to display the current active jobs list.
- **Phase 6: iPhone Companion App Report Endpoints**. Fetching `/api/v1/jobs/:id/report` with proper schema validation and companion app rendering.

## Recommended Next Implementation Package

- **Phase 7: True Backend Integration**. Connect the mock backend endpoints to the real OpenClaw task execution system.
