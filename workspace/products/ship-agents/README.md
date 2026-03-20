# Ship AI Agents to Production

Production-tested templates and architecture patterns for running AI agents 24/7. Extracted from a real system running 10+ agents across Telegram, LINE, and Discord for 3+ months.

---

## Quick Start: First Agent in 10 Minutes

```bash
# 1. Copy the agent workspace template into your project
cp -r templates/agent-workspace/ my-project/agents/my-agent/

# 2. Edit the SOUL.md to define your agent's identity
#    (open it -- every section has inline instructions)
$EDITOR my-project/agents/my-agent/SOUL.md

# 3. Copy the production CLAUDE.md into your project root
cp templates/CLAUDE.md.production my-project/CLAUDE.md

# 4. Edit the project context section at the top of CLAUDE.md
$EDITOR my-project/CLAUDE.md

# 5. Start Claude Code in your project directory
cd my-project && claude
```

That's it. Your agent now has identity, behavioral boundaries, memory management, and a health protocol. Read on to understand what each file does and how to customize them.

---

## Directory Structure

```
ship-agents/
├── README.md                          # You are here
├── SALES.md                           # Product description (for reference)
├── CLAUDE.md.production               # Production CLAUDE.md template
│                                      #   Copy this to your project root
│
├── templates/
│   ├── agent-workspace/               # Copy this per agent
│   │   ├── SOUL.md                    # Identity & personality
│   │   ├── CONSTITUTION.md            # Hard behavioral rules
│   │   ├── HEARTBEAT.md               # Liveness & status protocol
│   │   ├── MEMORY.md                  # Memory index & management
│   │   ├── TOOLS.md                   # Available tools & usage rules
│   │   └── memory/                    # Per-session memory files
│   │       └── TEMPLATE.md            # Memory entry template
│   │
│   ├── monitoring/
│   │   ├── daemon-blueprint.md        # Self-healing daemon architecture
│   │   ├── 4-layer-schedule.md        # Nightly / morning / scan / weekly
│   │   └── alert-escalation.md        # When and how to alert humans
│   │
│   └── multi-agent/
│       ├── bulletin-board.md          # Shared state pattern
│       ├── identity-isolation.md      # Keeping agents separate
│       └── orchestration.md           # Coordination patterns
│
├── examples/
│   ├── cs-agent/                      # Complete customer service agent
│   │   ├── SOUL.md
│   │   ├── CONSTITUTION.md
│   │   ├── HEARTBEAT.md
│   │   ├── MEMORY.md
│   │   ├── TOOLS.md
│   │   └── knowledge/                # Domain knowledge base
│   │       ├── faq.md
│   │       └── escalation-rules.md
│   │
│   └── data-analyst/                  # Complete data analyst agent
│       ├── SOUL.md
│       ├── CONSTITUTION.md
│       ├── HEARTBEAT.md
│       ├── MEMORY.md
│       ├── TOOLS.md
│       └── queries/                   # Example query patterns
│
├── patterns/
│   ├── memory-architecture.md         # 4-layer memory deep dive
│   ├── error-recovery.md              # What to do when things break
│   ├── context-window-management.md   # Keeping context under control
│   ├── session-continuity.md          # Surviving restarts & crashes
│   └── production-checklist.md        # Pre-deploy verification list
│
└── reference/
    ├── anti-patterns.md               # Common mistakes and how to avoid them
    ├── cost-optimization.md           # Keeping API costs sane
    └── scaling-guide.md               # From 1 agent to 10+
```

---

## Recommended Reading Order

### Day 1: Foundation (30 minutes)

1. **`CLAUDE.md.production`** -- Read the entire template. This is the backbone of everything else. Understand every section before you customize it.
2. **`templates/agent-workspace/SOUL.md`** -- How to define what an agent _is_.
3. **`templates/agent-workspace/CONSTITUTION.md`** -- How to define what an agent _must never do_.

### Day 2: Memory & Persistence (20 minutes)

4. **`patterns/memory-architecture.md`** -- The 4-layer system that lets agents learn across sessions.
5. **`patterns/session-continuity.md`** -- How to survive restarts without losing state.
6. **`patterns/context-window-management.md`** -- The #1 production problem you'll hit.

### Day 3: Operations (20 minutes)

7. **`templates/monitoring/daemon-blueprint.md`** -- Self-healing architecture.
8. **`patterns/error-recovery.md`** -- When (not if) things go wrong.
9. **`patterns/production-checklist.md`** -- Run this before you deploy.

### Day 4: Multi-Agent (when ready)

10. **`templates/multi-agent/identity-isolation.md`** -- Critical if running more than one agent.
11. **`templates/multi-agent/orchestration.md`** -- How agents coordinate.
12. **`templates/multi-agent/bulletin-board.md`** -- Shared state without shared context.

### Day 5: Learn from Examples

13. **`examples/cs-agent/`** -- Walk through a complete, working agent.
14. **`examples/data-analyst/`** -- A different archetype for comparison.

### Reference (as needed)

- **`reference/anti-patterns.md`** -- When you're stuck, check if you're doing something on this list.
- **`reference/cost-optimization.md`** -- When your API bill surprises you.
- **`reference/scaling-guide.md`** -- When one agent isn't enough.

---

## How to Customize for Your Use Case

### Step 1: Define the Job

Before touching any files, answer these questions:

- What does this agent DO? (one sentence)
- Who does it serve? (end users, internal team, other agents)
- What channels does it operate on? (chat, API, cron, manual trigger)
- What can go wrong? (list the top 3 failure modes)

### Step 2: Copy and Edit Templates

```bash
cp -r templates/agent-workspace/ your-project/agents/your-agent/
```

Edit in this order:

1. `SOUL.md` -- Fill in identity, domain expertise, communication style
2. `CONSTITUTION.md` -- Define the hard boundaries for your domain
3. `TOOLS.md` -- List what tools this agent can use and the rules for using them
4. `MEMORY.md` -- Set up the memory index structure
5. `HEARTBEAT.md` -- Define what "healthy" looks like for this agent

### Step 3: Set Up the Project CLAUDE.md

```bash
cp CLAUDE.md.production your-project/CLAUDE.md
```

Customize the `[PROJECT CONTEXT]` section. The rest of the template works out of the box -- adjust rules as you learn what your specific agents need.

### Step 4: Run the Production Checklist

Open `patterns/production-checklist.md` and go through every item before deploying.

### Step 5: Set Up Monitoring

Follow `templates/monitoring/daemon-blueprint.md` to create a lightweight daemon that watches your agents.

---

## FAQ

**Q: Can I use this with OpenAI / GPT instead of Claude?**
A: The architecture patterns (memory layers, monitoring, multi-agent coordination) are provider-agnostic. The CLAUDE.md template and agent workspace files are designed for Claude Code specifically, but the structure translates to any LLM-based agent system. You'd need to adapt the file conventions to your tool's equivalent.

**Q: Do I need to use all the files?**
A: No. Start with `CLAUDE.md.production` and one agent's `SOUL.md` + `CONSTITUTION.md`. Add layers as you need them. The system is modular -- every file is useful on its own.

**Q: My agent only runs on a cron schedule, not 24/7. Is this relevant?**
A: Yes. Cron-triggered agents need memory management and error recovery even more than always-on agents, because they have to rebuild context from scratch every run. The memory architecture and session continuity patterns are especially valuable for this.

**Q: How do I handle secrets and API keys?**
A: Never put secrets in CLAUDE.md or any agent workspace file. Use environment variables or a secrets manager. The CLAUDE.md template includes a section on this. Your agent files should reference secret _names_, not values.

**Q: What if I only need one agent, not ten?**
A: Start with one. The single-agent patterns (CLAUDE.md, SOUL.md, CONSTITUTION.md, memory architecture) are the core of this product. Multi-agent patterns are a bonus for when you scale.

**Q: I bought this and I'm stuck. Can I get help?**
A: Email the address in your purchase confirmation. No guaranteed response time, but real questions about implementation get real answers.

**Q: Will there be updates?**
A: Yes. The system this is extracted from is still running and still evolving. Updates are free forever.

---

## One Last Thing

The biggest mistake people make with AI agents is treating them like software. Software does exactly what you tell it. Agents have judgment, and judgment needs structure.

These templates are that structure. They don't constrain your agents -- they give them a framework to be reliably useful.

Ship something real.
