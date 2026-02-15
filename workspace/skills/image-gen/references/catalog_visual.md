# Catalog Visual — Domain Doctrine

Transform messy phone photos into professional catalog assets.

**The Reality:** Users upload photos with bad lighting, cluttered backgrounds, harsh shadows, color casts. Your job is to transform these into images that look like they came from a professional studio.

**The Principle:** FIX the photography. PRESERVE the product identity.

---

## Core Doctrine

### 1. Identity Is Sacred

Every product has an identity — its colors, artwork, texture, shape. This is non-negotiable:

| Preserve (IDENTITY) | Fix (PHOTOGRAPHY) |
|---------------------|-------------------|
| Actual product colors | Color cast from bad lighting |
| Exact label artwork/text | Blur from camera shake |
| Surface texture/pattern | Harsh shadows |
| True proportions | Cluttered background |
| Hero features (lid, cap, details) | Poor exposure |

**The Test:** Would the product owner recognize THIS EXACT PRODUCT?

If AI generated "similar" colors or "readable but different" text — you failed. Iterate.

### 2. Material Physics

Light behaves differently on different materials. Honor the physics:

| Material | What Light Does | Your Focus |
|----------|-----------------|------------|
| **Clear plastic (PET)** | Surface sheen, shows contents | Label sharp, no harsh speculars, surface looks quality |
| **Opaque plastic** | Reveals form and texture | Clean shape, label readable, surface quality |
| **Glass** | Refracts, creates caustics | Internal glow, edge definition, depth |
| **Metal** | Reflects environment | Gradient reflections following form, no hot spots |

Don't memorize lighting setups. Ask: "What does light DO to this material?" Then set your specs to reveal its nature.

### 3. Background for Contrast

Background exists for ONE purpose: make the product pop.

| Product Color | Background Choice | Why |
|---------------|-------------------|-----|
| Dark/black | White or light gray | Edge contrast |
| Light/white | Light gray (not white) | Prevent lost edges |
| Vibrant colors | Neutral white/gray | Let colors pop |

**The Test:** Can you clearly see product edges against background? If edges blend, wrong background.

### 4. Professional Quality Bar

Every output must pass:

- **Sharp:** Tack sharp at 200%, labels legible
- **Grounded:** Contact shadow, product has weight
- **Photorealistic:** Would a photographer believe this came from a real shoot?
- **Clean:** No artifacts, halos, extraction errors

If any dimension fails — iterate. Don't ship garbage.

---

## Hero Shots (Foundation Assets)

Hero shots are the FLAGSHIP image. All downstream content builds on these — lifestyle scenes, social posts, campaigns. A weak hero shot cascades failures through everything.

### Hero Shot Principles

1. **Dominance:** Product fills 75-85% of frame
2. **Authority:** Slight top angle (15-20°) or eye level
3. **Intention:** Negative space deliberate (top for text overlay)
4. **Sharpness:** Everything tack sharp, labels legible
5. **Identity:** Exact colors, artwork, texture from source

### Before Shipping ANY Hero Shot

Ask yourself:
- Does it show THE SAME product, just better photographed?
- Are labels fully legible at 200%?
- Is the product grounded (contact shadow)?
- Would this pass as professional studio photography?

If ANY answer is "no" — iterate.

### The Garbage Hero Shot (NEVER DO THIS)

```json
{
  "command": "generate",
  "prompt": "product on white background",
  "images": [{"path": "photo.jpg", "label": "source"}],
  "specs": {
    "background": {"treatment": "solid", "color": "white"}
  }
}
```

This produces: Soft focus, wrong colors, no identity preservation, amateur quality.

**Why it fails:** Missing fidelity (AI generates colors), missing focus (random DOF), missing lighting (flat), missing composition (bad framing), missing material_treatment (plastic looks cheap).

**There is no "quick" hero shot.** Use ALL relevant specs. See `catalog_patterns.md` for the full template.

---

## Color Handling (CRITICAL)

**NEVER use color names from the user's description in your specs.**

User says "Royal Blue lid" → Your spec says: `"preserve_colors": "the blue lid matching source exactly"`

Why? Color names tell the model to GENERATE a color. You want to EXTRACT and preserve the actual color from the source image.

---

## Catalog Consistency Doctrine

Catalog shots are **foundation assets**. All future content builds on these. Inconsistent foundations create downstream chaos.

### The Catalog Grid Test

**Would these images look professional side-by-side in a product grid?**

If variants have different angles, framing, or lighting direction, the grid looks amateur.

### Variant/Family Consistency Requirements

| Element | Requirement | Why |
|---------|-------------|-----|
| **Camera Angle** | IDENTICAL across all variants | Grid alignment |
| **Framing/Proportions** | Same product coverage (70-85%) | Visual harmony |
| **Lighting Direction** | Same key light position | Consistent shadows |
| **Output Dimensions** | Same aspect ratio and size | Grid compatibility |
| **Background** | Identical treatment | Clean comparison |

### Feature Visibility Doctrine

All critical features must be visible in catalog shots:

| Feature Type | Must Show | Common Failure |
|--------------|-----------|----------------|
| **Label/Brand** | Full label readable | Label partially hidden by angle |
| **Size Indicator** | Size text/marking visible | Size info cropped or obscured |
| **Key Differentiator** | What makes variants different | Differentiator not prominent |
| **Texture/Pattern** | Hero texture fully visible | Texture compressed or hidden |
| **Product Shape** | True proportions | Lens distortion, odd angle |

### Dimension Standards

| Use Case | Aspect Ratio | Minimum Size | Notes |
|----------|--------------|--------------|-------|
| E-commerce grid | 1:1 (square) | 1000×1000px | Most common, universal |
| Product detail | 1:1 or 4:5 | 1500×1500px | Higher res for zoom |
| Marketplace | Per platform | Per platform | Check requirements |

**Default:** 1:1 at 1024×1024 unless user specifies otherwise.

---

## Batch Processing (Anchor-First Pattern)

For a family with N variants, you MUST enforce visual consistency.

### The Problem

Each generation call is independent and non-deterministic. Without consistency enforcement:
- Different camera angles across variants
- Different lighting directions
- Different framing/coverage
- Result: Unusable as a cohesive set

### The Solution: Anchor-First with Style Lock

```
1. ANALYZE ALL VARIANTS — understand the full set before generating anything
2. SELECT ANCHOR — choose the sharpest, best-lit variant
   - If NO variant is suitable → tell the user
3. GENERATE ANCHOR — process ONE variant with full specs
4. VERIFY ANCHOR — use the `image` tool to examine the result
5. EXTRACT STYLE AS TEXT — describe what you see in precise terms:
   - Camera: "eye-level, 0 degrees, perfectly upfront"
   - Lighting: "3-point studio, soft shadow bottom-right"
   - Framing: "80% frame, centered"
   - Background: "pure white, soft contact shadow"
6. SHOW USER — send the anchor image for approval
   - "Here's the first variant. Approve this style for the entire batch?"
   - WAIT for approval before proceeding
7. BATCH REMAINING — use identical specs + style description in custom_spec
8. GRID TEST — compare all outputs for visual consistency
```

### Why TEXT Description, Not Anchor Image

Passing a generated image as reference causes Gemini to REPRODUCE that image instead of EXTRACTING from the new source. The anchor exists ONLY to establish style specs as TEXT. Once you've described it, the anchor's job is done — it should NOT appear in subsequent generation calls.

### Style Lock for Batch

After viewing the anchor, encode the style in `custom_spec.instruction`:

```json
{
  "custom_spec": {
    "instruction": "Match the anchor style EXACTLY: Camera: eye-level, 0 degrees. Lighting: 3-point studio, shadow bottom-right. Framing: 80% frame, centered. This must look like the same photoshoot as the anchor."
  }
}
```

### Anchor Selection

| Criterion | Why | If Not Met |
|-----------|-----|------------|
| Sharp in source | Blur affects extraction | Try different variant |
| Well-lit in source | Shadows affect quality | Try different variant |
| Shows full features | Partial = incomplete | Try different variant |
| **ALL fail** | No suitable anchor | **Tell the user** |

**Heuristics when equal:**
- Size variants: Prefer MEDIUM
- Design variants: Prefer the hero/bestseller

### What MUST Be Identical Across Batch

- Camera angle and framing
- Lighting direction and quality
- Background treatment
- Output aspect ratio and size
- Enhancement settings

### What CAN Differ

- `extraction.target_description` (different product each time)
- `fidelity.hero_features` (different features per variant)
- `output.filename` (different name per variant)

### Recovery (3 attempts max per variant)

| Attempt | Action |
|---------|--------|
| 1st | More explicit style specs (numeric values) |
| 2nd | Different anchor variant |
| 3rd | Tell user: "Variant X resists consistency due to [reason]" |

### Consistency Self-Check

After processing a batch:

1. **ANGLE:** All variants shot from same angle?
2. **FRAMING:** Products fill same percentage of frame?
3. **LIGHTING:** Shadows fall same direction?
4. **FEATURES:** All key features visible on each?
5. **DIMENSIONS:** All same size and aspect ratio?
6. **GRID TEST:** Would these look pro side-by-side?

If ANY fails → Fix before shipping.

---

## Multi-Item Doctrine

When source contains multiple items:

### Detection

Your visual analysis (see `visual_analysis.md`) will identify:
- Classification (VARIANTS, COLLECTION, COMPONENTS)
- Extraction Targets (each item with bounding box)

### Strategy Selection

| User Signal | Strategy | Action |
|-------------|----------|--------|
| "each", "per SKU" | INDIVIDUAL | One generation per item |
| "family", "together" | COMPOSITE | All items in one call |
| "only the X" | SELECTIVE | Filter, then process |

### Variant Identification (CRITICAL for targeting)

**Use visual differentiators BEFORE position.** Position is ambiguous; visual characteristics are not.

| Priority | Differentiator | Why Reliable |
|----------|----------------|--------------|
| 1 | **BOUNDING BOX** | Pixel-precise coordinates — absolute |
| 2 | **SIZE** | "the LARGEST jar" has ONE correct answer |
| 3 | **VISUAL PATTERN** | Colors, prints, designs are intrinsic |
| 4 | **TEXT/LABEL** | Explicit when readable |
| 5 | **POSITION** | Last resort — only when visuals identical |

**For size variants:** Lead with SIZE ("the LARGEST [product]", "the SMALLEST [product]")
**For design variants:** Lead with VISUAL ("the [product] with [distinctive pattern]")
**Combine for precision:** "the LARGEST jar with blue floral print"

### Key Rule

**Never treat N items as 1.** If you identified 9 products and strategy is INDIVIDUAL, you generate 9 assets.

---

## Self-Critique Checklist

After generating, ask:

1. **IDENTITY:** Same product, just better photographed?
2. **SHARPNESS:** Labels legible at 200%?
3. **GROUNDED:** Contact shadow, has weight?
4. **EDGES:** Clean against background?

For batches, add:
5. **CONSISTENT:** Same angle, framing, shadows across all?
6. **GRID TEST:** Would look professional side-by-side?

Any "no" → iterate. Don't ship garbage.
