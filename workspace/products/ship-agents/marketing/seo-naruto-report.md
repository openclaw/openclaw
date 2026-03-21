# SEO/AEO Naruto Report — Ship AI Agents to Production

**Date:** 2026-03-21
**Target:** thinker.cafe
**Product:** Ship AI Agents to Production (Claude Code architecture kit)
**Current indexed pages:** 1 (homepage only)

---

## 1. Keyword Gap Analysis

### What people actually search for

| Query                              | Who ranks #1                                             | Gap for us?                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "claude code best practices"       | code.claude.com (official docs)                          | No gap — official docs dominate. But #2-5 are blogs (shanraisshan GitHub, ykdojo tips, HumanLayer, UX Planet). We can rank #2-5.                                                   |
| "CLAUDE.md best practices"         | builder.io, HumanLayer blog, UX Planet                   | **YES — big gap.** Nobody covers CLAUDE.md for _production agents running 24/7_. All guides are for dev workflow, not production.                                                  |
| "how to run ai agents 24/7"        | theunwindai.com, MindStudio, dev.to (quantbit)           | **YES.** Top results are generic no-code or basic. Nobody covers battle-tested multi-agent production with identity isolation. Our dev.to article can rank here.                   |
| "ai agent production deployment"   | n8n blog, Google Cloud blog, MachineLearningMastery      | Competitive but possible. Our angle (practitioner who actually ran 10 agents for 90 days) is unique.                                                                               |
| "claude code production"           | No strong results — mostly generic Claude Code tutorials | **YES — wide open.** Nobody owns "Claude Code + production" as a combined keyword.                                                                                                 |
| "ai agent self healing monitoring" | Algomox, HealOps, dev.to                                 | **YES.** All results are enterprise infrastructure tools. Nobody writes about self-healing for _LLM-based agents_.                                                                 |
| "multi agent orchestration claude" | code.claude.com (sub-agents docs)                        | Partially open. Official docs cover SDK sub-agents but not production orchestration patterns.                                                                                      |
| "claude code memory persistence"   | code.claude.com (memory docs), dev.to, Medium            | Content exists but is about _dev workflow_ memory. Nobody covers production memory architecture (4-layer tower).                                                                   |
| "soul.md"                          | aaronjmars/soul.md GitHub, soul.md website               | **IMPORTANT:** soul.md is now an established project/brand. We should reference it and position as complementary (soul.md for personality, our kit for production infrastructure). |

### High-value keywords we should target

**Primary (high intent, low competition):**

1. `claude code production architecture` — nobody owns this
2. `run ai agents 24/7 production` — weak competition
3. `ai agent identity architecture` — zero competition
4. `claude code SOUL.md production template` — zero competition
5. `ai agent self healing daemon` — zero competition
6. `multi agent identity isolation` — almost nothing (all results are IAM/security, not LLM agent identity)

**Secondary (medium competition, high volume):**

1. `claude code best practices` — can rank #3-5
2. `CLAUDE.md template` — 4-5 GitHub repos compete, but none are production-focused
3. `ai agent monitoring production` — enterprise tools dominate, but our practitioner angle is unique
4. `how to deploy ai agents` — Google Cloud, StackAI rank. We can rank with practical content.

**Long-tail (low volume, zero competition, AEO goldmines):**

1. `how to prevent ai agent personality drift`
2. `claude code agent memory tower`
3. `ai agent constitution file`
4. `HEARTBEAT.md scheduled tasks ai agent`
5. `ai agent workspace directory structure`
6. `claude code multi agent gateway`

---

## 2. Content Gaps — What's Missing on the Internet

### Gap 1: "claude code soul.md" — OPPORTUNITY: HIGH

**Current state:** soul.md project by aaronjmars exists and is well-known. Multiple blog posts cover it. BUT nobody covers using SOUL.md specifically for _production reliability_ — preventing hallucination drift, maintaining identity across restarts, combining with CONSTITUTION.md.

**Action:** Write a blog post: "SOUL.md in Production: How Identity Files Prevent Agent Drift Over 90 Days." Reference the soul.md project, extend the concept to production. Link back to thinker.cafe.

### Gap 2: "ai agent self healing monitoring" — OPPORTUNITY: VERY HIGH

**Current state:** All results are enterprise infrastructure (Algomox, HealOps, Dagger CI). Nobody writes about self-healing for LLM agents — detecting hallucination, auto-restarting crashed agents, health check daemons for AI.

**Action:** This is our strongest content gap. Write: "Building a Self-Healing AI Agent Daemon: Cron, Health Checks, and Auto-Recovery." Pure practitioner content. Nobody else has this.

### Gap 3: "multi agent identity isolation" — OPPORTUNITY: VERY HIGH

**Current state:** All results are about enterprise IAM (Microsoft Entra, LoginRadius, Curity). ZERO results about preventing LLM agents from contaminating each other's personality/knowledge.

**Action:** Write: "Multi-Agent Identity Isolation: Why Your AI Agents Keep Stealing Each Other's Personality." This is a completely uncontested topic. We can own it.

### Gap 4: "claude code memory persistence" — OPPORTUNITY: MEDIUM

**Current state:** Official docs + 3-4 blog posts cover session memory for _development_. Nobody covers persistent memory for _production agents_ (daily summaries, knowledge extraction, archival).

**Action:** The "4-layer memory tower" concept is unique to us. Write about it, but frame it as extending the official memory system to production.

### Gap 5: "ai agent production architecture template" — OPPORTUNITY: HIGH

**Current state:** Google Cloud Agent Starter Pack, LangGraph starter kit, and some boilerplates exist. But ALL are framework-specific code repos. Nobody provides an _architecture template_ (directory structure, file conventions, monitoring patterns).

**Action:** Our product IS this template. Create a free preview (the directory structure + 2-3 sample files) and publish as a GitHub repo or gist. Link to full product.

### Gap 6: "claude code production CLAUDE.md template" — OPPORTUNITY: VERY HIGH

**Current state:** Multiple CLAUDE.md template repos exist (davila7, ArthurClune, abhishekray07). ALL are for development workflow. NONE are production-focused. The file we ship (`CLAUDE.md.production`) is unique.

**Action:** Publish a "CLAUDE.md for Production" blog post with a real production example. This directly competes with existing template posts but with a unique angle nobody covers.

---

## 3. Backlink Opportunities

### 3a. Awesome Lists — GET LISTED

| List                                                                                            | Stars  | Category to submit under                | Action                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)         | High   | "Agent Orchestrators" or "Applications" | Submit PR with: `[Ship AI Agents to Production](https://thinker.cafe/) - 21-file production architecture kit (SOUL.md, CONSTITUTION.md, memory tower, sentinel daemon)` |
| [jqueryscript/awesome-claude-code](https://github.com/jqueryscript/awesome-claude-code)         | Medium | "Frameworks" or "Resources"             | Same PR format                                                                                                                                                          |
| [rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit) | High   | "Templates"                             | Submit PR                                                                                                                                                               |
| [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills)             | Medium | "Resources"                             | Submit PR                                                                                                                                                               |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills)         | Medium | "Resources"                             | Submit PR                                                                                                                                                               |
| [mergisi/awesome-openclaw-agents](https://github.com/mergisi/awesome-openclaw-agents)           | High   | Production templates                    | Submit PR — our kit works with OpenClaw                                                                                                                                 |

**Priority:** hesreallyhim and rohitg00 first — highest visibility.

### 3b. Blog Posts to Get Mentioned In

| Post                                                                                                 | How to get mentioned                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [HumanLayer: Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)     | Comment or reach out — offer a "production-focused CLAUDE.md" perspective they can link to              |
| [builder.io: How to Write a Good CLAUDE.md File](https://www.builder.io/blog/claude-md-guide)        | Too big to respond to, but we can write a response post and link to them                                |
| [DataCamp: Writing the Best CLAUDE.md](https://www.datacamp.com/tutorial/writing-the-best-claude-md) | Educational platform — hard to get a backlink, but we can reference them in our content for reciprocity |
| [ClaudeLog](https://claudelog.com/)                                                                  | Resource aggregator — submit our dev.to article and product for listing                                 |
| [awesomeclaude.ai](https://awesomeclaude.ai/)                                                        | Directory — submit for listing                                                                          |

### 3c. Dev.to Comment Strategy

Target these existing articles with valuable comments + a link to our dev.to article (NOT direct product link — that gets flagged as spam):

1. **"How I Built 9 Autonomous AI Agents That Run 24/7"** (dev.to/quantbit) — Comment with our identity isolation insight. "Great post. We hit similar scaling challenges and found that identity isolation via separate SOUL.md files was the fix for agent personality contamination. Wrote about it here: [link to our dev.to article]."

2. **"Claude Code Tutorial for Beginners 2026"** (dev.to/ayyazzafar) — Comment about production considerations: "Solid beginner guide. For anyone taking this to production, the biggest thing missing from most tutorials is memory persistence and self-healing. We documented our 90-day production run here: [link]."

3. **"Claude Code Hooks Guide 2026"** (dev.to/serenitiesai) — Comment about using hooks for production monitoring.

4. **"The Complete SOUL.md Template Guide"** (dev.to/tomleelive) — Comment about SOUL.md in production context.

5. **"Cron-Based AI Agent Monitoring"** (dev.to/operationalneuralnetwork) — Direct competitor content. Comment with complementary perspective.

### 3d. Reddit Threads

Search suggests r/ClaudeAI and r/LocalLLaMA have active discussions. The existing `reddit-claudeai-post.md` should be posted. Also:

- Monitor for "running Claude Code in production" threads — answer with experience + link
- Monitor for "CLAUDE.md tips" threads — share production perspective
- r/selfhosted — post about running AI agents on a Mac Mini

---

## 4. AEO (AI Engine Optimization)

### "How do I run AI agents in production?"

**Currently cited sources:** n8n blog, Google Cloud blog, MachineLearningMastery, Medium articles.

**How to get cited:**

- Our dev.to article MUST be published. Dev.to has high domain authority and AI answer engines pull from it heavily.
- The FAQ schema on thinker.cafe already answers this question directly. Good.
- Add a standalone `/guide` page on thinker.cafe with a comprehensive "How to Run AI Agents in Production" guide (2000+ words). Single-page guides with clear H2 sections get cited by AI answer engines.

### "What's the best way to structure CLAUDE.md?"

**Currently cited sources:** code.claude.com (official), builder.io, HumanLayer, DataCamp.

**How to get cited:**

- Write a "CLAUDE.md for Production vs Development" comparison post on dev.to. Unique angle that none of the cited sources cover.
- The FAQ schema already has a SOUL.md question but NOT a CLAUDE.md structure question. Add one.

### "How to prevent AI agent hallucination in production"

**Currently cited sources:** TCS, AWS dev.to, CrewAI docs, Guardrails AI.

**How to get cited:**

- Our FAQ schema already answers this (question 8). Good.
- Need a blog post that goes deeper: "3 Production Patterns That Stopped My AI Agent From Hallucinating at 2am." Real story > generic advice for AEO.

### AEO-Specific Actions

1. **Add `speakable` schema** to the FAQ answers — tells Google which text is suitable for voice/AI reading
2. **Add `HowTo` schema** — step-by-step "How to set up production AI agents" with structured steps
3. **Create a `/faq` anchor or page** — dedicated FAQ URL that AI engines can crawl independently
4. **Ensure every FAQ answer is under 300 characters** — AI answer engines truncate longer answers. Current answers are too long. Shorten the schema answers, keep detail in the page content.

---

## 5. Schema Markup — Current State & Recommendations

### What you already have (GOOD)

- Product schema with offers, brand, author
- FAQ schema with 8 questions
- Article schema pointing to dev.to
- Organization schema

### What's missing (ADD THESE)

#### 5a. SoftwareApplication Schema

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Ship AI Agents to Production",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "macOS, Linux, Windows",
  "description": "21-file production architecture kit for running Claude Code AI agents 24/7. SOUL.md identity, self-healing sentinel, 4-layer memory tower.",
  "url": "https://thinker.cafe/",
  "author": {
    "@type": "Person",
    "name": "Cruz Tang"
  },
  "offers": {
    "@type": "AggregateOffer",
    "lowPrice": "0",
    "highPrice": "97",
    "priceCurrency": "USD",
    "offerCount": "3"
  },
  "featureList": [
    "SOUL.md identity architecture",
    "CONSTITUTION.md behavioral boundaries",
    "HEARTBEAT.md scheduled tasks",
    "4-layer memory tower",
    "Self-healing sentinel daemon",
    "Multi-agent orchestration",
    "Identity isolation patterns"
  ]
}
```

**Why:** SoftwareApplication gets rich results in Google (star ratings, pricing). Product schema alone doesn't trigger developer-tool-specific features.

#### 5b. HowTo Schema

```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Run AI Agents in Production 24/7",
  "description": "Set up production AI agents with identity architecture, self-healing monitoring, and persistent memory in 4 steps.",
  "totalTime": "PT2H",
  "step": [
    {
      "@type": "HowToStep",
      "position": 1,
      "name": "Define Agent Identity",
      "text": "Create SOUL.md with personality, expertise, and communication style. Create CONSTITUTION.md with behavioral boundaries. Create HEARTBEAT.md with scheduled tasks.",
      "url": "https://thinker.cafe/#identity"
    },
    {
      "@type": "HowToStep",
      "position": 2,
      "name": "Set Up Multi-Agent Isolation",
      "text": "Give each agent its own workspace directory with separate identity files. Configure the gateway to route messages to the correct agent without cross-contamination.",
      "url": "https://thinker.cafe/#multi-agent"
    },
    {
      "@type": "HowToStep",
      "position": 3,
      "name": "Deploy Self-Healing Monitoring",
      "text": "Set up the sentinel daemon with health checks, anomaly detection, and auto-restart. Configure alerting for hallucination drift and crash recovery.",
      "url": "https://thinker.cafe/#sentinel"
    },
    {
      "@type": "HowToStep",
      "position": 4,
      "name": "Build the Memory Tower",
      "text": "Configure 4-layer memory: working memory (session), episodic memory (daily summaries), semantic memory (extracted knowledge), archival (compressed long-term). Set up automated pruning and promotion.",
      "url": "https://thinker.cafe/#memory"
    }
  ]
}
```

**Why:** HowTo schema triggers step-by-step rich results AND gets cited by AI answer engines as procedural content. This directly targets "how to run AI agents in production."

#### 5c. WebPage Schema (wrap everything)

```json
{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Ship AI Agents to Production",
  "description": "Production architecture kit for Claude Code AI agents",
  "url": "https://thinker.cafe/",
  "speakable": {
    "@type": "SpeakableSpecification",
    "cssSelector": [".faq-answer", ".hero-description"]
  },
  "mainEntity": {
    "@type": "Product",
    "name": "Ship AI Agents to Production"
  }
}
```

**Why:** `speakable` tells AI engines which text to read aloud / cite in AI Overviews.

#### 5d. BreadcrumbList (if you add sub-pages later)

Not needed now with a single page, but add when you create `/guide`, `/faq`, etc.

### Schema Fixes for Existing Markup

1. **FAQ answers are too long.** Google truncates FAQ rich results at ~300 characters. Shorten each `acceptedAnswer.text` to a punchy answer, move detail to page content.

2. **Article schema points to dev.to URL as mainEntityOfPage.** This is technically correct if the article lives on dev.to, but consider also creating an on-site article (`/blog/how-i-run-10-agents`) for better domain authority.

3. **Add `aggregateRating` to Product schema** once you have reviews/testimonials. Even 3-5 ratings enable star snippets in Google.

4. **Add `image` property to Product schema.** Google requires it for Product rich results. Add `"image": "https://thinker.cafe/og-image.png"`.

---

## 6. Priority Action Items — Ranked by Impact

### TIER 1: Do This Week (highest ROI)

| #   | Action                                                   | Why                                                                                                             | Time   |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Publish dev.to article** (`devto-article.md`)          | Dev.to has DA 70+. Instant indexing. AEO engines cite it within days. This is the single highest-impact action. | 30 min |
| 2   | **Submit to 3 awesome-claude-code lists**                | Free backlinks from high-authority GitHub repos. PRs take 5 min each.                                           | 15 min |
| 3   | **Add SoftwareApplication + HowTo schema** to index.html | Triggers rich results in Google. Zero cost.                                                                     | 30 min |
| 4   | **Shorten FAQ schema answers** to under 300 chars each   | Current answers are too long for rich results. Google won't show them.                                          | 20 min |
| 5   | **Add `image` to Product schema**                        | Required for Google Product rich results. Missing = no rich snippet.                                            | 5 min  |

### TIER 2: Do This Month

| #   | Action                                                                        | Why                                                                                                          | Time   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| 6   | **Write "SOUL.md in Production" blog post** (dev.to)                          | Targets uncontested "soul.md production" keyword. References popular soul.md project for backlink potential. | 2 hr   |
| 7   | **Write "Multi-Agent Identity Isolation" post** (dev.to)                      | Zero competition. Entirely new topic. Will rank #1.                                                          | 2 hr   |
| 8   | **Write "Self-Healing AI Agent Daemon" post** (dev.to)                        | Another zero-competition topic. Practitioner angle nobody else has.                                          | 2 hr   |
| 9   | **Create free GitHub repo** with directory structure + 2 sample files         | Provides discoverability via GitHub search. Links to product. Open-source goodwill.                          | 1 hr   |
| 10  | **Post Reddit thread** in r/ClaudeAI (use existing `reddit-claudeai-post.md`) | Reddit threads rank in Google for long-tail queries. Direct traffic.                                         | 20 min |
| 11  | **Comment on 5 dev.to articles** with valuable insights + link                | Each comment is a contextual backlink. Dev.to comments are indexed.                                          | 30 min |
| 12  | **Submit to awesomeclaude.ai and ClaudeLog**                                  | Directory listings = free backlinks + referral traffic.                                                      | 10 min |

### TIER 3: Ongoing / Next Quarter

| #   | Action                                                                          | Why                                                                         | Time      |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
| 13  | **Create `/guide` page on thinker.cafe**                                        | Standalone 2000+ word guide = AEO magnet. Separate URL = separate indexing. | 4 hr      |
| 14  | **Write "CLAUDE.md for Production vs Development"** (dev.to)                    | Differentiates from 10+ existing CLAUDE.md template posts.                  | 2 hr      |
| 15  | **Create comparison page** (vs LangGraph, vs n8n, vs Google Agent Starter Pack) | Comparison pages rank well. People search "X vs Y."                         | 3 hr      |
| 16  | **Get 5 testimonials** for `aggregateRating` in Product schema                  | Star ratings in Google = massive CTR boost.                                 | ongoing   |
| 17  | **Monitor keyword rankings** weekly for top 10 keywords                         | Track progress. Adjust strategy.                                            | 15 min/wk |
| 18  | **Set up Google Search Console** for thinker.cafe (if not done)                 | Required to monitor indexing, impressions, CTR.                             | 10 min    |

---

## 7. Competitive Landscape Summary

### Direct Competitors (selling similar products)

| Competitor                            | What they sell                            | Our advantage                                                     |
| ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| [aitmpl.com](https://www.aitmpl.com/) | Claude Code templates marketplace (1000+) | They sell quantity. We sell a battle-tested production system.    |
| [soul.md](https://soul.md/)           | Personality builder for agents            | They do personality. We do the full production stack around it.   |
| Google Agent Starter Pack             | Free GCP agent templates                  | Cloud-locked. We're infrastructure-agnostic (runs on a Mac Mini). |
| [claudefa.st](https://claudefa.st/)   | Claude Code kit with CLAUDE.md + agents   | Dev-focused. We're production-focused.                            |

### Indirect Competitors (content competitors for the same keywords)

| Competitor                      | Content                            | Threat level                                                                                           |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| code.claude.com (official docs) | Best practices, memory, sub-agents | HIGH — they own brand keywords. We can't outrank on "claude code" but can on "claude code production." |
| HumanLayer blog                 | CLAUDE.md writing guide            | MEDIUM — good SEO, but dev-focused not production.                                                     |
| dev.to/quantbit                 | "9 Autonomous AI Agents 24/7"      | HIGH — similar story angle. But less technical depth.                                                  |
| n8n blog                        | AI agent production deployment     | MEDIUM — no-code focused. Different audience.                                                          |

### Our Unique Moat

Nobody else has:

1. Actually run 10 agents for 90+ days and documented it
2. The identity isolation architecture (SOUL + CONSTITUTION + HEARTBEAT trifecta)
3. A 4-layer memory tower with automated pruning
4. A self-healing sentinel daemon for LLM agents specifically
5. Production-tested multi-agent gateway patterns

**The content strategy should hammer these 5 points in every piece of content.** They are our unfair advantage.

---

## 8. Quick Wins Checklist

- [ ] Add `"image": "https://thinker.cafe/og-image.png"` to Product schema
- [ ] Add SoftwareApplication schema to `<head>`
- [ ] Add HowTo schema to `<head>`
- [ ] Shorten all FAQ `acceptedAnswer.text` to under 300 characters
- [ ] Publish dev.to article (flip `published: true`)
- [ ] Submit PR to hesreallyhim/awesome-claude-code
- [ ] Submit PR to rohitg00/awesome-claude-code-toolkit
- [ ] Submit PR to jqueryscript/awesome-claude-code
- [ ] Submit to awesomeclaude.ai directory
- [ ] Submit to ClaudeLog directory
- [ ] Set up Google Search Console for thinker.cafe
- [ ] Add `robots.txt` rule: `Allow: /` (already done)
- [ ] Verify sitemap.xml is submitted to Google Search Console
