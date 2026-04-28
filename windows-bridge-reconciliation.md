# Windows Bridge Reconciliation Report

Date: 2026-03-29
Workspace: `/home/mertb/.openclaw/workspace`
Host context: WSL2 Ubuntu on Windows

## Bottom line

The prior "WSL interop/vsock is broken" conclusion was incomplete.

What the tests show now is narrower and more practical:

- **Inside the ACP sandbox**, direct Windows process launch fails immediately with WSL/vsock errors.
- **Outside the sandbox** (after ACP escalation approval), the same Windows binaries launch successfully and produce Windows-side effects.
- The contradiction is therefore best explained by **different execution paths / restrictions**, not by a universally broken WSL interop stack.

## Tests performed

### 1. Sandboxed direct `cmd.exe` control test

- Exact command path used: `/mnt/c/Windows/System32/cmd.exe`
- Full command:

```bash
'/mnt/c/Windows/System32/cmd.exe' /c ver
```

- Reported result:
  - Exit code: `1`
  - Stdout: none
  - Stderr:

```text
<3>WSL (...) ERROR: UtilConnectUnix:533: connect failed 1
<3>WSL (...) ERROR: UtilBindVsockAnyPort:307: socket failed 1
```

- Observed side effect:
  - None verified.

### 2. Sandboxed direct `pwsh.exe` control test

- Exact command path used: `/mnt/c/Program Files/PowerShell/7/pwsh.exe`
- Full command:

```bash
'/mnt/c/Program Files/PowerShell/7/pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

- Reported result:
  - Exit code: `1`
  - Stdout: none
  - Stderr:

```text
<3>WSL (...) ERROR: UtilConnectUnix:533: connect failed 1
<3>WSL (...) ERROR: UtilBindVsockAnyPort:307: socket failed 1
```

- Observed side effect:
  - None verified.

### 3. Escalated direct `cmd.exe` marker-file test

- Exact command path used: `/mnt/c/Windows/System32/cmd.exe`
- Full command:

```bash
/mnt/c/Windows/System32/cmd.exe /c "echo DIRECT_CMD_20260329-2335>C:\Users\mertb\Desktop\acp-direct-cmd-marker.txt"
```

- Reported result:
  - Exit code: `0`
  - Stdout: none
  - Stderr:

```text
'\\wsl.localhost\Ubuntu\home\mertb\.openclaw\workspace'
CMD.EXE was started with the above path as the current directory.
UNC paths are not supported.  Defaulting to Windows directory.
```

- Observed / verifiable side effect:
  - File created: `/mnt/c/Users/mertb/Desktop/acp-direct-cmd-marker.txt`
  - Verified content:

```text
DIRECT_CMD_20260329-2335
```

- Interpretation:
  - The command launched successfully.
  - The stderr text is a **working-directory warning**, not a launch failure.
  - This is a clear case where stderr is present but the target Windows process still succeeded.

### 4. Escalated direct `pwsh.exe` marker-file test

- Exact command path used: `/mnt/c/Program Files/PowerShell/7/pwsh.exe`
- Full command:

```bash
'/mnt/c/Program Files/PowerShell/7/pwsh.exe' -NoProfile -Command "Set-Content -Path 'C:\Users\mertb\Desktop\acp-direct-pwsh-marker.txt' -Value 'DIRECT_PWSH_20260329-2335'"
```

- Reported result:
  - Exit code: `0`
  - Stdout: none
  - Stderr: none

- Observed / verifiable side effect:
  - File created: `/mnt/c/Users/mertb/Desktop/acp-direct-pwsh-marker.txt`
  - Verified content:

```text
DIRECT_PWSH_20260329-2335
```

### 5. Escalated helper-wrapper `pwsh` marker-file test

- Helper wrapper path used: `/home/mertb/.local/bin/pwsh`
- Wrapper target path: `/mnt/c/Program Files/PowerShell/7/pwsh.exe`
- Wrapper contents (inspected): simple `exec` pass-through to the Windows binary.
- Full command:

```bash
/home/mertb/.local/bin/pwsh -NoProfile -Command "Set-Content -Path 'C:\Users\mertb\Desktop\acp-wrapper-pwsh-marker.txt' -Value 'WRAPPER_PWSH_20260329-2335'"
```

- Reported result:
  - Exit code: `0`
  - Stdout: none
  - Stderr: none

- Observed / verifiable side effect:
  - File created: `/mnt/c/Users/mertb/Desktop/acp-wrapper-pwsh-marker.txt`
  - Verified content:

```text
WRAPPER_PWSH_20260329-2335
```

- Interpretation:
  - No evidence of a wrapper-specific bug here.
  - The wrapper and the direct binary path both work when run outside the ACP sandbox.

### 6. Escalated helper-wrapper browser launch probe

- Helper wrapper path used: `/home/mertb/.local/bin/browser-launch`
- Wrapper target order (inspected):
  1. `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`
  2. `/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`
  3. fallback `cmd.exe /c start`
- Full command:

```bash
timeout 8s /home/mertb/.local/bin/browser-launch "https://example.com/?acp_reconcile=20260329-2335"
```

- Reported result:
  - Exit code: `0`
  - Stdout: none
  - Stderr: none

- Observed / verifiable side effect:
  - No independent filesystem artifact from WSL.
  - This command is consistent with a successful browser launch and is also consistent with the user's earlier observation that a browser page opened on the Windows desktop.

### 7. Escalated no-write validation

- Commands:

```bash
/mnt/c/Windows/System32/cmd.exe /c ver
'/mnt/c/Program Files/PowerShell/7/pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

- Reported result:
  - `cmd.exe`: printed Windows version `10.0.26200.8037` (plus the same UNC working-directory warning)
  - `pwsh.exe`: printed PowerShell version `7.6.0`
  - Overall exit code: `0`

- Notable environment note:
  - `WSL_INTEROP` was still empty even in the successful escalated run.
  - So `WSL_INTEROP` being empty is **not sufficient** to explain the failure.

## Reconciliation of the contradiction

The earlier reports were based on **sandboxed ACP execution** and accurately described that execution path: in that mode, Windows binary launch failed with `UtilConnectUnix` / `UtilBindVsockAnyPort` errors.

The user's observation of real Windows-side effects is also credible and is consistent with the new evidence: **outside the sandbox**, the same binaries launch successfully, create files on the Windows Desktop, and the browser-launch helper exits cleanly.

So the contradiction is resolved as follows:

- Prior failure reports: **true for sandboxed execution path**.
- User-observed Windows desktop side effects: **true for escalated / unsandboxed execution path**.
- Therefore the environment is **not globally broken**; the limitation is **path-dependent**.

## Specific distinctions requested

### Command reported as failed but side effect still occurred

- I did **not** reproduce a case with a non-zero exit code plus a verified side effect in this run.
- I **did** reproduce a nearby case that matters operationally: `cmd.exe` emitted stderr warnings about the UNC current directory, but still exited `0` and created the Windows marker file.
- So stderr alone is not evidence of launch failure.

### Wrapper-level failure vs target process success

- The `pwsh` wrapper is a trivial `exec` shim.
- Direct `pwsh.exe` and wrapper `pwsh` both succeeded outside the sandbox and both failed inside the sandboxed mode tested earlier.
- That points away from a wrapper bug and toward **execution-context restrictions**.

### Approval-prompt blocking vs actual launch failure

- ACP escalation approval is a **separate layer** from Windows process launch.
- Without escalation, the sandboxed path failed with WSL/vsock errors before any useful Windows-side effect.
- After escalation approval, the same Windows launches worked.
- So if a command appears flaky because it waits for approval, that should be classified separately from interop failure.

### Direct binary call vs helper wrapper

- `pwsh.exe` direct and `/home/mertb/.local/bin/pwsh` behaved the same once execution context was held constant.
- `browser-launch` is also just a thin launcher wrapper. Given its clean exit under escalated execution, it is plausible that an earlier observed browser open came from the wrapper succeeding even though earlier sandboxed tests had failed.

## Is this environment usable for our automation model in practice?

**Conditionally yes.**

- **Usable** if the automation can run through the ACP's escalated / unsandboxed execution path, or otherwise from a Windows-capable context that is not subject to the sandbox restriction.
- **Not usable** if the automation model depends on ordinary sandboxed ACP commands directly launching Windows processes.

That means the real blocker is not "Windows interop is dead". The real blocker is **which execution lane the automation is using**.

## Best explanation for the contradiction

Best current explanation:

1. The earlier diagnosis over-generalized from sandboxed tests.
2. The ACP sandbox blocks or interferes with the WSL-to-Windows launch bridge in a way that manifests as `UtilConnectUnix` / `UtilBindVsockAnyPort` errors.
3. The unsandboxed path does not have that restriction, so Windows binaries launch normally and can cause visible Windows-side effects.
4. The user's earlier browser observation is therefore credible and does not conflict with the sandbox-failure evidence once the two execution contexts are separated.

## Next recommended step

Build or adapt the automation around the **working execution path**:

- Treat sandboxed ACP commands as Linux-only unless proven otherwise.
- Route Windows launches, browser auth, and Windows-native bridge operations through the **escalated / unsandboxed lane** or through a dedicated Windows-side helper process/service.
- As a follow-up, add one explicit capability probe at runtime:

```bash
/mnt/c/Windows/System32/cmd.exe /c echo OK>C:\Users\mertb\Desktop\acp-capability-probe.txt
```

If that probe succeeds, proceed with Windows-native automation; if it fails with the WSL/vsock error, fall back or surface a clear "sandboxed path cannot launch Windows binaries" status.
