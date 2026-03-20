# Memory Architecture: The 4-Layer Memory Tower

An AI agent without memory makes the same mistakes every session. An agent with
too much memory drowns in noise and burns context window tokens on irrelevant
facts. The memory tower is a four-layer architecture that turns raw session data
into actionable principles through progressive refinement.

---

## Overview

```
         ┌─────────────────────────────┐
   L3    │        Principles           │   5-15 rules
         │  "Always validate inputs    │   Updated monthly
         │   before external calls"    │   Permanent until revoked
         ├─────────────────────────────┤
   L2    │        Patterns             │   20-50 entries
         │  "Billing API fails on      │   Updated weekly
         │   edge cases 3x/week"       │   Retained 6 months
         ├─────────────────────────────┤
   L1    │    Deduplicated Facts       │   100-500 entries
         │  "Billing API returns 500   │   Updated daily
         │   on over-refund"           │   Retained 90 days
         ├─────────────────────────────┤
   L0    │     Raw Extraction          │   Unlimited
         │  "2026-03-20 14:32 kira     │   Append-only
         │   billing 500 refund..."    │   Retained 30 days
         └─────────────────────────────┘
```

Each layer is smaller, more refined, and longer-lived than the one below it.
Raw data flows up; principles flow down into agent instructions.

---

## L0: Raw Extraction

**What it is:** Every observation, error, success, and anomaly from every
session, captured as atomic entries with timestamps and metadata.

**Purpose:** Complete record of what happened. No filtering, no judgment.

### Format

```jsonl
{"ts": "2026-03-20T14:32:00Z", "agent": "kira", "type": "error", "text": "Billing API returned 500 on refund request. Refund amount $150 exceeded original charge $120.", "tags": ["billing", "api", "refund"], "session": "s_4a21"}
{"ts": "2026-03-20T14:45:00Z", "agent": "kira", "type": "success", "text": "Customer found answer using KB article #221 (password reset)", "tags": ["kb", "self-service"], "session": "s_4a21"}
{"ts": "2026-03-20T15:10:00Z", "agent": "dash", "type": "observation", "text": "daily_active_users metric delayed by 12 minutes due to batch job overlap", "tags": ["metrics", "latency"], "session": "s_4a22"}
```

### Extraction Strategy

Extraction happens at two points:

**1. During operation (inline).** The agent recognizes something worth
remembering and writes it immediately.

```python
def on_error(error, context):
    append_l0({
        "ts": now(),
        "agent": agent_name,
        "type": "error",
        "text": f"{error.message}. Context: {context}",
        "tags": classify_tags(error),
        "session": current_session_id,
    })
```

**2. End of session (batch).** A post-session process scans the conversation
log and extracts facts the agent didn't explicitly capture.

```python
def extract_session_facts(conversation_log):
    """Use a cheap LLM to extract facts from a conversation."""
    prompt = f"""Extract factual observations from this session log.
    For each fact, provide: type (error/success/observation), text, tags.
    Only extract things worth remembering across sessions.
    Ignore routine successful operations.

    Session log:
    {conversation_log}
    """
    return call_llm(model="cheap", prompt=prompt)
```

### Storage

JSONL files are the simplest option. One file per day:

```
memory/
  l0/
    2026-03-18.jsonl    # 847 entries
    2026-03-19.jsonl    # 923 entries
    2026-03-20.jsonl    # 412 entries (day in progress)
```

**Why JSONL:** Append-only, no parse-the-whole-file overhead, trivially
splittable, grep-friendly.

### Retention

**30 days.** After 30 days, anything not promoted to L1 is deleted. This is
aggressive and intentional. L0 is a staging area, not an archive.

---

## L1: Deduplication

**What it is:** Unique facts derived from L0 by merging duplicate and near-
duplicate entries.

**Purpose:** Answer "what do we know?" without wading through thousands of
raw log lines.

### The Deduplication Process

A nightly job reads all L0 entries from the past 24 hours and compares them
against existing L1 facts.

```python
def deduplicate_l0_to_l1(l0_entries, existing_l1):
    """Merge new L0 entries into L1 facts."""
    for entry in l0_entries:
        match = find_similar(entry["text"], existing_l1, threshold=0.85)
        if match:
            # Update existing fact
            match["count"] += 1
            match["last_seen"] = entry["ts"]
            match["agents"] = list(set(match["agents"] + [entry["agent"]]))
        else:
            # Create new fact
            existing_l1.append({
                "id": generate_id(),
                "text": entry["text"],
                "type": entry["type"],
                "tags": entry["tags"],
                "count": 1,
                "first_seen": entry["ts"],
                "last_seen": entry["ts"],
                "agents": [entry["agent"]],
                "severity": classify_severity(entry),
            })
    return existing_l1
```

### Similarity Matching

For `find_similar`, you have three options in increasing sophistication:

| Method                              | Speed  | Quality | Setup                    |
| ----------------------------------- | ------ | ------- | ------------------------ |
| Exact substring match               | Fast   | Low     | None                     |
| Fuzzy string matching (Levenshtein) | Fast   | Medium  | `pip install thefuzz`    |
| Embedding similarity (cosine)       | Slower | High    | Embedding model required |

**Start with fuzzy matching.** It catches "Billing API 500 on refund" and
"Billing API returned 500 error for refund request" as the same fact. Move to
embeddings when you have 1000+ L1 facts and fuzzy matching produces too many
false negatives.

### Format

```yaml
# memory/l1/facts.yaml
- id: f_001
  text: "Billing API returns 500 when refund amount exceeds original charge"
  type: error
  tags: [billing, api, validation]
  count: 7
  first_seen: "2026-03-12"
  last_seen: "2026-03-20"
  agents: [kira, dash]
  severity: high

- id: f_002
  text: "Password reset emails take 2-5 minutes to deliver"
  type: observation
  tags: [auth, email, latency]
  count: 12
  first_seen: "2026-02-28"
  last_seen: "2026-03-19"
  agents: [kira]
  severity: low

- id: f_003
  text: "Dashboard page load degrades between 09:00-10:00 due to batch jobs"
  type: observation
  tags: [performance, scheduling]
  count: 20
  first_seen: "2026-02-15"
  last_seen: "2026-03-20"
  agents: [kira, dash]
  severity: medium
```

### Retention

**90 days since last seen.** If a fact hasn't been observed in 90 days, it's
archived (not deleted -- moved to a cold storage directory). If it resurfaces,
it gets un-archived.

---

## L2: Pattern Recognition

**What it is:** Clusters of related L1 facts that reveal recurring themes.

**Purpose:** Answer "what keeps happening?" and "what should we fix
systemically?"

### The Pattern Extraction Process

Weekly, a process reads all L1 facts and groups them into patterns. This is
where an LLM adds real value.

```python
def extract_patterns(l1_facts):
    """Use LLM to identify patterns across facts."""
    # Filter to facts seen 3+ times (ignore one-offs)
    recurring = [f for f in l1_facts if f["count"] >= 3]

    prompt = f"""Analyze these {len(recurring)} recurring observations and identify patterns.

A pattern is: a theme that appears across multiple observations, suggesting
a systemic issue or opportunity.

For each pattern, provide:
- pattern: one-sentence description
- evidence: which facts support this pattern (reference by id)
- frequency: how often this occurs
- recommendation: what should be done about it

Facts:
{format_facts(recurring)}
"""
    return call_llm(model="cheap", prompt=prompt)
```

### Format

```yaml
# memory/l2/patterns.yaml
- id: p_001
  pattern: "External API calls fail when inputs contain edge-case values"
  evidence:
    - f_001: "Billing API 500 on over-refund (7 occurrences)"
    - f_017: "Shipping API 422 on zero-weight items (4 occurrences)"
    - f_031: "Auth API timeout on special chars in password (3 occurrences)"
  frequency: "~14 incidents across 3 APIs in 30 days"
  recommendation: "Add input validation layer before all external API calls"
  confidence: high
  created: "2026-03-15"
  last_reviewed: "2026-03-20"

- id: p_002
  pattern: "System performance degrades during morning batch window"
  evidence:
    - f_003: "Dashboard slow 09:00-10:00 (20 occurrences)"
    - f_044: "Report generation timeout during peak hours (6 occurrences)"
  frequency: "Daily, 09:00-10:00"
  recommendation: "Move batch jobs to 06:00 or add resource limits"
  confidence: high
  created: "2026-03-08"
  last_reviewed: "2026-03-20"
```

### Human Review

L2 patterns should be reviewed by a human (or a more capable AI model) before
they influence agent behavior. The LLM that generates patterns can hallucinate
connections that don't exist. A human glance catches:

- False patterns (correlation without causation)
- Stale patterns (the underlying issue was fixed)
- Merged patterns (two distinct issues lumped together)

### Retention

**6 months.** Review quarterly. Remove patterns whose underlying L1 facts have
all been archived.

---

## L3: Principles

**What it is:** The highest-confidence lessons distilled from patterns. These
are the rules that get embedded into agent instructions.

**Purpose:** Answer "what should we always do?" and "what should we never do?"

### Characteristics of Good Principles

A principle must be:

1. **Actionable.** An agent can immediately apply it without additional context.
2. **Derived from evidence.** It traces back to specific L2 patterns and L1 facts.
3. **Falsifiable.** You can imagine a situation where it would be wrong (and
   explicitly note that exception).

Bad principle: "Be careful with APIs."
Good principle: "Always validate that input values are within documented ranges
before calling external APIs. Exception: health check endpoints, which accept
no input."

### Format

```markdown
# Principles (updated 2026-03-01)

## Input Handling

1. **Always validate inputs before external API calls.**
   Derived from: p_001 (14 incidents across 3 APIs).
   Exception: Health check endpoints.

2. **Assume documentation is wrong -- verify rate limits empirically.**
   Derived from: p_007 (documented 200/min, actual 100/min).
   First 24 hours with a new API: log actual limits.

## Scheduling

3. **Never run batch operations during peak hours (09:00-10:00).**
   Derived from: p_002 (daily degradation).
   If unavoidable: add resource limits and alert on slow queries.

## Communication

4. **Customer-facing errors must never expose internal system names.**
   Derived from: p_012 (3 incidents of internal error messages shown to users).
   Use generic messages: "Something went wrong. Our team has been notified."

5. **When in doubt about data access permissions, decline and escalate.**
   Derived from: p_015 (2 near-miss data exposure incidents).
   Better to delay a response than to leak data.
```

### How Principles Flow Back Down

L3 principles don't sit in a file and get forgotten. They flow back into the
system:

```
L3 Principles
    │
    ├──→ CONSTITUTION.md  (hard rules become MUST/NEVER statements)
    ├──→ SOUL.md          (soft guidelines become personality traits)
    ├──→ Code changes      (validation logic, rate limiters)
    └──→ Monitoring rules  (new health checks, alert conditions)
```

When a new principle is added:

1. Update the relevant agent's CONSTITUTION.md
2. If the principle implies a code change, create a ticket
3. If the principle implies a monitoring gap, add a health check

### Retention

**Indefinite.** Principles are only removed by explicit human decision, with a
documented reason.

---

## Implementation Roadmap

### Phase 1: Start Simple (Week 1)

- Implement L0 as JSONL files (append-only, one per day)
- Add end-of-session extraction (cheap LLM or regex-based)
- Set up a 30-day pruning cron job

### Phase 2: Add Deduplication (Week 2-3)

- Implement L1 with fuzzy string matching
- Nightly dedup job that promotes L0 to L1
- Simple search CLI: `search_memory "billing API"`

### Phase 3: Pattern Recognition (Week 4-6)

- Weekly L2 extraction using LLM
- Human review workflow (output to a file, human marks approved/rejected)
- Connect approved patterns to agent instructions

### Phase 4: Full Tower (Month 2+)

- L3 principle extraction (monthly, human-reviewed)
- Automated CONSTITUTION.md updates from approved principles
- Vector database for L1 semantic search (when you hit 1000+ facts)
- Cross-agent memory sharing through the bulletin

---

## Implementation Options

### File-Based (Recommended Starting Point)

```
memory/
  l0/
    2026-03-18.jsonl
    2026-03-19.jsonl
    2026-03-20.jsonl
  l1/
    facts.yaml
  l2/
    patterns.yaml
  l3/
    principles.md
  archive/
    l0/                     # Entries older than 30 days
    l1/                     # Facts not seen in 90 days
```

**Pros:** Debuggable (read with any text editor), version-controllable (git),
no infrastructure dependencies.

**Cons:** Linear search (fine up to ~1000 L1 facts), no semantic matching.

### Vector Database

Replace L1 storage with a vector database (LanceDB, Qdrant, Chroma) for
semantic search.

```python
# Store
db.add(text="Billing API returns 500 on over-refund",
       metadata={"type": "error", "agent": "kira", "severity": "high"})

# Search (semantic)
results = db.search("payment processing failures", top_k=10)
# Returns: billing API 500, Stripe webhook timeout, refund race condition
```

**When to switch:** When you have 500+ L1 facts and keyword search misses
relevant results. Not before.

### Hybrid (Production Recommendation)

| Layer | Storage        | Search             | Reason                              |
| ----- | -------------- | ------------------ | ----------------------------------- |
| L0    | JSONL files    | Grep / date filter | High volume, write-optimized        |
| L1    | Vector DB      | Semantic search    | Needs fuzzy matching at scale       |
| L2    | YAML files     | Manual review      | Low volume, needs human readability |
| L3    | Markdown (git) | Read in full       | Tiny, version-controlled, permanent |

---

## When to Forget

Memory without forgetting is hoarding. These are the pruning rules:

| Layer | TTL                     | Trigger          | Action                         |
| ----- | ----------------------- | ---------------- | ------------------------------ |
| L0    | 30 days                 | Nightly cron     | Delete (not archive)           |
| L1    | 90 days since last seen | Weekly cron      | Archive to cold storage        |
| L2    | 6 months                | Quarterly review | Remove if evidence is archived |
| L3    | Indefinite              | Human decision   | Document reason for removal    |

### What Pruning Looks Like

```python
def prune_l0(l0_dir, max_age_days=30):
    """Delete L0 files older than max_age_days."""
    cutoff = datetime.now() - timedelta(days=max_age_days)
    for path in l0_dir.glob("*.jsonl"):
        file_date = datetime.strptime(path.stem, "%Y-%m-%d")
        if file_date < cutoff:
            path.unlink()
            log(f"Pruned L0: {path.name}")

def archive_cold_l1(facts, archive_dir, stale_days=90):
    """Move L1 facts not seen in stale_days to archive."""
    cutoff = datetime.now() - timedelta(days=stale_days)
    active, cold = [], []
    for fact in facts:
        if datetime.fromisoformat(fact["last_seen"]) < cutoff:
            cold.append(fact)
        else:
            active.append(fact)

    if cold:
        archive_path = archive_dir / f"l1-archived-{date.today()}.yaml"
        save_yaml(archive_path, cold)
        log(f"Archived {len(cold)} cold L1 facts")

    return active
```

### The Cost of Not Pruning

An agent with 10,000 L0 entries and 2,000 L1 facts will:

- Spend 30+ seconds loading memory at session start
- Burn thousands of context tokens on irrelevant facts
- Return noisy search results (signal-to-noise ratio drops)
- Eventually hit context window limits

Pruning is not data loss. It is signal preservation.

---

## Measuring Memory Quality

How do you know if your memory system is working?

| Metric                 | Healthy Range | What It Means                                             |
| ---------------------- | ------------- | --------------------------------------------------------- |
| L0 entries/day         | 50-500        | Too low = not capturing. Too high = capturing noise.      |
| L0 → L1 promotion rate | 5-20%         | Most raw entries are routine. Only novel facts promote.   |
| L1 dedup ratio         | 2:1 to 5:1    | Multiple L0 entries per L1 fact. Higher = good dedup.     |
| L2 patterns            | 10-30 active  | Too few = not enough data. Too many = not merging enough. |
| L3 principles          | 5-15          | Enough to be useful. Not so many they're ignored.         |
| Search hit rate        | > 70%         | When an agent searches, it finds something relevant.      |
| Memory load time       | < 5s          | If loading memory takes longer, prune more aggressively.  |
