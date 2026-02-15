# Lifestyle Visual — Domain Doctrine

Domain doctrine for lifestyle imagery: scene generation, contextual placement, aspirational content.

This teaches you HOW TO THINK about lifestyle work, not steps to follow. Internalize the doctrine, then reason from it.

---

## Mental Model

Catalog shows WHAT the product is. Lifestyle shows WHO you become with it.

You're not just placing a product in a scene. You're creating a moment the viewer wants to inhabit.

**The Question:** Would someone look at this and think "I want that life"?

### The Shift from Catalog

| Catalog Thinking | Lifestyle Thinking |
|------------------|-------------------|
| Product is hero | Moment is hero, product belongs |
| Isolate and highlight | Integrate and contextualize |
| Show features | Evoke feelings |
| Technical excellence | Emotional resonance |
| Product dominates | Product completes |

---

## Scene Doctrine

### Environment Selection

The environment tells a story about WHO uses this product.

**Reasoning pattern:**
1. Who is the ideal customer?
2. Where do they spend their time?
3. What moment would they use this product?
4. What does that moment look like?

### Environment-Product Fit

| Product Character | Environment Match |
|-------------------|-------------------|
| Modern, minimal | Clean spaces, contemporary design |
| Traditional, warm | Natural materials, cozy settings |
| Premium, luxury | Aspirational spaces, quality materials |
| Practical, everyday | Real-life settings, relatable contexts |

### Scene Authenticity

Scenes must feel LIVED IN, not staged.

**Authenticity markers:**
- Natural imperfections (a slightly open drawer, morning light angles)
- Contextual props that make sense (coffee cup near morning product)
- Signs of use without mess
- Lighting that could actually exist in that space

**Staged markers (AVOID):**
- Everything perfectly aligned
- No contextual items
- Lighting that's obviously artificial
- Products that look "placed" rather than "belong"

---

## Placement Doctrine

### Product Integration

The product should look like it BELONGS, not like it was inserted.

**Integration checklist:**
- Does the product sit naturally on the surface?
- Would someone actually put this product here?
- Does the scale feel right for the environment?
- Is the product interacting with light correctly?

### Scale Reasoning

**Mental check:** If a person were in this scene, would the product be the right size relative to them?

### Contact and Grounding

Products have weight. They affect their environment:
- Contact shadows where product meets surface
- Subtle surface response (compression on soft surfaces)
- Environmental reflections on product
- Product reflections on glossy surfaces

### Position Psychology

| Placement | Effect |
|-----------|--------|
| Center dominant | Hero moment, product focus |
| Rule of thirds | Editorial, storytelling |
| Background integration | Lifestyle context, product as part of life |
| Being used | Action, demonstration |

---

## Lighting Doctrine

### Environmental Lighting

Lifestyle lighting must be PLAUSIBLE for the environment.

**Ask:** Where would light actually come from in this space?

| Environment | Natural Light Source |
|-------------|---------------------|
| Kitchen | Window over sink, overhead fixtures |
| Living room | Side windows, lamps |
| Outdoor | Sun position for time of day |
| Office | Window light, desk lamp |

### Mood Through Light

| Mood | Lighting Character |
|------|-------------------|
| Warm, inviting | Golden tones, soft shadows, 3000-4000K |
| Fresh, energetic | Cool daylight, crisp shadows, 5500-6500K |
| Calm, serene | Soft diffused, minimal shadows |
| Premium, dramatic | Directional, controlled contrast |

### Light Consistency

All elements in the scene must respond to the SAME light source.

**The Test:** Trace the shadows. Do they all point away from the same source?

---

## Mood Doctrine

### Mood Vocabulary

| Term | Visual Translation |
|------|-------------------|
| Cozy | Warm light, soft textures, intimate scale |
| Fresh | Cool or neutral light, clean lines, airy space |
| Premium | Controlled lighting, quality materials, restraint |
| Playful | Bright colors, dynamic angles, energy |
| Serene | Soft everything, muted palette, stillness |

### Mood Consistency

Every element should reinforce the mood — color temperature, material textures, prop selection, light quality, composition. If one element breaks the mood, the whole image suffers.

### Product-Mood Alignment

The product's character should match the scene's mood.

**Conflict example:** Minimalist modern bottle in rustic cabin scene.
**Resolution:** Either change the scene to match the product, or acknowledge the contrast is intentional.

---

## Photorealism Doctrine (CRITICAL)

Lifestyle images must be INDISTINGUISHABLE from professional photography.

### The Uncanny Valley

AI-generated scenes often fall into uncanny valley:
- Too perfect (no natural imperfections)
- Lighting impossibilities (shadows in wrong direction)
- Scale errors (products too big/small)
- Texture repetition (AI artifact)
- Weird edge blending

**Your job:** Catch and fix these before shipping.

### Realism Checklist

Before shipping ANY lifestyle image:

- [ ] Shadows present and properly grounded?
- [ ] Lighting direction consistent across all elements?
- [ ] Materials render true to their nature?
- [ ] Product scale matches environment?
- [ ] Colors natural, not over-processed?
- [ ] No AI artifacts (weird edges, texture repetition)?
- [ ] Scene feels lived-in, not sterile?

**If ANY check fails, iterate.**

### The Photographer Test

Would a professional photographer believe this came from a real photoshoot?

This is not a metaphor. Actually imagine showing this to a photographer. What would they call out?

---

## Spec Application for Lifestyle

For lifestyle work, these specs typically matter:

| Spec | Purpose |
|------|---------|
| **scene** | Environment, style, mood, time_of_day, props_and_context |
| **placement** | Where product sits (position, scale, surface, interaction) |
| **lighting** | Match environment, create mood (type, direction, color_temperature) |
| **composition** | Framing, product prominence (product_coverage, position, camera_angle) |
| **fidelity** | ALWAYS include when using source product image — preserve identity |
| **material_treatment** | For glass/metal products — even in lifestyle, materials need correct physics |
| **focus** | Depth of field — shallow for lifestyle bokeh, product sharp |
| **enhancement** | Post-processing (sharpness, color_treatment — accurate to source) |
| **output** | Platform dimensions (1:1, 4:5, 9:16 depending on use) |

You rarely need: extraction (unless compositing), background as separate spec (scene handles it).

### Scene + Placement Together

Scene defines the environment. Placement defines where product goes. They work TOGETHER:

```json
{
  "specs": {
    "scene": {
      "environment": "Modern minimalist kitchen",
      "mood": "warm morning",
      "time_of_day": "morning light"
    },
    "placement": {
      "position": "on marble counter, left third",
      "surface": "white marble",
      "interaction": "natural shadow, coffee cup nearby"
    }
  }
}
```

---

## Style Direction

**Capture style through specs:**
- `scene.style`: Visual aesthetic ("warm minimalist", "industrial chic")
- `scene.mood`: Emotional atmosphere ("cozy morning", "aspirational luxury")
- `lighting.type` + `color_temperature`: Light quality ("natural_window", "warm 3200K")
- `custom_spec.instruction`: Detailed creative direction

**When user provides a reference image:**
Use the `image` tool to examine it, understand the mood/atmosphere, and translate into your specs.

**What to match from reference:**
- Light quality and direction
- Color temperature
- Mood and atmosphere
- Level of minimalism/richness

**What NOT to copy:**
- Exact composition
- Specific props
- Literal recreation

Style references guide the FEELING, not the specifics.

---

## Multi-Image Consistency

For campaigns or sequences with multiple lifestyle images:

### Style Lock (MANDATORY)

Before processing ANY image in a set:

1. Examine ALL references/sources first
2. Define LOCKED style guide:
   - Lighting direction and quality
   - Color temperature
   - Mood keywords
   - Composition rules
3. Apply IDENTICAL treatment to all

**Why:** Multiple images must look like the same photoshoot.

### Consistency Verification

After generating all images:
- Lighting temperature: IDENTICAL?
- Shadow direction: CONSISTENT?
- Color grade: MATCHING?
- Mood: COHESIVE?

---

## Self-Critique Checklist

After generating, ask:

1. **INTEGRATION:** Does product BELONG in this scene?
2. **GROUNDING:** Contact shadows, proper scale?
3. **LIGHTING:** Plausible for environment, consistent direction?
4. **MOOD:** All elements reinforce the feeling?
5. **REALISM:** Would fool a professional photographer?
6. **DESIRE:** Does this make someone want the product?

All pass → SHIP. Any fail → ITERATE on the failure.

---

## Anti-Patterns

| Pattern | Problem | Doctrine Violation |
|---------|---------|-------------------|
| Product floating in scene | No grounding | Placement: contact shadows required |
| Perfect CGI environment | Uncanny valley | Realism: lived-in, not sterile |
| Lighting from nowhere | Breaks believability | Lighting: plausible for environment |
| Product too prominent | Loses lifestyle feel | Lifestyle: moment is hero |
| Mood mismatch | Product fights environment | Mood: product-environment alignment |
| Inconsistent multi-image | Looks like different shoots | Style lock: identical treatment |
