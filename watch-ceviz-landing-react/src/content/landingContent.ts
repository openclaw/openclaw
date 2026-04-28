export type CardItem = {
  kicker?: string;
  title: string;
  body: string;
};

export type FAQItem = {
  question: string;
  answer: string;
};

export const landingContent = {
  hero: {
    eyebrow: "For founder-operators",
    headline: "Your agent workflows, one glance away.",
    lede: "Trigger work, get a short trustworthy summary, and move to the phone only when approval or deeper context is needed.",
    bullets: [
      "Check active jobs from your watch",
      "See PR, deploy, and incident summaries fast",
      "Open rich context on your phone when needed",
      "Stay aware without reaching for the laptop first",
    ],
    primaryCta: "Get early access",
    secondaryCta: "See how it works",
    watchMockTitle: "Latest deploy status",
    watchMockBody: "Production deploy succeeded. One warning, no rollback needed.",
    phoneMockTitle: "Structured report",
    phoneMockBody: "Risk summary, affected service, next action, and detail view ready.",
  },
  pricing: {
    kicker: "Public launch plan",
    plan: "Personal",
    price: "$29",
    interval: "/mo",
    audience: "For founder-operators and solo technical builders.",
  },
  productDefinition: {
    title: "What it is",
    paragraphs: [
      "Watch Ceviz is not a chatbot on the wrist. It is a fast access layer to your most important personal agent workflows.",
      "It helps you check what matters quickly, then move to the phone only when the situation needs more context, approval, or recovery.",
    ],
  },
  howItWorks: {
    title: "How it works",
    emphasis:
      "The watch gives you the signal. The phone gives you the context. OpenClaw does the work.",
    items: [
      {
        kicker: "Step 1",
        title: "Watch",
        body: "The watch is for trigger and glance. You ask for the status, get the signal, and understand whether something needs your attention.",
      },
      {
        kicker: "Step 2",
        title: "iPhone",
        body: "The phone is for depth, approval, and recovery. When things get heavier, the handoff opens the right screen with structured context.",
      },
      {
        kicker: "Step 3",
        title: "OpenClaw",
        body: "OpenClaw does the real work in the background, runs the workflow, gathers context, and prepares the report.",
      },
    ] as CardItem[],
  },
  whyItMatters: {
    title: "Why this matters",
    intro:
      "If you are both building the product and carrying operational responsibility, you do not need more noise. You need faster clarity.",
    bullets: [
      "Check deploy risk before opening the laptop",
      "See whether an alert actually matters",
      "Get a PR snapshot without digging through tabs",
      "Know whether a job is moving, blocked, or needs escalation",
    ],
  },
  personalIncludes: {
    title: "What Personal includes",
    bullets: [
      "Watch access to key workflows",
      "Active and recent jobs",
      "PR risk summary",
      "Deploy status snapshot",
      "Incident severity snapshot",
      "Open-on-phone handoff",
      "Structured phone report reading",
      "Cancel / stop current job",
    ],
    framing: [
      "Personal is built for fast awareness, not deep operator control.",
      "If you need approvals, retries, or deeper recovery flows, that is the upgrade path, not the launch story.",
    ],
  },
  workflows: {
    title: "Example workflows",
    items: [
      {
        title: "Deploy check",
        body: "Ask from the watch. Get a short summary of the latest deploy. Open the phone only if something looks risky.",
      },
      {
        title: "PR snapshot",
        body: "Ask for an active PR summary. Get a one-line risk read from the watch. Open the phone for files, notes, and next steps.",
      },
      {
        title: "Incident triage",
        body: "Receive or request a short incident summary. See severity fast. Move to the phone when the incident needs real diagnosis.",
      },
    ] as CardItem[],
  },
  handoff: {
    title: "Why the phone handoff exists",
    paragraphs: [
      "The phone handoff is not a fallback. It is the design.",
      "The watch stays useful by staying small. The phone becomes valuable because it carries the depth.",
    ],
    emphasis: "The watch is for awareness. The phone is for depth.",
  },
  cta: {
    title: "Get early access",
    body: "If you want faster awareness of deploys, PRs, incidents, and active jobs without opening the laptop first, join early access.",
    primary: "Get early access",
    secondary: "Read the FAQ",
  },
  faq: {
    title: "FAQ",
    items: [
      {
        question: "Why not just use the phone?",
        answer:
          "Because the watch is better for immediate awareness. It lets you check what matters without unlocking the phone first.",
      },
      {
        question: "Is this a full assistant on the watch?",
        answer:
          "No. Watch Ceviz is intentionally focused on trigger, glance, and handoff rather than long-form assistant use on a tiny screen.",
      },
      {
        question: "Why is phone handoff part of the product?",
        answer:
          "Because serious workflows often need structured context, approvals, or recovery options. The watch gives speed. The phone gives depth.",
      },
      {
        question: "Who is this for first?",
        answer:
          "Founder-operators, solo technical builders, and people who both ship product and carry technical responsibility.",
      },
    ] as FAQItem[],
  },
} as const;
