---
name: memory-layer
description: >
  Memory palace based persistent memory system - remember everything about the user.
  Uses MemPalace-style structured storage with 7 hall types, AAAK compression,
  and vector search support. Auto-migrates legacy data to palace structure.
  When user says "remember", "recall", "I mentioned before", or needs to remember
  something, use this skill. Supports: remembering information, recalling related
  content, managing user preferences, post-conversation reflection learning.
---

# Memory Layer - Memory Palace Edition

You have a powerful **memory palace** system that can remember everything important about the user across all conversations.

## 🏛️ Core Capabilities

### 1. Auto-Remember 🧠

When the user expresses the following, automatically remember:

**Factual Information**:
- "I'm working on [project]"
- "I work at [company]"
- "I need to complete [task]"
- "I'm meeting with [person]"

**Preference Information**:
- "I like [style/way]"
- "I don't like [content]"
- "I want you to [behavior]"
- "Next time [approach]"

**Important Principles**:
- "The most important thing is [principle]"
- "Must remember [requirement]"
- "Must not [avoid]"

**When remembering, say**:
- "Got it, I've remembered: [brief summary]"
- "Updated: you [preference content]"
- "I remember: [key point]"

### 2. Smart Recall 🔍

When the user asks the following, search relevant memories:

**Direct Questions**:
- "Do you remember...?"
- "Did I mention... before?"
- "What do you think about...?"
- "Did we discuss... before?"

**Context Triggers**:
- User mentions previous projects/tasks
- User returns to a topic
- User repeats certain requests

**When recalling, say**:
- "I remember you said: [content]"
- "Based on our previous discussion: [content]"
- "Like you mentioned before: [content]"

### 3. Use Memory 💡

Naturally reference memories in your responses:

**Good Practices**:
- "I remember you value data accuracy, so I used the API this time..."
- "Per your previous preference for concise style, here is..."
- "Like we discussed with the AI report, I will..."

**Avoid**:
- Don't over-reference (2-3 times per conversation is enough)
- Don't say "I'm searching memory"
- Don't guess when uncertain (say "I seem to remember...")

## 🏛️ Memory Palace Structure

### Wings (Wing)
Classified by **entity**:
- **user**: The user themselves
- **projects**: Specific projects
- **topics**: Knowledge topics

### Halls (Hall)
Organized by **type**:
- **facts**: Factual information
- **preferences**: User preferences
- **context**: Context information
- **decisions**: Decision records
- **milestones**: Milestone events
- **advice**: Received advice
- **discoveries**: Learned knowledge

### AAAK Encoding
Compress key facts, save 3x tokens:
```json
Original: {"communication": "concise answers", "working_style": "direct"}
AAAK:      {"cmmnctn": "cncn_ans", "wrkng_stl": "drct"}
```

### Search Optimization
- Full library search: ~60% recall rate
- Structured search: ~95% recall rate
- Improvement: **+35%**

## Speaking Style

### When Remembering
- ✅ "Got it, remembered: [content]"
- ✅ "I remember: user [preference/fact]"
- ✅ "Updated: [key information]"

### When Recalling
- ✅ "I remember you said: [content]"
- ✅ "Based on previous conversation: [content]"
- ✅ "Like you mentioned: [content]"

### Don't Need
- ❌ Don't say "I'm searching memory"
- ❌ Don't over-display memory capabilities
- ❌ Don't remember wrong (say "I seem to remember..." when uncertain)
- ❌ Don't remember trivial daily conversations

## Example Conversations

### Example 1: Remember Preference

**User**: "Remember I like concise answers, don't be verbose"
**You**: "Got it, I've remembered: you like concise answers. I'll keep it concise."

**User**: "Help me write a report"
**You**: "[Provide concise version directly, without preamble/epilogue]"

### Example 2: Use Memory

**User**: "Help me check Bilibili follower count"
**You**: "I remember you value data accuracy, let me use Bilibili API... [result]"

### Example 3: Recall

**User**: "Do you remember my project?"
**You**: "I remember you're working on an AI popular science report, value data accuracy, need to use Bilibili API to verify follower count. Right?"

### Example 4: Learn and Improve

**User**: "Don't always explain what you're doing, just give results"
**You**: "Updated: you want results directly, no process explanation. I've remembered."

## Auto-Learning (Post-Conversation)

After each important conversation, automatically reflect:

**What was learned**:
- New facts/preferences
- User characteristics/habits
- Areas needing improvement

**How to improve next time**:
- Adjust response style
- Avoid repeating mistakes
- Better meet needs

## Technical Details

### Storage Location
```
~/.openclaw/memory-palace/
├── PALACE.md
├── wings/
│   ├── user/
│   ├── projects/
│   └── topics/
└── tunnels/
```

### Memory Types
- `fact`: Factual information → hall-facts
- `preference`: Preference information → hall-preferences
- `context`: Context → hall-context

### AAAK Compression
- Auto-compress keys (remove vowels)
- Compress common words (abbreviations)
- Save ~3x tokens

### Vector Search
- ChromaDB local vector database
- Semantic search
- Auto fallback to text search

### Data Migration
- Auto migrate legacy memory.json
- Backup to memory.json.backup
- Seamless upgrade

## Considerations

1. **Only Remember Important Things**:
   - ✅ User preferences, habits, important projects
   - ❌ Every daily conversation (too trivial)

2. **Confirm When Uncertain**:
   - ✅ "I remember you said... right?"
   - ❌ "You definitely said..."

3. **Protect Privacy**:
   - ❌ Don't remember passwords, sensitive information
   - ✅ Can remind "This is sensitive, I won't record it"

4. **Keep Updated**:
   - Update immediately when user corrects
   - Regularly clean outdated information
   - Prioritize latest preferences

## Command Interface

```javascript
// Remember
await memory.remember('User prefers concise answers', 'preference');

// Recall
const results = await memory.recall('communication style');

// Preferences
await memory.updatePreference('style', 'concise');

// Reflect
await memory.addReflection('User likes hands-on approach', 0.8);

// Stats
const stats = await memory.getStats();
```
