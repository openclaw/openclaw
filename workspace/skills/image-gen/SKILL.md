# Image Generation Skill

Generate and edit images using Google Gemini's multimodal image generation.

## Tool Location

```
workspace/skills/image-gen/scripts/image_gen.py
```

## Interface

Write a JSON request file, then run:

```bash
python workspace/skills/image-gen/scripts/image_gen.py --file request.json
```

Output: JSON to stdout with `success`, image `path`, and `metadata`.

## Commands

### `generate` — Create or Transform Images

```json
{
  "command": "generate",
  "prompt": "A professional studio photo of this glass jar on white background, soft diffused lighting from above-left, shallow depth of field",
  "images": [
    {"path": "D:/path/to/source.jpg", "label": "source"}
  ],
  "specs": { ... },
  "output_dir": "D:/openclaw/workspace/output"
}
```

### `edit` — Iterative Editing (Multi-Turn)

```json
{
  "command": "edit",
  "session_id": "jar-hero-v1",
  "prompt": "Make the background warmer and add a subtle shadow on the right",
  "specs": { ... },
  "output_dir": "D:/openclaw/workspace/output"
}
```

### `list_sessions` — List Active Edit Sessions

```json
{
  "command": "list_sessions"
}
```

## Image Labels

When providing reference images, label them by role:

| Label | Role | When to Use |
|-------|------|-------------|
| `source` | THE product to photograph | Always for product shots — output must match this EXACT product |
| `product` | Alias for source | Same as source |
| `style_ref` | Style/mood reference | Match the FEEL (lighting, colors, atmosphere), not content |
| `background` | Background/scene reference | Use as environmental context |

## Structured Specs (All Optional)

Specs provide structured creative direction. They're composed into a natural language prompt — use them for precision, or just write a good `prompt` string.

### The 12 Spec Types

| Spec | Fields | Purpose |
|------|--------|---------|
| `extraction` | target_description, isolation, edge_treatment, targets[{bbox, image_label}] | Isolate product from messy/multi-product images |
| `fidelity` | preserve_colors, preserve_artwork, preserve_text, preserve_texture, preserve_shape, hero_features | PRESERVE product identity |
| `background` | treatment (transparent/solid/scene/gradient), color, scene_description | Background control |
| `lighting` | type, direction, quality, color_temperature, shadows, special_requirements | Light setup |
| `composition` | product_coverage, position, camera_angle, negative_space, crop_instruction | Framing |
| `scene` | environment, style, mood, time_of_day, props_and_context | Lifestyle environment |
| `placement` | position, scale, surface, interaction | Product positioning in scene |
| `material_treatment` | primary_material, rendering_notes, preserve_details | Material-specific rendering |
| `enhancement` | sharpness, contrast, color_treatment, detail_enhancement, cleanup | Post-processing |
| `focus` | focus_point, depth_of_field, falloff | Depth of field |
| `custom_spec` | instruction, style_reference, color_palette, texture_overlay, special_effect, artistic_intent, extra{} | Open-ended creative |
| `output` | format (PNG/JPEG/WEBP), size (1K/2K/4K), aspect_ratio (1:1/2:3/3:2/3:4/4:3/4:5/5:4/9:16/16:9/21:9), filename | Output configuration |

**All spec fields are free-form strings.** Be descriptive. Examples:
- `"preserve_colors": "exact match — the red label must be #CC0000"`
- `"lighting": {"type": "three-point studio", "direction": "key light upper-left at 45°"}`
- `"camera_angle": "slightly elevated 30° looking down, hero perspective"`

## Prompt Writing Tips

**Be specific and descriptive** — Gemini responds to rich natural language:
- ✅ "A high-resolution studio photo of this PET jar on a marble surface, soft diffused lighting from above-left, shallow depth of field focusing on the label, clean white background with subtle gradient"
- ❌ "product photo on white"

**Include photographic language:**
- Camera angles: "eye-level", "slightly elevated", "low-angle hero shot", "overhead flat lay"
- Lighting: "soft diffused", "hard directional", "rim light", "three-point studio setup"
- Depth: "shallow DOF with bokeh", "deep focus throughout", "tilt-shift effect"

**For product photography, always include fidelity spec** when a source image is provided — it tells the model what to preserve.

## Common Patterns

### 1. White Background Hero Shot
```json
{
  "command": "generate",
  "prompt": "Professional product photography, studio-lit hero shot",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact", "preserve_text": "all labels and logos", "preserve_shape": "exact proportions"},
    "background": {"treatment": "solid", "color": "pure white (#FFFFFF)"},
    "lighting": {"type": "soft diffused studio", "direction": "key light upper-left, fill right", "shadows": "soft contact shadow beneath product"},
    "composition": {"product_coverage": "70-80% of frame", "camera_angle": "slightly elevated, hero perspective"},
    "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "hero_shot"}
  }
}
```

### 2. Lifestyle Scene
```json
{
  "command": "generate",
  "prompt": "Place this product in a warm kitchen scene, morning light, cozy atmosphere",
  "images": [
    {"path": "product.jpg", "label": "source"},
    {"path": "kitchen_ref.jpg", "label": "style_ref"}
  ],
  "specs": {
    "fidelity": {"preserve_colors": "exact", "preserve_shape": "exact"},
    "scene": {"environment": "modern kitchen countertop", "mood": "warm and inviting", "time_of_day": "morning golden hour"},
    "placement": {"surface": "granite countertop", "position": "right-of-center", "interaction": "natural, as if placed there"},
    "focus": {"focus_point": "product label", "depth_of_field": "shallow, background softly blurred"},
    "output": {"format": "JPEG", "aspect_ratio": "4:3", "filename": "lifestyle_kitchen"}
  }
}
```

### 3. Background Removal
```json
{
  "command": "generate",
  "prompt": "Extract this product cleanly from the background, preserve all details",
  "images": [{"path": "messy_photo.jpg", "label": "source"}],
  "specs": {
    "extraction": {"target_description": "the glass jar in center of frame", "edge_treatment": "clean, anti-aliased edges"},
    "fidelity": {"preserve_colors": "exact", "preserve_text": "all", "preserve_shape": "exact"},
    "background": {"treatment": "transparent"},
    "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "extracted"}
  }
}
```

### 4. Social Media Post
```json
{
  "command": "generate",
  "prompt": "Eye-catching Instagram post featuring this product with bold colors and modern design",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact", "hero_features": "brand logo prominently visible"},
    "background": {"treatment": "gradient", "color": "brand colors — deep blue to teal"},
    "composition": {"product_coverage": "60%", "position": "center", "negative_space": "top for text overlay"},
    "custom_spec": {"instruction": "Modern, scroll-stopping design. Clean and premium feel.", "color_palette": "brand blues and teals with white accents"},
    "output": {"format": "JPEG", "aspect_ratio": "1:1", "filename": "instagram_post"}
  }
}
```

### 5. Iterative Editing
```json
// First: generate
{
  "command": "generate",
  "prompt": "Studio hero shot of this jar",
  "images": [{"path": "jar.jpg", "label": "source"}],
  "specs": {"output": {"filename": "jar_v1"}},
  "output_dir": "D:/openclaw/workspace/output"
}

// Then: edit (references previous output automatically)
{
  "command": "edit",
  "session_id": "jar-hero",
  "prompt": "The lighting is too harsh. Make it softer and warmer. Also add a subtle reflection on the surface below.",
  "specs": {"output": {"filename": "jar_v2"}},
  "output_dir": "D:/openclaw/workspace/output"
}
```

## Output Format

```json
{
  "success": true,
  "path": "D:/openclaw/workspace/output/hero_shot.png",
  "width": 1024,
  "height": 1024,
  "format": "PNG",
  "size_bytes": 245678,
  "model_notes": "Optional text from model about the generation"
}
```

On error:
```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

## Setup

1. Get a Google AI Studio API key: https://aistudio.google.com/apikey
2. Add `GOOGLE_API_KEY=your_key` to the **workspace root** `.env` file (shared by all skills)
3. Dependencies: `pip install google-genai Pillow`

## Reference Docs

For domain-specific patterns, see `references/`:
- `spec_guide.md` — Detailed guide to all 12 spec types with rich examples
- `catalog_patterns.md` — Product catalog / hero shot patterns
- `lifestyle_patterns.md` — Lifestyle scene generation patterns
- `social_patterns.md` — Social media content patterns

## Model Selection

| Model | ID | Best For | Input Images | Output Res | Extras |
|-------|------|----------|-------------|------------|--------|
| **Nano Banana** (default) | `gemini-2.5-flash-image` | Fast, high-volume, simple edits | Up to 3 | 1K only | Speed + efficiency |
| **Nano Banana Pro** | `gemini-3-pro-image-preview` | Complex scenes, pro assets, text rendering | Up to 14 (6 high-fidelity) | 1K, 2K, 4K | Thinking, Google Search grounding |

Set model in request: `"model": "gemini-3-pro-image-preview"`

### Google Search Grounding (Pro only)

Generate images informed by real-time data (weather, news, events):

```json
{
  "command": "generate",
  "model": "gemini-3-pro-image-preview",
  "use_search": true,
  "prompt": "Create an infographic showing today's weather forecast for Patna, Bihar with icons and temperatures",
  "specs": {"output": {"aspect_ratio": "16:9", "filename": "weather_patna"}}
}
```

## Google's Official Prompt Templates

These templates from Google's docs produce excellent results:

**Photorealistic scenes:**
> A photorealistic [shot type] of [subject], [action or expression], set in [environment]. The scene is illuminated by [lighting description], creating a [mood] atmosphere. Captured with a [camera/lens details], emphasizing [key textures and details]. The image should be in a [aspect ratio] format.

**Product mockups:**
> A high-resolution, studio-lit product photograph of a [product description] on a [background surface]. The lighting is a [lighting setup] to [purpose]. The camera angle is a [angle type] to showcase [feature]. Ultra-realistic, with sharp focus on [key detail]. [Aspect ratio].

**Stickers/icons:**
> A [style] sticker of a [subject], featuring [key characteristics] and a [color palette]. The design should have [line style] and [shading style]. The background must be transparent.

**Text in images (use Pro model):**
> Create a [image type] for [brand/concept] with the text "[text to render]" in a [font style]. The design should be [style description], with a [color scheme].

**Style transfer:**
> Transform the provided photograph of [subject] into the artistic style of [artist/art style]. Preserve the original composition but render it with [description of stylistic elements].

**Combining multiple images:**
> Create a new image by combining the elements from the provided images. Take the [element from image 1] and place it with/on the [element from image 2]. The final image should be a [description of the final scene].

## Limitations

- Image generation is non-deterministic — same prompt may yield different results
- Gemini may refuse certain content (violence, real people, etc.)
- Text rendering: use Pro model (`gemini-3-pro-image-preview`) for accurate text
- Transparent backgrounds (PNG alpha) depend on model capability
- Max input: Flash supports 3 images, Pro supports 14 (6 high-fidelity)
- Maximum ~2048px input dimension (auto-resized if larger)
- Best language support: EN, de-DE, es-MX, fr-FR, hi-IN, ja-JP, ko-KR, pt-BR, zh-CN
- All generated images include a SynthID watermark
