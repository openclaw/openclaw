# Lifestyle Scene Patterns

Domain knowledge for placing products in realistic lifestyle environments.

## The Lifestyle Mission

Show products IN CONTEXT — how they look in real life. The product must belong in the scene, not look composited in.

## Scene Authenticity Checklist

Every lifestyle image must pass these tests:
1. **Lighting consistency** — product and scene lit from the same direction
2. **Scale accuracy** — product is the right size relative to surroundings
3. **Surface interaction** — proper contact shadows, reflections, grounding
4. **Context sense** — the environment makes sense for this product category
5. **Natural placement** — looks like someone placed it there, not a computer

## Category → Environment Matrix

| Product Category | Natural Environments | Props | Time/Mood |
|-----------------|---------------------|-------|-----------|
| Food packaging | Kitchen, dining table, pantry, picnic | Cutting board, utensils, ingredients | Morning/warm |
| Beverages | Kitchen, outdoor, party, gym | Glasses, ice, fruit garnish | Varied |
| Beauty/personal care | Bathroom, vanity, spa | Towels, candles, flowers | Soft/calm |
| Cleaning products | Kitchen, laundry, bathroom | Clean surfaces, organized space | Bright/clean |
| Health/supplements | Kitchen, gym, office desk | Water bottle, fruit, workout gear | Energetic |
| Industrial/B2B | Warehouse, lab, factory | Equipment, shelving | Neutral/professional |

## Standard Lifestyle Template

```json
{
  "command": "generate",
  "prompt": "A lifestyle photograph showing this [PRODUCT] naturally placed in a [ENVIRONMENT]. The scene feels [MOOD] with [TIME_OF_DAY] lighting. [SPECIFIC SCENE DETAILS].",
  "images": [
    {"path": "product.jpg", "label": "source"},
    {"path": "mood_ref.jpg", "label": "style_ref"}
  ],
  "specs": {
    "fidelity": {
      "preserve_colors": "exact",
      "preserve_shape": "exact proportions",
      "preserve_text": "label readable"
    },
    "scene": {
      "environment": "[specific setting]",
      "style": "[design style]",
      "mood": "[emotional quality]",
      "time_of_day": "[lighting context]",
      "props_and_context": "[supporting elements]"
    },
    "placement": {
      "position": "[where in scene]",
      "surface": "[what it's on]",
      "scale": "life-size, realistic",
      "interaction": "naturally placed"
    },
    "lighting": {
      "type": "[match scene]",
      "color_temperature": "[match time of day]",
      "shadows": "natural, consistent with scene lighting"
    },
    "focus": {
      "focus_point": "product",
      "depth_of_field": "shallow — product sharp, background with pleasant bokeh"
    },
    "output": {
      "format": "JPEG",
      "aspect_ratio": "4:3",
      "filename": "lifestyle_[scene]"
    }
  }
}
```

## Style Reference Usage

When using a style reference image (`[style_ref]`):
- The model matches the FEEL — lighting quality, color temperature, mood, atmosphere
- It does NOT copy the content of the reference
- Good style refs: interior design photos, mood boards, magazine editorials
- Include explicit notes: "Match the warm golden lighting and cozy feel of [style_ref]"

## Scene Complexity Levels

### Simple (1 product, clean scene)
- Product on a surface with minimal props
- Works reliably, fast iterations
- Best for e-commerce lifestyle variants

### Medium (1 product, styled scene)
- Product with 2-3 contextual props
- Specific environment with atmosphere
- Good for social media and marketing

### Complex (multi-product or detailed scene)
- Multiple products arranged together
- Rich environment with many elements
- May need iterative editing (chat mode) to get right
- Consider generating scene first, then placing products

## Seasonal/Contextual Variations

Same product can have multiple lifestyle contexts:

| Season/Occasion | Environment Shift | Lighting Shift | Mood Shift |
|----------------|-------------------|----------------|------------|
| Summer | Outdoor, bright, garden | Bright natural, golden hour | Fresh, energetic |
| Winter | Indoor, cozy, warm | Warm artificial, firelight | Cozy, comfortable |
| Festival/celebration | Decorated setting | Warm, festive lights | Joyful, special |
| Professional/B2B | Office, commercial | Neutral, even | Clean, trustworthy |

## Common Mistakes

1. **Product too small in scene** — should be the clear subject, not lost in environment
2. **Inconsistent shadows** — product shadow going one way, scene shadows another
3. **Wrong scale** — product looks giant or tiny relative to props
4. **Generic scene** — "a kitchen" is boring; "a sunlit Scandinavian kitchen with herb pots on the windowsill" tells a story
5. **Over-styling** — too many props compete with the product for attention
