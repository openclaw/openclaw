# Reddit Post — r/ClaudeAI

**Title:** After 90 days of running 10 Claude Code agents in production, I packaged everything into reusable files

---

About 3 months ago, I started running Claude Code agents as always-on production systems — not just coding assistants, but autonomous agents handling customer service, monitoring, data analysis, and team coordination across Telegram, LINE, and Discord.

I'm at 10 agents now, all running on a single Mac Mini. No cloud orchestration. No Kubernetes. Just a Python sentinel daemon, some well-structured markdown files, and a lot of hard-won lessons.

Here are the 3 biggest things I learned:

**1. Identity architecture is everything.**

Early on, my agents would drift. They'd start mixing up contexts, break character, or do things I never asked for. The fix wasn't better prompts — it was giving each agent a formal identity structure. Every agent now has a SOUL.md (who it is, what it cares about), a CONSTITUTION.md (hard rules it cannot violate), and a HEARTBEAT.md (current state and priorities). This sounds simple but it changed everything. Agents stopped being "a prompt" and started being reliable workers.

**2. You need monitoring that understands agents, not just uptime.**

Traditional monitoring checks "is the process alive?" That's useless for AI agents. My agent could be alive but hallucinating, stuck in a loop, or silently dropping messages. I built a 4-layer sentinel daemon: nightly ops (cleanup, audits), morning briefs (daily summary to Telegram), anomaly scans every 4 hours, and weekly reviews. It caught 12 incidents while I was asleep — things like an agent that started responding in the wrong language, or one that was burning tokens on circular reasoning.

**3. Memory is the difference between a toy and a tool.**

Without persistent memory, your agent wakes up every session like it's day one. I built a 4-layer memory tower: session memory (conversation context), daily memory (what happened today), weekly digests (compressed summaries), and a long-term experience database with semantic search. When an agent encounters a problem it solved 6 weeks ago, it finds the solution in under a second. This is what makes agents actually useful over time — they get better, not just older.

**What I packaged:**

After iterating on this architecture for 90+ days, I extracted the reusable parts into 21 files — templates, configs, scripts, and documentation. It's not a framework or a SaaS product. It's the actual files I use, cleaned up and documented so someone else can adapt them.

The package includes SOUL/CONSTITUTION/HEARTBEAT templates, the sentinel daemon config, memory system architecture, deployment scripts, and the monitoring setup.

**If you want to check it out:**

I made a free checklist that covers the core patterns — what to set up before you deploy your first agent: https://thinkercruz.gumroad.com/l/ecxyi

The full system with all 21 files is at https://thinker.cafe — it's $47.

Full disclosure: I'm the creator. This isn't a "my friend built this" post. I built it, I use it every day, and I'm happy to answer any questions about the architecture, the tradeoffs, or the things that didn't work. Fire away.
