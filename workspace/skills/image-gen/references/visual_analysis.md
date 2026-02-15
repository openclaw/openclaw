# Visual Analysis — Domain Knowledge

How to systematically analyze product images before generating anything. This is your pre-flight checklist — skip it and you'll produce garbage.

## Why Analyze First?

Every image generation decision depends on understanding what you're working with. Material determines lighting. Form factor determines composition. Target customer determines style. Multi-item detection determines workflow.

**Read this before you write a single spec.**

---

## Analysis Focus Areas

### 1. Material Identification

| Visual Cue | Material Indicator |
|------------|-------------------|
| High transparency, glossy | PET, Glass |
| Translucent, matte | HDPE, PP |
| Opaque, smooth | LDPE, PP |
| Rigid, heavy appearance | Glass, Metal |
| Flexible appearance | LDPE, Flexible packaging |

**Key questions to ask:**
- Is it transparent, translucent, or opaque?
- Is the surface glossy or matte?
- Does it appear rigid or flexible?

Material identification drives your `material_treatment` spec — get this wrong and the output looks fake.

### 2. Form Factor Classification

| Shape | Typical Products |
|-------|------------------|
| Cylindrical, wide mouth | Jars (food, cosmetic) |
| Cylindrical, narrow neck | Bottles (beverage, chemical) |
| Rectangular | Containers (storage, industrial) |
| Pouches/bags | Flexible packaging |
| Custom shapes | Specialty packaging |

### 3. Size Estimation

Estimate capacity from visual cues:
- Hand-scale if present (typical hand ~18cm)
- Label text size as reference
- Proportion relative to known objects
- Closure size (caps are standard sizes)

**Common sizes by category:**
- Food jars: 100ml, 250ml, 500ml, 1L
- Beverage bottles: 200ml, 500ml, 1L, 2L
- Industrial containers: 5L, 20L, 50L, 200L

### 4. Feature Extraction

| Feature Type | Examples |
|--------------|----------|
| Texture | Honeycomb, ribbed, smooth, diamond |
| Closure | Screw cap, flip-top, pump, cork |
| Color | Clear, blue, amber, green, white |
| Branding | Labels, embossing, printing |
| Handles | None, integrated, bail handle |

### 5. Target Customer Indicators

| Indicator | Customer Signal |
|-----------|-----------------|
| Premium finish, elegant shape | High-end B2C, D2C |
| Standard industrial look | B2B industrial |
| Food-grade clarity, clean design | Food packaging B2B |
| Child-safe features | Consumer safety-focused |
| Bulk sizing, utilitarian | Wholesale, industrial |

---

## Analysis Template

When analyzing a product image, structure your observations:

```
MATERIAL:
- Type: [PET/Glass/HDPE/PP/etc.]
- Evidence: [Transparency, finish, appearance]

FORM FACTOR:
- Shape: [Jar/Bottle/Container/etc.]
- Dimensions estimate: [Height x Width or Capacity]

FEATURES:
- Texture: [Smooth/Honeycomb/Ribbed/etc.]
- Closure: [Screw cap/Flip-top/etc.]
- Color: [Clear/Blue/Amber/etc.]
- Special: [Handle/Label/Embossing/etc.]

TARGET CUSTOMER:
- Market positioning: [Premium/Standard/Industrial]
- Likely segment: [B2B/B2C/D2C/Wholesale]
- Use case: [Food/Cosmetic/Industrial/etc.]

GENERATION IMPLICATIONS:
- Material treatment needed: [glass/PET/metal — determines lighting spec]
- Key features for fidelity spec: [what MUST be preserved]
- Background recommendation: [white/gray based on product color]
- Composition notes: [angle that shows features best]
```

---

## Image Quality Assessment

Before generating, assess what you're working with:

| Quality Aspect | Good | Needs Fixing |
|----------------|------|--------------|
| Lighting | Even, no harsh shadows | Dark, overexposed |
| Focus | Sharp, details visible | Blurry, soft |
| Background | Clean, neutral | Cluttered, distracting |
| Angle | Shows product clearly | Obscured features |
| Resolution | Details readable | Pixelated |

Flag quality issues — they determine how aggressive your specs need to be.

---

## Common Product Patterns

### Food Packaging
- Materials: PET (transparency), Glass (premium), PP (versatility)
- Features: Food-safe, clear visibility, tamper-evident
- Sizes: 100ml-2L typical
- Generation: Emphasize clarity, cleanliness, contents visibility

### Cosmetic Packaging
- Materials: PET, Glass (premium), Acrylic
- Features: Elegant finish, pump dispensers, airless technology
- Sizes: 30ml-500ml typical
- Generation: Premium lighting, aspirational feel, texture detail

### Industrial Containers
- Materials: HDPE, Metal, Fiber drums
- Features: Chemical resistant, handles, stacking design
- Sizes: 5L-200L typical
- Generation: Clean and functional, show durability and features

### Beverage Bottles
- Materials: PET (most common), Glass (premium)
- Features: Lightweight, pressure-resistant, tamper-evident
- Sizes: 200ml-2L typical
- Generation: Show liquid through transparent walls, label prominence

---

## Multi-Product Image Handling

**CRITICAL:** When an image contains multiple products, you must classify and plan before generating.

### Domain Vocabulary

| Term | Meaning |
|------|---------|
| VARIANTS | Same product type, different size/color/design (complete products in grid) |
| COLLECTION | Different product types in same image (e.g., jar + lid + label) |
| COMPONENTS | Different PARTS across multiple images (bodies in one, lids in another) → COMPOSE together |

**Critical distinction:**
- **VARIANTS** = Complete products in a grid → EXTRACT each individually
- **COMPONENTS** = Incomplete parts across images → COMPOSE into complete products

### Classification Matrix

| Observation | Classification | Action |
|-------------|----------------|--------|
| Same product, multiple angles | SINGLE_ITEM | One generation, multiple assets |
| Same product type, different sizes | VARIANTS | Multiple generations, same family |
| Same product type, different colors/designs | VARIANTS | Multiple generations, variant axis |
| Different product types | COLLECTION | Multiple families or bundled set |
| Product with accessories | COLLECTION | Main product + accessory generations |
| Different images contain different PARTS | COMPONENTS | COMPOSE parts into complete shots |

### Multi-Product Assessment Template

When multi-product detected, document:

```markdown
## MULTI-ITEM ASSESSMENT

- **Count:** [N products]
- **Classification:** [VARIANTS | COLLECTION | COMPONENTS]
- **Rationale:** [Why this classification — what visual evidence]

### Variant Axes (if VARIANTS)

| Axis | Values Found |
|------|--------------|
| Size | [e.g., Large, Medium, Small] |
| Color | [e.g., Blue, Yellow, Pink] |
| Design | [e.g., Floral, Geometric, Plain] |

### Extraction Targets (with Bounding Boxes)

| # | Description | BBox [y_min, x_min, y_max, x_max] | Position | Size | Color | Design |
|---|-------------|-----------------------------------|----------|------|-------|--------|
| 1 | [Full description] | [estimated bounds] | [position] | [Size] | [Color] | [Design] |
| 2 | [Full description] | [estimated bounds] | [position] | [Size] | [Color] | [Design] |

### Processing Strategy

| Strategy | Result | Recommended When |
|----------|--------|------------------|
| INDIVIDUAL | [N] hero shots, one per SKU | Catalog work, product pages |
| BY_SIZE | [M] shots grouped by size | Size comparison graphics |
| BY_DESIGN | [M] shots grouped by design | Design showcase |
| COMPOSITE | 1 family shot | Marketing, range display |
```

**Bounding box coordinates:** Normalized to 0-1000 scale, format [y_min, x_min, y_max, x_max], origin top-left.

For a 3x3 grid, divide 1000 by 3: Row 1 starts at 0, Row 2 at ~333, Row 3 at ~666. Same for columns.

### COMPONENTS Detection (Cross-Image Analysis)

When analyzing multiple images, check if they show different parts:

| Cross-Image Signal | Classification | Action |
|--------------------|----------------|--------|
| Image A has bodies, Image B has lids | COMPONENTS | Parts to COMPOSE |
| Image A has products, Image B has accessories | COMPONENTS | Accessories to ADD |
| Grid of bodies + separate lid array | COMPONENTS | Match and compose |

**Anti-pattern:** Treating COMPONENTS as VARIANTS and just extracting from the grid — results in incomplete products (bodies without lids).

For COMPONENTS, use multiple labeled images in a single generation call:
```json
{
  "command": "generate",
  "prompt": "Compose the glass jar body with the matching blue lid to create a complete product shot",
  "images": [
    {"path": "bodies_grid.jpg", "label": "bodies"},
    {"path": "lids.jpg", "label": "lids"}
  ],
  "specs": {
    "extraction": {
      "target_description": "Compose jar body from [bodies] with blue lid from [lids]",
      "targets": [
        {"bbox": [100, 50, 800, 600], "image_label": "bodies"},
        {"bbox": [200, 100, 400, 300], "image_label": "lids"}
      ]
    }
  }
}
```

### Key Detection Signals

| Signal | Classification | Variant Axes |
|--------|----------------|--------------|
| Identical shape, different scales | VARIANTS | Size |
| Same shape, different colors | VARIANTS | Color |
| Same shape, different patterns/prints | VARIANTS | Design |
| Different shapes entirely | COLLECTION | N/A |
| Product + cap/lid separately | COLLECTION | N/A |
| Same product from multiple angles | SINGLE_ITEM | N/A |

---

## Integration with Generation

After visual analysis, you know:

1. **Material** → drives `material_treatment` spec
2. **Form factor** → drives `composition` spec (angle, framing)
3. **Features** → drives `fidelity` spec (what to preserve)
4. **Target customer** → drives style decisions (premium vs functional)
5. **Multi-item classification** → drives workflow (individual vs batch)

**Don't skip this step.** A 30-second analysis saves multiple failed generation attempts.

---

## Anti-Patterns

| Anti-Pattern | Problem | Correct Approach |
|--------------|---------|------------------|
| Surface-level analysis | "This is a plastic bottle" | Full detail: "500ml PET bottle, honeycomb texture, screw cap, clear with amber tint, premium cosmetic positioning" |
| Material-only focus | Only identify material | Material + Form + Features + Target Customer — all four inform generation |
| Ignoring target customer | "PET bottle = plastic family" | Consider finish and positioning: "Premium finish suggests D2C cosmetic — use aspirational lighting" |
| Skipping multi-item detection | Treat group photo as single product | Always count items, classify, plan extraction strategy |
