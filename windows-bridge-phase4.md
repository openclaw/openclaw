# Windows Bridge Phase 4

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## Goal

Remove manual JSON handling on the WSL side by adding a small wrapper that:

- creates a request ID
- writes the inbound request
- predicts the matching outbound result path
- optionally waits for the result with timeout

## What Was Added

- `windows-bridge-bootstrap/scripts/enqueue-bridge-request.py`

## Wrapper Behavior

Inputs:

- request kind: `capability-probe` or `dotnet-info`
- optional Windows `outputPath`
- optional explicit `requestId`
- optional `--wait`
- optional timeout override

Outputs:

- request metadata as JSON
- request path
- expected result path
- if `--wait` is used, parsed result JSON when available

## Example Usage

Write only:

```bash
python3 windows-bridge-bootstrap/scripts/enqueue-bridge-request.py dotnet-info \
  --output-path 'C:\Users\mertb\Desktop\windows-bridge-dotnet-info-phase4.json'
```

Write and wait for an already-running helper to finish:

```bash
python3 windows-bridge-bootstrap/scripts/enqueue-bridge-request.py capability-probe \
  --output-path 'C:\Users\mertb\Desktop\windows-bridge-capability-probe-phase4.json' \
  --wait --timeout-seconds 90
```

## Current Limitation

This wrapper does not itself start the Windows helper. It only handles the WSL enqueue and wait side.

That separation is intentional:

- WSL remains the planner/client side
- Windows helper remains the narrow execution side
- orchestration can later decide whether helper startup is manual, scheduled, or wrapped in a higher-level command

## Likely Phase 5

A higher-level bridge command that can:

1. enqueue a request
2. trigger the Windows helper run mode
3. wait for the matching result
4. normalize success/failure for agent use
