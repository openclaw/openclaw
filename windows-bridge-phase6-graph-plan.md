# Windows Bridge Phase 6.1 - Microsoft Graph Direction

Created: 2026-03-30
Workspace: `/home/mertb/.openclaw/workspace`

## Decision

Use Microsoft Graph as the primary direction for Outlook/mail access.

## Why This Is The Better Path

- Outlook COM failed on this machine in the current execution context
- Graph is less dependent on local Outlook client installation details
- the target capability is mailbox data access, not UI automation
- Graph is a stronger long-term base for read-only search, later classification, and possible future reply/draft flows

## Initial Product Goal

Read-only scan over recent mail for job-offer and pre-offer contact signals.

## Recommended Auth Shape

Start with delegated user auth and the smallest useful permission set.

Recommended first permission:

- `Mail.Read`

Optional later additions only if needed:

- `offline_access`
- `User.Read`
- `Mail.ReadBasic`

## Recommended First Auth Flow

Use delegated auth with device code or interactive login, then cache tokens locally on the Windows side.

Why:

- avoids building a confidential-client setup too early
- works for a personal mailbox flow
- keeps first PoC focused on mailbox read access

## Proposed Handler Breakdown

### 1. graph-auth-status

Purpose:

- detect whether a valid token/session already exists
- report which scopes are currently available
- return tenant/user hints if available

### 2. graph-auth-login

Purpose:

- initiate delegated auth
- obtain a token for `Mail.Read`
- persist token cache in a controlled local path

### 3. graph-mail-job-signal-scan

Purpose:

- fetch recent messages from target folders
- capture subject, sender, receivedDateTime, bodyPreview, webLink if available
- perform initial keyword matching
- return structured JSON for later summarization

## Suggested Local State

Store Graph auth/cache material only on the Windows side in a dedicated bridge folder, for example:

- `%LOCALAPPDATA%\\OpenClaw\\WindowsBridge\\graph\\`

Suggested contents:

- token cache
- auth status metadata
- last successful auth timestamp

## Suggested Mail Query Shape

Initial folders:

- Inbox
- Sent Items

Initial lookback:

- 180 days

Initial fields:

- `id`
- `subject`
- `from`
- `toRecipients`
- `receivedDateTime`
- `sentDateTime`
- `bodyPreview`
- `webLink`

Initial signal keywords:

- offer
- job offer
- opportunity
- position
- role
- interview
- recruiter
- compensation
- salary
- contract
- iş teklifi
- pozisyon
- maaş
- görüşme
- ik

## Transport Fit

The current queue/request-response bridge is already sufficient for these Graph handlers.

That means no transport redesign is required before starting Graph work.

## Concrete Next Step

Implement `graph-auth-status` first.

Reason:

- lowest-risk handler
- clarifies whether Graph tooling/auth prerequisites exist
- lets us decide the most practical login mechanism before touching mail queries

## After That

1. add `graph-auth-login`
2. verify a successful delegated sign-in
3. add `graph-mail-job-signal-scan`
4. run a real 180-day mail signal scan
5. summarize/classify results on the WSL side
