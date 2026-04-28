# Windows Helper RunOnce Test Note

Prepared: 2026-03-30

## Prepared inbound examples

- `queue/inbound/probe-request-example.json`
- `queue/inbound/dotnet-info-request-example.json`

## Intended Windows-side command

From the proven Windows-capable PowerShell lane:

```powershell
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File 'C:\\path\\to\\windows-bridge-bootstrap\\windows-helper\\runner.ps1' -RunOnce
```

## Expected outcomes

- Matching result files appear in `queue/outbound/`
- Processed inbound files move into `queue/archive/`
- Probe request produces its requested Windows JSON artifact
- Dotnet request produces its requested Windows JSON artifact

## Suggested verification checklist

1. Confirm `queue/outbound/*.result.json` exists for each request ID.
2. Confirm `queue/archive/` contains the original request files.
3. Read the result JSON and inspect `status`, `output`, and `error`.
4. Verify the Windows artifact paths from WSL via `/mnt/c/...`.
