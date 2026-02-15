# Image Generation Tool Mastery

Master the image_gen.py tool — professional image processing with Google Gemini.

For WHAT TO THINK about different domains, see the domain docs:
- **Catalog work:** `catalog_visual.md`
- **Lifestyle scenes:** `lifestyle_visual.md`
- **Social content:** `social_content.md`
- **Multi-item:** `multi_item.md`

This doc teaches HOW TO USE the tool effectively.

---

## Statelessness Doctrine (CRITICAL)

**Every generation call is COMPLETELY STATELESS. Each call is independent.**

| Reality | Consequence |
|---------|-------------|
| No memory between calls | EVERY call must include ALL details |
| Doesn't know previous images | ALWAYS provide `images` array with paths |
| Doesn't remember materials | ALWAYS specify `material_treatment` when relevant |
| Doesn't retain fidelity context | ALWAYS include `fidelity` spec for source products |
| Doesn't know extraction history | ALWAYS describe target in `extraction.target_description` |

**Your job:** You hold the context. The tool does not. Transfer your understanding INTO each request.

### What This Means in Practice

```json
// WRONG — Assuming tool remembers the source
{
  "command": "generate",
  "prompt": "extract the jar",
  "specs": {"extraction": {"target_description": "the jar"}}
}

// CORRECT — Complete, self-contained call
{
  "command": "generate",
  "prompt": "Professional hero shot of this glass jar, extracted from source photo",
  "images": [{"path": "D:/openclaw/workspace/photos/product.jpg", "label": "source"}],
  "specs": {
    "extraction": {"target_description": "glass jar with blue lid in [source]"},
    "material_treatment": {"primary_material": "clear_glass"},
    "fidelity": {"preserve_colors": "exact blue lid", "hero_features": "honeycomb pattern"}
  }
}
```

### Checklist Before EVERY Call

- [ ] `images` array provided with all needed images and labels?
- [ ] `extraction.target_description` specific enough to identify THE item?
- [ ] `material_treatment` specified for glass/metal/reflective surfaces?
- [ ] `fidelity` included when processing source product images?
- [ ] `focus` specified (deep for catalog, shallow for lifestyle)?
- [ ] `enhancement` included for sharpness/contrast control?
- [ ] `output.filename` specified for predictable output path?
- [ ] Label references (`[source]`, `[product]`, `[style_ref]`) used in specs?

**The tool is your brush. You must tell it exactly what to paint, every time.**

---

## Labeled Images Architecture

The key differentiator: **labeled images + structured specs = intelligent composition**.

### Image Labels

```json
{
  "images": [
    {"path": "D:/path/to/photo.jpg", "label": "source"},
    {"path": "D:/path/to/mood.jpg", "label": "style_ref"}
  ]
}
```

| Label | Purpose |
|-------|---------|
| `source` / `product` | Main product to extract/feature |
| `style_ref` | Mood/lighting reference — match its atmosphere |
| `background` | Background/scene reference |

**Use descriptive labels that match your intent.** Reference labels using `[label]` syntax in specs:

```json
{
  "extraction": {"target_description": "glass jar in [source]"},
  "scene": {"style": "match [style_ref] atmosphere"}
}
```

**Max images:** Flash model supports 3, Pro model supports 14 (6 high-fidelity).

---

## Spec Reference (Quick Guide)

All 12 spec types. Use what applies — don't include irrelevant specs.

### extraction
Isolate product from messy/multi-product image.
- `target_description`: WHAT to extract, reference [label]
- `targets`: Array of `{bbox, image_label}` — WHERE to extract
- `isolation`: How complete (complete, soft with shadow, with context)
- `edge_treatment`: Edge quality (surgical, natural soft, feathered)

### fidelity (CRITICAL for source images)
FIX photography, PRESERVE identity. **Always include with source/product images.**
- `preserve_colors`: True product colors
- `preserve_artwork`: Exact graphics/prints
- `preserve_text`: Exact labels/text
- `preserve_texture`: Actual surface texture
- `preserve_shape`: Real proportions
- `hero_features`: 1-3 features that DEFINE this product

### background
- `treatment`: transparent, solid, gradient, scene
- `color`: Color value
- `scene_description`: For scene backgrounds

### lighting
- `type`: natural window, studio 3-point, rim, dramatic
- `direction`: Where light comes from
- `quality`: Soft diffused, hard specular, wraparound
- `color_temperature`: 5500K neutral, 3200K warm, cool blue
- `shadows`: Soft falloff, no shadows, hard dramatic

### composition
- `product_coverage`: How much frame product fills (80%, 60%)
- `position`: Where in frame (centered, rule of thirds)
- `camera_angle`: Viewing angle (eye level, 45° hero, top-down)
- `negative_space`: Empty space usage

### scene
- `environment`: Setting (modern kitchen, outdoor patio)
- `style`: Visual style (minimalist, rustic, industrial)
- `mood`: Emotional atmosphere (warm, serene, professional)
- `time_of_day`: Lighting context (morning, golden hour)
- `props_and_context`: Supporting elements

### placement
- `position`: Where product goes in scene
- `scale`: How prominent
- `surface`: What product sits on
- `interaction`: How product relates to scene

### material_treatment
- `primary_material`: clear_plastic, glass, metal, fabric, etc.
- `rendering_notes`: How to treat the material
- `preserve_details`: Critical details to preserve

### enhancement
- `sharpness`: Tack sharp, subtle, product sharp background soft
- `contrast`: Subtle lift, medium punch, S-curve for pop
- `color_treatment`: Accurate to source, vibrant, natural
- `detail_enhancement`: Label legibility, texture detail

### focus
- `focus_point`: Where to focus
- `depth_of_field`: Shallow with bokeh, deep all sharp, medium
- `falloff`: How sharpness falls off

### custom_spec
- `instruction`: Open creative direction
- `style_reference`: Reference aesthetic
- `color_palette`: Custom colors
- `artistic_intent`: Emotional/conceptual goal
- `extra`: Anything else (dict)

### output
- `format`: PNG, JPEG, WEBP
- `size`: 1K, 2K, 4K (2K/4K require Pro model)
- `aspect_ratio`: 1:1, 4:5, 9:16, 16:9, etc.
- `filename`: Predictable output name (no extension)

---

## Use Patterns

### Pattern 1: Extract with Transparent Background

```json
{
  "command": "generate",
  "prompt": "Extract this glass jar cleanly, preserve all details",
  "images": [{"path": "photo.jpg", "label": "source"}],
  "specs": {
    "extraction": {"target_description": "glass jar in [source]"},
    "background": {"treatment": "transparent"},
    "material_treatment": {"primary_material": "clear_glass"},
    "fidelity": {"preserve_colors": "true colors", "hero_features": "glass clarity"},
    "output": {"format": "PNG", "filename": "extracted_jar"}
  }
}
```

### Pattern 2: Full Hero Shot (Base Asset)

**Hero shots are foundation assets. Use ALL relevant specs.**

```json
{
  "command": "generate",
  "prompt": "Professional studio hero shot of this PET jar. Commercial catalog quality.",
  "images": [{"path": "source.jpg", "label": "source"}],
  "specs": {
    "extraction": {"target_description": "PET jar in [source]", "edge_treatment": "surgical clean"},
    "fidelity": {"preserve_colors": "exact match", "preserve_artwork": "exact labels", "hero_features": "lid detail, honeycomb texture"},
    "background": {"treatment": "solid", "color": "white"},
    "lighting": {"type": "studio 3-point", "shadows": "soft contact shadow"},
    "composition": {"product_coverage": "75-85%", "camera_angle": "slight top (15-20 deg)"},
    "material_treatment": {"primary_material": "clear_plastic", "rendering_notes": "show quality, not cheap"},
    "focus": {"depth_of_field": "deep — everything sharp"},
    "enhancement": {"sharpness": "tack sharp", "color_treatment": "accurate to source"},
    "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "product_hero"}
  }
}
```

**Key principle:** Include ALL specs. Minimal calls produce garbage.

### Pattern 3: Lifestyle Scene

```json
{
  "command": "generate",
  "prompt": "Natural lifestyle photo of this product in a cozy kitchen, morning light",
  "images": [
    {"path": "product.jpg", "label": "product"},
    {"path": "mood.jpg", "label": "style_ref"}
  ],
  "specs": {
    "scene": {"environment": "modern kitchen", "style": "match [style_ref]", "time_of_day": "morning light"},
    "placement": {"position": "on counter, left third", "surface": "white marble", "interaction": "natural shadow"},
    "lighting": {"type": "natural_window", "special_requirements": "match [style_ref] atmosphere"},
    "fidelity": {"preserve_colors": "true product colors", "hero_features": "label and texture"},
    "focus": {"depth_of_field": "shallow — product sharp, background bokeh"},
    "enhancement": {"sharpness": "crisp on product", "color_treatment": "accurate to source"},
    "output": {"aspect_ratio": "4:5", "filename": "product_lifestyle"}
  }
}
```

### Pattern 4: Multi-Item Extraction

For images with multiple products, extract individually:

```json
{
  "command": "generate",
  "prompt": "Extract the large jar with blue lid from this group photo, professional hero shot",
  "images": [{"path": "group.jpg", "label": "source"}],
  "specs": {
    "extraction": {
      "target_description": "the LARGEST jar with blue floral lid in [source]",
      "targets": [{"bbox": [0, 0, 333, 333], "image_label": "source"}]
    },
    "fidelity": {"preserve_colors": "exact", "hero_features": "blue lid, floral print"},
    "background": {"treatment": "solid", "color": "white"},
    "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "variant_large_blue"}
  }
}
```

### Pattern 5: Iterative Editing (Chat Mode)

Use `edit` command for multi-turn refinement:

```json
// Turn 1 — initial generation
{
  "command": "edit",
  "session_id": "jar-hero",
  "prompt": "Studio hero shot of this jar on white background",
  "images": [{"path": "jar.jpg", "label": "source"}],
  "specs": {"output": {"filename": "jar_v1"}}
}

// Turn 2 — refine (previous output auto-loaded)
{
  "command": "edit",
  "session_id": "jar-hero",
  "prompt": "Make lighting softer and warmer. Add subtle reflection on surface below.",
  "specs": {"output": {"filename": "jar_v2"}}
}
```

### Pattern 6: Verification Grid

After generating batch variants, compose a grid for consistency check:

```json
{
  "command": "generate",
  "prompt": "Create a 2x2 grid of these product variants for comparison",
  "images": [
    {"path": "output/variant_1.png", "label": "v1"},
    {"path": "output/variant_2.png", "label": "v2"},
    {"path": "output/variant_3.png", "label": "v3"},
    {"path": "output/variant_4.png", "label": "v4"}
  ],
  "specs": {
    "composition": {"position": "grid layout — 2x2, equal spacing"},
    "background": {"treatment": "solid", "color": "white"},
    "output": {"aspect_ratio": "1:1", "filename": "verification_grid"}
  }
}
```

---

## Workflow

### Standard: Source → Generate → Verify

```
1. ANALYZE SOURCE — use `image` tool to examine what you're working with
2. GENERATE — write request.json, run image_gen.py
3. VERIFY — use `image` tool to check output quality
4. ITERATE OR SHIP — if quality passes, deliver; if not, adjust specs and retry
```

### For Batches: Anchor → Approve → Batch → Grid Test

```
1. ANALYZE ALL SOURCES
2. GENERATE ANCHOR (best source, full specs)
3. VERIFY ANCHOR (image tool)
4. SHOW USER for approval
5. BATCH REMAINING (identical specs, different targets)
6. GRID TEST (compose verification grid)
7. FIX OUTLIERS if needed
```

---

## Anti-Patterns

| Pattern | Problem | Fix |
|---------|---------|-----|
| No source analysis before generating | Ship blind | Always examine input first |
| Missing fidelity spec | AI generates wrong colors | Include fidelity for ALL source images |
| Missing material_treatment | Glass looks flat, metal looks plastic | Specify material for glass/metal |
| Missing focus spec | Random depth of field | Deep for catalog, shallow for lifestyle |
| No output.filename | Can't find output | Always specify for predictable paths |
| Single extraction for N items | 1 asset for 9 products | Extract each item separately |
| Minimal specs for hero shots | Garbage quality | Use ALL specs (see Pattern 2) |
| Not verifying output | Shipping bad images | Always check with `image` tool after generating |

---

## Model Selection

| Model | Best For | Input Images | Output Res |
|-------|----------|-------------|------------|
| **gemini-2.5-flash-image** (default) | Fast, simple edits, high volume | Up to 3 | 1K |
| **gemini-3-pro-image-preview** | Complex scenes, text rendering, pro assets | Up to 14 | 1K-4K |

Set in request: `"model": "gemini-3-pro-image-preview"`

Pro model also supports Google Search grounding (`"use_search": true`) for real-time data in graphics.
