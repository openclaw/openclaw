# Image Generation Skill — Deep Dive Analysis

## Date: 2026-02-14

## What AutifyME Built

### The Core Tool: `image_studio`
A single unified tool wrapping **Gemini 3 Pro Image** (multimodal image generation model). The fundamental operation:

```
prompt (structured JSON specs) + labeled images → new image
```

### Architecture: Intelligence-First
- **Labeled images**: Each input image gets a semantic label (`source`, `product`, `style_ref`, `background`, `product_variant`)
- **Structured specs**: 12 optional spec types guide completeness without restricting creativity
- **Model reasoning**: Gemini receives the specs as JSON + images, and reasons about what to do
- **All specs accept free-form strings** — not enums. Examples inspire, don't restrict.

### The 12 Spec Types

| Spec | Purpose | Key Fields |
|------|---------|------------|
| `extraction` | Extract product from messy/multi-product images | target_description, targets[{bbox, image_label}], isolation, edge_treatment |
| `fidelity` | PRESERVE product identity (colors, artwork, text, shape) | preserve_colors, preserve_artwork, preserve_text, preserve_texture, preserve_shape, hero_features |
| `background` | Background treatment | treatment (transparent/solid/scene/gradient), color, scene_description |
| `lighting` | Light setup | type, direction, quality, color_temperature, shadows, special_requirements |
| `composition` | Framing | product_coverage, position, camera_angle, negative_space, crop_instruction |
| `scene` | Lifestyle environment generation | environment, style, mood, time_of_day, props_and_context |
| `placement` | Product positioning in scene | position, scale, surface, interaction |
| `material_treatment` | Material-specific rendering | primary_material, rendering_notes, preserve_details |
| `enhancement` | Post-processing | sharpness, contrast, color_treatment, detail_enhancement, cleanup |
| `focus` | Depth of field | focus_point, depth_of_field, falloff |
| `custom_spec` | Open-ended creative direction | instruction, style_reference, color_palette, texture_overlay, special_effect, artistic_intent, extra{} |
| `output` | Output config | format (PNG/JPEG/WEBP), size (1K/2K/4K), aspect_ratio, filename |

### The Processing Pipeline

```
1. Load & encode all input images (resize to max 2048px, JPEG quality 85)
2. Build JSON prompt from specs (only non-None fields)
3. Send to Gemini 3 Pro Image with system prompt + user content (text + images)
4. Extract base64 image from response
5. Save to temp file + upload to Supabase Storage (pending/ folder)
6. Return structured output with storage_path + metadata
7. Also return the image as multimodal content so the agent can SEE the result
```

### System Prompt (to Gemini)
Focused on execution, not domain knowledge. Key concepts:
- **Labeled image roles**: [source]/[product] = THE ACTUAL PRODUCT (work from it), [style_ref] = match atmosphere, [background] = scene reference
- **Source vs no-source distinction**: Source provided → output must be BASED ON that product. No source → generate from description.
- **Quality dimensions**: IDENTITY, SHARPNESS, PHOTOREALISM, CREATIVITY — specs guide priority balance
- **Output standards**: Sharp at 200% zoom, professional studio quality, products grounded with contact shadows

### Integration Points
- **Supabase Storage**: Generated images uploaded to `pending/{thread_id}/` automatically
- **Storage paths**: Tool returns `storage_path` (e.g., `pending/output.png`) for downstream use
- **Multimodal return**: Agent SEES the generated image inline for quality verification
- **Stateless**: Each call is completely independent — no memory between calls

---

## How AutifyME USED This Tool

### Domain-Specific Usage Patterns

**1. Catalog (Hero Shots)**
- Transform messy phone photos → professional catalog assets
- FIX photography (bad lighting, cluttered bg, color cast) while PRESERVING product identity
- Use ALL specs: extraction + fidelity + background + lighting + composition + material_treatment + enhancement + focus + output
- 1:1 aspect ratio, 2K resolution, PNG format
- "Would the product owner recognize THIS EXACT PRODUCT?" test

**2. Lifestyle Scenes**
- Place product in realistic environments (kitchen, living room, outdoor)
- Style reference images for mood/atmosphere matching
- Scene + placement + lighting + fidelity + focus + enhancement
- Product must BELONG in scene, not look inserted
- Shallow DOF for lifestyle bokeh

**3. Social Media Content**
- Platform-specific dimensions (1:1 feed, 9:16 stories, 4:5 Instagram)
- Scroll-stopping design
- Can include text overlays via custom_spec
- Data-driven graphics (price posts, offer graphics)

**4. Multi-Item Extraction**
- Detect multiple products in one image
- Classify: VARIANTS (same type, diff attributes) / COLLECTION / COMPONENTS
- Bounding box targeting [y_min, x_min, y_max, x_max] on 0-1000 normalized scale
- Individual extraction per item, or composite family shots
- Anchor-first pattern for batch consistency

**5. Batch Consistency (Catalog Families)**
- Select anchor variant → generate with full specs → HITL approval → batch remaining with IDENTICAL style params
- Style specs extracted as TEXT from viewing anchor (never pass anchor image to subsequent calls)
- Grid test for visual consistency verification

### The Domain Knowledge Layer (Protocols)

AutifyME had a protocol system — `.protocol` files containing domain reasoning doctrines:

| Protocol | Domain | What It Teaches |
|----------|--------|-----------------|
| `catalog_visual` | visual | Hero shot doctrine, identity preservation, material physics, batch consistency |
| `lifestyle_visual` | visual | Scene authenticity, placement integration, mood coherence, photorealism |
| `social_content` | visual | Platform specs, scroll-stopping design, carousel psychology, data graphics |
| `multi_item` | creative | Multi-product detection, classification, extraction strategies, batch patterns |
| `image_studio` | shared | Tool mastery — statelessness, labeled images, spec usage patterns |
| `hitl` | creative | Human feedback handling — iterate until happy |
| `data` | creative | Asset record creation after image processing |

### The Creative Specialist Agent

A specialized agent that:
1. Receives task from Project Manager
2. Loads relevant protocols
3. Views source image (assess quality, material, features)
4. Processes with image_studio (full specs)
5. Views output (quality verification)
6. Creates asset record via write_data (with HITL approval)

Workflow: `view → process → verify → catalog`

---

## What We Need for OpenClaw Skill

### The Fundamental Insight

The AutifyME image_studio tool is really TWO things:
1. **An atomic image generation tool** (Python script calling Gemini API)
2. **Domain knowledge** about WHEN and HOW to use it (protocols + specialist prompts)

For bottom-up approach, we build #1 first. #2 becomes domain skills later.

### What the Atomic Tool Must Do

1. Accept labeled images (local paths, URLs, or Supabase storage paths)
2. Accept structured specs (all 12 types, all optional)
3. Call Gemini image generation API
4. Save output locally
5. Return structured result (path, metadata, success/error)

### What the Atomic Tool Should NOT Do (yet)

- Upload to Supabase Storage (that's the Storage skill)
- Create asset records (that's the Database skill)
- Make domain decisions (that's domain knowledge skills)
- Handle HITL (that's OpenClaw's native capability)

### Key Design Decisions

1. **API Provider**: Gemini (Google) — same as AutifyME. Has native image generation.
2. **Interface**: JSON file → Python script → JSON output (same pattern as db_tool.py)
3. **Image handling**: Input images loaded, resized, encoded. Output saved to workspace.
4. **Spec structure**: Keep the 12 spec types — they're well-designed and model-agnostic
5. **System prompt**: Keep the execution-focused prompt from AutifyME (it's excellent)
6. **Domain knowledge**: Extracted as reference docs in the skill folder (like query_patterns.md for DB skill)

### Scenarios/Permutations to Handle

| Scenario | Input | Key Specs | Output |
|----------|-------|-----------|--------|
| Background removal | 1 product photo | extraction, background(transparent) | PNG with alpha |
| White background hero | 1 product photo | extraction, fidelity, background, lighting, composition, material, enhancement, focus | Professional catalog image |
| Lifestyle scene | 1 product + optional style ref | scene, placement, lighting, fidelity, focus | Product in environment |
| Multi-product extraction | 1 group photo | extraction(multiple targets with bbox) | N individual images |
| Family composition | N product images | composition, background | Combined family shot |
| Social media graphic | 1+ product images | composition, custom_spec, output(platform dims) | Platform-specific content |
| Style transfer | 1 product + 1 style ref | lighting (match ref), scene (match ref) | Product with reference style |
| Enhancement only | 1 product photo | enhancement, focus | Improved version |
| Custom creative | 1+ images | custom_spec, creative_direction | Creative output |
| Batch (N variants) | N source images | Identical specs per item | N consistent outputs |

### What Makes This Different From Generic Image Gen

1. **Labeled images** — not just "generate from prompt" but "transform THESE specific images with THESE roles"
2. **Structured specs** — completeness guidance without rigidity
3. **Fidelity preservation** — the model understands "fix photography, preserve product identity"
4. **Material awareness** — different rendering for glass, metal, plastic, fabric
5. **Bounding box targeting** — precise extraction from multi-product images
6. **Professional photography domain** — system prompt encodes studio photography knowledge

---

## Implementation Plan

### File Structure
```
workspace/skills/image-gen/
├── SKILL.md                    # How to use (for the LLM)
├── scripts/
│   └── image_gen.py            # The atomic tool
├── references/
│   ├── spec_guide.md           # All 12 specs with examples
│   ├── catalog_patterns.md     # Catalog/hero shot domain knowledge
│   ├── lifestyle_patterns.md   # Lifestyle scene domain knowledge
│   └── social_patterns.md      # Social content domain knowledge
└── .env                        # Google API key (gitignored)
```

### image_gen.py Interface (--file pattern)

```json
{
  "command": "generate",
  "images": [
    {"path": "D:/path/to/image.jpg", "label": "source"}
  ],
  "specs": {
    "extraction": {"target_description": "glass jar in [source]"},
    "background": {"treatment": "transparent"},
    "fidelity": {"preserve_colors": "exact match"},
    "output": {"format": "PNG", "size": "2K", "aspect_ratio": "1:1", "filename": "jar_hero"}
  },
  "output_dir": "D:/openclaw/workspace/output"
}
```

Output:
```json
{
  "success": true,
  "path": "D:/openclaw/workspace/output/jar_hero.png",
  "metadata": {"width": 1024, "height": 1024, "format": "PNG", "size_bytes": 245678}
}
```

### Dependencies
- `google-genai` (Google's Gemini SDK)
- `Pillow` (image loading/resizing)

### API Key
- Google AI Studio API key (free tier available)
- Stored in `.env` file
