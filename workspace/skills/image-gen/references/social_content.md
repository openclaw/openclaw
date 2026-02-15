# Social Content — Domain Doctrine

Domain doctrine for social media visual content: platform-specific imagery, carousels, stories, data-driven graphics.

This teaches you HOW TO THINK about social content, not steps to follow.

---

## Mental Model

Social content exists in a FEED. Your image competes with hundreds of others.

**The Question:** Would someone stop scrolling?

### The Social Mindset

| Other Domains | Social Domain |
|---------------|---------------|
| Image viewed deliberately | Image glimpsed in motion |
| Full attention available | Fractional attention |
| Quality is table stakes | Stopping power is table stakes |
| Tell the whole story | Hook, then tell |
| Timeless | Immediate |

### Platform as Context

Every platform has a culture. Content that looks like it was made for Instagram but posted to WhatsApp feels wrong — even if technically fine.

---

## Platform Doctrine

### Platform Character

| Platform | Culture | Content Style |
|----------|---------|---------------|
| **Instagram** | Aspirational, curated | High aesthetic, clean, scroll-stopping |
| **Facebook** | Social, shareable | Relatable, informational, community |
| **WhatsApp Status** | Personal, direct | Quick, authentic, mobile-first |
| **Pinterest** | Inspirational, saved | Vertical, text welcome, aspirational |

### Platform Specs

**Instagram:**
- Feed: 1:1 (1080×1080) or 4:5 (1080×1350)
- Stories/Reels: 9:16 (1080×1920)
- Carousel: 1:1 or 4:5, consistent across slides

**Facebook:**
- Feed: 16:9 (1200×628) or 1:1 (1080×1080)
- Portrait: 4:5 (1080×1350)

**WhatsApp:**
- Status: 9:16 (1080×1920)
- Catalog: 1:1 (1080×1080)

**Pinterest:**
- Standard: 2:3 (1000×1500)
- Long: 1:2.1 (1000×2100)

---

## Scroll-Stopping Doctrine

### The Hook Principle

First impression happens in milliseconds. Design for it.

**Stopping power elements:**
- Unusual visual (breaks pattern)
- Strong color (stands out from feed)
- Intriguing composition (incomplete story)
- Clear focal point (eye knows where to go)
- Emotional trigger (evokes immediate response)

### The Swipe Motivation (Carousels)

Each slide must promise MORE.

- Slide 1: HOOK — stop the scroll
- Middle slides: STORY — maintain interest
- Final slide: CTA — drive action

Each slide should feel incomplete without the next.

---

## Storyline Doctrine

### Story Arc Thinking

Multi-image content is a NARRATIVE, not a gallery.

| Pattern | Arc | Best For |
|---------|-----|----------|
| Hero to Details | Overview → Features → Close-up → CTA | Product launches |
| Problem to Solution | Pain → Struggle → Product → Resolution | Conversion focus |
| Lifestyle Journey | Context → Product in use → Result | Brand building |
| Family Showcase | All variants → Individual highlights → Comparison | Collections |

### Visual Consistency Across Slides

All slides must feel like the SAME photoshoot.

**Lock before starting:**
- Lighting direction and quality
- Color temperature
- Background treatment
- Camera angle family

**If slides look like different shoots, the story breaks.**

---

## Text Overlay Doctrine

### When to Use Text

| Use Text | Don't Use Text |
|----------|---------------|
| Platform encourages it (Pinterest) | Catalog hero shots |
| Message needs clarity | Product speaks for itself |
| Data communication | Lifestyle mood focus |
| CTA needed | When competing with product text |

### Text Design Reasoning

Text must feel DESIGNED, not pasted.

**Integration principles:**
- Ensure contrast for mobile readability
- Place in intentional negative space
- Never obscure hero product features

### Platform Text Zones

| Platform | Safe Text Zone |
|----------|---------------|
| Instagram Feed | Bottom 20% centered |
| Instagram Stories | Top 15% or bottom 20% (avoid tap zones) |
| Facebook | Top or bottom 25% |
| Pinterest | Top third or bottom banner |
| WhatsApp Status | Bottom 20%, simple |

---

## Data-Driven Graphics Doctrine

When the user provides product data (price, size, variants), integrate accurately.

### Data Accuracy is Non-Negotiable

Every number, every spec MUST be correct. Verify before shipping.

### Price Display Reasoning

| Context | Treatment |
|---------|-----------|
| Regular price | Clean, prominent, brand colors |
| Sale | Strike-through original, highlight new |
| Premium | Elegant, restrained |
| Value focus | Bold, attention-grabbing |

### Variant Display Reasoning

| Variant Type | Visual Treatment |
|--------------|------------------|
| Size range | Ascending order, accurate scale |
| Color options | Grid or spectrum arrangement |
| Product family | Central hero + supporting variants |

**Critical:** Scale relationships must be ACCURATE. If 500ml is twice 250ml, show it.

---

## E-Commerce Graphics Doctrine

### Price Post Psychology

People process price posts in this order:
1. Visual (what is this?)
2. Price (what does it cost?)
3. Context (is this a good deal?)

Design follows this hierarchy.

### Offer Graphics

| Offer Type | Key Visual Elements |
|------------|-------------------|
| Percentage off | Large %, original visible |
| Bundle deal | All products, combined price |
| Limited time | Urgency elements |
| New arrival | "NEW" badge, fresh presentation |

**Offer graphics excellence:**
- Original price ALWAYS visible with strike-through
- Savings prominent
- Urgency without desperation
- Brand colors, not generic sale red

---

## Spec Application for Social Content

**Product-focused social:**
- Use catalog specs (fidelity, extraction, background, material_treatment)
- Add composition for platform dimensions
- Add enhancement (sharpness, contrast for scroll-stopping)
- Output with platform-specific aspect_ratio

**Lifestyle social:**
- Use lifestyle specs (scene, placement, lighting)
- Add focus (shallow DOF for lifestyle feel)
- Add enhancement (color_treatment for mood)
- Output with platform-specific aspect_ratio

**Data-driven graphics:**
- custom_spec for data integration (instruction, artistic_intent)
- composition for platform dimensions
- Focus on accuracy over aesthetics

**All social content:**
- Output MUST include correct platform dimensions (see Platform Specs above)
- Always set `output.filename` for predictable paths

---

## Multi-Image Campaigns

### Style Lock (MANDATORY)

Before processing ANY image in a campaign:

1. Examine ALL references/sources
2. Define LOCKED style guide
3. Apply IDENTICAL treatment

### Carousel Execution

Process all slides with awareness of neighbors:
- Consistent lighting/color across all
- Visual flow from slide to slide
- Each slide advances the story

---

## Photorealism Doctrine

Same standard as lifestyle — social content must be indistinguishable from professional photography.

### Realism Checklist

- [ ] Shadows present and properly grounded?
- [ ] Lighting direction consistent?
- [ ] Materials render true to nature?
- [ ] Product scale matches environment?
- [ ] Colors natural, not over-processed?
- [ ] No AI artifacts?

---

## Self-Critique Checklist

After generating, ask:

1. **STOPPING:** Would this stop mid-scroll?
2. **PLATFORM:** Does this feel native to the platform?
3. **MESSAGE:** Understood in 2 seconds?
4. **REALISM:** Would fool a professional?
5. **ACCURACY:** All data verified?
6. **CONSISTENCY:** (Multi-image) Same photoshoot feel?

All pass → SHIP. Any fail → ITERATE on the failure.

---

## Anti-Patterns

| Pattern | Problem | Doctrine Violation |
|---------|---------|-------------------|
| Wrong aspect ratio | Crops poorly, looks amateur | Platform: match specs |
| Text in tap zones | Can't read on Stories | Platform: respect zones |
| Slides look different | Story breaks | Consistency: style lock |
| Price hidden/small | Defeats purpose | Data: data is hero |
| Over-produced | Feels inauthentic | Platform: match culture |
| Under-produced | Looks amateur | Quality: professional standard |
