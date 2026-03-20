# Orchestration Patterns for Multi-Agent Systems

Running one AI agent is straightforward. Running five simultaneously -- each with
its own responsibilities, context windows, and failure modes -- requires
deliberate architecture. This guide covers three orchestration patterns, when to
use each, and how to avoid the subtle bugs that only surface at 3 AM on a
Saturday.

## The Core Problem

Multiple agents running on the same machine will eventually:

1. **Write to the same file at the same time** (data corruption)
2. **Act on stale state** (agent A fixes something, agent B doesn't know)
3. **Duplicate work** (both agents respond to the same event)
4. **Starve each other** (one agent consumes all API quota)

Every orchestration pattern is a different answer to these four problems.

---

## Pattern 1: Peer-to-Peer (No Central Controller)

Each agent runs as an independent process. There is no orchestrator, no message
bus, no coordinator. Agents communicate through the filesystem.

```
┌──────────┐   ┌──────────┐   ┌──────────┐
│ Agent: CS │   │ Agent:   │   │ Agent:   │
│  Support  │   │ Analytics│   │ Ops      │
└─────┬─────┘   └─────┬────┘   └─────┬────┘
      │               │              │
      └───────────────┼──────────────┘
                      │
              ┌───────▼────────┐
              │  Shared        │
              │  Filesystem    │
              │  (BULLETIN.md, │
              │   MEMORY.md)   │
              └────────────────┘
```

**How it works:**

- Each agent has its own workspace directory (`agents/cs/`, `agents/analytics/`)
- A shared `BULLETIN.md` file at the root acts as a message board
- Agents read the bulletin at session start to catch up on state changes
- Agents append to the bulletin when they change something other agents
  should know about

**When to use it:**

- Agents have clearly separated domains (CS handles tickets, analytics
  handles dashboards -- no overlap)
- You want maximum simplicity and debuggability
- You can tolerate eventual consistency (agents might be seconds behind)

**When to avoid it:**

- Agents need to coordinate in real-time (e.g., one must wait for another)
- You have more than ~8 agents (the bulletin becomes noisy)

### Implementation: The Bulletin Board

The bulletin is a Markdown file with a simple structure:

```markdown
# BULLETIN -- Cross-Agent Shared State

> Last updated: 2026-03-20

## 2026-03-20

- [cs] Resolved 14 tickets, escalated 2 to engineering
- [analytics] Daily report generated, revenue up 12%
- [ops] Deployed v2.3.1, restarted cache layer

## Active Alerts

### [P1] Database replica lag > 30s

Detected 14:30. Analytics queries may return stale data.
Auto-resolve: monitoring replica sync.

## Shared Learnings

- API rate limit is 100/min, not 200/min as documented
- Customer "Acme Corp" has two accounts -- always check both
```

**Rules for the bulletin:**

1. **Append-only during a session.** Never edit or delete other agents' entries.
2. **Date-sectioned.** Each day gets its own heading. Old entries stay for
   context but can be pruned weekly.
3. **Prefixed by source.** Every line starts with `[agent-name]` so you can
   grep for a specific agent's updates.
4. **Alerts have priority levels.** `[P0]` = everything is on fire.
   `[P3]` = nice to know.

A simple CLI wrapper makes this ergonomic:

```bash
# Any agent can post
bulletin add "[cs] Escalated ticket #4421 to engineering"
bulletin alert "[P2] Payment gateway returning 503s intermittently"
bulletin learn "Retry logic needs jitter -- pure exponential causes thundering herd"

# Any agent reads at session start
bulletin show
```

### Filesystem Locking

Two agents writing to the same file simultaneously will corrupt it. Options:

| Strategy                               | Complexity | Reliability             |
| -------------------------------------- | ---------- | ----------------------- |
| Advisory lock (`flock`)                | Low        | Good for single-machine |
| Atomic write (write to tmp, then `mv`) | Low        | Excellent               |
| Agent-specific files, merged on read   | Medium     | Excellent               |

The atomic write pattern is the simplest reliable approach:

```python
import os, tempfile

def safe_write(path, content):
    """Write to a temp file, then atomically rename."""
    dir_name = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, path)
    except:
        os.unlink(tmp)
        raise
```

---

## Pattern 2: Hub-and-Spoke (Central Scheduler)

A lightweight scheduler process manages when each agent runs. Agents don't talk
to each other -- they talk to the scheduler.

```
                ┌───────────────┐
                │   Scheduler   │
                │  (cron-like)  │
                └──┬─────┬────┬┘
                   │     │    │
          ┌────────┘     │    └────────┐
          │              │             │
     ┌────▼────┐   ┌─────▼───┐  ┌─────▼────┐
     │ Agent A │   │ Agent B │  │ Agent C  │
     │ 07:00   │   │ */15min │  │ on-event │
     └─────────┘   └─────────┘  └──────────┘
```

**Configuration as YAML:**

```yaml
timezone: America/New_York
tasks:
  daily_report: { schedule: "07:00", enabled: true }
  health_check: { schedule: "every 15m", enabled: true }
  weekly_review: { schedule: "sunday 10:00", enabled: true }
  anomaly_scan: { schedule: "every 4h", enabled: true, ai_model: "cheap" }
```

**When to use it:**

- You need to control execution order (report generation before delivery)
- You want to enforce rate limits on AI API calls
- You need audit logs of what ran when

**When to avoid it:**

- The scheduler itself is a single point of failure
- Agents need to react to events faster than the schedule allows

### Budget-Aware Scheduling

AI agents burn money. The scheduler should enforce budgets:

```yaml
ai_budget:
  max_daily_calls: 50
  prefer_model: "cheap" # Use for routine tasks
  escalate_model: "expensive" # Only for anomalies
```

The scheduler tracks cumulative spend and refuses to run expensive tasks once the
daily budget is hit. Cheap triage first, expensive diagnosis only when needed.

---

## Pattern 3: Event-Driven (Pub/Sub)

Agents subscribe to events. When something happens, all interested agents are
notified.

```
┌──────────────────────────────────────────────┐
│                 Event Bus                     │
│  (file watcher / webhook / message queue)     │
└──┬────────────┬───────────────┬───────────────┘
   │            │               │
   ▼            ▼               ▼
 [new_ticket] [deploy]    [alert_fired]
   │            │               │
   ▼            ▼               ▼
 CS Agent    Ops Agent     On-Call Agent
```

**When to use it:**

- Agents need to react to external events (incoming messages, deployments,
  monitoring alerts)
- You want loose coupling -- adding a new agent shouldn't require changing
  existing ones
- Latency matters (sub-second reaction time)

**When to avoid it:**

- You're running on a single machine with < 5 agents (overkill)
- You don't have reliable event delivery (file watchers miss events under load)

---

## Choosing a Pattern

| Factor                  | Peer-to-Peer | Hub-and-Spoke | Event-Driven |
| ----------------------- | :----------: | :-----------: | :----------: |
| Setup complexity        |     Low      |    Medium     |     High     |
| Real-time coordination  |      No      |      No       |     Yes      |
| Budget control          |    Manual    |   Built-in    |    Manual    |
| Debugging ease          |     High     |     High      |    Medium    |
| Single point of failure |     None     |   Scheduler   |  Event bus   |
| Best for N agents       |     2-8      |     3-20      |      5+      |

**Most production systems start with peer-to-peer and add a scheduler when they
hit three or more timed tasks.** The event-driven pattern is worth the complexity
only when you need sub-second response to external events.

---

## Practical Checklist

Before running multiple agents in production:

- [ ] Each agent has its own workspace directory with clear boundaries
- [ ] No two agents write to the same file (use bulletin for shared state)
- [ ] API rate limits are enforced globally, not per-agent
- [ ] You can answer: "which agent changed this file?" (audit trail)
- [ ] Agent crash doesn't cascade (process isolation)
- [ ] You have a way to pause a single agent without stopping others
- [ ] Shared state (bulletin) has a pruning strategy (don't grow forever)
- [ ] You've tested: what happens when agent A is down for 2 hours?

---

## Anti-Patterns

**The God Orchestrator.** A central process that knows every agent's internals,
calls them as functions, and manages all state. This works until you have 4
agents, then collapses under its own complexity. Prefer dumb pipes and smart
agents.

**Shared Database as Message Bus.** Tempting, but databases are for state, not
for signaling. Agents polling a table for "new tasks" is slow, wasteful, and
hard to debug. Use files or actual message queues.

**Implicit Coordination.** Two agents that "happen to work" because of timing
(agent A always finishes before agent B starts). This breaks silently. Make
coordination explicit or accept that order doesn't matter.
