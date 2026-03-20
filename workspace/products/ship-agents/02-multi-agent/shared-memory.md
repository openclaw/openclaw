# Shared Memory for Multi-Agent Systems

Agents need to learn. But learning in a multi-agent system creates a tension:
share too much and you break identity isolation; share too little and agents
repeat each other's mistakes. This guide covers how to share knowledge without
sharing context.

---

## The Distinction: Knowledge vs. Context

**Context** is conversation-specific. "The user asked about their billing issue
with invoice #4421." This must never cross agent boundaries.

**Knowledge** is generalizable. "Our billing API returns a 422 when the
currency field is null." This should be shared -- every agent dealing with
billing benefits from knowing it.

The rule: **share the lesson, not the conversation that taught it.**

---

## Pattern 1: File-Based Memory (MEMORY.md)

Each agent maintains a `MEMORY.md` file in its workspace. This is the agent's
long-term memory -- facts, preferences, and lessons learned across sessions.

```markdown
# MEMORY -- Kira (Customer Support)

## Customer Patterns

- Most billing questions come in on Mondays (after weekend invoices)
- "Can't log in" is usually a password issue, not an account issue
- Enterprise customers prefer email follow-ups over chat

## System Quirks

- Billing API returns 422 when currency field is null (not 400)
- Password reset emails take 2-5 minutes, not instant
- Dashboard loading is slow between 9-10 AM (batch jobs running)

## Learned Preferences

- Keep responses under 100 words for simple questions
- Include KB article links when available
- Don't apologize more than once per conversation
```

**How agents use it:**

1. At session start, the agent reads its MEMORY.md
2. During operation, when the agent learns something worth keeping, it
   appends to MEMORY.md
3. Periodically (nightly), a maintenance process prunes duplicates and
   outdated entries

**Sizing constraint:** Keep MEMORY.md under 200 lines. When it grows past that,
move detailed content into topic-specific files and keep MEMORY.md as an index:

```markdown
# MEMORY -- Kira (Customer Support)

## Index

- [billing-quirks.md](billing-quirks.md) -- Billing API edge cases
- [customer-patterns.md](customer-patterns.md) -- Behavioral patterns
- [escalation-log.md](escalation-log.md) -- Past escalations and outcomes
```

---

## Pattern 2: Experience Capture

When an agent fails -- hits an error, gives a wrong answer, discovers an
undocumented edge case -- that failure should be captured as a searchable
experience.

Each experience has four fields:

| Field           | Purpose           | Example                                            |
| --------------- | ----------------- | -------------------------------------------------- |
| **Phenomenon**  | What happened     | "Billing API returned 500 on refund request"       |
| **Cause**       | Why it happened   | "Refund amount exceeded original charge"           |
| **Solution**    | How to fix it     | "Validate refund <= charge before calling API"     |
| **Methodology** | General principle | "Always validate inputs before external API calls" |

**Storage options:**

```bash
# Simple: append to a JSONL file
echo '{"phenomenon": "...", "cause": "...", "solution": "...", "tags": ["billing", "api"]}' \
  >> experiences.jsonl

# Better: CLI tool that handles formatting and search
save_experience \
  -p "Billing API returned 500 on refund" \
  -c "Refund exceeded original charge" \
  -s "Validate refund amount first" \
  -m "Always validate inputs before external calls" \
  -t "billing,api,validation" \
  --severity critical
```

**Search before acting:**

```bash
# Before touching the billing API, check what we've learned
search_experience "billing API refund"

# Results:
# [2026-02-14] severity=critical tags=billing,api
#   Phenomenon: Billing API returned 500 on refund request
#   Solution: Validate refund <= charge before calling API
```

The cognitive discipline is: **search before you act, save after you fail.**
Build this into your agent's operating loop, not as an afterthought.

---

## Pattern 3: The Bulletin Board (Cross-Agent State)

The bulletin (covered in detail in [orchestration-pattern.md](orchestration-pattern.md))
is where agents share real-time state. But it also serves as a shared learning
channel:

```markdown
## Shared Learnings

- API rate limit is 100/min, not 200/min as documented
- Customer "Acme Corp" has two accounts -- always check both
- Deploy on Fridays triggers a 10-min cache warm-up delay
```

Shared learnings are **generic by design**. They contain no customer-specific
data, no conversation content, no agent-specific context. Any agent in the
system should be able to read them and benefit.

---

## The Memory Tower: L0 through L3

Raw experiences are noisy. The same lesson appears five times with slightly
different wording. Patterns emerge only when you step back and look across
dozens of experiences. The memory tower is a four-layer architecture that
progressively refines raw data into reusable principles.

```
┌─────────────────────────────────────────────────┐
│  L3: Principles                                 │
│  "Always validate inputs before external calls" │
│  (5-10 statements, updated monthly)             │
├─────────────────────────────────────────────────┤
│  L2: Patterns                                   │
│  "Billing API fails on edge cases 3x/week"      │
│  (20-50 entries, updated weekly)                 │
├─────────────────────────────────────────────────┤
│  L1: Deduplicated Facts                         │
│  "Billing API returns 500 on over-refund"        │
│  (100-500 entries, updated daily)               │
├─────────────────────────────────────────────────┤
│  L0: Raw Extraction                             │
│  "2026-03-20 14:32 agent=kira billing 500 ..."   │
│  (unlimited, append-only, pruned after 30 days) │
└─────────────────────────────────────────────────┘
```

### L0: Raw Extraction

Every session produces raw observations. These are timestamped, tagged, and
dumped into a log. No filtering, no judgment.

```
2026-03-20 14:32 agent=kira type=error billing API 500 on refund $150 > $120 charge
2026-03-20 15:01 agent=kira type=success customer found answer in KB article #221
2026-03-20 15:44 agent=dash type=observation daily_active_users metric delayed by 12 min
```

**Retention:** 30 days. After that, anything not promoted to L1 is discarded.

### L1: Deduplication

A nightly process scans L0 entries and merges similar ones. Five instances of
"billing API 500 on refund" become one fact with a count.

```yaml
- fact: "Billing API returns 500 when refund exceeds original charge"
  count: 5
  first_seen: 2026-03-15
  last_seen: 2026-03-20
  agents: [kira, dash]
  severity: high
```

**Implementation:** This can be done with simple string similarity (fuzzy
matching on phenomenon text) or with an LLM that clusters related entries.
Start simple.

### L2: Pattern Recognition

Weekly, a process looks across L1 facts and asks: "What keeps happening?"

```yaml
- pattern: "External API calls fail on input edge cases"
  evidence:
    - "Billing API 500 on over-refund (5 occurrences)"
    - "Shipping API 422 on zero-weight items (3 occurrences)"
    - "Auth API timeout on special characters in password (2 occurrences)"
  frequency: "~10 incidents/week"
  recommendation: "Add input validation layer before all external API calls"
```

An LLM is useful here. Feed it 50 L1 facts and ask: "What patterns do you see?
What keeps failing for the same reason?" A cheap model works fine -- this is
pattern matching, not creative reasoning.

### L3: Principles

Monthly (or on-demand), the highest-confidence patterns are distilled into
principles. These are the rules that should be baked into every agent's
CONSTITUTION or SOUL.

```markdown
## Principles (updated 2026-03-01)

1. Always validate inputs before making external API calls.
2. Assume documentation is wrong -- verify rate limits empirically.
3. Customer-facing errors should never expose internal system names.
4. When in doubt about data access, decline and escalate.
5. Schedule batch operations outside peak hours (9-10 AM, 2-3 PM).
```

Principles are **small in number** (5-15), **high in confidence** (derived
from repeated patterns, not one-off incidents), and **actionable** (an agent
can immediately apply them).

---

## When to Share vs. When to Isolate

| Data Type              | Share?      | Mechanism                          |
| ---------------------- | ----------- | ---------------------------------- |
| System outage info     | Yes         | Bulletin alert                     |
| API quirks and bugs    | Yes         | Shared learnings / L1 facts        |
| Customer-specific data | **No**      | Agent's own memory only            |
| Conversation history   | **No**      | Never crosses agent boundary       |
| Operational principles | Yes         | L3 principles in each CONSTITUTION |
| Performance metrics    | Selectively | Bulletin (aggregated, no PII)      |
| Credentials            | **Never**   | Per-agent credential store         |

**The litmus test:** If this knowledge were posted on a public wiki, would it
cause harm? If yes, it stays in the agent's private memory. If no, it can be
shared.

---

## Implementation Options

### File-Based (Start Here)

```
workspace/
  BULLETIN.md                    # Cross-agent real-time state
  memory/
    experiences.jsonl             # L0 raw experiences
    facts.yaml                   # L1 deduplicated facts
    patterns.yaml                # L2 patterns
    principles.md                # L3 principles
  agents/
    kira-cs/
      MEMORY.md                  # Kira's private memory
    dash-analytics/
      MEMORY.md                  # Dash's private memory
```

**Pros:** Simple, debuggable, version-controllable with git.
**Cons:** Search is linear (fine up to ~1000 entries), no semantic matching.

### Vector Database (When File-Based Isn't Enough)

When you have 1000+ experiences and need semantic search ("find experiences
related to payment failures" should match "billing API 500" and "Stripe webhook
timeout"), add a vector store.

```python
# Embed and store
embedding = model.encode("Billing API returns 500 on over-refund")
db.insert({"text": "...", "embedding": embedding, "tags": ["billing"]})

# Semantic search
results = db.search("payment processing errors", top_k=5)
```

**Use vector DB for L0/L1** (high volume, needs search).
**Keep L2/L3 as files** (low volume, needs human readability).

### Hybrid (Recommended for Production)

- L0: Append-only JSONL files (cheap, fast writes)
- L1: Vector database with metadata filtering (semantic search)
- L2: YAML files reviewed by humans or LLM (patterns need judgment)
- L3: Markdown files committed to git (principles are code)

---

## When to Forget

Memory without pruning grows until it degrades performance. Old, irrelevant
memories dilute search results and waste context window tokens.

**Pruning rules:**

| Layer | Retention  | Pruning Strategy                               |
| ----- | ---------- | ---------------------------------------------- |
| L0    | 30 days    | Delete after promotion to L1 or expiry         |
| L1    | 90 days    | Archive if no occurrences in 60 days           |
| L2    | 6 months   | Review quarterly, remove if no longer relevant |
| L3    | Indefinite | Only removed by human decision                 |

**What triggers pruning:**

- A nightly job that deletes expired L0 entries
- A weekly job that archives cold L1 facts
- A monthly human review of L2 patterns
- L3 principles are sacred until explicitly revoked

**The danger of not pruning:** An agent with 10,000 L0 entries will spend
more time reading memory than doing its job. Aggressive pruning of raw data
is a feature, not a loss.
