# Image Generation Spec Guide

Complete reference for the 12 structured spec types. All fields are **free-form strings** — be descriptive and specific. Only include specs relevant to the task.

## 1. extraction

**Purpose:** Isolate and extract a product from a cluttered or multi-product image.

| Field | Description | Examples |
|-------|-------------|----------|
| `target_description` | What to extract | "the red PET jar in center", "all three bottles" |
| `isolation` | How to isolate | "clean cutout", "separate each item", "remove surrounding products" |
| `edge_treatment` | Edge quality | "clean anti-aliased edges", "feathered 2px", "sharp pixel-perfect" |
| `targets` | Multi-target list | `[{"bbox": [100, 200, 500, 600], "image_label": "source"}]` |

**When to use:** Source image has clutter, multiple products, or messy background you want to remove.

**bbox format:** `[y_min, x_min, y_max, x_max]` on 0–1000 normalized scale.

## 2. fidelity

**Purpose:** Preserve product identity — the most critical spec for product photography.

| Field | Description | Examples |
|-------|-------------|----------|
| `preserve_colors` | Color accuracy | "exact match", "match Pantone 186C red", "preserve label gradient" |
| `preserve_artwork` | Graphics/logos | "all label artwork exactly as-is", "brand logo must be sharp and legible" |
| `preserve_text` | Text on product | "all text readable", "Hindi and English labels preserved", "SKU number visible" |
| `preserve_texture` | Surface texture | "matte finish visible", "glass transparency maintained", "embossed pattern clear" |
| `preserve_shape` | Form accuracy | "exact proportions", "cap shape precisely maintained", "no distortion" |
| `hero_features` | Key features | "unique ribbed grip pattern", "holographic label effect", "transparent window showing contents" |

**When to use:** ALWAYS when a source/product image is provided. This is what prevents the model from "inventing" a different product.

**The golden test:** "Would the product owner recognize THIS EXACT PRODUCT in the output?"

## 3. background

**Purpose:** Control what's behind the product.

| Field | Description | Examples |
|-------|-------------|----------|
| `treatment` | Type | "transparent", "solid", "gradient", "scene", "blurred original" |
| `color` | Background color | "pure white (#FFFFFF)", "soft grey (#F0F0F0)", "brand blue #003366" |
| `scene_description` | Scene (if treatment=scene) | "marble countertop with soft shadows", "wooden shelf in a pantry" |

**Common treatments:**
- **transparent** → PNG with alpha channel (for catalog/compositing)
- **solid white** → Classic e-commerce (Amazon-style)
- **gradient** → Premium feel (subtle light-to-dark gradient)
- **scene** → Lifestyle (pairs with `scene` spec)

## 4. lighting

**Purpose:** Control the light setup like a photography director.

| Field | Description | Examples |
|-------|-------------|----------|
| `type` | Lighting setup | "soft diffused studio", "three-point", "natural window light", "dramatic single source" |
| `direction` | Light placement | "key light upper-left at 45°", "backlit with rim light", "overhead flat" |
| `quality` | Light character | "soft and even", "hard with defined shadows", "dappled through leaves" |
| `color_temperature` | Warmth | "neutral 5500K", "warm golden 3200K", "cool blue 7000K" |
| `shadows` | Shadow control | "soft contact shadow only", "long dramatic shadows to the right", "minimal shadows" |
| `special_requirements` | Extra notes | "match the lighting in [style_ref]", "simulate late afternoon sun" |

**Photography lighting cheat sheet:**
- **Catalog/hero:** Soft diffused, key + fill, minimal shadows
- **Lifestyle:** Natural/warm, directional, visible shadows for depth
- **Dramatic:** Single hard source, deep shadows, high contrast
- **Flat lay:** Overhead even lighting, no shadows

## 5. composition

**Purpose:** Control framing, angle, and space.

| Field | Description | Examples |
|-------|-------------|----------|
| `product_coverage` | Frame fill | "70-80% of frame", "30% (lots of negative space)", "tight crop on label" |
| `position` | Placement in frame | "center", "rule-of-thirds left", "lower-right with space above for text" |
| `camera_angle` | Perspective | "eye-level straight on", "slightly elevated 30°", "low-angle hero", "overhead flat lay" |
| `negative_space` | Empty space | "minimal", "generous top and right for text overlay", "even margins all around" |
| `crop_instruction` | Specific crop | "include full product with 10% margin", "crop tight to label area" |

**Platform-specific composition:**
- **E-commerce square (1:1):** Center, 80% coverage, even margins
- **Instagram feed (1:1 or 4:5):** Rule-of-thirds, space for captions
- **Stories/Reels (9:16):** Product in lower 2/3, top for text
- **Banner (16:9):** Product left or right, wide negative space

## 6. scene

**Purpose:** Define the lifestyle environment around the product.

| Field | Description | Examples |
|-------|-------------|----------|
| `environment` | Setting | "modern kitchen countertop", "outdoor picnic on grass", "luxury bathroom shelf" |
| `style` | Visual style | "minimalist Scandinavian", "rustic farmhouse", "modern industrial" |
| `mood` | Atmosphere | "warm and inviting", "fresh and clean", "cozy evening" |
| `time_of_day` | Lighting context | "morning golden hour", "bright midday", "warm sunset", "soft overcast" |
| `props_and_context` | Supporting elements | "fresh herbs nearby, wooden cutting board", "towel and candle", "scattered coffee beans" |

**Scene authenticity rules:**
- Product must look PLACED, not pasted
- Props should make sense (food product → kitchen context, beauty product → bathroom)
- Lighting must be consistent between product and scene
- Scale must be realistic

## 7. placement

**Purpose:** Control exactly how the product sits in a scene.

| Field | Description | Examples |
|-------|-------------|----------|
| `position` | Where | "center of counter", "right-of-center at 2/3 mark", "arranged in triangle formation" |
| `scale` | Size | "life-size proportion", "slightly larger than life for emphasis", "to-scale with surroundings" |
| `surface` | What it's on | "marble countertop", "wooden table", "floating with shadow below" |
| `interaction` | How it relates | "naturally placed as if someone set it down", "being poured into glass", "arranged with other items" |

## 8. material_treatment

**Purpose:** Guide accurate material rendering.

| Field | Description | Examples |
|-------|-------------|----------|
| `primary_material` | Main material | "clear PET plastic", "frosted glass", "brushed aluminum", "matte ceramic" |
| `rendering_notes` | How to render | "show transparency with contents visible", "metallic specular highlights on cap", "matte finish should absorb light" |
| `preserve_details` | Specific details | "embossed logo on cap must be visible", "recycling symbol on base", "seam line should be minimized" |

**Material physics cheat sheet:**
- **Glass:** Transparent, refractive, reflective highlights, visible contents
- **PET/Plastic:** Semi-transparent or opaque, subtle sheen, clean edges
- **Metal:** Specular highlights, reflections of environment, brushed/polished texture
- **Matte:** Light absorption, soft gradients, no harsh reflections
- **Paper/Label:** Flat, readable text, accurate colors, slight curl/depth

## 9. enhancement

**Purpose:** Post-processing adjustments.

| Field | Description | Examples |
|-------|-------------|----------|
| `sharpness` | Detail clarity | "razor sharp at 200% zoom", "natural sharpness", "slightly soft/dreamy" |
| `contrast` | Tonal range | "high contrast, punchy", "low contrast, airy and light", "match [style_ref] contrast" |
| `color_treatment` | Color grading | "vibrant and saturated", "desaturated moody tones", "warm color grade" |
| `detail_enhancement` | Texture boost | "enhance material textures", "bring out label detail", "subtle skin smoothing on packaging" |
| `cleanup` | Fixes | "remove dust spots", "clean up label wrinkles", "fix color cast from original photo" |

## 10. focus

**Purpose:** Depth of field control.

| Field | Description | Examples |
|-------|-------------|----------|
| `focus_point` | What's sharp | "product label", "cap and upper body", "entire product front-to-back" |
| `depth_of_field` | DOF range | "shallow — only label in focus", "moderate — full product sharp, background soft", "deep — everything sharp" |
| `falloff` | Blur transition | "gradual natural falloff", "sharp transition to bokeh", "tilt-shift effect" |

**DOF guidelines:**
- **Catalog:** Deep focus (everything sharp) or moderate (product sharp, bg soft)
- **Lifestyle:** Shallow (product sharp, scene as bokeh context)
- **Detail/macro:** Very shallow (specific feature in focus)
- **Social:** Moderate (product clear, enough context visible)

## 11. custom_spec

**Purpose:** Anything not covered by the other 11 specs.

| Field | Description | Examples |
|-------|-------------|----------|
| `instruction` | Open creative direction | "Create a vintage 1950s advertising style", "Make it look like a magazine cover" |
| `style_reference` | Style to match | "match the aesthetic of Apple product photography", "Wes Anderson color palette" |
| `color_palette` | Specific colors | "pastel pinks and mint greens", "monochrome with one red accent" |
| `texture_overlay` | Texture effects | "subtle paper texture overlay", "film grain for vintage feel" |
| `special_effect` | Effects | "lens flare from upper right", "water droplets on product", "steam rising" |
| `artistic_intent` | The why | "this is for a premium brand launch — everything should feel luxurious" |
| `extra` | Anything else | `{"text_overlay": "NEW", "text_position": "upper-right badge"}` |

## 12. output

**Purpose:** Technical output specifications.

| Field | Values | Default |
|-------|--------|---------|
| `format` | PNG, JPEG, WEBP | PNG |
| `size` | 1K, 2K, 4K | (model default) |
| `aspect_ratio` | 1:1, 3:4, 4:3, 9:16, 16:9 | 1:1 |
| `filename` | Any string (no extension) | gen_{timestamp} |

**Format selection:**
- **PNG:** Catalog images, transparent backgrounds, maximum quality
- **JPEG:** Lifestyle shots, social media, web use (smaller files)
- **WEBP:** Web-optimized, good quality-to-size ratio
