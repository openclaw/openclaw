# The 4-Layer Memory Tower: How to Give AI Agents Long-Term Memory

Every morning, your AI agent wakes up as a stranger. It doesn't remember yesterday's conversations. It doesn't know that the database migration broke three times last week. It doesn't recall that the customer in ticket #4521 has been escalated twice already.

You paste context into the prompt. You maintain a growing system message. You manually update a notes file. And eventually, you realize you've become the memory system — the human RAM that your agent depends on.

There's a better way. This article introduces the **4-Layer Memory Tower** — a simple architecture that gives AI agents persistent, structured memory using nothing more than markdown files and a few conventions.

## The Amnesia Problem

Stateless AI agents have a fundamental flaw: they treat every interaction as their first. This creates three concrete problems:

**1. Repeated mistakes.** Your agent hits the same error, tries the same wrong fix, and fails the same way. Without memory of past failures, it can't learn from experience.

**2. Context loss.** A customer explains their setup in detail on Monday. On Tuesday, a different session handles their follow-up — and asks them to explain everything again.

**3. Knowledge decay.** Your agent discovers that the staging API requires a special header. That knowledge exists in one conversation thread and is lost when the thread ends.

These aren't theoretical problems. If you've run an AI agent for more than a week, you've experienced all three.

## The 4-Layer Memory Tower

The Memory Tower organizes agent memory into four layers, each with different persistence, update frequency, and purpose:

```
Layer 4: Archival Memory     (permanent, compressed, rarely read)
Layer 3: Semantic Memory     (long-term knowledge, weekly updates)
Layer 2: Episodic Memory     (daily experiences, auto-pruned)
Layer 1: Working Memory      (current session, ephemeral)
```

Think of it like human memory. Working memory is what you're thinking about right now. Episodic memory is what happened yesterday. Semantic memory is what you _know_ (facts, skills, patterns). Archival memory is that thing from 2019 that you can recall if you really try.

Let's build each layer.

### Layer 1: Working Memory (In-Session Context)

Working memory is the easiest layer — it's just the conversation context. Every AI model already has this. But you can make it more effective by structuring what goes into it.

At the start of each session, load a **context primer**:

```python
def start_session(agent_dir: str) -> str:
    """Build the working memory context for a new session."""
    context_parts = []

    # Load identity (who am I?)
    soul = Path(agent_dir, "SOUL.md").read_text()
    context_parts.append(soul)

    # Load current state (what's happening now?)
    heartbeat = Path(agent_dir, "HEARTBEAT.md")
    if heartbeat.exists():
        context_parts.append(heartbeat.read_text())

    # Load recent episodic memory (what happened recently?)
    memory_dir = Path(agent_dir, "memory")
    if memory_dir.exists():
        recent = sorted(memory_dir.glob("*.md"), reverse=True)[:3]
        for f in recent:
            context_parts.append(f"## Memory: {f.stem}\n{f.read_text()}")

    return "\n\n---\n\n".join(context_parts)
```

The key insight: working memory should be _curated_, not comprehensive. Load the 3 most recent episodic memories, not all 200. The model performs better with focused context than with a massive dump.

### Layer 2: Episodic Memory (Daily Logs)

Episodic memory captures _what happened_ — the raw experiences from each day or session. It's the simplest layer to implement and the most immediately useful.

At the end of each session, write a summary:

```python
from datetime import date

def save_episode(agent_dir: str, summary: str, learnings: list[str]):
    """Save today's episodic memory."""
    memory_dir = Path(agent_dir, "memory")
    memory_dir.mkdir(exist_ok=True)

    today = date.today().isoformat()
    filepath = memory_dir / f"{today}.md"

    # Append if file exists (multiple sessions per day)
    mode = "a" if filepath.exists() else "w"
    with open(filepath, mode) as f:
        if mode == "w":
            f.write(f"# {today}\n\n")
        f.write(f"## Session Summary\n{summary}\n\n")
        if learnings:
            f.write("## Learnings\n")
            for learning in learnings:
                f.write(f"- {learning}\n")
            f.write("\n")
```

A typical episodic memory file looks like this:

```markdown
# 2025-03-21

## Session Summary

Handled 14 support tickets. Two were related to the billing API timeout
issue from yesterday — confirmed the fix is deployed. One new issue:
customers on the Enterprise plan can't download invoices as PDF.

## Learnings

- Invoice PDF generation uses wkhtmltopdf, which requires a display server.
  The container doesn't have one. Fix: use --headless flag or switch to weasyprint.
- Customer "Acme Corp" prefers email responses over chat. Added to their profile.
```

This is simple, human-readable, and instantly useful. When the agent starts tomorrow, it loads this file and knows what happened today.

### Layer 3: Semantic Memory (Distilled Knowledge)

Episodic memory tells you _what happened_. Semantic memory tells you _what you know_. It's the distilled, generalized knowledge extracted from many episodes.

Implement semantic memory as a single `MEMORY.md` file that gets updated periodically — daily or weekly:

```markdown
# MEMORY.md — Kira (Support Agent)

Last updated: 2025-03-21

## Known Issues

- Invoice PDF generation fails in containers without display server (since 3/21)
- OAuth token refresh has a race condition under high load (since 3/15, fix pending)

## Customer Notes

- Acme Corp: Enterprise plan, prefers email, custom SLA (1h response)
- Widget Inc: Free tier, considering upgrade, main contact is Sarah

## Operational Knowledge

- Deploy window: Tuesdays and Thursdays, 2-4pm UTC
- Staging API requires X-Staging-Auth header (value in vault)
- Log aggregation has 5-minute delay; don't panic if logs seem empty

## Patterns Learned

- Monday mornings have 3x normal ticket volume (people report weekend issues)
- "Can't log in" tickets are usually expired sessions, not password issues
- Enterprise customers escalate faster; respond within 15 minutes
```

The critical property of semantic memory is that it's **curated and compressed**. It doesn't record that you handled a login issue on March 3rd — it records that login issues are usually expired sessions. The specific episode is forgotten; the pattern is retained.

### Promoting Episodes to Semantic Memory

How does knowledge flow from Layer 2 (episodic) to Layer 3 (semantic)? You can do this with a simple weekly script:

```python
def promote_to_semantic(agent_dir: str, model_client):
    """Review recent episodes and extract patterns for semantic memory."""
    memory_dir = Path(agent_dir, "memory")
    memory_file = Path(agent_dir, "MEMORY.md")

    # Gather last 7 days of episodes
    recent_files = sorted(memory_dir.glob("*.md"), reverse=True)[:7]
    episodes = "\n\n".join(f.read_text() for f in recent_files)

    current_memory = memory_file.read_text() if memory_file.exists() else ""

    prompt = f"""Review these recent daily logs and the current semantic memory.
Extract any new patterns, knowledge, or facts that should be remembered long-term.
Remove anything from current memory that is no longer true.
Return the updated MEMORY.md content.

## Current Memory
{current_memory}

## Recent Episodes
{episodes}"""

    updated = model_client.generate(prompt)
    memory_file.write_text(updated)
```

This is where a cheap, fast model (like Claude Haiku) earns its keep. For a fraction of a cent, it reads a week of episodes and updates the semantic memory — compressing experience into knowledge.

### Layer 4: Archival Memory (Compressed History)

Archival memory is where old episodic memories go before deletion. It's a compressed summary of what happened over longer time periods.

```python
def archive_old_episodes(agent_dir: str, keep_days: int = 14):
    """Archive episodes older than keep_days into monthly summaries."""
    memory_dir = Path(agent_dir, "memory")
    archive_dir = Path(agent_dir, "memory", "archive")
    archive_dir.mkdir(exist_ok=True)

    cutoff = date.today() - timedelta(days=keep_days)

    to_archive = {}
    for f in memory_dir.glob("*.md"):
        try:
            file_date = date.fromisoformat(f.stem)
            if file_date < cutoff:
                month_key = file_date.strftime("%Y-%m")
                to_archive.setdefault(month_key, []).append(f)
        except ValueError:
            continue

    for month, files in to_archive.items():
        archive_path = archive_dir / f"{month}.md"
        content = f"# Archive: {month}\n\n"
        for f in sorted(files):
            content += f"## {f.stem}\n{f.read_text()}\n\n"
        archive_path.write_text(content)

        for f in files:
            f.unlink()  # delete original
```

Archival memory is rarely loaded into working context. It exists as a safety net — if the agent needs to recall something from two months ago, the archive is there to search.

## Pruning: The Art of Forgetting

Memory without forgetting is hoarding. An agent that loads 6 months of memories into every session will perform worse than one that loads the right 3 days.

Here are practical pruning rules:

```python
PRUNING_RULES = {
    "working_memory":  "End of session. Gone.",
    "episodic_memory":  "Keep 14 days. Archive, then delete originals.",
    "semantic_memory":  "Review weekly. Remove stale entries. Cap at 100 lines.",
    "archival_memory":  "Keep 6 months. Compress monthly into quarterly after 3 months.",
}
```

The most important pruning rule is for semantic memory: **cap it at a fixed size**. When MEMORY.md grows past 100 lines, the weekly promotion script should be asked to ruthlessly compress, merge entries, and drop anything that hasn't been relevant in 30 days.

Forgetting is not a bug. Humans forget things constantly, and it's what keeps us functional. Your agent should too.

## Putting It All Together

Here's the complete lifecycle:

```
Session Start:
  1. Load SOUL.md (identity - never changes)
  2. Load MEMORY.md (semantic - what I know)
  3. Load last 3 episodic memories (what happened recently)
  4. Begin session with full context

During Session:
  5. Normal operation. Working memory is the conversation context.

Session End:
  6. Write episodic memory for today (what happened, what I learned)
  7. Update HEARTBEAT.md (current state snapshot)

Weekly (automated):
  8. Promote episodic patterns to semantic memory
  9. Archive episodes older than 14 days
  10. Prune semantic memory to 100 lines

Monthly (automated):
  11. Compress monthly archives into quarterly summaries
  12. Delete raw archives older than 6 months
```

The entire system uses only markdown files. No database. No vector store. No infrastructure beyond a file system. You can inspect every memory by opening a text file, which means you can debug memory issues by reading files — not by querying an opaque embedding space.

## When to Upgrade Beyond Files

Flat files work surprisingly well up to about 500 memories. Beyond that, you might want:

- **Full-text search**: Add a SQLite FTS5 index over your markdown files. Still file-based, but searchable.
- **Semantic search**: Add a vector store (like LanceDB, which is also file-based) for similarity search across memories.
- **Cross-agent memory**: When multiple agents need to share knowledge, add a shared semantic memory file that all agents can read.

But start with files. Seriously. The complexity of a vector store is not worth it until you've proven that simple file-based memory actually helps your agent. Most people add infrastructure before they add value. Start with the value.

---

_If you're building agents that need to remember, learn, and operate autonomously over days and weeks, check out [thinker.cafe](https://thinker.cafe) — a practical playbook for AI agent architecture in production._
