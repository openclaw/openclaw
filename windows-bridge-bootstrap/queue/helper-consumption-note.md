# Windows Helper Queue Note

Minimal future behavior:

1. Watch `queue/inbound/` for new JSON request files.
2. For a `capability-probe` request, run `scripts/win-capability-probe.ps1` with the requested output path.
3. Write a small result JSON into `queue/outbound/` with the request ID, status, output path, and completion time.
4. Move the processed inbound request into `queue/archive/`.
