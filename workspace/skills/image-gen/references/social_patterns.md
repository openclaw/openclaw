# Social Media Content Patterns

Domain knowledge for creating platform-specific visual content.

## Platform Specifications

| Platform | Format | Aspect Ratio | Ideal Size | Notes |
|----------|--------|-------------|------------|-------|
| Instagram Feed | Square | 1:1 | 1080x1080 | Most versatile |
| Instagram Feed | Portrait | 4:5 | 1080x1350 | More screen real estate |
| Instagram Stories/Reels | Vertical | 9:16 | 1080x1920 | Full screen |
| Facebook Post | Landscape | 16:9 | 1200x675 | Feed-optimized |
| WhatsApp Status | Vertical | 9:16 | 1080x1920 | Similar to Stories |
| Twitter/X | Landscape | 16:9 | 1200x675 | Timeline card |
| LinkedIn | Landscape | 16:9 | 1200x627 | Professional |
| Pinterest | Tall portrait | 2:3 | 1000x1500 | Scroll-stopping tall pins |

## Design Principles for Social

### Scroll-Stopping Power
- **Bold colors** that pop against feed backgrounds
- **High contrast** between product and background
- **Clean composition** — instantly readable at thumbnail size
- **One clear subject** — don't overload the visual

### Text-Safe Zones
When images need text overlay (done by separate tools):
- **Top 20%** — good for headlines
- **Bottom 15%** — good for CTAs/prices
- Keep product in the safe middle zone
- Use negative space intentionally for text placement

## Common Social Templates

### Product Announcement / Launch
```json
{
  "command": "generate",
  "prompt": "Bold, eye-catching product reveal image. [PRODUCT] centered against a dramatic gradient background. Premium and modern feel. The product should POP.",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact", "hero_features": "brand logo prominently visible"},
    "background": {"treatment": "gradient", "scene_description": "dramatic dark-to-light gradient in brand colors"},
    "composition": {"product_coverage": "60%", "position": "center", "negative_space": "top 20% clear for headline text"},
    "lighting": {"type": "dramatic studio", "direction": "rim light from behind, key light from front", "quality": "high contrast, premium feel"},
    "enhancement": {"contrast": "high, punchy", "sharpness": "razor sharp"},
    "output": {"format": "JPEG", "aspect_ratio": "1:1", "filename": "launch_post"}
  }
}
```

### Lifestyle / In-Use Shot (Instagram Feed)
```json
{
  "command": "generate",
  "prompt": "Warm, authentic lifestyle shot of [PRODUCT] being used naturally. Instagram-worthy, aspirational but relatable.",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact", "preserve_text": "label visible"},
    "scene": {"environment": "[relevant context]", "mood": "warm, aspirational", "time_of_day": "golden hour"},
    "placement": {"position": "rule-of-thirds", "interaction": "being used/held naturally"},
    "focus": {"focus_point": "product", "depth_of_field": "shallow, Instagram-style bokeh"},
    "output": {"format": "JPEG", "aspect_ratio": "4:3", "filename": "lifestyle_ig"}
  }
}
```

### Story / Reel Vertical Format
```json
{
  "command": "generate",
  "prompt": "Vertical format product showcase. [PRODUCT] with bold visual impact, designed for mobile full-screen viewing.",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact"},
    "background": {"treatment": "solid", "color": "[brand color or complementary]"},
    "composition": {"product_coverage": "50%", "position": "center-lower", "negative_space": "top 30% for text, bottom 10% for swipe-up zone"},
    "output": {"format": "JPEG", "aspect_ratio": "9:16", "filename": "story_post"}
  }
}
```

### Offer / Sale Graphic
```json
{
  "command": "generate",
  "prompt": "Bold sale/offer graphic. [PRODUCT] with energetic, attention-grabbing design. Clear space for price/discount text overlay.",
  "images": [{"path": "product.jpg", "label": "source"}],
  "specs": {
    "fidelity": {"preserve_colors": "exact"},
    "background": {"treatment": "solid", "color": "vibrant red or brand accent color"},
    "composition": {"product_coverage": "55%", "position": "center-right", "negative_space": "left side clear for price/offer text"},
    "custom_spec": {"instruction": "Energetic, sale-worthy design. Bold and premium, not cheap-looking.", "color_palette": "red, white, gold accents"},
    "enhancement": {"contrast": "high, punchy colors"},
    "output": {"format": "JPEG", "aspect_ratio": "1:1", "filename": "sale_post"}
  }
}
```

### Product Comparison / Family Shot
```json
{
  "command": "generate",
  "prompt": "Clean product family shot showing all variants together. Organized, professional, easy to compare.",
  "images": [
    {"path": "variant1.jpg", "label": "product"},
    {"path": "variant2.jpg", "label": "product"},
    {"path": "variant3.jpg", "label": "product"}
  ],
  "specs": {
    "fidelity": {"preserve_colors": "exact for all variants"},
    "background": {"treatment": "solid", "color": "white or light grey"},
    "composition": {"position": "evenly spaced in row", "camera_angle": "slightly elevated, consistent for all"},
    "lighting": {"type": "even studio lighting, identical for all products"},
    "output": {"format": "PNG", "aspect_ratio": "16:9", "filename": "product_family"}
  }
}
```

## Content Calendar Rotation

For consistent social presence, rotate through these content types:

1. **Hero/product shot** — clean, professional (1-2x/week)
2. **Lifestyle/in-use** — aspirational context (2-3x/week)
3. **Behind-the-scenes** — manufacturing, team (1x/week)
4. **Offer/promotional** — sales, deals (as needed)
5. **Educational** — usage tips, comparisons (1x/week)
6. **User-generated style** — authentic, relatable (1-2x/week)

## Brand Consistency

Across all social content, maintain:
- **Color palette** — consistent brand colors in backgrounds/accents
- **Photography style** — same lighting quality and mood
- **Composition patterns** — recognizable framing style
- **Quality level** — every post should feel premium
