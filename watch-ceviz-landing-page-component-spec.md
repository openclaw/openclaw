# Watch Ceviz, Landing Page Component Spec

## Goal

Break the landing page into implementation-ready blocks so design or frontend work can start without rethinking the product story.

## Page-level rules

- audience: founder-operator
- public plan shown: Personal only
- public billing shown: monthly only
- tone: technical, crisp, grounded
- avoid: consumer-assistant language, hype, generic AI framing

---

## 1. HeroSection

### Purpose

Make the product understandable in a few seconds.

### Required content

- eyebrow: `For founder-operators`
- headline: `Your agent workflows, one glance away.`
- subheadline
- 4 value bullets
- primary CTA
- secondary CTA
- pricing chip or quick price reference

### UI notes

- two-column layout on desktop
- left: headline + copy + CTA
- right: watch + phone mock pair
- hero must immediately show both watch and phone together

### Component children

- `EyebrowChip`
- `HeroHeadline`
- `HeroSubheadline`
- `ValueBulletList`
- `PrimaryCTAButton`
- `SecondaryCTAButton`
- `HeroDeviceMockPair`
- `HeroPriceChip`

---

## 2. ProductDefinitionSection

### Purpose

Kill the wrong mental model early.

### Required content

- short statement that this is not a wrist chatbot
- short statement that this is an access layer to important agent workflows
- short statement that phone handoff is intentional

### UI notes

- text-first section
- no complex visuals needed
- could include a small compare block: `Not this / Is this`

### Optional child block

- `PositioningContrastList`

---

## 3. HowItWorksSection

### Purpose

Make the watch -> phone -> OpenClaw model obvious.

### Required content

Three blocks/cards:

- Watch = trigger and glance
- iPhone = depth, approval, recovery
- OpenClaw = execution and orchestration

### UI notes

- 3-card grid on desktop
- stacked cards on mobile
- each card should be short and scannable

### Component children

- `HowItWorksCard`
  - title
  - short description
  - optional icon

---

## 4. WhyItMattersSection

### Purpose

Connect the product to real founder-operator pain.

### Required content

- short intro paragraph
- 4 pain/value bullets

### UI notes

- copy should sound lived-in, not salesy
- strong candidate for slightly darker panel or contrast background

### Component children

- `SectionIntro`
- `PainValueBulletList`

---

## 5. PersonalPlanSection

### Purpose

Make the public offer concrete.

### Required content

- section title
- short framing line
- included feature list
- note that Personal is for awareness, not deep operator control

### UI notes

- should not show Pro or Team Pilot cards
- can be one content block or split into `Included` + `Framing`

### Component children

- `FeatureList`
- `FramingNote`

---

## 6. WorkflowExamplesSection

### Purpose

Let the reader imagine using the product.

### Required content

Three workflow cards:

- Deploy check
- PR snapshot
- Incident triage

Each card should show:

- trigger
- watch outcome
- phone handoff moment

### UI notes

- cards should feel scenario-based, not feature-based
- keep each scenario short

### Component children

- `WorkflowScenarioCard`
  - title
  - 2-3 lines of story

---

## 7. PhoneHandoffSection

### Purpose

Frame handoff as a product decision, not a limitation.

### Required content

- short title
- short explanation
- highlighted line: `The watch is for awareness. The phone is for depth.`

### UI notes

- this section is strategically important
- use emphasis styling for the highlighted line

### Component children

- `EmphasisQuote`

---

## 8. PricingSection

### Purpose

Present the public offer cleanly.

### Required content

Single card only:

- plan name: `Personal`
- price: `$29/mo`
- audience line
- short included summary
- CTA

### UI notes

- no comparison table at launch
- no annual toggle at launch
- no struck-through pricing tricks

### Component children

- `PricingCard`
  - name
  - price
  - audience line
  - included bullets
  - CTA

---

## 9. EarlyAccessCTASection

### Purpose

Repeat the ask simply.

### Required content

- one short paragraph
- one primary CTA
- optional supporting CTA or FAQ link

### UI notes

- should feel lighter than hero, but still decisive

### Component children

- `CTACluster`

---

## 10. FAQSection

### Purpose

Handle predictable objections.

### Required content

Questions:

- Why not just use the phone?
- Is this a full assistant on the watch?
- Why is phone handoff part of the product?
- Who is this for first?

### UI notes

- accordion or simple stacked cards
- answers should stay short

### Component children

- `FAQItem`
  - question
  - answer

---

## Shared component notes

### Buttons

Use only 2 styles at launch:

- primary
- secondary

### Cards

Use one card language consistently across:

- how it works
- workflows
- pricing
- FAQ

### Typography

Need only a small system:

- eyebrow
- H1
- H2
- body
- supporting bullet text

### Visual language

Keep it:

- dark / technical / crisp
- product-focused
- not futuristic for the sake of it

---

## Asset checklist for implementation

To build this page, the frontend/design side will need:

- watch mock image or placeholder
- phone mock image or placeholder
- logo / wordmark treatment
- button styles
- section spacing rules
- mobile stacking behavior

---

## Recommended next build order

1. implement HeroSection
2. implement HowItWorksSection
3. implement PricingSection
4. add WorkflowExamplesSection
5. add FAQ
6. polish visuals last

## Why this order

If the first 3 sections are strong:

- the story is clear
- the product is legible
- the offer is visible

Everything else becomes support, not rescue.
