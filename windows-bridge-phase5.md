# Windows Bridge Phase 5

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## Goal

Turn the bridge into a single higher-level command that:

1. enqueues a request from WSL
2. triggers the Windows helper in `RunOnce` mode
3. waits for the matching result file
4. returns one normalized JSON response

## What Was Added

- `windows-bridge-bootstrap/scripts/run-bridge-request.py`

## Flow

1. Generate or accept a request ID
2. Call `enqueue-bridge-request.py`
3. Launch `runner.ps1 -RunOnce`
4. Wait for `queue/outbound/<requestId>.result.json`
5. Return the final result payload

## Example Usage

```bash
python3 windows-bridge-bootstrap/scripts/run-bridge-request.py dotnet-info \
  --output-path 'C:\Users\mertb\Desktop\windows-bridge-dotnet-info-phase5.json'
```

```bash
python3 windows-bridge-bootstrap/scripts/run-bridge-request.py capability-probe \
  --output-path 'C:\Users\mertb\Desktop\windows-bridge-capability-probe-phase5.json'
```

## Current Boundaries

- still limited to allowlisted handler kinds
- still uses the proven PowerShell lane via `pwsh`
- still relies on the queue as the transport contract
- does not yet run a persistent helper service

## Practical Outcome

At this point the bridge is usable as a single request/response command from WSL-side orchestration. That is enough for agent-driven command execution patterns where the agent should not manually manage queue files.

## Likely Phase 6

- add richer request payload fields per handler
- add a safer continuous helper mode or scheduled-task bootstrap
- add cleanup/retention policy for outbound and archive artifacts
- add a first real Windows-side task beyond probe/dotnet-info
