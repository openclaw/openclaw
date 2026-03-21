# Show HN Submission

**Title:** Show HN: Production-tested architecture files for running AI agents 24/7

**URL:** https://thinker.cafe

---

**Body:**

I've been running 10 AI agents (Claude Code-based) in production for 90+ days on a single Mac Mini. After stabilizing the system, I extracted the architecture into 21 reusable files.

This is not a framework, not a SaaS, not a library. It's the actual configuration files, templates, and scripts I use — cleaned up and documented.

**What's in the 21 files:**

- SOUL.md / CONSTITUTION.md / HEARTBEAT.md templates — identity architecture that prevents agent drift
- Python sentinel daemon config — 4-layer monitoring (nightly ops, morning briefs, anomaly scans, weekly reviews)
- 4-layer memory tower architecture — session, daily, weekly, long-term with semantic search
- Deployment scripts and Docker Compose setup
- Workspace structure templates for multi-agent coordination

**Key differentiator:** These files were extracted from a system that has been running continuously for 3 months, not assembled from tutorials or documentation. Every pattern exists because something broke without it.

**What's free:**

- A deployment checklist covering the core patterns: https://thinkercruz.gumroad.com/l/ecxyi
- A Dev.to article walking through the 4 foundational patterns

**What's paid ($47):**

The full 21-file system with the sentinel daemon, memory architecture, identity templates, and deployment configs.

**Tech details:**

- Python sentinel daemon with launchd integration (no Docker required for the daemon itself)
- Docker Compose for service orchestration
- SOUL/CONSTITUTION/HEARTBEAT pattern for agent identity (plain markdown, model-agnostic)
- LanceDB + SentenceTransformers for the experience memory layer
- Designed for Claude Code but the patterns apply to any LLM agent

Happy to discuss architecture decisions and answer questions.

---

## Prepared Answers for Tough HN Questions

**"Why is this paid?"**

The free checklist covers the patterns. The paid package saves you the 90 days of iteration I spent figuring out what actually works in production vs. what sounds good in a blog post. The sentinel daemon alone took 3 weeks to stabilize — it's the difference between "monitoring" and monitoring that catches an agent hallucinating in the wrong language at 3am. If you're technical enough to build it yourself from the free materials, go for it. The package is for people who'd rather skip the iteration.

**"What's the moat?"**

There isn't one in the traditional sense. The value is in the specific decisions: why 4 memory layers instead of 2, why CONSTITUTION.md is separate from SOUL.md, why the sentinel runs anomaly scans every 4 hours instead of continuously. Each decision has a production failure behind it. You could reach the same conclusions independently — this just gets you there faster.

**"Is this just a wrapper?"**

No. There's no code that wraps an API. It's architecture files — markdown templates, YAML configs, Python scripts, Docker Compose files. Think of it as a starter kit for the operational layer around AI agents, not the agents themselves. You still need to build your agents. This handles the part that makes them survive in production.

**"Why not open source?"**

The checklist and the core patterns article are free. The full package is paid because packaging, documenting, and supporting 21 files for general use is real work on top of building the system. If the free materials are enough for you, genuinely great — that's why they exist. The paid version is for people who want the complete, tested configuration without reconstructing it from blog posts.
