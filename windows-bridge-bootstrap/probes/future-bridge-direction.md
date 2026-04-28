# Future Bridge Direction

## Recommended First Direction

Start with a file-queue bridge, then optionally wrap it with a local helper service.

## Why This Fits The Current Evidence

- sandboxed WSL planning is reliable
- Windows-native execution needs the escalated lane
- a queue gives a narrow, auditable handoff between those two sides
- it avoids making browser/UI actions part of the transport contract

## Minimal Shape

```text
windows-bridge-bootstrap/
queue/
  inbound/
  outbound/
  archive/
windows-helper/
  runner.ps1
  handlers/
    probe.ps1
    dotnet-info.ps1
```

## Suggested Flow

1. WSL side writes a small request file such as `probe-20260330-001.json`.
2. A Windows-side helper watches `inbound/`.
3. The helper executes a single trusted handler.
4. The helper writes a structured result file to `outbound/`.
5. WSL reads and archives the result.

## Why Not Jump Straight To Outlook

- transport reliability is the first unknown to stabilize
- a queue/helper split reduces risk before introducing auth, Graph scopes, or mailbox operations
- the same transport can later back a local HTTP service if needed
