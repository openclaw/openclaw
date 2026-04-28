# Windows Bridge Phase 3

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## Goal

Build the smallest usable queue-driven Windows helper runner so WSL-side planning can hand off narrow Windows-native work through an auditable filesystem contract.

## What Was Added

- `windows-bridge-bootstrap/windows-helper/runner.ps1`
- `windows-bridge-bootstrap/windows-helper/handlers/capability-probe.ps1`
- `windows-bridge-bootstrap/windows-helper/handlers/dotnet-info.ps1`

## Contract

Inbound request shape:

- `requestId`: stable unique ID
- `kind`: trusted handler name
- optional handler-specific fields such as `outputPath`

Current supported request kinds:

- `capability-probe`
- `dotnet-info`

Outbound result shape:

- `requestId`
- `kind`
- `status` (`succeeded` or `failed`)
- `startedAtUtc`
- `finishedAtUtc`
- `host`
- `output`
- `error`

## Runner Behavior

1. Watches `queue/inbound/*.json`
2. Parses the request
3. Routes only to a trusted local handler by `kind`
4. Writes a structured result file into `queue/outbound/`
5. Moves the processed inbound file into `queue/archive/`

## Minimal Safety Properties

- no arbitrary script path execution from request JSON
- handler routing is allowlisted in `runner.ps1`
- request and result artifacts stay on disk for inspection
- transport remains separate from future Outlook/Graph features

## Suggested Next Verification

Prepared test inputs:

- `windows-bridge-bootstrap/queue/inbound/probe-request-example.json`
- `windows-bridge-bootstrap/queue/inbound/dotnet-info-request-example.json`

Run the helper on Windows via the proven PowerShell lane in `-RunOnce` mode against:

1. the existing capability probe example
2. the prepared `dotnet-info` request

Then verify:

- result JSON appears in `queue/outbound/`
- inbound request is moved to `queue/archive/`
- any Windows-side artifact requested by the handler is actually created

## Phase 4 Follow-up

Phase 4 added `windows-bridge-bootstrap/scripts/enqueue-bridge-request.py` to:

- enqueue requests from WSL safely
- generate correlation-friendly request IDs
- optionally wait for matching result files with timeout

The remaining follow-up after that is deciding whether the Windows helper should be:

- started manually per run
- run continuously as a scheduled task or service
- or triggered by a higher-level bridge wrapper
