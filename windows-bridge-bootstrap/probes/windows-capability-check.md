# Windows Capability Check

Use this when you want a narrow first-pass verification from the known working Windows-capable lane.

## Safe Sequence

1. `pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`
2. `dotnet --info`
3. `pwsh -NoProfile -File <workspace-or-windows-path>/win-capability-probe.ps1 -OutputPath <windows-path>`

## Expected Lane

- Windows-native command execution: escalated Windows-capable lane
- Output verification from WSL via `/mnt/c/...`: sandboxed or escalated read path is fine

## Success Criteria

- PowerShell returns a version string
- `dotnet --info` exits successfully
- the probe script writes a JSON file to a Windows-accessible location

## Failure Interpretation

- WSL/vsock-style launch errors: wrong lane or execution-context restriction
- missing `dotnet`: Windows runtime/tooling gap, not a bridge design failure
- write failure on a Windows path: permission/path issue, not necessarily process-launch failure
