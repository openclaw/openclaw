# Data Logging — trust8004 Community Manager

This folder contains all structured logs from the trust8004 CM operations: searches, engagement actions, content drafts, audits, and reports.

## Folder Structure

```
data/
├── daily/
│   └── YYYY-MM-DD/
│       ├── engagement_search.md        # Keyword search results from X
│       ├── engagement_actions.md       # Likes, replies, follows of the day
│       ├── data_drop_draft.md          # Data drop content draft
│       └── mentions.md                 # Mentions found
├── weekly/
│   └── YYYY-WNN/
│       ├── analytics_report.md         # Weekly analytics report
│       ├── educational_thread.md       # Educational thread content
│       └── product_update.md           # Product update content
├── audits/
│   └── YYYY-MM-DD_CHAINID-ID.md       # Individual agent audits
└── README.md                           # This file
```

## Naming Conventions

| Element       | Pattern                        | Example                 |
| ------------- | ------------------------------ | ----------------------- |
| Daily folder  | `YYYY-MM-DD`                   | `2026-02-14`            |
| Weekly folder | `YYYY-WNN` (ISO week)          | `2026-W07`              |
| File names    | `type_subtype.md` (snake_case) | `engagement_search.md`  |
| Audit files   | `YYYY-MM-DD_CHAINID-ID.md`     | `2026-02-14_8453-42.md` |

## File Header Template

Every file MUST start with this header:

```markdown
# [Type] — [Date]

## Generated: YYYY-MM-DD HH:MM ET
```

## What Gets Logged

| Activity                    | File                       | Folder              |
| --------------------------- | -------------------------- | ------------------- |
| Keyword search results on X | `engagement_search.md`     | `daily/YYYY-MM-DD/` |
| Likes, replies, follows     | `engagement_actions.md`    | `daily/YYYY-MM-DD/` |
| Data Drop content           | `data_drop_draft.md`       | `daily/YYYY-MM-DD/` |
| Mentions found              | `mentions.md`              | `daily/YYYY-MM-DD/` |
| Weekly analytics report     | `analytics_report.md`      | `weekly/YYYY-WNN/`  |
| Educational thread          | `educational_thread.md`    | `weekly/YYYY-WNN/`  |
| Product update              | `product_update.md`        | `weekly/YYYY-WNN/`  |
| Fix My Agent audit          | `YYYY-MM-DD_CHAINID-ID.md` | `audits/`           |

## Rules

- Create folders on demand — do not pre-create empty folders
- Always use the header template on every file
- If a log file does not exist yet, create it first with the header template, then append entries
- If the same activity runs multiple times in a day, append to the existing file
- Keep files concise but complete — data over prose
- Timestamps in ET (America/New_York)

## Data Hygiene — Keep It Lean

Disk space is limited. Every file must be **precise and concise**.

### Size Limits Per File

| File type               | Max size guideline                                            |
| ----------------------- | ------------------------------------------------------------- |
| `engagement_search.md`  | Top 10 relevant results only — username, link, 1-line summary |
| `engagement_actions.md` | One line per action: `[like/reply/follow] @user — reason`     |
| `data_drop_draft.md`    | Final draft text only — no brainstorming or alternatives      |
| `mentions.md`           | Username + link + 1-line context, skip irrelevant/spam        |
| `analytics_report.md`   | Numbers and bullet points, no narrative paragraphs            |
| `educational_thread.md` | Final thread text only                                        |
| `product_update.md`     | Final tweet text only                                         |
| Audit files             | 10-15 lines max: findings + 1 actionable tip                  |

### What NOT to Log

- Raw HTML or full-page content
- Screenshots (reference them by description, don't embed)
- Duplicate entries — check before appending
- Tweets that aren't relevant to ERC-8004
- Verbose explanations — use bullet points

### Retention Policy

- **Daily folders older than 14 days**: Delete (data already summarized in weekly reports)
- **Weekly folders older than 8 weeks**: Delete
- **Audit files older than 30 days**: Delete
- Run cleanup during Monday morning routine
