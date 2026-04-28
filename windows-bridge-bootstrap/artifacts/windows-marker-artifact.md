# Windows Marker Artifact

Status: created and verified

## Verified Fresh Artifact

- artifact type: Windows capability probe JSON
- lane: escalated Windows-capable ACP execution
- mechanism: direct `pwsh.exe` invocation from WSL with one-shot execution-policy bypass
- script: `/home/mertb/.openclaw/workspace/windows-bridge-bootstrap/scripts/win-capability-probe.ps1`

## Windows Path

- `C:\Users\mertb\Desktop\windows-bridge-capability-probe-20260330-0117.json`

## WSL Verification Path

- `/mnt/c/Users/mertb/Desktop/windows-bridge-capability-probe-20260330-0117.json`

## Verified Content Summary

- generatedAtUtc: `2026-03-29T22:18:12.2073175Z`
- computerName: `KOLTIGINMASAUST`
- userProfile: `C:\Users\mertb`
- pwshVersion: `7.6.0`
- dotnetOk: `true`
- dotnetVersion: `10.0.103`

## Practical Meaning

This is the Phase 2 proof that the current trusted lane can execute the bootstrap probe script on Windows, write a real JSON artifact to a Windows-user location, and verify that artifact from WSL.
