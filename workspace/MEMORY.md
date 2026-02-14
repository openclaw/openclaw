# MEMORY.md — Long-Term Memory

> Rule: Only what I need in EVERY conversation. Details go in daily files.

## Abhishek & Pavisha
- **Company:** Pavisha PET Industries, Patna, Bihar
- **Products:** PET jars, bottles, cans, preforms, caps, accessories
- **GSTIN:** 10AENPK6359M3Z2 | Proprietor: Poonam Keshri
- **Goal:** AI to manage business — operations, research, communications, planning

## Active Projects
- **AutifyME** → Pivoting to OpenClaw-native skills (was LangChain/LangGraph)
  - Repo: `D:\openclaw\workspace\AutifyME` (github: akeshr/AutifyME, branch: specialist-build-up-v11)
  - Master doc: `AutifyME/docs/REDESIGN_MASTER_DOCUMENT.md`
  - Whitepaper: `AutifyME/docs/whitepaper.md` (14 workflow domains, Agentic Business OS vision)
  - Backend: Supabase (project: badupjrwhiucpvnuwluc)
  - Vision: Platform for MILLIONS of businesses, not just Pavisha

### Database Skill ✅ DONE
- Location: `workspace/skills/database/` (SKILL.md, scripts/db_tool.py, references/)
- **--file flag**: model writes JSON file with `Write` tool, runs `python db_tool.py --file q.json` — zero escaping
- 38/38 regression on Sonnet, Haiku, AND free 11B model (StepFun Step 3.5 Flash)
- Merged to main, pushed to github

### Domain Architecture (IN PROGRESS — key decisions)
- **Intent → Domain(s) → Specialists**: user message classified into domains, specialist sub-agents spawned per domain
- **User roles**: owner/employee/customer — determines domain access + action permissions
- **Security = Supabase RLS** (database enforces, NOT the model) — generic policies, NOT per-table custom views/RPCs
- **Users = Supabase Auth** + profiles table (NOT a JSON file) — phone auth for WhatsApp
- **Domain knowledge = skill folders** with extracted protocol knowledge
- **Classification = LLM reasoning** reading skill descriptions (NOT a rigid registry)
- **Must scale**: AutifyME serves millions of businesses, solutions must be generic

### OpenRouter
- API key configured in OpenClaw (`env.OPENROUTER_API_KEY`)
- Free models available: StepFun Step 3.5 Flash (11B active), Aurora Alpha, Arcee Trinity

## Priorities
1. Extract catalog protocols → product-cataloging skill (domain knowledge)
2. Set up Supabase Auth + profiles + generic RLS
3. Build domain routing in AGENTS.md (classification + orchestration patterns)
4. Connect Pavisha WhatsApp Business number to OpenClaw
5. Build image_gen.py (creative-production skill)
6. Migrate Pavisha website to use AutifyME schema
7. Claim Google Business profile

## System
- **PC:** ASRock B450 Steel Legend, Windows
- **OpenClaw:** Source at `D:\openclaw`, workspace at `D:\openclaw\workspace`
- **Auto-start:** Startup bat in Windows Startup folder
- **WhatsApp:** Active channel
- **GitHub CLI:** `C:\Program Files\GitHub CLI\gh.exe` (auth as akeshr)
