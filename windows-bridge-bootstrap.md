# Windows Bridge Bootstrap Phase 1

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## What Was Created

- `windows-bridge-bootstrap/`
- `windows-bridge-bootstrap/README.md`
- `windows-bridge-bootstrap/scripts/win-capability-probe.ps1`
- `windows-bridge-bootstrap/probes/windows-capability-check.md`
- `windows-bridge-bootstrap/probes/safe-test-notes.md`
- `windows-bridge-bootstrap/probes/future-bridge-direction.md`
- `windows-bridge-bootstrap/artifacts/README.md`
- `windows-bridge-bootstrap/artifacts/windows-marker-artifact.md`

## Execution Lane Expectations

| Item                                                                       | Expected lane                                             | Reason                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Markdown notes in this workspace                                           | Escalated ACP in this session                             | Workspace writes are blocked in the default sandbox here.                         |
| `win-capability-probe.ps1`                                                 | Windows-capable escalated lane via `pwsh.exe -File ...`   | The script is meant to run on the Windows side and write its own probe output.    |
| Read-only inspection of these files                                        | Sandboxed ACP                                             | WSL-local reads are already reliable.                                             |
| Windows capability checks (`pwsh`, `dotnet`, browser launch, marker files) | Windows-capable escalated lane                            | Prior evidence shows Windows process launch is only reliable outside the sandbox. |
| Future queue/helper bridge                                                 | Mixed: sandboxed planner + narrow escalated runner/helper | Keeps planning safe while isolating Windows-native execution.                     |

## Already Proven

- Windows-native process launch is viable in the escalated lane.
- `pwsh.exe` has worked in that lane.
- `dotnet.exe` has worked in that lane.
- Browser launch is possible but interactive and should stay a manual-safe probe.
- Windows-user file creation is possible in the escalated lane.
- WSL-side read-only planning and document inspection are reliable in the sandboxed lane.

## Still Pending

- Re-running the full capability probe from the new bootstrap package.
- Establishing a stable pre-approved runner pattern for repeatable Windows execution.
- Deciding whether Phase 2 should use:
  - a local helper service
  - a filesystem queue bridge
  - or both, with the queue as the first transport
- Any Outlook or Microsoft Graph implementation work.
- Any unattended browser-dependent flow.

## Fresh Verifiable Artifact

See `windows-bridge-bootstrap/artifacts/windows-marker-artifact.md` for the exact Windows-side marker created during this phase and how it was verified from WSL.

Current marker:

- Windows path: `C:\Users\mertb\Desktop\windows-bridge-bootstrap-marker-20260330-0042.txt`
- WSL path: `/mnt/c/Users/mertb/Desktop/windows-bridge-bootstrap-marker-20260330-0042.txt`

## Practical Phase 1 Outcome

This package does not attempt to build the Outlook bridge. It gives a repeatable place to put:

- trusted Windows-side probe scripts
- lane-specific testing notes
- recorded verification artifacts
- the first recommended bridge direction for later phases
