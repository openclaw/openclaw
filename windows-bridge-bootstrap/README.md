# Windows Bridge Bootstrap

Minimal Phase 1 scaffold for Windows-side automation bootstrap.

## Purpose

- keep Windows-specific probes in one place
- separate safe planning from Windows execution
- record verifiable artifacts
- prepare for a later Outlook/Microsoft Graph bridge without building it yet

## Structure

- `scripts/` trusted, narrow Windows-side entrypoints
- `probes/` command notes and lane-specific test guidance
- `artifacts/` verification records produced during bootstrap

## Recommended Use

1. Read the probe notes from WSL/sandboxed planning mode.
2. Run Windows-native checks only through the known working escalated lane.
3. Record each concrete verification artifact under `artifacts/`.

## Non-Goals In Phase 1

- no Graph auth flow
- no Outlook automation
- no long-lived helper service yet
- no unattended browser automation
