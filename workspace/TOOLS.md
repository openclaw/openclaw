# TOOLS.md - Technical Reference

## Environment

- Running on Dokploy (Docker container)
- Connected via Telegram for communication with Gilberts
- Typefully skill installed via clawhub

## Tool 1: Typefully (Publishing)

### Free Tier Limits

| Resource    | Limit           |
| ----------- | --------------- |
| Posts/month | **15**          |
| Scheduled   | **3** at a time |
| Drafts      | **5** at a time |

- Do NOT create draft until Gilberts approves via Telegram
- Check `typefully drafts:list` before creating — max 5
- Alert Gilberts at 12/15 posts used
- ALWAYS draft, NEVER publish directly. NEVER use `--now`

### Commands

```bash
typefully config:show
typefully social-sets:list
typefully config:set-default <social_set_id>
typefully drafts:create --text "Tweet content"
typefully drafts:create --text $'1/ First\n\n\n\n2/ Second\n\n\n\n3/ Third'
typefully drafts:list
typefully drafts:list --status scheduled
```

### Draft Rules

- Draft text must be **English only**
- Threads: 4 line breaks between tweets, numbered `1/`, `2/`, `3/`
- Save locally in `data/daily/YYYY-MM-DD/` or `data/weekly/YYYY-WNN/` before creating draft

## Tool 2: trust8004 API (Ecosystem Metrics)

```bash
exec node scripts/fetch-metrics.mjs
```

Outputs JSON to stdout. Uses headless Chromium to bypass Vercel bot-protection.

Response fields:

- `totals.registrations24h` / `registrationsDeltaPct` — new agents + % change vs previous day
- `totals.verifiedEndpointsTotal` / `verifiedEndpointsDeltaAbs` — verified endpoints + delta
- `chains[]` — per-chain breakdown: registrations, delta, trend (up/down/stable), verified endpoints
- `topChainsByRegistrations24h` — sorted ranking

Numbers must match the API exactly.

### Changelog

```bash
exec node scripts/fetch-changelog.mjs
```

Returns JSON array of `{ date, version, type, title, description, highlights }`. Use when Gilberts asks for platform updates or to tweet about new releases.

## Tool 3: Data Logging

All data saved in `data/`. Active log: `data/daily/YYYY-MM-DD/data_drop_draft.md`.

Every file starts with `# [Type] — [Date]` header. Keep files lean: bullets, not paragraphs.

**Retention (Monday mornings):** daily >14 days — delete.
**X Policy:** Do NOT store full tweet text. Log only: tweet ID/URL, author handle, 1-line summary.

## Agent Format

**`CHAINID:ID`** — e.g., `8453:42`. URL: `https://www.trust8004.xyz/agents/CHAINID:ID`

| Chain        | ID       | Chain     | ID    |
| ------------ | -------- | --------- | ----- |
| Ethereum     | 1        | BNB Chain | 56    |
| Polygon      | 137      | Optimism  | 10    |
| Arbitrum One | 42161    | Celo      | 42220 |
| Base Sepolia | 84532    | Gnosis    | 100   |
| Eth Sepolia  | 11155111 | Avalanche | 43114 |
| Abstract     | 2741     | Linea     | 59144 |

## ERC-8004 Key Concepts

- **Identity Registry**: On-chain registration per chain, points to agentURI
- **agentURI**: Off-chain JSON with services, endpoints, capabilities
- **Reputation**: feedback.value/valueDecimals scores + tags
- **Endpoint Verification**: trust8004 checks if endpoints respond
- **Trust Signals**: Identity verification, endpoint health, reputation, cross-chain presence

## Content Tips

- Screenshots > raw links for engagement
- Links in replies, never in main tweets
- Use CHAINID:ID format consistently
