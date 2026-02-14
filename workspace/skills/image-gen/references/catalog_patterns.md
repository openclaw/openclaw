# Catalog & Hero Shot Patterns

Domain knowledge for product catalog photography using the image generation tool.

## The Catalog Mission

Transform messy phone photos into professional catalog assets. Fix the PHOTOGRAPHY while preserving the PRODUCT.

**The golden rule:** The product owner must recognize their EXACT product in every output. Colors, text, logos, shape, proportions — sacred and untouchable.

## Standard Catalog Workflow

### 1. Assess Source Quality
Before generating, evaluate the source image:
- **Lighting quality:** Over/under-exposed? Color cast? Uneven?
- **Background:** Cluttered? Distracting? Multiple products?
- **Product visibility:** Partially obscured? Tilted? Blurry?
- **Key features:** Label readable? Logo visible? Unique details clear?

### 2. Choose the Right Pattern

| Source Quality | Pattern | Key Specs |
|---------------|---------|-----------|
| Good photo, bad background | Background swap | extraction, fidelity, background, output |
| Bad photo overall | Full hero shot | fidelity, background, lighting, composition, material_treatment, enhancement, focus, output |
| Multiple products in one shot | Multi-extraction | extraction (with targets), fidelity, background, output |
| Product variants (colors/sizes) | Batch consistency | Same specs for all, anchor-first pattern |

### 3. Hero Shot Template

The go-to for professional catalog images:

```json
{
  "command": "generate",
  "prompt": "Professional product photography. Studio-lit hero shot of this [MATERIAL] [PRODUCT_TYPE]. Clean, commercial quality suitable for e-commerce catalog.",
  "images": [{"path": "source.jpg", "label": "source"}],
  "specs": {
    "extraction": {
      "target_description": "[describe product in image]",
      "edge_treatment": "clean anti-aliased"
    },
    "fidelity": {
      "preserve_colors": "exact color match — [note specific colors]",
      "preserve_text": "all label text legible and accurate",
      "preserve_artwork": "logo and label graphics exactly as source",
      "preserve_shape": "exact proportions maintained",
      "hero_features": "[unique product features to emphasize]"
    },
    "background": {
      "treatment": "solid",
      "color": "pure white (#FFFFFF)"
    },
    "lighting": {
      "type": "soft diffused studio lighting",
      "direction": "key light upper-left at 45°, fill light from right",
      "shadows": "soft, subtle contact shadow beneath product"
    },
    "composition": {
      "product_coverage": "75% of frame",
      "camera_angle": "slightly elevated, hero perspective",
      "negative_space": "even margins all around"
    },
    "material_treatment": {
      "primary_material": "[glass/PET/metal/etc.]",
      "rendering_notes": "[material-specific notes]"
    },
    "enhancement": {
      "sharpness": "sharp at 200% zoom",
      "cleanup": "remove dust, scratches, fingerprints from source"
    },
    "focus": {
      "focus_point": "product label and body",
      "depth_of_field": "moderate — full product sharp"
    },
    "output": {
      "format": "PNG",
      "aspect_ratio": "1:1",
      "filename": "[product_name]_hero"
    }
  }
}
```

## Material-Specific Notes

### PET / Plastic Containers
- Show material quality — not cheap-looking
- If transparent, contents should be visible through walls
- Cap/closure detail matters — render precisely
- Seam lines: minimize but don't remove (looks fake)
- Recycling marks on base: preserve if visible

### Glass
- Transparency with proper refraction
- Reflective highlights that show studio lights
- Contents visible through glass
- Label should appear through glass from behind (if applicable)
- Extra care with color accuracy (glass tints)

### Metal / Aluminum
- Specular highlights showing environment
- Brushed vs polished texture distinction
- Embossed details must be visible
- Proper reflection behavior

### Paper / Cardboard Packaging
- Texture of the material should be visible
- Print quality should look crisp
- Slight dimensional depth (not perfectly flat)
- Flap/fold details matter

## Multi-Product Extraction

When source has multiple products:

1. **Identify products** — note positions, count
2. **Use bounding boxes** if precise targeting needed (0-1000 normalized scale)
3. **Extract individually** — one generation call per product
4. **Consistent specs** — same lighting/background/composition for the family

## Batch Consistency Pattern

For product variants (same product, different colors/sizes/flavors):

1. **Pick anchor** — choose the most representative variant
2. **Generate anchor** with full specs → get approval
3. **Extract style description** — note exactly what the approved output looks like
4. **Apply identical specs** to remaining variants
5. **Verify consistency** — compare all outputs side by side

**Critical:** Between anchor and variants, keep specs IDENTICAL. The only thing that changes is the source image.

## E-Commerce Platform Requirements

| Platform | Aspect Ratio | Min Size | Background | Notes |
|----------|-------------|----------|------------|-------|
| Amazon | 1:1 | 1000x1000 | Pure white | 85%+ fill, no text/badges |
| Flipkart | 1:1 | 500x500 | White | Similar to Amazon |
| Shopify | 1:1 | 2048x2048 | Any | Consistent across catalog |
| Instagram Shop | 1:1 | 1080x1080 | Any | Lifestyle OK |
| General catalog | 1:1 | 1024x1024 | White or transparent | PNG for transparency |

## Quality Checklist

Before approving a catalog image:
- [ ] Product is recognizable as the exact source product
- [ ] Colors match source (especially brand colors)
- [ ] All text on labels/packaging is legible
- [ ] Logo/branding is clear and accurate
- [ ] Material looks realistic (glass is glassy, metal is metallic)
- [ ] Lighting is professional and even
- [ ] Background is clean (no artifacts)
- [ ] Product is properly framed with appropriate margins
- [ ] Shadow looks natural
- [ ] No distortion of product shape
