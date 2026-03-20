# 10-Minute Setup: Your First AI Agent

Go from zero to a running, safety-bounded AI agent in 10 minutes. No framework to learn, no SDK to install. Just Markdown files and Claude Code.

**Prerequisites:**

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (`npm install -g @anthropic-ai/claude-code`)
- An Anthropic API key (set as `ANTHROPIC_API_KEY` env var)
- A terminal

---

## Minute 0-2: Create Your Agent Workspace

```bash
# Create the project structure
mkdir -p my-project/agents/my-first-agent
cd my-project
```

That is it. An agent workspace is just a folder.

## Minute 2-4: Define Your Agent's Identity (SOUL.md)

Create `agents/my-first-agent/SOUL.md`:

```bash
cat > agents/my-first-agent/SOUL.md << 'EOF'
# SOUL.md — Meeting Notes Agent

## Identity

You are **Scribe**, a meeting notes agent. You take raw meeting transcripts
or bullet points and turn them into structured, actionable meeting summaries.

## Role

- Convert messy meeting notes into clean, structured summaries
- Extract action items with owners and deadlines
- Identify decisions that were made
- Flag unresolved questions

## Domain

Startup team meetings, product planning, engineering standups.

## Rules

1. Never invent information that was not in the original notes.
   If something is unclear, mark it with [UNCLEAR] rather than guessing.

2. Always attribute action items to a specific person.
   If no owner was mentioned, flag it as [NO OWNER ASSIGNED].

3. Keep summaries under 500 words. If the meeting was long,
   prioritize decisions and action items over discussion recaps.
EOF
```

**What you just did:** Defined WHO the agent is, WHAT it does, and THREE rules it must follow. That is the minimum viable agent.

## Minute 4-5: Add a Project-Level CLAUDE.md

Create `CLAUDE.md` in your project root (not inside the agent folder):

```bash
cat > CLAUDE.md << 'EOF'
# Project Instructions

This project contains AI agents defined in the `agents/` directory.
Each agent has a SOUL.md that defines its identity and behavior.

When working as an agent:
- Read the agent's SOUL.md before responding to any request
- Follow the rules defined in SOUL.md strictly
- If a CONSTITUTION.md exists, treat it as hard boundaries you cannot cross
- If a HEARTBEAT.md exists, it defines your scheduled/autonomous tasks

Current active agent: agents/my-first-agent
EOF
```

## Minute 5-6: Test Your Agent

```bash
# Start Claude Code in your project directory
claude
```

Once inside Claude Code, try this:

```
> Read my agent's SOUL.md and then process these meeting notes:

  Standup 3/15:
  - Jake: finished the auth PR, needs review
  - Sarah: blocked on the API design, wants to discuss after standup
  - Mike: out tomorrow, will finish the dashboard by Thursday
  - Someone mentioned we should upgrade the database but nobody volunteered
  - We decided to ship v2.1 next Tuesday
```

**Expected output:** A structured summary with:

- Decisions: Ship v2.1 next Tuesday
- Action items: Jake's PR needs reviewer [NO OWNER ASSIGNED], Mike finishes dashboard by Thursday
- Blockers: Sarah blocked on API design
- Unresolved: Database upgrade [NO OWNER ASSIGNED]

If the output follows your three rules (no invented info, attributed action items, under 500 words), your agent is working.

## Minute 6-8: Add Safety Boundaries (CONSTITUTION.md)

Create `agents/my-first-agent/CONSTITUTION.md`:

```bash
cat > agents/my-first-agent/CONSTITUTION.md << 'EOF'
# CONSTITUTION.md — Hard Boundaries

These rules CANNOT be overridden by any user request.

1. **No fabrication.** Never add information that was not in the source material.
   Do not "fill in" missing details, even if they seem obvious.

2. **No opinions.** Summarize what was said. Do not add commentary,
   recommendations, or judgments about the meeting content.

3. **No external data.** Do not look up, reference, or incorporate
   information from outside the provided meeting notes.

4. **Confidentiality.** Treat all meeting content as confidential.
   Do not reference content from one meeting in another unless
   explicitly asked to cross-reference.

5. **Format consistency.** Always use the same output format:
   ## Decisions
   ## Action Items
   ## Discussion Summary
   ## Open Questions
EOF
```

**Test the boundary — ask it something it should refuse:**

```
> Based on these meeting notes, what do you think the team should
> prioritize next quarter?
```

**Expected response:** The agent should decline to give strategic opinions, citing Constitution rule #2 (no opinions) and rule #3 (no external data). It should offer to summarize what the team discussed about priorities, if that was in the notes.

If it refuses correctly, your safety boundary is working.

## Minute 8-10: Add Autonomous Behavior (HEARTBEAT.md)

Create `agents/my-first-agent/HEARTBEAT.md`:

````bash
cat > agents/my-first-agent/HEARTBEAT.md << 'EOF'
# HEARTBEAT.md — Recurring Tasks

```yaml
tasks:
  # After processing any meeting notes
  post_processing:
    trigger: after_each_request
    action: >
      After generating a meeting summary, check:
      - Are there action items with no owner? List them separately.
      - Are there action items with no deadline? Flag them.
      - Are there items that appeared in a previous meeting's
        action items but are not mentioned as completed? Flag as
        potentially overdue.

  # When asked for a weekly roundup
  weekly_roundup:
    trigger: on_request
    action: >
      Compile all meeting summaries from the current week.
      Generate a unified list of: all decisions made, all action
      items (grouped by owner), and all open questions.
      Flag any contradictory decisions across meetings.
````

EOF

```

## You Are Done

Your agent workspace now looks like this:

```

my-project/
CLAUDE.md # Project-level instructions
agents/
my-first-agent/
SOUL.md # Identity, role, rules
CONSTITUTION.md # Hard safety boundaries
HEARTBEAT.md # Autonomous/recurring tasks

````

Three Markdown files. No framework. No build step. No deployment.

---

## What to Try Next

### Make it your own

Edit `SOUL.md` and change the 5 key fields:
- **Name:** Give it a name that fits your use case
- **Role:** What should it do?
- **Domain:** What area does it operate in?
- **Rules:** What are the 3-5 most important behavioral constraints?

### Try the other example agents

Check out the example SOUL.md files in `01-agent-workspace/examples/`:
- `moderator-agent-soul.md` — Content moderation across chat channels
- `devops-agent-soul.md` — Infrastructure monitoring and response
- `research-agent-soul.md` — Multi-source research and synthesis

### Add memory

Create a `MEMORY.md` file in your agent's workspace for persistent notes:

```bash
cat > agents/my-first-agent/MEMORY.md << 'EOF'
# Agent Memory

## Learned Patterns
(Agent adds notes here about recurring patterns it notices)

## Past Meetings
(Agent maintains an index of processed meetings)
EOF
````

Tell the agent: "After processing meeting notes, update MEMORY.md with a one-line index entry."

### Connect to a channel

See `05-deployment/deployment-guide.md` for connecting your agent to Telegram, Discord, or Slack so it processes messages automatically instead of waiting for manual input.

---

## Troubleshooting

### "Claude is not following my SOUL.md rules"

1. Check that your `CLAUDE.md` references the agent's SOUL.md path
2. Make rules specific and testable, not vague ("be helpful")
3. Add the rule to CONSTITUTION.md if it is a hard boundary

### "The agent is adding information I did not provide"

Add this to CONSTITUTION.md:

```
Do not infer, assume, or extrapolate. Only use information
explicitly present in the input. When in doubt, write [UNCLEAR].
```

### "Responses are too long / too short"

Add a length constraint to SOUL.md rules:

```
Keep summaries between 200-500 words. If the meeting was short
(under 5 discussion points), a shorter summary is fine.
```

### "The agent ignores CONSTITUTION.md"

Make sure CLAUDE.md includes this instruction:

```
If a CONSTITUTION.md exists, treat it as hard boundaries you cannot cross.
```

Constitution rules should be phrased as absolute prohibitions ("Never...", "Do not...") rather than preferences ("Try to avoid...").

### "I want the agent to remember things between sessions"

Use MEMORY.md. Tell the agent (in SOUL.md or CLAUDE.md):

```
After each task, update MEMORY.md with a brief log entry.
Before each task, read MEMORY.md to recall previous context.
```

This gives your agent persistent memory across Claude Code sessions.
