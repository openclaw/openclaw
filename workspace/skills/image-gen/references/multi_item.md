# Multi-Item Handling — Domain Doctrine

Domain-agnostic pattern for handling images containing multiple distinct items.
Applies universally: products, properties, dishes, garments, components, or any future domain.

This defines the PATTERN. Domain-specific docs (catalog_visual, lifestyle_visual) apply the VOCABULARY.

---

## Core Concepts

### Item

A distinct, identifiable entity within an image that could be processed independently.

### Classification Types

| Type | Definition | Examples |
|------|------------|----------|
| **VARIANTS** | Same item type, different attributes | 3 jar sizes, 4 bottle colors, 3 design patterns |
| **COLLECTION** | Different item types, related context | Product + accessories, jar + lid + label |
| **COMPONENTS** | Parts of a single whole | Bodies in one image, lids in another |
| **UNRELATED** | Coincidental presence | Background clutter, bystanders |

### Variant Axes

When items are VARIANTS, identify the axes of variation:

| Axis Type | Examples |
|-----------|----------|
| Size | Small/Medium/Large |
| Color | Red/Blue/Green |
| Design | Pattern A/B/C |
| Material | Glass/Plastic/Metal |

---

## Variant Identification Doctrine (CRITICAL)

**Position is AMBIGUOUS. Visual characteristics are UNAMBIGUOUS. Bounding boxes are ABSOLUTE.**

### Identification Hierarchy (use in priority order)

| Priority | Differentiator | Why Reliable |
|----------|----------------|--------------|
| 1 | **BOUNDING BOX** | Pixel-precise coordinates — absolute |
| 2 | **SIZE** | Visually absolute — tallest/shortest is unambiguous |
| 3 | **VISUAL PATTERN** | Intrinsic to product — distinct colors, designs, prints |
| 4 | **TEXT/LABEL** | Explicit identification when readable |
| 5 | **POSITION** | Last resort — only when visual characteristics identical |

**Compound identification:** Combine for precision. Bounding box provides location, size/pattern confirms the specific item, description provides semantic understanding.

**NEVER rely solely on verbal position when bbox coordinates exist.**

---

## Item Manifest Format

When multi-item detected, document a structured manifest:

```markdown
## MULTI-ITEM ASSESSMENT

- **Count:** [N]
- **Classification:** [VARIANTS | COLLECTION | COMPONENTS | UNRELATED]
- **Rationale:** [Why this classification]

### Variant Axes (if VARIANTS)

| Axis | Values |
|------|--------|
| [axis1] | [value1, value2, value3] |
| [axis2] | [valueA, valueB] |

### Extraction Targets

| # | Description (WHAT) | BBox [y_min, x_min, y_max, x_max] | Position (ref only) | Key Attributes |
|---|-------------------|-----------------------------------|---------------------|----------------|
| 1 | [visual characteristics] | [coordinates] | [for human ref] | [domain-specific] |
| 2 | [visual characteristics] | [coordinates] | [for human ref] | [domain-specific] |

### Processing Strategies

| Strategy | Result | Recommended When |
|----------|--------|------------------|
| INDIVIDUAL | [N] separate outputs | Catalog, each needs own asset |
| BY_[AXIS] | [M] grouped outputs | Comparison graphics |
| COMPOSITE | 1 combined output | Marketing, family shot |
| SELECTIVE | Subset only | User requested specific items |
```

### Coordinate System

```
Coordinates: [y_min, x_min, y_max, x_max]
Scale: 0-1000 (normalized to image dimensions)
Origin: Top-left corner of image
```

### Position Vocabulary

| Position | Meaning |
|----------|---------|
| top-left, top-center, top-right | Upper third of frame |
| middle-left, center, middle-right | Middle third of frame |
| bottom-left, bottom-center, bottom-right | Lower third of frame |
| foreground, midground, background | Depth positioning |

**For non-grid layouts** (stacked columns, irregular arrangements):
- Use: "left-column, 3rd from top" or "right-column, top item"
- NOT: "middle-left" (ambiguous)

**Best practice:** Combine spatial position WITH visual identifier:
- "the jar with floral print in left-column"
- "the blue lid variant, 3rd from top"

---

## Processing Strategies

### INDIVIDUAL
Extract each item separately → N outputs.

**When:** Catalog/inventory work (each SKU needs its own asset).

**Pattern:** One generation call per item, using extraction spec with bounding box targeting:

```json
{
  "command": "generate",
  "prompt": "Professional catalog hero shot of this product, extracted from group photo",
  "images": [{"path": "group_photo.jpg", "label": "source"}],
  "specs": {
    "extraction": {
      "target_description": "the large jar with blue floral print",
      "targets": [{"bbox": [50, 20, 600, 350], "image_label": "source"}]
    },
    "fidelity": {"preserve_colors": "exact", "hero_features": "floral print, blue lid"},
    "background": {"treatment": "solid", "color": "white"},
    "output": {"format": "PNG", "aspect_ratio": "1:1", "filename": "variant_large_blue"}
  }
}
```

### GROUPED (BY_AXIS)
Group items by a variant axis → M outputs (M < N).

**When:** Size comparison graphics, color swatches, category showcases.

### COMPOSITE
Keep all items together → 1 output.

**When:** Family/range shots, marketing banners, complete collection displays.

### SELECTIVE
Filter to specific items, then apply INDIVIDUAL or COMPOSITE.

**When:** User requests specific items ("just the large ones", "only blue variants").

**Parsing user filters:**

| User Says | Filter | Match Pattern |
|-----------|--------|---------------|
| "only the large ones" | Size = Large | Filter manifest by size |
| "just the blue ones" | Color = Blue | Filter by color attribute |
| "the ones in the top row" | Position = top-* | Filter by position |
| "the pink design" | Design = pink | Filter by design attribute |

---

## Strategy Selection Signals

### From User Request

| Signal | Implies Strategy |
|--------|------------------|
| "each", "individual", "per item", "separately" | INDIVIDUAL |
| "together", "family", "group", "all in one", "range" | COMPOSITE |
| "by size", "by color", "grouped by" | GROUPED |
| "only the X", "just the Y", "specific" | SELECTIVE |

### From Context

| Context | Default Strategy |
|---------|------------------|
| Catalog, inventory, SKU creation | INDIVIDUAL |
| Marketing, lifestyle, campaigns | COMPOSITE |
| Comparison, sizing guide | GROUPED |
| Quality issue, specific request | SELECTIVE |

### Ambiguity Resolution

If signals are unclear:
1. Check if user explicitly mentions desired output count
2. Infer from context (catalog = individual, marketing = composite)
3. Ask the user for clarification

---

## Batch Consistency (Anchor-First Pattern)

When processing multiple items with INDIVIDUAL strategy, all outputs must appear from the SAME photoshoot.

See `catalog_visual.md` for the full anchor-first workflow. Key points:

1. **Select anchor** — representative item, sharp and well-lit
2. **Generate anchor** — full specs, verify quality
3. **Show user** — get approval for style before batching
4. **Extract style as text** — describe camera, lighting, framing precisely
5. **Batch remaining** — identical specs + style description in custom_spec
6. **Grid test** — verify visual consistency across all outputs

**Core principle:** The anchor call is a TEMPLATE. Batch calls copy the template, changing only extraction target and filename.

---

## COMPONENTS Handling (Cross-Image)

When different images contain different PARTS of complete products:

| Signal | Example |
|--------|---------|
| Image A has bodies, Image B has lids | Parts to COMPOSE |
| Image A has products, Image B has accessories | Accessories to ADD |
| Grid of bodies + separate lid array | Match and compose |

**Use multiple labeled images in one call:**

```json
{
  "command": "generate",
  "prompt": "Compose the glass jar body with the matching blue lid into a complete product hero shot",
  "images": [
    {"path": "bodies_grid.jpg", "label": "bodies"},
    {"path": "lids.jpg", "label": "lids"}
  ],
  "specs": {
    "extraction": {
      "target_description": "Glass jar body from [bodies] composed with blue lid from [lids]",
      "targets": [
        {"bbox": [100, 50, 800, 600], "image_label": "bodies"},
        {"bbox": [200, 100, 400, 300], "image_label": "lids"}
      ]
    },
    "fidelity": {"preserve_colors": "exact", "preserve_shape": "exact proportions"},
    "background": {"treatment": "solid", "color": "white"},
    "output": {"filename": "complete_jar_blue"}
  }
}
```

**Anti-Pattern:** Treating COMPONENTS as VARIANTS and just extracting from the grid → incomplete products (bodies without lids).

---

## Failure Handling

When extracting N items individually, some may fail.

### Strategies

| Strategy | When | Behavior |
|----------|------|----------|
| **CONTINUE** (default) | Most cases | Complete remaining, report failures at end |
| **RETRY_ONCE** | Ambiguous targeting | Retry with refined description |
| **ABORT** | Critical dependency | Stop on first failure |

### Recovery

| Failure Type | Recovery Action |
|--------------|-----------------|
| Overlap/ambiguous | Retry with more specific targeting: tighter bbox, more visual detail |
| Not found at position | Verify manifest against actual image |
| Quality issue | Retry with different extraction settings |
| Persistent failure | Report to user, continue with successful items |

---

## Workflow Pattern

```
1. DETECT    — Examine image, identify item count and relationships
2. MANIFEST  — Output structured item list with positions and attributes
3. STRATEGIZE — Read user signals, apply context defaults
4. EXECUTE   — Apply strategy (INDIVIDUAL / GROUPED / COMPOSITE / SELECTIVE)
5. VERIFY    — Confirm all items processed, quality check each output
```

---

## Anti-Patterns

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| Treating multi-item as single | "the products" instead of "9 products" | Enumerate each item explicitly |
| No bounding boxes | Can't target specific items | Always include coordinates |
| Ignoring variant structure | Miss size/color relationships | Identify variant axes |
| Hardcoded strategy | Always INDIVIDUAL or always COMPOSITE | Select strategy from signals |
| No manifest output | Can't plan extraction | Always produce structured manifest |
