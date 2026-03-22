# Automated YouTube Product Review Videos

## Overview

Create product review videos automatically from product data/reviews.

---

## Pipeline Stages

```
Product URL/Name → Script → Voice → Visuals → Video → YouTube
```

---

## Stage 1: Script Generation

| Tool                 | Cost             | Quality   | Notes                   |
| -------------------- | ---------------- | --------- | ----------------------- |
| LLM (GPT/Claude/GLM) | $0.01-0.10/video | Excellent | Research + write script |
| Perplexity API       | $0.02/query      | Good      | Real-time product info  |
| Amazon Product API   | Free tier        | Good      | Specs, reviews, images  |

**Script Structure:**

1. Hook (0-5s): "Is [Product] worth it?"
2. Intro (5-15s): What we're reviewing
3. Features (15-45s): Key specs/benefits
4. Pros & Cons (45-75s): Balanced review
5. Verdict (75-90s): Buy or pass
6. CTA (90-95s): Like, subscribe

---

## Stage 2: Voiceover (TTS)

| Tool                | Cost         | Quality    | Notes                |
| ------------------- | ------------ | ---------- | -------------------- |
| ElevenLabs          | $5-22/mo     | ⭐⭐⭐⭐⭐ | Best voices, cloning |
| OpenAI TTS          | $15/1M chars | ⭐⭐⭐⭐   | Good, limited voices |
| Edge TTS            | Free         | ⭐⭐⭐     | Microsoft, free      |
| Google TTS          | $4/1M chars  | ⭐⭐⭐     | Standard             |
| Local (Coqui/Piper) | Free         | ⭐⭐       | Requires setup       |

**Recommendation:** ElevenLabs for quality, Edge TTS for free.

---

## Stage 3: Visuals

| Source                        | Cost      | Notes                        |
| ----------------------------- | --------- | ---------------------------- |
| Product images (Amazon)       | Free      | Screenshots, official images |
| Stock video (Pexels)          | Free      | B-roll footage               |
| AI images (Midjourney/DALL-E) | $10-30/mo | Custom visuals               |
| Screen recording              | Free      | Demo the product             |
| AI video (Runway/Pika)        | $12-28/mo | Generate clips               |

**Visual Strategy:**

- Product photos → Ken Burns effect (zoom/pan)
- Stock footage → Lifestyle shots
- Text overlays → Key points
- B-roll → Keep engagement

---

## Stage 4: Video Assembly

| Tool             | Cost   | Automation | Notes                |
| ---------------- | ------ | ---------- | -------------------- |
| MoviePy (Python) | Free   | ✅ Full    | Programmatic editing |
| FFmpeg           | Free   | ✅ Full    | CLI, powerful        |
| Remotion (JS)    | Free   | ✅ Full    | React-based          |
| Canva Video      | $12/mo | ⚠️ Partial | Templates            |
| InVideo AI       | $25/mo | ✅ Full    | AI video generator   |
| Pictory          | $23/mo | ✅ Full    | Text-to-video        |

**Recommendation:** MoviePy or FFmpeg for full control, InVideo for ease.

---

## Stage 5: Upload

| Method           | Cost | Notes                |
| ---------------- | ---- | -------------------- |
| YouTube API      | Free | Requires OAuth setup |
| YouTube Studio   | Free | Manual upload        |
| Scheduled upload | Free | API or Studio        |

---

## Complete Tool Stack Options

### Option A: Fully Automated (Low Cost)

```
LLM (GLM-5) → Edge TTS (free) → Product images → MoviePy → YouTube API
Cost: ~$0.05/video
```

### Option B: High Quality (Mid Cost)

```
LLM (Claude) → ElevenLabs → AI images + stock → InVideo → Manual upload
Cost: ~$0.50-1.00/video
```

### Option C: AI Video Generator (Easiest)

```
InVideo AI / Pictory → (text prompt) → Done
Cost: $25/mo unlimited
```

---

## Implementation Plan

### Week 1: Core Pipeline

- [ ] Set up script generation (LLM prompt template)
- [ ] Configure TTS (ElevenLabs or Edge)
- [ ] Test with sample product

### Week 2: Visuals

- [ ] Product image scraper/fetcher
- [ ] Ken Burns effect implementation
- [ ] Text overlay system

### Week 3: Assembly

- [ ] MoviePy video assembly script
- [ ] Background music integration
- [ ] Export settings optimization

### Week 4: Automation

- [ ] YouTube API OAuth setup
- [ ] End-to-end automation script
- [ ] Batch processing capability

---

## Sample Workflow

```bash
# Input
python make_review.py --product "iPhone 15 Pro" --url "https://amazon.com/..."

# Process
1. Fetch product data (API/scrape)
2. Generate script (LLM)
3. Create voiceover (TTS)
4. Download images
5. Assemble video (MoviePy)
6. Export MP4

# Output
output/iphone-15-pro-review.mp4
```

---

## Costs Summary

| Tier    | Monthly Cost | Videos/Month | Cost/Video |
| ------- | ------------ | ------------ | ---------- |
| Free    | $0           | 10-20        | $0.00      |
| Starter | $25          | 50-100       | $0.25-0.50 |
| Pro     | $50-100      | Unlimited    | <$0.10     |

---

## Legal Considerations

- ✅ Fair use: Product images for review
- ✅ Original script: AI-generated is yours
- ⚠️ Music: Use royalty-free only
- ⚠️ Footage: Check stock licenses
- ❌ Don't: Copy other reviewers' scripts

---

## Next Steps

1. **Choose stack:** Option A (cheap) or B (quality)?
2. **Set up TTS:** ElevenLabs API key or Edge TTS?
3. **Test product:** Share a product URL to test pipeline
4. **YouTube channel:** Create or use existing?

---

_Ready to build. Which option interests you?_
