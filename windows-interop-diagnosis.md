# Windows Interop Diagnosis

Date: 2026-03-29
Environment: WSL2 Ubuntu 24.04.4 on kernel `6.6.114.1-microsoft-standard-WSL2`

## Observed Evidence

- Windows files are visible and executable bits are present under `/mnt/c`.
- Direct execution of Windows binaries fails immediately:
  - `'/mnt/c/Windows/System32/cmd.exe' /c ver`
  - `'/mnt/c/Program Files/PowerShell/7/pwsh.exe' -NoProfile -Command ...`
  - `'/mnt/c/Program Files/dotnet/dotnet.exe' --info`
- All fail with the same pre-launch WSL errors:
  - `WSL ERROR: UtilConnectUnix:533: connect failed 1`
  - `WSL ERROR: UtilBindVsockAnyPort:307: socket failed 1`
- This reproduces even when bypassing local wrapper scripts and calling the `.exe` files directly.
- `binfmt_misc` reports WSL interop as enabled:
  - `/proc/sys/fs/binfmt_misc/WSLInterop` exists and points to `/init`
- `/run/WSL/*_interop` sockets exist:
  - `/run/WSL/2_interop`
  - `/run/WSL/1583_interop`
  - `/run/WSL/650_interop`
- Current shell environment does not include `WSL_INTEROP`.
- Safe remediation test tried:
  - explicitly setting `WSL_INTEROP=/run/WSL/2_interop` and retrying `cmd.exe /c ver`
  - same failure
- Low-level socket test:
  - direct AF_UNIX connect attempts to `/run/WSL/*_interop` return `PermissionError: [Errno 1] Operation not permitted`

## Likely Root Cause Ranking

1. WSL interop/vsock path is broken or unusable in this session/host state.
2. Interop socket environment/setup is incomplete for this shell (`WSL_INTEROP` missing), but this is not the only issue because setting it manually did not restore execution.
3. Codex non-interactive permission prompts are a secondary concern only after Windows process launch works.

## Are Codex Permission Prompts a Plausible Blocker Here?

Yes in general, but not as the current first failure.

Reason: Windows executables fail before the target Windows process starts. The failure happens inside WSL interop (`/init` + Unix/vsock bridge), so there is no evidence that a Windows-side Codex approval dialog is even being reached from this session.

## Can This ACP/Codex Setup Execute Windows Commands Non-Interactively Right Now?

No.

Practical conclusion: this WSL-based ACP/Codex session can read Windows-mounted files, but it cannot currently launch Windows processes non-interactively, or interactively, through the normal WSL bridge path.

## Concrete Remediation Steps

1. Restart WSL from Windows host side, then retest:
   - `wsl --shutdown`
   - reopen the distro/session
   - retry `cmd.exe /c ver`, `pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'`, `dotnet --info`
2. If still broken, restart the Windows host. The errors are consistent with host-side WSL interop/vsock state being unhealthy.
3. After restart, verify `WSL_INTEROP` is present in the shell environment. If missing, compare behavior in a fresh interactive WSL shell versus this ACP/Codex-launched shell.
4. If interactive WSL can launch Windows commands but ACP/Codex cannot, investigate how ACP/Codex spawns the shell:
   - whether it strips `WSL_INTEROP`
   - whether it applies seccomp/container restrictions blocking Unix socket or vsock usage
5. Only after process launch works, test whether Windows-side Codex approval prompts block automation:
   - start with a trivial non-privileged Windows command
   - then a bridge command known to trigger approval
   - observe whether execution hangs awaiting manual approval
6. If approval prompts do block unattended runs, the fix is architectural:
   - run the Windows bridge in a directly interactive Windows session
   - or pre-authorize required actions there
   - or use a file-queue / local service design so WSL never needs to drive approval-gated UI flows

## Bottom Line

Current blocker: WSL interop/vsock, not approval prompts.

Approval prompts remain a plausible second blocker for later, but there is no evidence they are the reason these commands fail from this WSL session today.
