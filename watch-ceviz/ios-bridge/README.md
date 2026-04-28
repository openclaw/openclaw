# Package B3: iPhone Companion Bridge

This package contains the implementation-ready Swift files for the iPhone Companion Bridge and an executable Python simulator to test the end-to-end flow locally.

## Architecture

The Apple Watch acts as a dumb terminal (recording audio, playing audio/text).
The iPhone acts as a proxy, passing the payload over HTTP to the OpenClaw backend.

- `WatchBridgeCoordinator.swift`: The main coordinator implementing `WCSessionDelegate`. It listens for messages from the Watch via `WatchConnectivity` and proxies them to the OpenClaw backend using `URLSession`.
- `Models.swift`: Codable structs reflecting `watch-command-request.schema.json` and `watch-command-response.schema.json`.
- `CompanionApp.swift`: The main iOS SwiftUI app entry point. Handles canonical `ceviz://job/<id>` deep-links for handoff features, while still accepting the legacy `ceviz://job/<id>/report` shape.

## Local Verification

Since an iOS app cannot be easily compiled and executed in this headless environment, we provide a Python simulator to verify the bridge data flow against the actual backend stub.

1. Start the backend stub:
   ```bash
   ../backend/run.sh
   ```
2. Run the simulator (in a new terminal):
   ```bash
   python3 simulator.py
   ```

The simulator mimics the Watch generating the JSON payload, the iPhone bridge sending it to the backend, and the Watch parsing the resulting response for text and TTS audio playback.
