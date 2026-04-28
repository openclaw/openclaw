# Safe Test Notes

## `pwsh`

Preferred minimal test:

```bash
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
```

Why:

- no profile side effects
- no filesystem mutation
- easy to verify from stdout

## `dotnet`

Preferred minimal test:

```bash
dotnet --info
```

Why:

- confirms Windows-side SDK/runtime access
- read-only probe

## Browser Launch

Treat browser launch as manual-safe only.

Preferred probe:

```bash
browser-launch https://example.com/?windows_bridge_probe=1
```

Rules:

- only run it when a visible browser side effect is acceptable
- do not make it part of unattended automation
- do not use it as the primary proof that the bridge works
- prefer a marker file or JSON artifact for repeatable verification
