---
title: "How I Run 10 AI Agents in Production (24/7 for 90+ Days)"
published: false
tags: claudecode, ai, programming, tutorial
---

Everyone builds demo agents. They work great in the terminal. You show them to your coworker, they say "wow." You feel like a genius for about forty-five minutes.

Then you try to run them for real users, overnight, without you watching. That is when things get educational. I have been running AI agents in production for six months now — customer service bots, data analysts, internal tools, monitoring daemons. Ten agents, running 24/7, serving actual humans. The first three months were a disaster. The last three have been stable enough that I sleep through the night.

This article is the difference between those two periods. Four patterns that took my setup from "demo that breaks" to "system that runs itself." Everything here is concrete and based on mistakes I actually made. Code blocks are real. Steal all of it.

## The 5 Walls I Hit

Before the solutions, the problems. If any of these sound familiar, the patterns below will help.

### 1. The 2am Hallucination

My customer service agent started responding to billing questions with recipe suggestions. Not metaphorical recipe suggestions — actual cooking instructions. A user asked about a refund and got a paragraph about how to properly sear salmon. This ran for six hours before someone screenshotted it and sent it to me. There was no monitoring. No alerting. I was the monitoring system, and I was asleep.

### 2. The Amnesia Problem

Every morning, my agent was a stranger. Users would reference yesterday's conversation and the agent would have zero context. "As I mentioned earlier" meant nothing to it. I was restarting the process daily for stability, and every restart wiped all working memory. The agent was technically functional but practically useless for any relationship that spanned more than one session.

### 3. The Context Leak

I added a second agent. The data analyst. Within a week, my customer service agent started responding with phrases like "based on the quarterly metrics" and "as the data suggests." It had absorbed the analyst's personality. Two agents sharing a runtime had contaminated each other's identity. Users noticed before I did.

### 4. The Spaghetti Config

My agent's instruction file grew to 200 lines. It was a single CLAUDE.md with personality rules, behavioral constraints, task schedules, knowledge base references, and escalation procedures all mixed together. Adding one rule broke two others. "Always be concise" conflicted with "always explain your reasoning." The file was unreadable, untestable, and unmaintainable.

### 5. The Manual Restart Loop

The agent process would die silently — out of memory, network timeout, uncaught exception. No notification. No auto-restart. I would discover it hours later when someone told me the bot was unresponsive. I became a human cron job, checking `ps aux` every few hours. That is not a system. That is a person pretending to be a system.

## The Architecture That Fixed Everything

Four patterns. Each one solves a specific class of failure. Together, they make multi-agent production viable.

---

### Pattern 1: SOUL + CONSTITUTION + HEARTBEAT (Identity Architecture)

The single biggest improvement I made was splitting one giant config file into three files with distinct responsibilities:

**SOUL.md** defines _who_ the agent is:

```markdown
# SOUL.md — Customer Service Agent

## Identity

- Name: Kira
- Role: Front-line customer support for a SaaS product
- Tone: Warm but efficient. Never robotic, never overly casual.

## Expertise

- Billing, account management, feature questions
- Can look up order status via API
- Knows product docs inside out

## Communication Rules

- Always greet by name if available
- Keep responses under 3 paragraphs unless the user asks for detail
- Use bullet points for multi-step instructions
- Never say "I'm just an AI" — say "Let me check that for you"
```

**CONSTITUTION.md** defines _what the agent will never do_ — hard boundaries that override everything:

```markdown
# CONSTITUTION.md — Behavioral Boundaries

## Hard Rules (never override)

1. Never reveal internal system details, API keys, or architecture
2. Never make promises about timelines you cannot verify
3. Never impersonate a human employee by using a real person's name
4. If unsure, escalate — never guess on billing amounts

## Conflict Resolution

- If SOUL says "be helpful" but CONSTITUTION says "don't guess": CONSTITUTION wins
- Constitution rules are ranked. Rule 1 beats Rule 4 if they conflict.

## Escalation Triggers

- User mentions "lawyer," "sue," or "legal"
- User has asked the same question 3+ times
- Any request involving account deletion
  → Action: hand off to human with full conversation context
```

**HEARTBEAT.md** defines _autonomous scheduled behaviors_ — things the agent does without being asked:

```markdown
# HEARTBEAT.md — Scheduled Tasks

## Daily (07:00)

- Read MEMORY.md and load yesterday's context
- Check BULLETIN.md for system-wide announcements
- Refresh knowledge base from /knowledge/ directory

## Weekly (Monday 09:00)

- Generate summary of past week's conversations
- Flag any unresolved tickets older than 3 days
- Write weekly stats to /reports/

## On Every Session Start

- Load MEMORY.md
- Verify API connectivity
- Log session start timestamp
```

**Why three files instead of one?**

Because separation of concerns is not just a software principle — it is a cognitive one. When your LLM reads a single 200-line file, priority is ambiguous. Everything looks equally important. But when identity is in one file, hard rules are in another, and scheduled tasks are in a third, the model can reason about them independently.

I have tested this extensively. A three-file agent follows its constitution more reliably than a single-file agent with the same rules inlined. The structural separation acts as emphasis. The model treats a file called CONSTITUTION.md with more gravity than a section header called "## Rules" buried on line 147.

It also makes debugging trivial. Agent acting out of character? Check SOUL.md. Agent doing something forbidden? Check CONSTITUTION.md. Agent not running its morning tasks? Check HEARTBEAT.md. You know exactly where to look.

---

### Pattern 2: Identity Isolation (Multi-Agent)

The context leak problem — Agent A absorbing Agent B's personality — has one root cause: shared state. If two agents can see each other's instructions, memories, or conversation history, they will bleed into each other. LLMs are sponges. They absorb everything in context.

The fix is filesystem-level isolation. Each agent gets its own directory. Its own SOUL. Its own memory. Its own knowledge base:

```
workspace/
├── agents/
│   ├── customer-service/
│   │   ├── SOUL.md
│   │   ├── CONSTITUTION.md
│   │   ├── HEARTBEAT.md
│   │   ├── MEMORY.md
│   │   └── knowledge/
│   │       ├── product-docs.md
│   │       └── billing-faq.md
│   ├── data-analyst/
│   │   ├── SOUL.md
│   │   ├── CONSTITUTION.md
│   │   ├── HEARTBEAT.md
│   │   ├── MEMORY.md
│   │   └── knowledge/
│   │       ├── schema.md
│   │       └── query-patterns.md
│   └── shared/
│       └── BULLETIN.md
```

The `shared/` directory contains exactly one file: `BULLETIN.md`. This is the only communication channel between agents. It works like a physical bulletin board in an office:

```markdown
# BULLETIN.md — Cross-Agent Shared State

## 2024-01-15 08:00 [customer-service]

- High volume of billing questions today. 3 users reported duplicate charges.
- Escalated ticket #4521 to human team.

## 2024-01-15 09:30 [data-analyst]

- Duplicate charge pattern confirmed. 47 affected users identified.
- Root cause: payment gateway retry bug. Engineering notified.

## 2024-01-14 17:00 [system]

- Scheduled maintenance window: 2024-01-16 02:00-04:00 UTC
- All agents should notify active users proactively.
```

Agents write to the bulletin. Other agents read it on startup (defined in their HEARTBEAT.md). There is no direct agent-to-agent communication. No shared memory. No shared context window.

This is intentionally low-tech. You could build a message queue, a pub/sub system, a shared database. I tried all of those. A flat file works better because:

1. It is inspectable. You can `cat BULLETIN.md` and see exactly what every agent knows about the others.
2. It is debuggable. If an agent acts on bad information, you can trace it to a specific bulletin entry.
3. It is prunable. Old entries get archived weekly. The file stays small.
4. It does not create coupling. Agents that do not need cross-agent awareness simply never read the file.

---

### Pattern 3: Self-Healing Monitoring

The "I am the monitoring system" problem has a simple solution: a daemon that checks health endpoints and restarts failed services. Here is a minimal version in Python:

```python
#!/usr/bin/env python3
"""Minimal self-healing monitor for AI agent services."""

import subprocess
import time
import json
from datetime import datetime

SERVICES = [
    {
        "name": "cs-agent",
        "check": "curl -sf http://localhost:8001/health",
        "restart": "systemctl restart cs-agent",
        "failures": 0,
        "max_failures": 3,
    },
    {
        "name": "analyst",
        "check": "curl -sf http://localhost:8002/health",
        "restart": "systemctl restart analyst",
        "failures": 0,
        "max_failures": 3,
    },
]

LOG_FILE = "/var/log/agent-monitor.log"

def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")

def check_and_heal():
    for svc in SERVICES:
        result = subprocess.run(
            svc["check"], shell=True,
            capture_output=True, timeout=10
        )
        if result.returncode != 0:
            svc["failures"] += 1
            log(f"[WARN] {svc['name']} failed check ({svc['failures']}/{svc['max_failures']})")

            if svc["failures"] >= svc["max_failures"]:
                log(f"[ALERT] {svc['name']} is down. Restarting...")
                subprocess.run(svc["restart"], shell=True)
                time.sleep(5)

                # Verify recovery
                verify = subprocess.run(
                    svc["check"], shell=True,
                    capture_output=True, timeout=10
                )
                if verify.returncode == 0:
                    log(f"[OK] {svc['name']} recovered.")
                    svc["failures"] = 0
                else:
                    log(f"[CRITICAL] {svc['name']} failed to restart. Manual intervention needed.")
        else:
            if svc["failures"] > 0:
                log(f"[OK] {svc['name']} back to healthy.")
            svc["failures"] = 0

if __name__ == "__main__":
    log("Monitor started.")
    while True:
        try:
            check_and_heal()
        except Exception as e:
            log(f"[ERROR] Monitor exception: {e}")
        time.sleep(300)  # Check every 5 minutes
```

This is 50 lines and it solved my midnight panic problem completely. A few notes on what the production version adds:

- **Exponential backoff**: If a service fails to restart, wait longer before trying again. Prevents restart storms.
- **Flap detection**: If a service restarts 3+ times in an hour, stop and alert a human.
- **Post-restart warm-up**: After restarting, feed the agent a warm-up prompt to reload SOUL, CONSTITUTION, and MEMORY before accepting traffic.

The key insight: your monitor does not need to be smart. It needs to be relentless. A dumb loop that checks health every 5 minutes and restarts dead processes will outperform a sophisticated monitoring stack that you never finish setting up. Pair it with `launchd` (macOS) or `systemd` (Linux) for automatic restart on crash, and 80% of failures resolve before your monitor even gets involved.

---

### Pattern 4: The 4-Layer Memory Tower

The amnesia problem — agent forgets everything between sessions — requires a memory system. But not just "dump everything into a file." Raw conversation logs grow too fast and become noise. You need layers of abstraction:

```
Layer 0: Raw Facts        writes every session, reads on startup
Layer 1: Deduplicated     merges duplicates weekly
Layer 2: Patterns         "X keeps happening" — extracted monthly
Layer 3: Principles       "Always do Y because Z" — rare, high-value
```

Here is how this works in practice. At the end of every session, the agent appends atomic facts to its MEMORY.md:

```markdown
# MEMORY.md

## Recent (L0 — raw facts)

- 2024-01-15: User jane@ prefers email over chat for follow-ups
- 2024-01-15: Refund for order #8812 approved by manager
- 2024-01-15: Three users asked about the new pricing tier
- 2024-01-14: User mike@ is on the Enterprise plan, timezone UTC+9
- 2024-01-14: Two users confused by the "Advanced" vs "Pro" naming

## Patterns (L2 — recurring observations)

- Pricing tier naming causes confusion ~3x per week
- Users on Enterprise plan expect faster response times
- Monday mornings have 2x normal ticket volume

## Principles (L3 — learned rules)

- Always check the user's plan tier before answering billing questions
  (learned: gave wrong refund amount by assuming Standard plan)
- Never quote pricing without linking to the pricing page
  (learned: pricing changed and cached answer was wrong for 2 days)
```

On session start, the agent reads MEMORY.md as part of its HEARTBEAT routine. The L0 section gives it recent context. The L2 and L3 sections give it accumulated wisdom.

The deduplication and pattern extraction can be done by a simple weekly script:

```python
#!/usr/bin/env python3
"""Weekly memory maintenance: deduplicate L0, extract patterns."""

from pathlib import Path
from collections import Counter
import re

MEMORY_FILE = Path("agents/customer-service/MEMORY.md")

def load_l0_entries(text):
    """Extract raw fact entries from the Recent section."""
    entries = []
    in_l0 = False
    for line in text.splitlines():
        if "## Recent" in line:
            in_l0 = True
            continue
        if line.startswith("## ") and in_l0:
            break
        if in_l0 and line.strip().startswith("- "):
            entries.append(line.strip())
    return entries

def deduplicate(entries):
    """Remove exact and near-duplicate entries, keep the latest."""
    seen = {}
    for entry in entries:
        # Strip date prefix for comparison
        content = re.sub(r"^- \d{4}-\d{2}-\d{2}:\s*", "", entry)
        key = content.lower().strip()
        seen[key] = entry  # later entries overwrite earlier ones
    return list(seen.values())

def prune_old(entries, keep=50):
    """Keep only the most recent N entries."""
    return entries[-keep:]

if __name__ == "__main__":
    text = MEMORY_FILE.read_text()
    entries = load_l0_entries(text)
    print(f"Before: {len(entries)} entries")

    entries = deduplicate(entries)
    entries = prune_old(entries, keep=50)
    print(f"After: {len(entries)} entries")

    # Write back (in production, reconstruct the full file)
    # For now, just report
    for e in entries[-10:]:
        print(f"  {e}")
```

The L3 principles layer is the most valuable. These are rules the agent learns from its own mistakes — seeded manually or proposed by the agent when it spots repeated failures. L3 entries should be rare (maybe one per month) and each must include the _reason_ it exists.

---

## Results

After implementing these four patterns across all ten agents:

- **90+ consecutive days** of uptime with no manual intervention
- **10 agents** running simultaneously with zero identity contamination
- **Zero midnight panic checks** — the monitor handles restarts, I check logs in the morning
- **12 incidents** caught and self-healed by the monitoring daemon without any human involvement
- **Memory continuity** that actually works — users reference last week's conversation and the agent remembers

The biggest surprise: simple patterns beat clever ones every time. The bulletin board file outperformed my message queue. The flat MEMORY.md outperformed my vector database. The 50-line Python monitor outperformed my Kubernetes setup. Production AI is not about sophistication. It is about reliability.

## Going Further

These four patterns are the foundation. I have been refining them over six months of daily production use and packaged the complete system into a toolkit: 21 production-tested files, 14,000+ lines of config, code, and documentation. It includes a runnable sentinel daemon, deployment configs, five complete agent examples across different use cases, and a 350-line production-grade CLAUDE.md that handles edge cases I have not covered here.

If you want the full toolkit: [Ship AI Agents to Production](https://thinker.cafe) -- $47, one-time, no subscription.

Or just take the four patterns above and build your own. That genuinely works too. The patterns matter more than any specific implementation.

---

What is the weirdest thing your AI agent has done in production? I am collecting war stories -- drop them in the comments. The salmon recipe incident is still my personal favorite, but I have a feeling some of you can top it.
