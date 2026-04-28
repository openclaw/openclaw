# Windows Execution Profile

Generated: 2026-03-29T23:54:00+03:00
Workspace: /home/mertb/.openclaw/workspace

## Capability Matrix

| Action class                                      | Sandboxed ACP                | Escalated/unsandboxed ACP     | Evidence / notes                                                                                                                                                                                                                  |
| ------------------------------------------------- | ---------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux/WSL-local read-only tasks                   | Reliable                     | Reliable                      | Sandboxed `uname -a` and directory listing succeeded.                                                                                                                                                                             |
| Linux/WSL-local file-write tasks in workspace     | Blocked in this session      | Reliable                      | Sandboxed `touch sandbox-write-probe.tmp` returned `Permission denied`. Unsandboxed write probe succeeded at `/home/mertb/.openclaw/workspace/unsandboxed-write-probe-20260329-235339.tmp`.                                       |
| Windows filesystem access through `/mnt/c`        | Read-only access is reliable | Reliable                      | Sandboxed `ls -ld /mnt/c /mnt/c/Users /mnt/c/Users/mertb/Desktop` succeeded.                                                                                                                                                      |
| Windows filesystem writes through `/mnt/c`        | Blocked                      | Reliable                      | Sandboxed desktop write probe returned `Permission denied`. Unsandboxed direct writes to `/mnt/c/Users/mertb/Desktop/openclaw-unsandboxed-probe-direct.txt` and `/mnt/c/Users/mertb/openclaw-profile-probe-direct.txt` succeeded. |
| Windows process launch: `cmd.exe`                 | Not reliable / blocked       | Reliable                      | Sandboxed launch failed with WSL vsock-style errors. Unsandboxed `cmd.exe /c ver` exited `0` and returned Windows version info.                                                                                                   |
| Windows process launch: `pwsh.exe`                | Not reliable / blocked       | Reliable                      | Sandboxed launch failed with WSL vsock-style errors. Unsandboxed PowerShell returned version `7.6.0`.                                                                                                                             |
| Windows process launch: `dotnet.exe`              | Not reliable / blocked       | Reliable                      | Sandboxed launch failed with WSL vsock-style errors. Unsandboxed `.NET SDK` probe exited `0` and reported Windows `win-x64` runtime info.                                                                                         |
| Browser launch                                    | Unsuitable                   | Works, but interactive        | Unsandboxed `cmd.exe /c start "" about:blank` exited `0`; it is still a GUI side effect, not a robust unattended primitive.                                                                                                       |
| Creating files on Windows desktop or user profile | Blocked                      | Reliable                      | Confirmed via direct unsandboxed marker-file writes.                                                                                                                                                                              |
| Tasks likely to trigger approval prompts          | Low for read-only WSL work   | High for Windows-side actions | The approval boundary is the escalation requirement.                                                                                                                                                                              |

## What Works In Sandboxed Mode

- WSL-local read-only inspection is dependable.
- Reading Windows-mounted paths through `/mnt/c` is dependable.
- Sandboxed mode is suitable for discovery, parsing, validation, and planning when no writes or Windows-native process launches are needed.

## What Works Only In Escalated/Unsandboxed Mode

- Writing inside the workspace from this current ACP session configuration.
- Writing to Windows-user locations such as desktop and profile paths.
- Launching Windows-native processes using explicit executable paths, including `cmd.exe`, `pwsh.exe`, and `dotnet.exe`.
- Browser launch attempts.

## Flaky Or Unsuitable For Unattended Use

- Any Windows process launch from sandboxed ACP is currently unsuitable; all three probes failed with the same WSL errors: `UtilConnectUnix` and `UtilBindVsockAnyPort`.
- Browser launch is interactive by nature and weak as an unattended automation primitive even when unsandboxed.
- Any workflow that depends on an escalation prompt is unsuitable for unattended orchestration, because execution pauses at the approval boundary.
- `cmd.exe` launches from the WSL workspace show a UNC-path warning before defaulting to the Windows directory. That is acceptable for simple probes but not ideal for workflows that depend on the starting directory.

## Approval-Boundary Risks

- The practical approval boundary is not Linux versus Windows; it is sandboxed/read-only versus escalated/unsandboxed.
- In this environment, Windows-side automation almost always crosses that boundary.
- Repeated Windows-side tasks by Codex are therefore likely to trigger repeated approval prompts unless a durable approval rule exists for the exact command prefix being used.
- Even simple actions like marker-file creation or PowerShell invocation are prompt-bound if they require escalation.
- Browser launch is especially poor for unattended flows because it combines escalation requirements with GUI side effects.

## Evidence Notes

- Sandboxed `cmd.exe`, `pwsh.exe`, and `dotnet.exe` all failed with the same WSL vsock-style pattern: `UtilConnectUnix` and `UtilBindVsockAnyPort`.
- Unsandboxed `cmd.exe /c ver` output included a UNC-path warning and then reported `Microsoft Windows [Version 10.0.26200.8037]`.
- Unsandboxed `pwsh.exe` returned `7.6.0`.
- Unsandboxed `dotnet.exe --info` reported `.NET SDK 10.0.103` on `Windows 10.0.26200`, `RID win-x64`.
- Confirmed unsandboxed workspace write probe: `/home/mertb/.openclaw/workspace/unsandboxed-write-probe-20260329-235339.tmp`.
- Confirmed unsandboxed Windows marker files:
  - `/mnt/c/Users/mertb/Desktop/openclaw-unsandboxed-probe-direct.txt`
  - `/mnt/c/Users/mertb/openclaw-profile-probe-direct.txt`

## Recommended Orchestration Policy

- Use sandboxed ACP for WSL-local read-only work: inspect files, compute plans, prepare arguments, and validate preconditions.
- Route any Windows-native action through a dedicated escalated lane, not through the default sandboxed lane.
- Treat Windows process launch, Windows-user file creation, and browser control as approval-bound operations.
- For unattended Ceviz orchestration, avoid per-step Codex escalation prompts. Prefer one of these patterns:
  1. A pre-approved narrow command prefix for a stable runner such as `pwsh.exe -File <trusted-script>`.
  2. A long-lived Windows-side helper/service that Codex triggers through one pre-approved interface.
  3. Splitting orchestration into a sandboxed planning phase and a separately authorized execution phase.
- Do not model browser launch as a reliable automation primitive unless the human is explicitly in the loop.
- Prefer idempotent script entrypoints over ad hoc inline commands; this reduces prompt frequency and keeps the approval surface narrow.
