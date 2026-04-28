# Windows Agent Status

## Base runtime environment

- OS: Ubuntu 24.04.4 LTS
- Kernel: `6.6.114.1-microsoft-standard-WSL2`
- Shell: `bash`
- Working directory: `/home/mertb/.openclaw/workspace`
- Interpretation: Linux userspace inside WSL2, with Windows drives mounted under `/mnt/*`

## Windows bridge tools tested

- `powershell.exe`
  - Command: `powershell.exe -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`
  - Outcome: failed immediately, `/bin/bash: line 1: powershell.exe: command not found`
- `pwsh`
  - Wrapper found at `/home/mertb/.local/bin/pwsh`
  - Backing Windows binary exists at `/mnt/c/Program Files/PowerShell/7/pwsh.exe`
  - Command: `pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`
  - Outcome: failed with WSL interop error:
    - `WSL ERROR: UtilConnectUnix:533: connect failed 1`
    - `WSL ERROR: UtilBindVsockAnyPort:307: socket failed 1`
- `dotnet`
  - Wrapper found at `/home/mertb/.local/bin/dotnet`
  - Backing Windows binary exists at `/mnt/c/Program Files/dotnet/dotnet.exe`
  - Command: `dotnet --info`
  - Outcome: failed with the same WSL interop/vsock error as `pwsh`
- `browser-launch`
  - Wrapper found at `/home/mertb/.local/bin/browser-launch`
  - Wrapper logic prefers:
    - `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`
    - `/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`
    - fallback `cmd.exe /c start`
  - Chrome and Edge binaries both exist on `/mnt/c`
  - Dry-run feasibility check: `browser-launch --help`
  - Outcome: failed with the same WSL interop/vsock error before any visible browser launch
  - Assessment: a real browser launch would likely fail the same way and would be noisy if interop recovered, so no live launch was attempted
- Windows filesystem mounts
  - Checked: `/mnt/c`, `/mnt/d`, `/mnt/e`
  - Outcome: all three exist and are readable from WSL

## Practical assessment

- Windows-native files are reachable through `/mnt/c`
- Windows-native process execution is not currently working from this WSL session
- Result: Windows-native tasks are not yet realistically possible through these bridges from here, despite the binaries being present

## Constraints still present

- No working WSL-to-Windows process bridge in this session
- `powershell.exe` and `cmd.exe` are not on the WSL PATH
- Direct execution of Windows `.exe` files from `/mnt/c` currently fails with the same interop/vsock error
- Browser-based auth or UI automation is not reliable until that interop issue is fixed

## Recommended next step

Fix or restart WSL interop on the host, then re-test `pwsh`, `dotnet --info`, and a controlled browser launch. Once those succeed, this environment should be viable for a Windows-side .NET Outlook/Microsoft Graph bridge service.

## Proposed initial .NET Outlook/Microsoft Graph bridge structure

Only relevant after bridge execution works, because `dotnet` is installed on the Windows side but not currently launchable from this session.

```text
outlook-graph-bridge/
  src/
    Bridge.Host/                    # Worker entrypoint, DI, config, logging
    Bridge.Graph/                   # Microsoft Graph client wrapper and auth flows
    Bridge.Contracts/               # DTOs and shared request/response contracts
    Bridge.Storage/                 # Token cache, local state, retry metadata
    Bridge.Transport.FileQueue/     # Simple filesystem bridge for WSL <-> Windows
  tests/
    Bridge.Graph.Tests/
    Bridge.Transport.Tests/
  config/
    appsettings.json
    appsettings.Development.json
  README.md
```
