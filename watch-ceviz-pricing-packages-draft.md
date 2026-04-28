# Watch Ceviz Pricing + Packages Draft

## Goal

Turn the current V1 product direction into a simple, sellable package structure.

Core rule:

- do not price "generic AI chat"
- price "fast access to high-value personal agent workflows"

## Product Packaging Principle

Watch Ceviz should be sold as:

- a watch-first access layer
- an iPhone handoff surface
- bundled access to specific OpenClaw workflows

So the package is not:

- "an AI watch app"
- "a tiny chatbot on the wrist"

It is:

- trigger work from the watch
- get a short trustworthy summary fast
- move to phone only when depth or approval is needed

## Recommended Launch Packaging

### Recommended first commercial wedge

- **Developer / Operator Pack**

This should be the first paid package because it is:

- easiest to demo
- easiest to justify financially
- closest to current OpenClaw strengths
- least likely to drift into generic-assistant positioning

## Recommended V1 commercial structure

Keep launch packaging very simple.

### Option A, recommended

Start with **one flagship package** and only light tiering.

#### 1. Developer / Operator Pack, Personal

Best for:

- solo developers
- indie hackers
- technical operators
- power users running personal infra or CI/CD flows

Includes:

- watch trigger for key workflows
- active/recent jobs on watch
- progress summary on watch
- open-on-phone handoff
- structured phone report
- PR summary snapshot
- deploy status snapshot
- incident/alert summary
- cancel / stop current job

#### 2. Developer / Operator Pack, Pro

Best for:

- heavier daily users
- users with multiple repos/environments
- users who need more approval/recovery depth

Adds:

- more workflow presets
- richer report history
- deeper next-action and approval flows
- more integrations / surfaces
- better recovery and escalation paths

#### 3. Team Pilot, later but near-term

Best for:

- very small technical teams
- early design partners

Adds:

- multi-user access
- shared job/report visibility
- shared operational workflows
- pilot onboarding and tighter support

## Recommended Personal vs Pro split

Use a very simple rule:

- **Personal = understand quickly**
- **Pro = continue / approve / recover**

That keeps the upgrade line product-shaped instead of artificially feature-gated.

### Personal should include

This tier should solve the watch-first awareness problem for a single power user.

Included workflows:

- latest deploy status
- PR summary snapshot
- incident / alert summary
- active and recent jobs
- short progress summaries on watch
- open-on-phone report handoff
- structured report reading on phone
- cancel / stop current job

Personal is best when:

- the user wants a fast answer
- the output is mostly summary / inspection
- the workflow is single-user
- the workflow does not need a risky approval step

### Pro should add

This tier should solve the "now act on it" problem.

Included or upgraded workflows:

- approval / continue / retry actions on phone
- richer next-action cards
- deeper failure recovery flows
- multi-repo / multi-environment operator workflows
- broader preset library for technical workflows
- more integrations and higher daily usage intensity
- more operational depth after handoff

Pro is best when:

- the user needs to decide, approve, or recover
- the workflow crosses systems or environments
- the workflow is part of a daily operator routine
- the user is getting value from execution, not just summaries

### Practical packaging rule

If the workflow ends with:

- "here is the status"
- "here is the summary"
- "open this on your phone for context"

it is probably **Personal**.

If the workflow ends with:

- "approve this"
- "retry / continue this"
- "pick the next action"
- "recover from failure"

it is probably **Pro**.

### Recommended workflow split for launch

#### Personal

- deploy status snapshot
- PR risk summary
- incident severity snapshot
- active job glance
- open-on-phone handoff
- report reading
- stop / cancel current job

#### Pro

- deploy recovery follow-up
- approval / continue / retry cards
- richer next-actions
- diagnosis-oriented incident continuation
- multi-system operator presets
- deeper failure handling after handoff

### What should stay out of Personal

To keep the upgrade path honest, Personal should not try to be a small Pro tier.

Avoid putting these in Personal at launch:

- multi-step approval workflows
- complex recovery actions
- broad multi-environment operator flows
- heavy integration count as a selling point
- "do everything" assistant positioning

## Recommended initial price test points

Do not overfit exact pricing yet. Test a few anchors.

### Personal

- floor: **$19/mo**
- recommended test: **$29/mo**
- ceiling to test later: **$39/mo**

### Pro

- floor: **$49/mo**
- recommended test: **$59/mo**
- ceiling to test later: **$79/mo**

### Team Pilot

- starting point: **$149-$299/mo**
- sold as pilot / design-partner package, not self-serve at first

## Recommended launch price, my current pick

If we need one concrete starting proposal:

- **Developer / Operator Pack Personal**: **$29/mo**
- **Developer / Operator Pack Pro**: **$59/mo**
- **Team Pilot**: **custom / starting around $199/mo**

Launch billing visibility rule:

- show **monthly pricing only** at first
- keep annual pricing for later, after the first public story is working

Why this level:

- high enough to signal vertical utility
- low enough for early technical adopters
- avoids competing on cheap-chat pricing
- leaves room for future Executive / Workflow packs

## What should NOT be separate paid packages in V1

Do not split these too early:

- Watch app vs iPhone app
- handoff vs report view
- summary vs approval

For V1, those should feel like one product.

## What can become future packs

After the first wedge is proven:

- Executive Pack
- Inbox / Calendar Pack
- Workflow / Approval Pack
- Incident / Ops Pack as a more explicit premium layer

## Packaging language

Good language:

- personal agent workflows from your wrist
- fast trigger, trustworthy summary, rich phone handoff
- watch for glance, phone for depth

Avoid language like:

- AI friend on your watch
- general assistant for everything
- unlimited chat from your wrist

## Suggested launch message

**Watch Ceviz gives technical power users a fast way to trigger, inspect, and continue important agent workflows without reaching for the phone first.**

Short version:

- **Saatte kısa, telefonda derin, arkada gerçek iş.**

## Recommended go-to-market order

1. launch with Developer / Operator Pack only
2. test Personal vs Pro willingness to pay
3. keep Team as pilot-only
4. do not add second pack until first pack has a repeatable demo and buyer story

## Recommended first buyer persona

**Founder-operator** is the best first public buyer persona.

More specifically:

- technical founder
- solo builder with production responsibility
- small-product owner who is both developer and operator

Why this persona first:

- feels deploy / PR / incident urgency personally
- often away from the laptop, so watch-first access is meaningful
- has higher willingness to pay than a casual solo developer
- still fits the single-user Personal launch model
- matches the watch -> phone -> backend story cleanly

Why not solo developer first:

- easier to message, but usually weaker urgency and lower wrist-level need

Why not infra-heavy power user first:

- real need is strong, but the use case leans faster toward Pro and deeper operational control

So the launch-facing story should be:

- **for founder-operators who need fast awareness of important technical workflows without opening the laptop or phone first**

## Open questions to answer next

1. Should Pro stay private until after first pilots, or become visible shortly after launch?
2. Which workflows are truly included in Personal vs Pro?

## Current recommendation

If we want the sharpest V1 story:

- launch with **Developer / Operator Pack**
- expose **Personal** publicly as the only public plan at first
- keep **Pro** soft-launched / private until the first buyer story is proven
- keep **Team Pilot** manual

Short internal rule:

- **Personal sells awareness**
- **Pro sells operational control**

Practical launch decision:

- **Public at launch:** Personal
- **Not public at launch:** Pro, Team Pilot
- **Show publicly at launch:** monthly pricing only

That keeps the product simple while preserving an upgrade path.
