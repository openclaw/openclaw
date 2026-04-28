# Windows Bridge Phase 6

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## Goal

Add the first real read-only Windows task: scan Outlook mail for job-offer or pre-offer contact signals over a recent time window.

## Scope

Initial scope is intentionally narrow:

- read-only
- Outlook local client via COM
- Inbox + Sent Items
- default lookback: 180 days
- keyword-based signal matching
- structured JSON result for later summarization/classification

## What Was Added

- `windows-bridge-bootstrap/windows-helper/handlers/outlook-job-signal-scan.ps1`

## Request Shape

- `kind`: `outlook-job-signal-scan`
- optional `daysBack`
- optional `maxResults`
- optional `keywords`
- optional `outputPath`

## Output Shape

- `generatedAtUtc`
- `daysBack`
- `maxResults`
- `totalScanned`
- `matchedCount`
- `matches[]`
  - `folder`
  - `subject`
  - `sender`
  - `receivedAt`
  - `preview`
  - `matchReasons`

## Notes

This is a pragmatic first Outlook bridge step. It is not yet Microsoft Graph-based and should be treated as a local Outlook-profile read path.

## Likely Next Work

- add stronger result classification beyond raw keyword hits
- support folder selection / mailbox selection
- optionally migrate to Graph if auth and scope management becomes worth the complexity
