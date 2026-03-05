# HEARTBEAT.md - Scheduled Tasks

## Every Heartbeat Check

1. **Check for pending Gilberts approvals** — if a draft was sent and Gilberts replied, create the Typefully draft

## Morning Routine (9:00 AM Chile, America/Santiago)

- [ ] (Monday) **Data cleanup**: Delete `data/daily/` folders older than 14 days
- [ ] **Daily Data Drop**: Fetch metrics via `exec node scripts/fetch-metrics.mjs`, draft tweet, send preview to Gilberts
- [ ] **Changelog Update**: Fetch changelog via `exec node scripts/fetch-changelog.mjs`, check for new entries since last post, draft tweet if new entries found, send preview to Gilberts
- [ ] On approval for either draft, create Typefully draft and confirm to Gilberts
