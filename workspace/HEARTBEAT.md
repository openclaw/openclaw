# HEARTBEAT.md - Scheduled Tasks

## Every Heartbeat Check

1. **Check for pending Gilberts approvals** — if a Data Drop draft was sent and Gilberts replied, create the Typefully draft

## Morning Routine (9:00 AM Chile, America/Santiago)

- [ ] (Monday) **Data cleanup**: Delete `data/daily/` folders older than 14 days, `data/weekly/` older than 8 weeks, audits older than 30 days
- [ ] Fetch metrics: `exec node scripts/fetch-metrics.mjs`
- [ ] Draft Data Drop tweet and save to `data/daily/YYYY-MM-DD/data_drop_draft.md`
- [ ] Send preview to Gilberts via Telegram
- [ ] On approval, create Typefully draft: `typefully drafts:create --text "content"`
- [ ] Confirm to Gilberts: "Draft created in Typefully"
