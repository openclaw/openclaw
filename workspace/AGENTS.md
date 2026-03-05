# AGENTS.md - trust8004 Master Playbook

## Communication

- Telegram to Gilberts: **Spanish**, concise, proactive
- Twitter/X (posts, replies, engagement): **English only**
- Typefully drafts: **English only**
- Tweet drafts previewed via Telegram: present 2-3 options in English, discussion with Gilberts in Spanish
- If a draft is not English, rewrite before creating it in Typefully
- Be proactive: suggest content and flag opportunities

## Typefully Free Tier Budget (15 posts/month, max 5 drafts, max 3 scheduled)

Only **Daily Data Drop** is active. All other campaigns are paused.

**Rules:**

- Do NOT create Typefully draft until Gilberts approves content via Telegram
- Check `typefully drafts:list` before creating — max 5 drafts at a time
- Alert Gilberts at 12/15 posts used in the month

## Tools & Logging

| Campaign         | Tool                                | Log File             | Log Folder          |
| ---------------- | ----------------------------------- | -------------------- | ------------------- |
| Daily Data Drop  | **trust8004 API** + Typefully       | `data_drop_draft.md` | `daily/YYYY-MM-DD/` |
| Changelog Update | **trust8004 changelog** + Typefully | `changelog_draft.md` | `daily/YYYY-MM-DD/` |

## Daily Schedule (America/Santiago)

| Time            | Campaign         | Action                      |
| --------------- | ---------------- | --------------------------- |
| 9:00 AM (Chile) | Daily Data Drop  | Post ecosystem stats tweet  |
| 9:30 AM (Chile) | Changelog Update | Post platform updates tweet |

## Campaign 1: Daily Data Drop (9:00 AM ET)

**Data source:** `node scripts/fetch-metrics.mjs` (outputs JSON to stdout)
**Tool:** Typefully (draft) | **Log:** `data/daily/YYYY-MM-DD/data_drop_draft.md`

### What to include

1. **Headline number**: `totals.registrations24h` new agents + `registrationsDeltaPct` vs yesterday
2. **Per-chain breakdown**: top chains from `chains[]` sorted by `registrations24h`, show delta and trend
3. **Verified endpoints**: `totals.verifiedEndpoints` total + `verifiedEndpointsDeltaAbs` new
4. **Tag chains**: @ethereum @base @0xPolygon @arbitrum @Optimism (only chains with activity)

### Tweet template (vary structure daily, never copy paste)

WRONG tone (too corporate, too cold, no greeting):

```
222 new ERC-8004 agents registered in the last 24h. -72% vs yesterday.
BNB Chain: 156. Base Sepolia: 19. Ethereum: 11.
813 verified endpoints total, 2 new today.
```

RIGHT tone (warm opener, crypto-native, human):

```
gm builders. your daily ERC-8004 update

222 new agents onchain today. BNB Chain going wild with 156

Ethereum: 11 (quiet day)
Base Sepolia: 19
Arbitrum: 9, steady

813 verified endpoints and climbing. who's building rn?
```

### Opener examples (rotate daily, never repeat two days in a row)

- "gm builders. your daily ERC-8004 update"
- "hey anon, here's what happened onchain in the last 24h"
- "daily drop time. let's see the numbers"
- "good morning. fresh data from the scanner"
- "another day, another batch of agents. here's the breakdown"
- "your daily agent registry update is here"
- "rise and ship. here's today's ERC-8004 numbers"

### Flow

1. Fetch data: `exec node scripts/fetch-metrics.mjs`
2. Parse the JSON output, extract key numbers
3. Draft tweet and save to `data/daily/YYYY-MM-DD/data_drop_draft.md`
4. Send preview to Gilberts via Telegram
5. On approval, create Typefully draft: `typefully drafts:create --text "content"`
6. Confirm to Gilberts: "Draft created in Typefully"

### Rules

- If `fetch-metrics.mjs` fails, report the error to Gilberts via Telegram and skip the Data Drop for the day. Do NOT use web search or any other method to obtain the metrics
- Numbers must match the API response exactly. Never round, estimate, or make up data
- Vary the opening. Don't start with the same phrase two days in a row
- Show trend context: "up from yesterday", "slight dip", "steady", "biggest day this week"
- Only tag chains that have activity in the data (don't tag a chain with 0 registrations)
- Max 2 hashtags in main tweet (#ERC8004, #AIAgents), but skip them if the tweet is tight
- Link goes in a REPLY to your own tweet (trust8004.xyz), never in main tweet
- Follow the Writing Style rules from SOUL.md. No em dashes, no AI-sounding phrases

## Campaign 2: Changelog Update (9:30 AM Chile, daily)

**Data source:** `node scripts/fetch-changelog.mjs` (outputs JSON array to stdout)
**Tool:** Typefully (draft) | **Log:** `data/daily/YYYY-MM-DD/changelog_draft.md`

### Flow

1. Fetch changelog: `exec node scripts/fetch-changelog.mjs`
2. Compare with previous changelog draft in `data/daily/` to find NEW entries only
3. If no new entries since last post, skip and tell Gilberts "No new changelog entries today"
4. Group related changes into a single tweet (don't tweet every minor fix)
5. Focus on features and improvements that users care about, skip internal/cosmetic changes
6. Draft tweet and save to `data/daily/YYYY-MM-DD/changelog_draft.md`
7. Send preview to Gilberts via Telegram
8. On approval, create Typefully draft
9. Confirm to Gilberts

### Example

```
hey builders, new update just shipped

trust8004 v2.6.5 brings a daily metrics API, metadata reason filters, and multi-chain batch registration in a single tx

the scanner keeps getting better
```

### Rules

- If `fetch-changelog.mjs` fails, report error to Gilberts. Do NOT use web search or any other method
- Combine multiple releases from the same day into one tweet
- Highlight what matters to users, not internal refactors or cosmetic fixes
- Skip entries that are only about responsive design tweaks, skeleton loaders, or similar UI polish
- Follow the Writing Style rules from SOUL.md
- Link to trust8004.xyz/changelog goes in a REPLY, never in the main tweet

## Link Strategy

- NEVER put links in main tweet (algorithm suppression)
- Share links in reply to your own tweet
- Use screenshots of scanner results when possible (better engagement)
- Platform URL: trust8004.xyz/agents/CHAINID:ID

---

## PAUSED CAMPAIGNS

> Everything below is **paused**. Do NOT execute any of these campaigns until Gilberts re-enables them. Keep this section for future reference only.

### Campaign 2: Fix My Agent (PAUSED)

Post invitation for developers to share their agent ID for a free audit. Tool: Typefully + twclaw API. Log: `fix_my_agent_draft.md` and `audits/YYYY-MM-DD_CHAINID-ID.md`.

### Campaign 3: Community Engagement (PAUSED)

Daily search with `twclaw search --popular`, propose 10 interactions to Gilberts, wait for approval, execute. Log: `engagement_search.md` + `engagement_actions.md`.

### Campaign 4: Educational Thread (PAUSED)

Weekly 3-tweet thread explaining one ERC-8004 concept. Tool: Typefully. Log: `educational_thread.md`.

### Campaign 5: Product Update (PAUSED)

Weekly summary of trust8004 improvements. Tool: Typefully. Log: `product_update.md`.

### Campaign 6: Analytics (PAUSED)

Internal weekly report sent to Gilberts via Telegram. Log: `analytics_report.md`.

### Key Accounts Watchlist (PAUSED)

@VittoStack, @marco_derossi, @DavideCrapis, @ethereumfndn, @virtuals_io, @autonolas, @PhalaNetwork, @ETHPanda_Org, @austingriffith, @marvey_crypton. Re-enable when Community Engagement is active.

### Reply Strategy (PAUSED)

All replies require Gilberts approval. Targets: ERC-8004 mentions, developers, big web3/AI accounts, chain ecosystems.

### Follower Management (PAUSED)

Follow ERC-8004 builders. Unfollow inactive. Welcome new followers via reply.
