# HEARTBEAT.md - Scheduled Tasks

## Every Heartbeat Check

1. **Check for pending Gilberts approvals** — if a draft was sent and Gilberts replied, create the Typefully draft

## Morning Routine (9:00 AM Chile, America/Santiago)

**IMPORTANT: Before running any task, check if a draft file already exists for today in `data/daily/YYYY-MM-DD/`. If it exists, the task is DONE for the day — do NOT re-run it or send another preview.**

- [ ] (Monday) **Data cleanup**: Delete `data/daily/` folders older than 14 days
- [ ] **Daily Data Drop**: Check if `data/daily/YYYY-MM-DD/data_drop_draft.md` exists. If NOT, fetch metrics via `exec node scripts/fetch-metrics.mjs`, draft tweet, save to file, send preview to Gilberts. If file exists, skip
- [ ] **Changelog Update**: Check if `data/daily/YYYY-MM-DD/changelog_draft.md` exists. If NOT, fetch changelog via `exec node scripts/fetch-changelog.mjs`, check for new entries, draft tweet if found, save to file, send preview. If file exists, skip
- [ ] **Community Engagement** (10:00 AM): Check if `data/daily/YYYY-MM-DD/engagement_actions.md` exists. If NOT, search for relevant tweets via twclaw, propose up to 5 interactions to Gilberts, wait for approval. If file exists, skip
- [ ] On approval for any draft or engagement, execute and confirm to Gilberts

## Anti-Repetition Rules

- Do NOT send the same message to Gilberts more than once per day
- Do NOT re-fetch metrics or changelog if you already fetched them today
- If you already sent a preview and are waiting for approval, just wait. Do not resend
- If a task failed and you reported the error, do not retry until the next day unless Gilberts asks
