import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type {
  BookWriterDashboardSnapshot,
  BookWriterPlan,
} from "../controllers/book-writer-dashboard.ts";
import {
  renderBookWriterDashboard,
  type BookWriterDashboardProps,
} from "./book-writer-dashboard.ts";

function plan(): BookWriterPlan {
  return {
    schemaVersion: 1,
    kind: "full",
    runId: "book-run",
    title: "Bridge Ledger",
    subtitle: "An Original Book",
    slug: "bridge-ledger",
    topic: "An original clean mystery about invoice fraud.",
    genre: "clean commercial mystery",
    penName: "Northstar House",
    targetWords: 1600,
    createdAt: "2026-05-18T00:00:00Z",
    updatedAt: "2026-05-18T00:00:00Z",
    version: 3,
    status: "paragraph-plan",
    mode: "advanced",
    brief: {
      topicParagraph: "An original clean mystery about invoice fraud.",
      readerPromise: "A fair mystery with practical courage.",
      audience: "Commercial readers.",
      tone: "Clean and concrete.",
      constraints: ["Original only."],
    },
    styleGuide: {
      tonePreset: "professional",
      toneDescription: "Professional: Polished, practical, and clear.",
      profanityLevel: "none",
      profanityDescription: "Clean language for the category.",
    },
    chapters: [
      {
        id: "chapter-1",
        number: 1,
        title: "The First Ledger",
        description: "Open the case.",
        styleDirection: "",
        targetWords: 800,
        locked: false,
        status: "planned",
        paragraphs: [
          {
            id: "paragraph-1",
            order: 1,
            title: "Hook",
            summary: "This paragraph says the suspicious invoice appears at sunrise.",
            purpose: "Open with the suspicious invoice.",
            beats: ["Invoice appears."],
            styleDirection: "",
            targetWords: 200,
            text: "Audrey found the invoice at sunrise.",
            locked: false,
            status: "drafted",
          },
        ],
      },
    ],
    cover: {
      brief: "Clean mystery cover.",
      prompt: "Clean mystery cover.",
      status: "planned",
      variants: [],
    },
    publishing: {
      channel: "kdp",
      finalSubmitRequiresApproval: true,
      status: "not-ready",
      checklist: ["Review"],
    },
    artifactLinks: {},
    revisionHistory: [
      {
        version: 3,
        at: "2026-05-18T00:00:00Z",
        action: "save",
        summary: "Saved edits.",
      },
    ],
  };
}

function planWithParagraphCount(count: number): BookWriterPlan {
  const current = plan();
  return {
    ...current,
    chapters: [
      {
        ...current.chapters[0],
        paragraphs: Array.from({ length: count }, (_, index) => ({
          ...current.chapters[0].paragraphs[0],
          id: `paragraph-${index + 1}`,
          order: index + 1,
          title: `Beat ${index + 1}`,
          purpose: `Paragraph ${index + 1} does useful thing.`,
          summary: `Paragraph ${index + 1} shows useful thing.`,
          targetWords: 180,
          text: index === 4 ? "Focused reader-facing paragraph." : "",
          status: index === 4 ? "drafted" : "planned",
        })),
      },
    ],
  };
}

function snapshot(): BookWriterDashboardSnapshot {
  const currentPlan = plan();
  return {
    generatedAt: "2026-05-18T00:00:00Z",
    outputDir: "/tmp/books",
    selectedRunId: currentPlan.runId,
    plan: currentPlan,
    manuscriptPreview:
      "# Bridge Ledger\n\nBy Northstar House\n\n## Chapter 1: The First Ledger\n\nAudrey found the invoice at sunrise.\n",
    projects: [
      {
        runId: currentPlan.runId,
        title: currentPlan.title,
        subtitle: currentPlan.subtitle,
        penName: currentPlan.penName,
        genre: currentPlan.genre,
        status: currentPlan.status,
        kind: currentPlan.kind,
        version: currentPlan.version,
        updatedAt: currentPlan.updatedAt,
        targetWords: currentPlan.targetWords,
        draftedWords: 7,
        chapterCount: 1,
        paragraphCount: 1,
        lockedParagraphCount: 0,
        artifactLinks: {},
      },
    ],
    archivedBooks: [],
    deletedBooks: [],
    finishedBooks: [],
    penNameProfiles: [],
    planQuality: {
      status: "pass",
      findings: [
        {
          code: "draft-coverage",
          status: "pass",
          message: "1/1 paragraph(s) have generated or edited text.",
        },
      ],
      counts: {
        chapters: 1,
        paragraphs: 1,
        draftedParagraphs: 1,
        lockedParagraphs: 0,
        draftedWords: 7,
      },
    },
    reviewPack: null,
    publishDryRun: null,
    automation: {
      enabled: false,
      scheduled: false,
      status: "manual-only",
      message: "Manual only. Book Studio will not write on its own.",
    },
    generationModel: {
      provider: "ollama",
      model: "qwen2.5:32b",
    },
    localAiHealth: {
      status: "ready",
      provider: "ollama",
      model: "qwen2.5:32b",
      baseUrl: "http://127.0.0.1:11434",
      reachable: true,
      modelAvailable: true,
      modelLoaded: true,
      message: "Local AI is connected and the selected model is warm.",
      lastCheckedAt: "2026-05-18T00:00:00Z",
      benchmark: {
        source: "measured",
        tokensPerSecond: 24.7,
        peakMemoryGb: 21.5,
        qualityScore: 0.82,
        measuredAt: "2026-05-18T00:00:00Z",
      },
      guidance: ["You can use Book Studio AI buttons now."],
    },
    localCoverAiStatus: {
      status: "ready",
      provider: "comfy",
      model: "comfy/workflow",
      message: "Local image AI is ready through ComfyUI.",
      guidance: ["Generate a local AI cover."],
      checkedAt: "2026-05-18T00:00:00Z",
    },
    nextActions: ["Package and run gates."],
  };
}

function homeSnapshot(
  overrides: Partial<BookWriterDashboardSnapshot> = {},
): BookWriterDashboardSnapshot {
  const current = snapshot();
  return {
    ...current,
    selectedRunId: null,
    plan: null,
    manuscriptPreview: "",
    planQuality: null,
    reviewPack: null,
    publishDryRun: null,
    ...overrides,
  };
}

function approvedPublishSnapshot(): BookWriterDashboardSnapshot {
  const current = snapshot();
  const approvedPlan: BookWriterPlan = {
    ...current.plan!,
    cover: {
      ...current.plan!.cover,
      status: "approved",
      variants: [
        {
          id: "auto-concept",
          label: "Editable SVG concept",
          path: "/books/book-run/cover-concept.svg",
          source: "svg-concept",
          approved: true,
        },
      ],
    },
  };
  return {
    ...current,
    plan: approvedPlan,
    reviewPack: {
      runId: current.plan!.runId,
      recommendation: "approve",
      artifacts: {
        ebook: "/books/book-run/ebook.epub",
        cover: "/books/book-run/cover.tiff",
      },
      gaps: [],
      publishPreview: {
        title: "Bridge Ledger",
        subtitle: "An Original Book",
        description: "A clean original mystery.",
        keywords: ["clean mystery", "invoice fraud"],
        categories: ["Fiction / Mystery & Detective / Traditional"],
        aiDisclosure: "Disclose AI-generated text and cover if used.",
        kdpSelectDefault: true,
        pricing: { ebookUsd: 2.99 },
        checklist: ["Stop before final submit."],
      },
    },
    publishDryRun: {
      runId: current.plan!.runId,
      status: "ready",
      coverStrategy: "upload",
      findings: [
        {
          code: "review-pack-approved",
          status: "pass",
          message: "Review pack is approved.",
        },
        {
          code: "final-submit-approval",
          status: "pass",
          message: "Final KDP submit is intentionally blocked.",
        },
      ],
      uploadManifest: {
        files: {
          ebook: "/books/book-run/ebook.epub",
          coverUpload: "/books/book-run/cover.tiff",
          metadata: "/books/book-run/metadata.json",
          publishPreview: "/books/book-run/publish-preview.json",
          printPdf: "/books/book-run/print.pdf",
        },
      },
      browserActions: [
        {
          id: "open-kdp-bookshelf",
          kind: "navigate",
          target: "https://kdp.amazon.com/en_US/bookshelf",
        },
        {
          id: "upload-ebook",
          kind: "upload",
          target: "Manuscript",
          file: "/books/book-run/ebook.epub",
        },
        {
          id: "stop-before-final-submit",
          kind: "pause",
          target: "Publish Your Kindle eBook",
          requiresApproval: true,
        },
      ],
      finalSubmit: {
        allowed: false,
        requiresApproval: true,
        reason: "KDP final submit remains approval-gated.",
      },
    },
  };
}

function approvedPrePublishSnapshot(): BookWriterDashboardSnapshot {
  const current = approvedPublishSnapshot();
  return {
    ...current,
    publishDryRun: null,
  };
}

function rejectedReviewSnapshot(): BookWriterDashboardSnapshot {
  const current = snapshot();
  return {
    ...current,
    reviewPack: {
      runId: current.plan!.runId,
      recommendation: "reject",
      artifacts: {
        manuscript: "/books/book-run/manuscript.md",
      },
      gaps: ["Drafted word count is below the publishing minimum."],
      publishPreview: {
        title: "Bridge Ledger",
        subtitle: "An Original Book",
        description: "A clean original mystery.",
        keywords: ["clean mystery"],
        categories: ["Fiction / Mystery & Detective / Traditional"],
        aiDisclosure: "Disclose AI-generated text and cover if used.",
        kdpSelectDefault: true,
        pricing: { ebookUsd: 2.99 },
        checklist: ["Stop before final submit."],
      },
    },
    publishDryRun: {
      runId: current.plan!.runId,
      status: "blocked",
      coverStrategy: "kdp-cover-creator",
      findings: [
        {
          code: "review-pack-approved",
          status: "blocked",
          message: "Review pack recommendation is reject; publish prep requires approve.",
        },
      ],
      uploadManifest: { files: {} },
      browserActions: [],
      finalSubmit: {
        allowed: false,
        requiresApproval: true,
        reason: "KDP final submit remains approval-gated.",
      },
    },
  };
}

function props(overrides: Partial<BookWriterDashboardProps> = {}): BookWriterDashboardProps {
  return {
    loading: false,
    error: null,
    snapshot: snapshot(),
    lastFetchAt: 0,
    selectedRunId: "book-run",
    topicDraft: "",
    targetWordsDraft: 12000,
    toneDraft: "professional",
    customToneDraft: "",
    profanityDraft: "none",
    penNameDraft: "",
    newBookSetupOpen: false,
    readPage: 0,
    readPreviewOpen: false,
    readPreviewMode: "paperback",
    activeView: "paragraphs",
    mode: "guided",
    pendingAiAction: null,
    pendingAiSuggestion: null,
    pendingDestructiveAction: null,
    actionReceipt: null,
    celebration: null,
    focusedParagraphId: null,
    searchQuery: "",
    savingAction: null,
    canUndo: true,
    canRedo: false,
    onRefresh: vi.fn(),
    onSelectRun: vi.fn(),
    onTopicDraftChange: vi.fn(),
    onTargetWordsDraftChange: vi.fn(),
    onToneDraftChange: vi.fn(),
    onCustomToneDraftChange: vi.fn(),
    onProfanityDraftChange: vi.fn(),
    onPenNameDraftChange: vi.fn(),
    onOpenNewBookSetup: vi.fn(),
    onCloseNewBookSetup: vi.fn(),
    onCreatePlan: vi.fn(),
    onFixBook: vi.fn(),
    onSavePlan: vi.fn(),
    onDeleteRun: vi.fn(),
    onArchiveRun: vi.fn(),
    onCopyRun: vi.fn(),
    onRestoreArchivedRun: vi.fn(),
    onDeleteArchivedRun: vi.fn(),
    onRestoreDeletedRun: vi.fn(),
    onDeleteDeletedRun: vi.fn(),
    onEmptyDeletedRuns: vi.fn(),
    onFinishRun: vi.fn(),
    onRestoreFinishedRun: vi.fn(),
    onUpdatePublishedMetrics: vi.fn(),
    onBuildRecommendedBook: vi.fn(),
    onDraftPlan: vi.fn(),
    onFillParagraphPlans: vi.fn(),
    onGenerateIdeaSetup: vi.fn(),
    onGenerateChapterSetup: vi.fn(),
    onUpdatePenNameProfile: vi.fn(),
    onDraftParagraph: vi.fn(),
    onStitchPlan: vi.fn(),
    onPackagePlan: vi.fn(),
    onPreparePublish: vi.fn(),
    onPreparePublishWithCoverStrategy: vi.fn(),
    onGenerateCoverConcept: vi.fn(),
    onGenerateEditableCoverConcept: vi.fn(),
    onEditCoverWithLocalAi: vi.fn(),
    onApproveCover: vi.fn(),
    onUploadCoverFile: vi.fn(),
    onDisableAutomation: vi.fn(),
    onCreateQuickRead: vi.fn(),
    onShowHome: vi.fn(),
    onActiveViewChange: vi.fn(),
    onReadPageChange: vi.fn(),
    onReadPreviewOpenChange: vi.fn(),
    onReadPreviewModeChange: vi.fn(),
    onModeChange: vi.fn(),
    onFocusedParagraphChange: vi.fn(),
    onRequestAiHelp: vi.fn(),
    onRequestSetupAiHelp: vi.fn(),
    onCancelAiSuggestion: vi.fn(),
    onApplyAiSuggestion: vi.fn(),
    onRequestAiAction: vi.fn(),
    onCancelAiAction: vi.fn(),
    onConfirmAiAction: vi.fn(),
    onRequestDestructiveAction: vi.fn(),
    onCancelDestructiveAction: vi.fn(),
    onConfirmDestructiveAction: vi.fn(),
    onDismissReceipt: vi.fn(),
    onDismissCelebration: vi.fn(),
    onSearchQueryChange: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    ...overrides,
  };
}

describe("renderBookWriterDashboard", () => {
  it("shows storyline overview, sync status, affected chapters, and propagation action", () => {
    const onRequestAiAction = vi.fn();
    const current = plan();
    const syncPlan: BookWriterPlan = {
      ...current,
      storylineOverview: {
        status: "current",
        shortText: "Mara investigates invoice fraud after a council clerk twist changes the case.",
        protagonistGoal: "Mara must expose the fraud.",
        centralConflict: "The council may approve a dangerous repair contract.",
        currentTwist: "The council clerk is secretly Mara's sister.",
        stakes: "The bridge could fail.",
        relationshipDynamics: ["The clerk reveal changes Mara's trust."],
        unresolvedQuestions: ["Who benefits from the forged invoice?"],
        nextChapterDirection: "Foreshadow the clerk before the reveal.",
        sourceVersion: 4,
        updatedAt: "2026-05-18T00:00:00Z",
        confidence: 0.86,
      },
      bookSync: {
        state: "needs-propagation",
        pendingImpactId: "impact-1",
        lastAnalyzedVersion: 4,
        lastSyncedVersion: 3,
        affectedChapterIds: ["chapter-1"],
        affectedParagraphIds: ["paragraph-1"],
        lockedConflictCount: 0,
        summary: "whole-book story impact detected across 1 chapter.",
      },
    };
    const container = document.createElement("div");
    render(
      renderBookWriterDashboard(
        props({
          snapshot: { ...snapshot(), plan: syncPlan },
          mode: "advanced",
          onRequestAiAction,
        }),
      ),
      container,
    );

    expect(container.querySelector("[data-book-writer-storyline-overview]")?.textContent).toContain(
      "Mara investigates invoice fraud",
    );
    expect(
      container.querySelector("[data-book-writer-sync-state='needs-propagation']"),
    ).toBeTruthy();
    expect(container.querySelector("[data-book-writer-affected-chapters]")?.textContent).toContain(
      "Ch. 1: The First Ledger",
    );

    const propagate = container.querySelector<HTMLButtonElement>("[data-book-writer-propagate]");
    expect(propagate?.textContent).toContain("Propagate Change Through Book");
    propagate?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("propagate");
  });

  it("shows visible step navigation, profanity labels, and a distinct Home button", () => {
    const onActiveViewChange = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ onActiveViewChange })), container);

    const visibleSteps = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".book-writer-guided-header__top .book-writer-guided-step",
      ),
    );
    expect(visibleSteps.map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "1 Idea",
      "2 Chapters",
      "3 Plan",
      "4 Write",
      "5 Read",
      "6 Publish",
    ]);
    visibleSteps[3].click();
    expect(onActiveViewChange).toHaveBeenCalledWith("draft");
    expect(container.querySelector(".book-writer-command-home")?.textContent).toContain(
      "Home / Trophy Room",
    );
    const normalizedText = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(normalizedText).toContain("Profanity");
    expect(normalizedText).toContain("Clean language unless you choose otherwise.");
  });

  it("keeps All Controls escapable and infers legacy dramatic tone without resetting", () => {
    const onModeChange = vi.fn();
    const legacyPlan = {
      ...plan(),
      brief: { ...plan().brief, tone: "Tense, cinematic, and emotional." },
      styleGuide: undefined,
    };
    const legacySnapshot = { ...snapshot(), plan: legacyPlan };
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({ mode: "advanced", snapshot: legacySnapshot, activeView: "brief", onModeChange }),
      ),
      container,
    );

    const tone = container.querySelector<HTMLSelectElement>('[aria-label="Book control tone"]');
    expect(tone?.value).toBe("dramatic");
    const backToSimple = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Back to Simple"),
    );
    backToSimple?.click();
    expect(onModeChange).toHaveBeenCalledWith("guided");
  });
  it("renders editable paragraph plans and manuscript controls", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props()), container);

    expect(container.textContent).toContain("Guided Builder");
    expect(container.textContent).toContain("The First Ledger");
    expect(
      Array.from(container.querySelectorAll("textarea")).some((input) =>
        input.value.includes("Open with the suspicious invoice"),
      ),
    ).toBe(true);
    expect(container.textContent).toContain("Blueprint this chapter");
    expect(container.textContent).toContain("Book Text");
    expect(container.textContent).toContain("AI reads this as steering. Readers do not.");
    expect(container.textContent).toContain("Chapter 1 - Paragraph 1");
    expect(container.textContent).toContain("Jump to chapter");
    expect(container.textContent).toContain("Full outline + search");
    const chapterParagraphs = container.querySelector(".book-writer-guided-chapter-paragraphs");
    expect(chapterParagraphs?.textContent).toContain("This paragraph says the suspicious invoice");
    expect(chapterParagraphs?.textContent).toContain("Text ready");
    expect(container.querySelectorAll("button.book-writer-ai-help").length).toBeGreaterThanOrEqual(
      10,
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("gives Chapter, Plan, and Write editors larger focused text boxes", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "chapters" })), container);
    expect(
      container
        .querySelector("textarea.book-writer-chapter-description")
        ?.classList.contains("book-writer-editor-field--large"),
    ).toBe(true);

    render(renderBookWriterDashboard(props({ activeView: "paragraphs" })), container);
    expect(
      container
        .querySelector("textarea.book-writer-plan-summary")
        ?.classList.contains("book-writer-editor-field--large"),
    ).toBe(true);
    const planningDetail = container.querySelector<HTMLDetailsElement>(
      "details.book-writer-editor-details",
    );
    expect(planningDetail?.textContent).toContain("Writing notes");
    expect(planningDetail?.open).toBe(true);

    render(renderBookWriterDashboard(props({ activeView: "draft" })), container);
    expect(
      container
        .querySelector("textarea.book-writer-guided-book-text")
        ?.classList.contains("book-writer-editor-field--hero"),
    ).toBe(true);
    const planNotes = container.querySelector<HTMLDetailsElement>(
      "details.book-writer-write-plan-notes",
    );
    expect(planNotes?.textContent).toContain("What this paragraph should cover");
    expect(planNotes?.open).toBe(false);
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("6 words · target 200");

    const styles = container.querySelector("style")?.textContent ?? "";
    expect(styles).toContain("textarea.book-writer-editor-field--hero");
    expect(styles).toContain("min-height: 220px");
  });

  it("expands the selected paragraph into a stronger focus editor", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "paragraphs" })), container);

    const planFocusCard = container.querySelector(".book-writer-guided-paragraph-card");
    expect(
      planFocusCard?.classList.contains("book-writer-guided-paragraph-card--focus-editor"),
    ).toBe(true);
    expect(planFocusCard?.classList.contains("book-writer-guided-paragraph-card--plan-mode")).toBe(
      true,
    );
    expect(container.textContent).toContain(
      "Focus mode · this paragraph gets the largest editing space.",
    );

    render(renderBookWriterDashboard(props({ activeView: "draft" })), container);

    const writeFocusCard = container.querySelector(".book-writer-guided-paragraph-card");
    expect(
      writeFocusCard?.classList.contains("book-writer-guided-paragraph-card--focus-editor"),
    ).toBe(true);
    expect(
      writeFocusCard?.classList.contains("book-writer-guided-paragraph-card--write-mode"),
    ).toBe(true);

    const styles = container.querySelector("style")?.textContent ?? "";
    expect(styles).toContain(".book-writer-guided-paragraph-card--focus-editor");
    expect(styles).toContain("textarea.book-writer-guided-book-text");
    expect(styles).toContain("min(56vh, 520px)");
  });

  it("renders state-driven progress and a one-click new-book setup starter", () => {
    const onOpenNewBookSetup = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ mode: "advanced", onOpenNewBookSetup })), container);

    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(container.querySelector(".book-writer-progress-ring")).toBeNull();
    expect(text).not.toContain("New book idea");
    expect(text).not.toContain("Use setup for the full guided form.");
    expect(text).toContain("All Controls");
    expect(text).toContain("Back to Simple");
    expect(text).toContain("Workflow map");
    expect(container.querySelector('[aria-label="New book target words"]')).toBeNull();
    expect(container.querySelector('[aria-label="New book tone"]')).toBeNull();
    expect(container.querySelector('[aria-label="New book profanity"]')).toBeNull();
    expect(container.querySelectorAll('.book-writer-term-help[tabindex="0"]')).toHaveLength(0);

    expect(container.querySelector(".book-writer-new-book")).toBeNull();
    expect(onOpenNewBookSetup).not.toHaveBeenCalled();
  });

  it("opens a single new-book setup workspace from an existing book", () => {
    const onRequestAiAction = vi.fn();
    const onRequestSetupAiHelp = vi.fn();
    const onCloseNewBookSetup = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          newBookSetupOpen: true,
          topicDraft: "A field guide for calm family emergency routines.",
          onRequestAiAction,
          onRequestSetupAiHelp,
          onCloseNewBookSetup,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("New Book Setup");
    expect(container.textContent).toContain("Describe the book. AI builds the editable draft.");
    expect(container.textContent).toContain(
      "Actual reader-facing prose, editable paragraph by paragraph.",
    );
    expect(container.textContent).toContain("Style Preview");
    expect(container.querySelectorAll(".book-writer-setup-controls")).toHaveLength(1);
    expect(container.querySelectorAll('input[aria-label="New book target words"]')).toHaveLength(1);
    expect(container.querySelectorAll('select[aria-label="New book tone"]')).toHaveLength(1);
    expect(container.querySelectorAll('select[aria-label="New book profanity"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Book target words"]')).toBeNull();
    expect(
      container.querySelectorAll('[aria-label="AI setup text helpers"] .book-writer-ai-help'),
    ).toHaveLength(6);

    const setupImproveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Improve"),
    );
    setupImproveButton?.click();
    expect(onRequestSetupAiHelp).toHaveBeenCalledWith("improve");

    const returnButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Return to current book"),
    );
    returnButton?.click();
    expect(onCloseNewBookSetup).toHaveBeenCalledTimes(1);

    const fullDraftButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write my editable draft"),
    );
    fullDraftButton?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("full-draft");

    const makeChaptersButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Just make chapters first"),
    );
    makeChaptersButton?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("create");
  });

  it("uses paragraph names and readiness instead of repeating Written in the Write step", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "draft" })), container);

    const focusedStatus = container.querySelector(".book-writer-guided-status");
    expect(container.textContent).toContain("You are in Write");
    expect(container.textContent).toContain("Create the actual paragraph readers will see.");
    expect(container.textContent).toContain("AI rewrite this Book Text");
    expect(focusedStatus?.textContent?.replace(/\s+/g, " ").trim()).toContain("Text ready");
    expect(focusedStatus?.textContent).toContain(
      "Book Text ready. Edit it, lock it, or move to the next paragraph.",
    );
    expect(container.textContent).toContain("Chapter 1: The First Ledger");
    expect(container.textContent).toContain("Chapter 1 - Paragraph 1");
    expect(container.textContent).toContain("Book Text Final Writing");
  });

  it("shows every paragraph in the selected guided chapter and routes full outline/search on demand", () => {
    const onModeChange = vi.fn();
    const longPlan = planWithParagraphCount(8);
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          focusedParagraphId: "paragraph-5",
          snapshot: {
            ...snapshot(),
            plan: longPlan,
            planQuality: {
              ...snapshot().planQuality!,
              counts: {
                ...snapshot().planQuality!.counts,
                paragraphs: 8,
                draftedParagraphs: 1,
              },
            },
          },
          onModeChange,
        }),
      ),
      container,
    );

    const paragraphCards = container.querySelectorAll(".book-writer-guided-paragraph-card");
    expect(paragraphCards).toHaveLength(8);
    expect(container.textContent).toContain("Jump to chapter");
    expect(container.textContent).toContain("Chapter 1 - Paragraph 1");
    expect(container.textContent).toContain("Chapter 1 - Paragraph 8");
    expect(container.textContent).toContain("Paragraph 1 shows useful thing");
    expect(container.textContent).toContain("Paragraph 8 shows useful thing");

    const fullOutline = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open full outline and search"]',
    );
    fullOutline?.click();
    expect(onModeChange).toHaveBeenCalledWith("advanced");
  });

  it("makes Plan versus Write explicit and warns when preview text looks instructional", () => {
    const current = snapshot();
    const oldInstructionText =
      "Advance one argument, clue, scene beat, or practical insight. Chapter focus: Open the book with the central problem. The book is about a practical field guide. The paragraph should make one clear move.";
    const instructionPlan = JSON.parse(JSON.stringify(current.plan)) as BookWriterPlan;
    instructionPlan.chapters[0].paragraphs[0].text = oldInstructionText;
    instructionPlan.chapters[0].paragraphs[0].status = "drafted";
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "paragraphs",
          snapshot: {
            ...current,
            manuscriptPreview: oldInstructionText,
            plan: instructionPlan,
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Plan");
    expect(container.textContent).toContain("What the paragraph will say");
    expect(container.textContent).toContain("Write");
    expect(container.textContent).toContain("Book Text readers see");
    expect(container.textContent).toContain("Needs Book Text");
    expect(container.textContent).toContain("readers should not see planning instructions");
  });

  it("keeps top navigation and status compact so work starts immediately", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "chapters" })), container);

    const header = container.querySelector<HTMLElement>(".book-writer-guided-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector(".book-writer-guided-steps")).not.toBeNull();
    expect(header?.querySelector(".book-writer-guided-header__reader")).not.toBeNull();
    expect(header?.querySelector(".book-writer-guided-header__status")).not.toBeNull();
    expect(header?.querySelector(".book-writer-command-row")).not.toBeNull();
    expect(header?.querySelectorAll(".book-writer-command-primary")).toHaveLength(1);

    const workspace = container.querySelector<HTMLElement>(".book-writer-guided-workspace");
    expect(workspace).not.toBeNull();
    expect(header?.nextElementSibling).toBe(workspace);

    expect(
      container.querySelector(".book-writer-guided-next .book-writer-guided-primary"),
    ).toBeNull();
    expect(container.querySelector(".book-writer-mini-preview")).toBeNull();
    expect(container.querySelector(".book-writer-health-strip")).toBeNull();
    expect(container.querySelector(".book-writer-plan-write-legend")).toBeNull();
  });

  it("shows local AI health in the compact command bar", () => {
    const onRefresh = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "draft", onRefresh })), container);

    const health = container.querySelector<HTMLElement>(".book-writer-local-ai-health");
    expect(health).not.toBeNull();
    expect(health?.textContent).toContain("Local AI");
    expect(health?.textContent).toContain("Ready");
    expect(health?.textContent).toContain("ollama");
    expect(health?.textContent).toContain("qwen2.5:32b");
    expect(health?.textContent).toContain("24.7 tok/s");

    const checkAgain = Array.from(health?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Check again"),
    );
    checkAgain?.click();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps journey and editor controls keyboard/a11y discoverable", () => {
    const onActiveViewChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);

    render(renderBookWriterDashboard(props({ onActiveViewChange })), container);

    const journeySteps = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".book-writer-guided-step"),
    );
    expect(journeySteps.map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "1 Idea",
      "2 Chapters",
      "3 Plan",
      "4 Write",
      "5 Read",
      "6 Publish",
    ]);

    journeySteps[1].focus();
    expect(document.activeElement).toBe(journeySteps[1]);
    journeySteps[1].click();
    expect(onActiveViewChange).toHaveBeenCalledWith("chapters");

    const controls = Array.from(
      container.querySelectorAll<HTMLElement>("button,input,textarea,select"),
    );
    for (const control of controls) {
      const label = control.closest("label")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const accessibleHint = [
        control.getAttribute("aria-label"),
        control.getAttribute("title"),
        control.getAttribute("placeholder"),
        control.textContent,
        label,
      ]
        .filter(Boolean)
        .join(" ")
        .trim();
      expect(accessibleHint, control.outerHTML).not.toBe("");
    }
    container.remove();
  });

  it("defines dashboard publishing and planning terms inline", () => {
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "publish", mode: "advanced" })),
      container,
    );

    expect(container.textContent).toContain("Plain-English dictionary");
    expect(container.textContent).toContain("No hover required");
    expect(container.textContent).toContain("Book plan");
    expect(container.textContent).toContain("Paragraph plan");
    expect(container.textContent).toContain("Approval gate");
    expect(container.textContent).toContain("What this section is for");
    expect(container.textContent).toContain("This is the KDP handoff");
    expect(container.textContent).toContain("Back to Simple");
    expect(container.textContent).toContain("Book readiness map");
    expect(container.textContent).toContain("Click any row to jump there");
    expect(container.textContent).toContain("Stage map");
    expect(container.textContent).toContain("Quality findings");

    const helpTitles = Array.from(container.querySelectorAll<HTMLElement>(".book-writer-term-help"))
      .map((help) => help.getAttribute("title") ?? "")
      .join("\n");
    expect(helpTitles).toContain("KDP");
    expect(helpTitles).toContain("Approval gate");
    expect(helpTitles).toContain("Metadata");
    expect(helpTitles).toContain("Browser actions");

    const glossaryChips = Array.from(
      container.querySelectorAll<HTMLElement>(".book-writer-glossary-chip"),
    );
    expect(glossaryChips.length).toBeGreaterThanOrEqual(8);
    expect(glossaryChips.some((chip) => chip.getAttribute("aria-label")?.includes("KDP"))).toBe(
      true,
    );
    expect(container.querySelectorAll(".book-writer-field-hint").length).toBeGreaterThanOrEqual(3);
  });

  it("shows a click-to-jump readiness map for the whole workflow", () => {
    const onActiveViewChange = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ onActiveViewChange, mode: "advanced" })), container);

    const workflowSteps = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".book-writer-workflow-step"),
    );
    expect(workflowSteps).toHaveLength(7);
    expect(workflowSteps.map((step) => step.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      expect.stringContaining("Idea"),
      expect.stringContaining("Make Chapters"),
      expect.stringContaining("Plan Paragraphs"),
      expect.stringContaining("Write Book Text"),
      expect.stringContaining("Readable Book"),
      expect.stringContaining("Read Book"),
      expect.stringContaining("Publish prep"),
    ]);

    const manuscript = workflowSteps.find((step) => step.textContent?.includes("Readable Book"));
    expect(manuscript?.getAttribute("aria-label")).toContain(
      "Build the manuscript from finished Book Text",
    );
    manuscript?.click();
    expect(onActiveViewChange).toHaveBeenCalledWith("draft");
  });

  it("turns version conflicts into a safe refresh recovery action", () => {
    const onRefresh = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          error: "book plan version conflict: expected 3, found 4",
          onRefresh,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Someone edited this plan first.");
    expect(container.textContent).toContain("Refresh the latest version before saving again");
    const refreshLatest = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Refresh latest"),
    );
    refreshLatest?.click();

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("offers one obvious start action before a plan exists", () => {
    const onRequestAiAction = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({ snapshot: null, topicDraft: "A simple book topic.", onRequestAiAction }),
      ),
      container,
    );

    expect(container.textContent).toContain("Describe the book. AI builds the editable draft.");
    expect(container.textContent).toContain("Describe the book. AI builds the editable draft.");
    expect(container.textContent).toContain("Write my editable draft");
    const startButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write my editable draft"),
    );
    startButton?.click();

    expect(onRequestAiAction).toHaveBeenCalledWith("full-draft");
  });

  it("uses the home page for trophies and completed books before setup opens", () => {
    const onOpenNewBookSetup = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          snapshot: homeSnapshot(),
          onOpenNewBookSetup,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Published trophies first");
    expect(container.textContent).toContain("Completed books");
    expect(container.textContent).toContain("New book idea");
    expect(container.textContent).not.toContain("Describe the book. AI builds the editable draft.");
    const setupButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Set up new book"),
    );
    setupButton?.click();
    expect(onOpenNewBookSetup).toHaveBeenCalledTimes(1);
  });

  it("shows book length, tone, and profanity controls with a page estimate", () => {
    const onTargetWordsDraftChange = vi.fn();
    const onToneDraftChange = vi.fn();
    const onProfanityDraftChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          snapshot: null,
          topicDraft: "A simple book topic.",
          targetWordsDraft: 12000,
          toneDraft: "technical",
          profanityDraft: "mild",
          onTargetWordsDraftChange,
          onToneDraftChange,
          onProfanityDraftChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Length, tone, and profanity");
    expect(container.textContent).toContain("12,000 words");
    expect(container.textContent).toContain("≈ 40-48 paperback pages");
    expect(container.textContent).toContain("Profanity");
    expect(container.textContent).toContain("Style Preview");
    expect(container.textContent).toContain("How AI will try to sound");

    const lengthInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="New book target words"], input[type="number"]',
    );
    lengthInput!.value = "24000";
    lengthInput!.dispatchEvent(new Event("input"));
    expect(onTargetWordsDraftChange).toHaveBeenCalledWith(24000);

    const toneSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="New book tone"]',
    );
    const profanitySelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="New book profanity"]',
    );
    if (!toneSelect || !profanitySelect) {
      throw new Error("Expected draft control selects to be visible.");
    }
    toneSelect.value = "humorous";
    toneSelect.dispatchEvent(new Event("change"));
    profanitySelect.value = "extreme";
    profanitySelect.dispatchEvent(new Event("change"));

    expect(onToneDraftChange).toHaveBeenCalledWith("humorous");
    expect(onProfanityDraftChange).toHaveBeenCalledWith("extreme");
  });

  it("keeps length, tone, and profanity in one visible controls card", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "brief" })), container);

    expect(container.querySelectorAll(".book-writer-context-panel")).toHaveLength(1);
    expect(container.querySelectorAll('input[aria-label="Context target words"]')).toHaveLength(1);
    expect(container.querySelectorAll('select[aria-label="Context tone"]')).toHaveLength(1);
    expect(container.querySelectorAll('select[aria-label="Context profanity"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="New book target words"]')).toBeNull();
    expect(container.querySelector('[aria-label="New book tone"]')).toBeNull();
    expect(container.querySelector('[aria-label="New book profanity"]')).toBeNull();
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Book Control Bar");
    expect(text).toContain("Change the book without losing the thread");
    expect(text).not.toContain("All writing settings live in the Idea step.");
  });

  it("keeps one section-specific left context panel across Idea, Chapters, and Write", () => {
    const container = document.createElement("div");

    const byIdea = props({ activeView: "brief" });
    render(renderBookWriterDashboard(byIdea), container);

    const ideaPanel = container.querySelector(".book-writer-context-panel");
    expect(ideaPanel).not.toBeNull();
    expect(ideaPanel?.textContent).toContain("Book Control Bar");
    expect(ideaPanel?.textContent).toContain(
      "Global controls stay here. Edit idea details on the right.",
    );

    const byChapters = props({
      activeView: "chapters",
      onActiveViewChange: vi.fn(),
    });
    render(renderBookWriterDashboard(byChapters), container);

    const chapterPanel = container.querySelector(".book-writer-context-panel");
    expect(chapterPanel).not.toBeNull();
    expect(chapterPanel?.textContent).toContain("Left panel · Chapters");
    expect(chapterPanel?.textContent).toContain("Make chapter hooks, roles, and style cues.");
    expect(chapterPanel?.textContent).toContain("AI generate selected chapter fields");
    expect(container.querySelectorAll(".book-writer-context-panel")).toHaveLength(1);

    const byDraft = props({
      activeView: "draft",
      onActiveViewChange: vi.fn(),
    });
    render(renderBookWriterDashboard(byDraft), container);

    const writePanel = container.querySelector(".book-writer-context-panel");
    expect(writePanel).not.toBeNull();
    expect(writePanel?.textContent).toContain("Left panel · Write");
    expect(writePanel?.textContent).toContain(
      "Steer this paragraph without breaking the book voice.",
    );
    const workspacePanels = container.querySelectorAll(".book-writer-context-panel");
    expect(workspacePanels).toHaveLength(1);
  });

  it("shows friendly Chapter role controls for chapter feel and plot job", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "chapters" })), container);

    expect(container.textContent).toContain("Chapter role");
    expect(container.textContent).toContain("What is this chapter doing?");
    expect(container.textContent).toContain("Converging stories");
    expect(container.textContent).toContain("Plot twist");
    expect(container.textContent).toContain("Mystery deepens");
  });

  it("shows AI idea setup options and sends selected fields to the idea-strategist", () => {
    const onGenerateIdeaSetup = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "brief", onGenerateIdeaSetup })),
      container,
    );

    expect(container.textContent).toContain("AI generate idea setup");
    expect(container.textContent).toContain("Profanity stays Off");
    const tone = container.querySelector<HTMLInputElement>('input[value="tone"]');
    if (!tone) {
      throw new Error("Expected tone checkbox.");
    }
    tone.checked = false;
    const button = Array.from(container.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("AI generate selected idea fields"),
    );

    button?.click();

    expect(onGenerateIdeaSetup).toHaveBeenCalledWith([
      "title",
      "summary",
      "readerPromise",
      "targetWords",
      "audience",
    ]);
  });

  it("shows chapter numbers and sends selected chapter fields to the chapter-architect", () => {
    const onGenerateChapterSetup = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "chapters", onGenerateChapterSetup })),
      container,
    );

    expect(container.textContent).toContain("Chapter 1 title");
    expect(container.textContent).toContain("AI generate selected chapter fields");
    expect(container.textContent).toContain("Regenerate better titles");
    expect(container.textContent).toContain("Style direction");
    const role = container.querySelector<HTMLInputElement>('input[value="role"]');
    if (!role) {
      throw new Error("Expected role checkbox.");
    }
    role.checked = false;
    const button = Array.from(container.querySelectorAll("button")).find((item) =>
      item.textContent?.includes("AI generate selected chapter fields"),
    );

    button?.click();

    expect(onGenerateChapterSetup).toHaveBeenCalledWith(["title", "description", "style"]);
  });

  it("offers a dedicated visible action to regenerate only better chapter titles", () => {
    const onGenerateChapterSetup = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "chapters", onGenerateChapterSetup })),
      container,
    );

    const button = container.querySelector<HTMLButtonElement>(
      "[data-book-writer-regenerate-titles]",
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Regenerate better titles");

    button?.click();

    expect(onGenerateChapterSetup).toHaveBeenCalledWith(["title"]);
  });

  it("lets Plan fill unlocked paragraph boxes while exposing per-field locks", () => {
    const onFillParagraphPlans = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "paragraphs", onFillParagraphPlans })),
      container,
    );

    expect(container.textContent).toContain("AI fill all unlocked paragraph plans");
    expect(container.textContent).toContain("Lock this box from AI");
    const fillAll = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI fill all unlocked paragraph plans"),
    );

    fillAll?.click();

    expect(onFillParagraphPlans).toHaveBeenCalledWith();
  });

  it("turns Read into a page-by-page final review with chapter jump", () => {
    const onReadPageChange = vi.fn();
    const current = snapshot();
    const readPlan: BookWriterPlan = {
      ...current.plan!,
      chapters: [
        current.plan!.chapters[0],
        {
          ...current.plan!.chapters[0],
          id: "chapter-2",
          number: 2,
          title: "The Second Ledger",
          paragraphs: [
            {
              ...current.plan!.chapters[0].paragraphs[0],
              id: "paragraph-2",
              order: 1,
              text: "Audrey read the second ledger slowly. The name in the margin did not match the signature below it.",
            },
          ],
        },
      ],
    };
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "package",
          readPage: 0,
          onReadPageChange,
          snapshot: { ...current, plan: readPlan, manuscriptPreview: "" },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Final review, page by page.");
    expect(container.textContent).toContain("Jump to chapter");
    expect(container.textContent).toContain("The Second Ledger");

    const next = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Next page",
    );
    next?.click();

    expect(onReadPageChange).toHaveBeenCalledWith(1);
  });

  it("keeps the Read chapter selector synchronized with the current page", () => {
    const current = snapshot();
    const readPlan: BookWriterPlan = {
      ...current.plan!,
      chapters: [
        current.plan!.chapters[0],
        {
          ...current.plan!.chapters[0],
          id: "chapter-2",
          number: 2,
          title: "The Second Ledger",
          paragraphs: [
            {
              ...current.plan!.chapters[0].paragraphs[0],
              id: "paragraph-2",
              text: "The second ledger moved the mystery into a colder room.",
            },
          ],
        },
      ],
    };
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "package",
          readPage: 1,
          snapshot: { ...current, plan: readPlan, manuscriptPreview: "" },
        }),
      ),
      container,
    );

    const selector = container.querySelector<HTMLSelectElement>(
      ".book-writer-read-controls select",
    );
    expect(selector?.value).toBe("1");
    expect(container.querySelector(".book-writer-read-page header span")?.textContent).toContain(
      "The Second Ledger",
    );
  });

  it("opens an elegant paperback Book Preview with TOC, pages, and chapter starts", () => {
    const onReadPreviewOpenChange = vi.fn();
    const onReadPageChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "package",
          readPreviewOpen: true,
          readPreviewMode: "paperback",
          onReadPreviewOpenChange,
          onReadPageChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Finished book preview");
    expect(container.textContent).toContain("Paperback pages");
    expect(container.textContent).toContain("Contents");
    expect(container.textContent).not.toContain("Index");
    expect(container.textContent).toContain("Return to Read");
    expect(container.textContent).toContain("Bridge Ledger");
    expect(container.textContent).not.toContain("Open with the suspicious invoice.");
    expect(container.textContent).not.toContain("Hook");
    expect(container.textContent).not.toContain(
      "A small detail now points toward the later reveal",
    );

    const next = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Next page",
    );
    next?.click();
    expect(onReadPageChange).toHaveBeenCalledWith(1);

    const back = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Return to Read"),
    );
    back?.click();
    expect(onReadPreviewOpenChange).toHaveBeenCalledWith(false);
  });

  it("switches Book Preview to a clearly labeled reflowable eBook reader", () => {
    const onReadPreviewModeChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "package",
          readPreviewOpen: true,
          readPreviewMode: "ebook",
          onReadPreviewModeChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("eBook reader");
    expect(container.textContent).toContain("eBook mode is reflowable");
    expect(container.textContent).toContain("Audrey found the invoice at sunrise.");

    const paperback = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Paperback",
    );
    paperback?.click();
    expect(onReadPreviewModeChange).toHaveBeenCalledWith("paperback");
  });

  it("shows the active draft library only on Home, not inside build pages", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "chapters" })), container);

    expect(container.querySelector(".book-writer-rail")).toBeNull();
    expect(container.textContent).not.toContain("New book idea");
    expect(container.querySelector(".book-writer-context-panel")).not.toBeNull();

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          snapshot: homeSnapshot(),
        }),
      ),
      container,
    );

    expect(container.querySelector(".book-writer-rail")).not.toBeNull();
    expect(container.textContent).toContain("New book idea");
  });

  it("offers a clear Home action from guided build pages", () => {
    const onShowHome = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "draft", onShowHome })), container);

    const homeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Book Studio home and trophy room"]',
    );
    expect(homeButton).not.toBeNull();
    expect(homeButton?.textContent).toContain("Home / Trophy Room");

    homeButton?.click();
    expect(onShowHome).toHaveBeenCalledTimes(1);
  });

  it("offers the same Home action from Advanced View", () => {
    const onShowHome = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ mode: "advanced", onShowHome })), container);

    const homeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Book Studio home and trophy room"]',
    );
    expect(homeButton).not.toBeNull();

    homeButton?.click();
    expect(onShowHome).toHaveBeenCalledTimes(1);
  });

  it("keeps Idea controls stable and swaps later sections to task-specific rails", () => {
    const container = document.createElement("div");
    const getControlValues = () => {
      const panel = container.querySelector(".book-writer-context-panel");
      if (!panel) {
        return null;
      }
      return {
        targetWords: panel?.querySelector<HTMLInputElement>(
          'input[aria-label="Context target words"]',
        )?.value,
        tone: panel?.querySelector<HTMLSelectElement>('select[aria-label="Context tone"]')?.value,
        profanity: panel?.querySelector<HTMLSelectElement>('select[aria-label="Context profanity"]')
          ?.value,
      };
    };

    render(renderBookWriterDashboard(props({ activeView: "brief" })), container);
    expect(container.querySelectorAll(".book-writer-context-panel")).toHaveLength(1);
    expect(getControlValues()).toMatchObject({
      targetWords: "1600",
      tone: "professional",
      profanity: "none",
    });

    render(renderBookWriterDashboard(props({ activeView: "chapters" })), container);
    expect(container.querySelectorAll(".book-writer-context-panel")).toHaveLength(1);
    expect(getControlValues()).toMatchObject({
      targetWords: undefined,
      tone: undefined,
      profanity: undefined,
    });
    expect(container.querySelector(".book-writer-context-panel")?.textContent).toContain(
      "Left panel · Chapters",
    );

    render(renderBookWriterDashboard(props({ activeView: "draft" })), container);
    expect(container.querySelectorAll(".book-writer-context-panel")).toHaveLength(1);
    expect(getControlValues()).toMatchObject({
      targetWords: "1600",
      tone: "professional",
      profanity: "none",
    });
    expect(container.querySelector(".book-writer-context-panel")?.textContent).toContain(
      "Left panel · Write",
    );
  });

  it("keeps editable book settings visible after Idea without duplicating setup controls", () => {
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "draft" })), container);

    const settings = container.querySelector(".book-writer-context-panel");
    expect(settings).not.toBeNull();
    expect(settings?.textContent).toContain("Book Control Bar");
    expect(settings?.textContent).toContain("How AI will sound");
    expect(settings?.textContent).toContain("Manual only");
    expect(settings?.textContent).toContain("Audience");
    expect(settings?.textContent).toContain("Reader promise");
    expect(container.querySelectorAll(".book-writer-setup-controls")).toHaveLength(0);
    expect(container.querySelector('input[aria-label="Context target words"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Context tone"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Context profanity"]')).not.toBeNull();
  });

  it("shows scheduled automation and exposes the autonomous-writing kill switch", () => {
    const onDisableAutomation = vi.fn();
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "draft",
          onDisableAutomation,
          snapshot: {
            ...current,
            automation: {
              enabled: true,
              scheduled: true,
              status: "scheduled",
              message: "Autonomous overnight writing is scheduled.",
              scriptPath: "/tmp/book-writer-nightly.sh",
            },
          },
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Autonomous overnight writing is scheduled.");
    const killSwitch = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Turn off autonomous writing"),
    );
    killSwitch?.click();
    expect(onDisableAutomation).toHaveBeenCalledTimes(1);
  });

  it("shows book health at a glance and routes cards to the right step", () => {
    const onActiveViewChange = vi.fn();
    const current = rejectedReviewSnapshot();
    const healthPlan = planWithParagraphCount(4);
    healthPlan.chapters[0].paragraphs[0].locked = true;
    healthPlan.chapters[0].paragraphs[1].text = "Finished reader-facing text.";
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "chapters",
          snapshot: {
            ...current,
            plan: healthPlan,
            planQuality: null,
          },
          onActiveViewChange,
        }),
      ),
      container,
    );

    const health = container.querySelector(".book-writer-guided-header__status");
    expect(health).not.toBeNull();
    expect(health?.textContent).toContain("Book health");
    expect(health?.textContent).toContain("3 left");
    expect(health?.textContent).toContain("1 locked");
    expect(health?.textContent).toContain("Rejected");
    expect(health?.textContent).toContain("Blocked");

    const buttons = Array.from(health!.querySelectorAll("button"));
    expect(buttons.length).toBeGreaterThanOrEqual(4);
    buttons.find((button) => button.textContent?.includes("Unfinished text"))?.click();
    buttons.find((button) => button.textContent?.includes("Locked text"))?.click();
    buttons.find((button) => button.textContent?.includes("Quality status"))?.click();
    buttons.find((button) => button.textContent?.includes("Publish readiness"))?.click();

    expect(onActiveViewChange).toHaveBeenNthCalledWith(1, "draft");
    expect(onActiveViewChange).toHaveBeenNthCalledWith(2, "draft");
    expect(onActiveViewChange).toHaveBeenNthCalledWith(3, "package");
    expect(onActiveViewChange).toHaveBeenNthCalledWith(4, "publish");
  });

  it("shows a custom tone field and preview before AI creates the plan", () => {
    const onCustomToneDraftChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          snapshot: null,
          topicDraft: "A cozy field guide for resilient family routines.",
          toneDraft: "custom",
          customToneDraft: "Cozy, dryly funny, and emotionally warm.",
          onCustomToneDraftChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Custom tone details");
    expect(container.textContent).toContain("Style Preview");
    expect(container.textContent).toContain("Custom voice direction");
    expect(container.textContent).toContain("not saved as Book Text");

    const customToneInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New book custom tone"]',
    );
    customToneInput!.value = "Noir, clipped, but still readable.";
    customToneInput!.dispatchEvent(new Event("input"));

    expect(onCustomToneDraftChange).toHaveBeenCalledWith("Noir, clipped, but still readable.");
  });

  it("saves existing book length, tone, and profanity edits into the plan", () => {
    const onSavePlan = vi.fn();
    const onRequestAiAction = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "brief", onSavePlan })), container);

    const lengthInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Context target words"]',
    );
    lengthInput!.value = "12000";
    lengthInput!.dispatchEvent(new Event("change"));
    const lengthPlan = onSavePlan.mock.calls[0][0] as BookWriterPlan;
    expect(lengthPlan.targetWords).toBe(12000);
    expect(lengthPlan.chapters[0].targetWords).toBe(12000);
    expect(lengthPlan.chapters[0].paragraphs[0].targetWords).toBe(12000);

    lengthInput!.value = "250";
    lengthInput!.dispatchEvent(new Event("change"));
    const shortPlan = onSavePlan.mock.calls[1][0] as BookWriterPlan;
    expect(shortPlan.targetWords).toBe(250);
    expect(shortPlan.chapters[0].targetWords).toBe(250);
    expect(shortPlan.chapters[0].paragraphs[0].targetWords).toBe(250);

    const toneSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Context tone"]',
    );
    const profanitySelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Context profanity"]',
    );
    if (!toneSelect || !profanitySelect) {
      throw new Error("Expected context tone and profanity selects.");
    }
    toneSelect.value = "technical";
    toneSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    profanitySelect.value = "high";
    profanitySelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    const tonePlan = onSavePlan.mock.calls[2][0] as BookWriterPlan;
    const profanityPlan = onSavePlan.mock.calls[3][0] as BookWriterPlan;
    expect(tonePlan.styleGuide?.tonePreset).toBe("technical");
    expect(tonePlan.brief.tone).toContain("Technical");
    expect(profanityPlan.styleGuide?.profanityLevel).toBe("high");
    expect(profanityPlan.brief.constraints.join(" ")).toContain("Profanity level");
  });

  it("offers and applies structure rebalance when a long draft is shortened to flash length", () => {
    const onSavePlan = vi.fn();
    const onRequestAiAction = vi.fn();
    const longPlan = planWithParagraphCount(6);
    longPlan.targetWords = 12000;
    longPlan.chapters = Array.from({ length: 6 }, (_item, chapterIndex) => ({
      ...longPlan.chapters[0],
      id: `chapter-${chapterIndex + 1}`,
      number: chapterIndex + 1,
      title: `Chapter ${chapterIndex + 1}`,
      paragraphs: longPlan.chapters[0].paragraphs.map((paragraph) => ({
        ...paragraph,
        id: `${paragraph.id}-${chapterIndex + 1}`,
      })),
    }));
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          snapshot: { ...snapshot(), plan: longPlan },
          activeView: "brief",
          onSavePlan,
          onRequestAiAction,
        }),
      ),
      container,
    );

    const lengthInput = container.querySelector<HTMLInputElement>(
      'input[aria-label="Context target words"]',
    );
    lengthInput!.value = "250";
    lengthInput!.dispatchEvent(new Event("change"));
    render(
      renderBookWriterDashboard(
        props({
          snapshot: { ...snapshot(), plan: onSavePlan.mock.calls[0][0] as BookWriterPlan },
          activeView: "brief",
          onSavePlan,
          onRequestAiAction,
        }),
      ),
      container,
    );

    expect(container.querySelector("[data-book-writer-rebalance-callout]")?.textContent).toContain(
      "Structure mismatch",
    );
    container.querySelector<HTMLButtonElement>("[data-book-writer-rebalance]")?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("rebalance");
  });

  it("saves custom tone edits on an existing plan", () => {
    const onSavePlan = vi.fn();
    const current = plan();
    const customPlan: BookWriterPlan = {
      ...current,
      brief: { ...current.brief, tone: "Cozy, dryly funny, and warm." },
      styleGuide: {
        ...current.styleGuide!,
        tonePreset: "custom",
        toneDescription: "Cozy, dryly funny, and warm.",
      },
    };
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "brief",
          snapshot: { ...snapshot(), plan: customPlan },
          onSavePlan,
        }),
      ),
      container,
    );

    const customToneInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="How AI will sound"]',
    );
    customToneInput!.value = "Noir, clipped, but readable.";
    customToneInput!.dispatchEvent(new Event("change"));

    const savedPlan = onSavePlan.mock.calls[0][0] as BookWriterPlan;
    expect(savedPlan.styleGuide?.tonePreset).toBe("custom");
    expect(savedPlan.styleGuide?.toneDescription).toBe("Noir, clipped, but readable.");
    expect(savedPlan.brief.tone).toBe("Noir, clipped, but readable.");
  });

  it("saves paragraph text edits through the provided callback", () => {
    const onSavePlan = vi.fn();
    const container = document.createElement("div");

    render(renderBookWriterDashboard(props({ activeView: "draft", onSavePlan })), container);

    const draft = container.querySelector(".book-writer-draft") as HTMLTextAreaElement;
    draft.value = "A manually revised paragraph.";
    draft.dispatchEvent(new Event("change"));

    expect(onSavePlan).toHaveBeenCalledTimes(1);
    const savedPlan = onSavePlan.mock.calls[0][0] as BookWriterPlan;
    expect(savedPlan.chapters[0].paragraphs[0].text).toBe("A manually revised paragraph.");
  });

  it("applies paragraph bulk operations without touching text", () => {
    const onSavePlan = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "paragraphs", mode: "advanced", onSavePlan })),
      container,
    );

    const lockAll = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Lock all paragraphs"),
    );
    const approveDrafted = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Approve written paragraphs"),
    );
    lockAll?.click();
    approveDrafted?.click();

    expect(onSavePlan).toHaveBeenCalledTimes(2);
    const lockedPlan = onSavePlan.mock.calls[0][0] as BookWriterPlan;
    expect(lockedPlan.chapters[0].paragraphs[0].locked).toBe(true);
    expect(lockedPlan.chapters[0].paragraphs[0].text).toBe("Audrey found the invoice at sunrise.");
    const approvedPlan = onSavePlan.mock.calls[1][0] as BookWriterPlan;
    expect(approvedPlan.chapters[0].paragraphs[0].status).toBe("approved");
    expect(approvedPlan.chapters[0].paragraphs[0].locked).toBe(true);
  });

  it("makes paragraph generation obvious and calls the draft action", () => {
    const onDraftPlan = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(props({ activeView: "paragraphs", mode: "advanced", onDraftPlan })),
      container,
    );

    expect(container.textContent).toContain("After planning");
    expect(container.textContent).toContain("Write actual Book Text from these plans.");
    expect(container.textContent).toContain("The normal path is Write");
    expect(container.textContent).toContain("Plan for AI");
    expect(container.textContent).toContain("Nothing in Plan for AI is printed in the book.");

    const generateButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("title")?.startsWith("Write the paragraphs: advanced shortcut"),
    );
    generateButton?.click();

    expect(onDraftPlan).toHaveBeenCalledTimes(1);
  });

  it("makes chapter plans visibly AI instructions, not printed book text", () => {
    const onFocusedParagraphChange = vi.fn();
    const onActiveViewChange = vi.fn();
    const onModeChange = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "chapters",
          onActiveViewChange,
          onFocusedParagraphChange,
          onModeChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("You do");
    expect(container.textContent).toContain("AI does");
    expect(container.textContent).toContain("Readers see");
    expect(container.textContent).toContain("Plan for AI");
    expect(container.textContent).toContain(
      "Paraphrase the chapter's reader-facing content. This is not printed in the book.",
    );
    expect(container.textContent).toContain("Chapter style direction");
    const writeMyself = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write this chapter myself"),
    );
    writeMyself?.click();

    expect(onFocusedParagraphChange).toHaveBeenCalledWith("paragraph-1");
    expect(onModeChange).toHaveBeenCalledWith("guided");
    expect(onActiveViewChange).toHaveBeenCalledWith("draft");
  });

  it("routes focused paragraph AI and manual writing choices", () => {
    const onDraftParagraph = vi.fn();
    const onActiveViewChange = vi.fn();
    const onFocusedParagraphChange = vi.fn();
    const onModeChange = vi.fn();
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "draft",
          onDraftParagraph,
          onActiveViewChange,
          onFocusedParagraphChange,
          onModeChange,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Active model:");
    expect(container.textContent).toContain("qwen2.5:32b");
    const aiWriteThis = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI rewrite this Book Text"),
    );
    const manualWrite = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("I’ll write Book Text"),
    );
    aiWriteThis?.click();
    manualWrite?.click();

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Replace this paragraph"));
    expect(onDraftParagraph).toHaveBeenCalledWith("paragraph-1", true);
    expect(onFocusedParagraphChange).toHaveBeenCalledWith("paragraph-1");
    expect(onModeChange).toHaveBeenCalledWith("guided");
    expect(onActiveViewChange).toHaveBeenCalledWith("draft");
    confirmSpy.mockRestore();
  });

  it("shows beginner AI confirmation and routes the guided primary action", () => {
    const onRequestAiAction = vi.fn();
    const onConfirmAiAction = vi.fn();
    const current = snapshot();
    const emptyPlan = JSON.parse(JSON.stringify(current.plan)) as BookWriterPlan;
    for (const chapter of emptyPlan.chapters) {
      for (const paragraph of chapter.paragraphs) {
        paragraph.text = "";
        paragraph.status = "planned";
      }
    }
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "draft",
          snapshot: {
            ...current,
            plan: emptyPlan,
            planQuality: {
              ...current.planQuality!,
              counts: {
                ...current.planQuality!.counts,
                draftedParagraphs: 0,
                draftedWords: 0,
              },
            },
          },
          onRequestAiAction,
          pendingAiAction: "draft",
          onConfirmAiAction,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Before AI starts");
    expect(container.textContent).toContain("AI will not overwrite");
    const primary = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI write Book Text"),
    );
    primary?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("draft");

    const confirm = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write 1 paragraphs"),
    );
    confirm?.click();
    expect(onConfirmAiAction).toHaveBeenCalledWith("draft");
  });

  it("confirms the one-click editable draft path from one description", () => {
    const onConfirmAiAction = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          snapshot: null,
          topicDraft: "A clean mystery about a lighthouse ledger.",
          pendingAiAction: "full-draft",
          onConfirmAiAction,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Write the editable draft now?");
    expect(container.textContent).toContain("actual Book Text");
    expect(container.textContent).toContain("continues from saved work");
    expect(container.textContent).toContain("Nothing is published");
    const confirm = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write editable draft"),
    );
    confirm?.click();

    expect(onConfirmAiAction).toHaveBeenCalledWith("full-draft");
  });

  it("shows staged, resumable progress while AI builds the editable draft", () => {
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "draft",
          savingAction: "full-draft-text",
        }),
      ),
      container,
    );

    const progress = container.querySelector(".book-writer-full-draft-progress");
    expect(progress?.textContent).toContain("AI is building your editable draft");
    expect(progress?.textContent).toContain("Making chapters");
    expect(progress?.textContent).toContain("Planning paragraphs");
    expect(progress?.textContent).toContain("Writing Book Text");
    expect(progress?.textContent).toContain("Building preview");
    expect(progress?.textContent).toContain("Finish editable draft");
    expect(
      progress?.querySelector(".book-writer-full-draft-progress__step--current")?.textContent,
    ).toContain("Writing Book Text");
  });

  it("routes guided review buttons to screens and AI-writing buttons to AI", () => {
    const onRequestAiAction = vi.fn();
    const onActiveViewChange = vi.fn();
    const chaptersContainer = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "chapters",
          onRequestAiAction,
          onActiveViewChange,
        }),
      ),
      chaptersContainer,
    );

    const paragraphPlanButton = Array.from(chaptersContainer.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Review paragraph plan"),
    );
    paragraphPlanButton?.click();
    expect(onActiveViewChange).toHaveBeenCalledWith("paragraphs");
    expect(onRequestAiAction).not.toHaveBeenCalled();

    const paragraphsContainer = document.createElement("div");
    render(
      renderBookWriterDashboard(
        props({
          activeView: "paragraphs",
          onRequestAiAction,
          onActiveViewChange,
        }),
      ),
      paragraphsContainer,
    );

    const writeButton = Array.from(paragraphsContainer.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("AI write Book Text"),
    );
    writeButton?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("draft");
  });

  it("keeps active-book deletion in Manage books after the book-opening shelf", () => {
    const onRequestDestructiveAction = vi.fn();
    const onConfirmDestructiveAction = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          onRequestDestructiveAction,
          snapshot: homeSnapshot({ projects: snapshot().projects }),
        }),
      ),
      container,
    );

    expect(
      container.querySelector(".book-writer-project > .book-writer-project__delete"),
    ).toBeNull();
    expect(container.querySelector(".book-writer-project-more")).toBeNull();
    expect(container.textContent).toContain("Manage books");
    expect(container.textContent).toContain("Maintenance stays here so opening books stays fast.");
    expect(container.textContent).toMatch(/Recently Deleted keeps\s+recovery copies\./);
    const projects = container.querySelector(".book-writer-projects");
    const manageBooks = container.querySelector(".book-writer-manage-books");
    expect(projects).not.toBeNull();
    expect(manageBooks).not.toBeNull();
    expect(
      projects!.compareDocumentPosition(manageBooks!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const deleteButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Move Bridge Ledger to Recently Deleted"),
    );
    deleteButton?.click();

    expect(onRequestDestructiveAction).toHaveBeenCalledWith({
      kind: "move-active",
      runId: "book-run",
      title: "Bridge Ledger",
    });

    render(
      renderBookWriterDashboard(
        props({
          pendingDestructiveAction: {
            kind: "move-active",
            runId: "book-run",
            title: "Bridge Ledger",
          },
          onConfirmDestructiveAction,
        }),
      ),
      container,
    );
    expect(container.textContent).toContain("Move this book to Recently Deleted?");
    const dialog = container.querySelector('[role="dialog"]');
    const confirmMove = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Move to Recently Deleted"),
    );
    confirmMove?.click();
    expect(onConfirmDestructiveAction).toHaveBeenCalledWith({
      kind: "move-active",
      runId: "book-run",
      title: "Bridge Ledger",
    });
  });

  it("archives active drafts into a hidden Archived books section with restore and safe delete", () => {
    const onArchiveRun = vi.fn();
    const onRestoreArchivedRun = vi.fn();
    const onRequestDestructiveAction = vi.fn();
    const onConfirmDestructiveAction = vi.fn();
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          onArchiveRun,
          onRestoreArchivedRun,
          onRequestDestructiveAction,
          snapshot: {
            ...homeSnapshot({ projects: current.projects }),
            archivedBooks: [
              {
                archivedId: "archived-book-run",
                runId: "archived-run",
                title: "Archived Ledger",
                subtitle: "Hidden draft",
                penName: "Northstar House",
                genre: "clean commercial mystery",
                status: "drafting",
                kind: "full",
                version: 4,
                archivedAt: "2026-05-22T12:00:00.000Z",
                targetWords: 1600,
                draftedWords: 700,
                chapterCount: 3,
                paragraphCount: 12,
              },
            ],
          },
        }),
      ),
      container,
    );

    const archiveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Archive draft Bridge Ledger"),
    );
    archiveButton?.click();
    expect(onArchiveRun).toHaveBeenCalledWith("book-run");

    const copyButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Copy draft Bridge Ledger"),
    );
    expect(copyButton).not.toBeNull();

    const archivedDetails = container.querySelector("details .book-writer-archived-books__list");
    expect(container.textContent).toContain("Archived books (1)");
    expect(archivedDetails).not.toBeNull();

    const restore = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Restore archived Archived Ledger"),
    );
    restore?.click();
    expect(onRestoreArchivedRun).toHaveBeenCalledWith("archived-book-run");

    const deleteArchived = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Delete archived Archived Ledger"),
    );
    deleteArchived?.click();
    expect(onRequestDestructiveAction).toHaveBeenCalledWith({
      kind: "delete-archived",
      archivedId: "archived-book-run",
      title: "Archived Ledger",
    });

    render(
      renderBookWriterDashboard(
        props({
          pendingDestructiveAction: {
            kind: "delete-archived",
            archivedId: "archived-book-run",
            title: "Archived Ledger",
          },
          onConfirmDestructiveAction,
        }),
      ),
      container,
    );
    expect(container.textContent).toContain("Move archived");
    const dialog = container.querySelector('[role="dialog"]');
    const confirmMove = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Move to Recently Deleted"),
    );
    confirmMove?.click();
    expect(onConfirmDestructiveAction).toHaveBeenCalledWith({
      kind: "delete-archived",
      archivedId: "archived-book-run",
      title: "Archived Ledger",
    });
  });

  it("offers a safe all-active-books cleanup action for duplicate library clutter", () => {
    const onRequestDestructiveAction = vi.fn();
    const onConfirmDestructiveAction = vi.fn();
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          onRequestDestructiveAction,
          snapshot: homeSnapshot({
            projects: [
              ...current.projects,
              {
                ...current.projects[0],
                runId: "book-run-duplicate",
                title: "Bridge Ledger",
              },
            ],
          }),
        }),
      ),
      container,
    );

    const cleanupButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Move all active books"),
    );
    cleanupButton?.click();
    expect(onRequestDestructiveAction).toHaveBeenCalledWith({
      kind: "move-active-many",
      runIds: ["book-run", "book-run-duplicate"],
      count: 2,
    });

    render(
      renderBookWriterDashboard(
        props({
          pendingDestructiveAction: {
            kind: "move-active-many",
            runIds: ["book-run", "book-run-duplicate"],
            count: 2,
          },
          onConfirmDestructiveAction,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Move all 2 active books to Recently Deleted?");
    const dialog = container.querySelector('[role="dialog"]');
    const confirmMoveAll = Array.from(dialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Move all to Recently Deleted"),
    );
    confirmMoveAll?.click();
    expect(onConfirmDestructiveAction).toHaveBeenCalledWith({
      kind: "move-active-many",
      runIds: ["book-run", "book-run-duplicate"],
      count: 2,
    });
  });

  it("shows recently deleted books with restore, delete forever, and empty all", () => {
    const onRestoreDeletedRun = vi.fn();
    const onRequestDestructiveAction = vi.fn();
    const onConfirmDestructiveAction = vi.fn();
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          onRestoreDeletedRun,
          onRequestDestructiveAction,
          snapshot: homeSnapshot({
            projects: current.projects,
            deletedBooks: [
              {
                deletedId: "2026-05-22T12-00-00-000Z-book-run",
                runId: "deleted-book-run",
                title: "Deleted Ledger",
                subtitle: "A recoverable book",
                penName: "Northstar House",
                genre: "clean commercial mystery",
                status: "packaged",
                kind: "full",
                version: 5,
                deletedAt: "2026-05-22T12:00:00.000Z",
                targetWords: 1600,
                draftedWords: 800,
                chapterCount: 3,
                paragraphCount: 12,
              },
            ],
          }),
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Recently deleted");
    expect(container.textContent).toContain("Restore brings the book back");
    expect(container.textContent).toContain("Delete forever");
    expect(container.textContent).toContain("Empty Recently Deleted…");
    const restoreButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Restore Deleted Ledger"),
    );
    restoreButton?.click();

    expect(onRestoreDeletedRun).toHaveBeenCalledWith("2026-05-22T12-00-00-000Z-book-run");
    const deleteForever = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Delete Deleted Ledger forever"),
    );
    deleteForever?.click();
    expect(onRequestDestructiveAction).toHaveBeenCalledWith({
      kind: "delete-deleted",
      deletedId: "2026-05-22T12-00-00-000Z-book-run",
      title: "Deleted Ledger",
    });

    const emptyAll = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Empty Recently Deleted"),
    );
    emptyAll?.click();
    expect(onRequestDestructiveAction).toHaveBeenCalledWith({
      kind: "empty-deleted",
      count: 1,
    });

    render(
      renderBookWriterDashboard(
        props({
          pendingDestructiveAction: {
            kind: "empty-deleted",
            count: 1,
          },
          onConfirmDestructiveAction,
        }),
      ),
      container,
    );
    expect(container.textContent).toContain("Permanently delete all 1 deleted books?");
    expect(container.textContent).toContain("This cannot be undone.");
    const emptyDialog = container.querySelector('[role="dialog"]');
    const confirmEmpty = Array.from(emptyDialog?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Delete forever"),
    );
    confirmEmpty?.click();
    expect(onConfirmDestructiveAction).toHaveBeenCalledWith({
      kind: "empty-deleted",
      count: 1,
    });
  });

  it("keeps long Recently Deleted lists collapsed so the page stays readable", () => {
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          selectedRunId: null,
          snapshot: homeSnapshot({
            projects: current.projects,
            deletedBooks: Array.from({ length: 5 }, (_, index) => ({
              deletedId: `deleted-${index + 1}`,
              runId: `deleted-book-${index + 1}`,
              title: `Deleted Ledger ${index + 1}`,
              subtitle: "A recoverable book",
              penName: "Northstar House",
              genre: "clean commercial mystery",
              status: "packaged" as const,
              kind: "full" as const,
              version: 5,
              deletedAt: "2026-05-22T12:00:00.000Z",
              targetWords: 1600,
              draftedWords: 800,
              chapterCount: 3,
              paragraphCount: 12,
            })),
          }),
        }),
      ),
      container,
    );

    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("5 recoverable books");
    expect(text).toContain("Show 2 more deleted books");
    expect(container.querySelector("details.book-writer-deleted-books__more")).not.toBeNull();
  });

  it("shows finished books in a trophy room and can move them back to the active library", () => {
    const onRestoreFinishedRun = vi.fn();
    const onUpdatePublishedMetrics = vi.fn();
    const onBuildRecommendedBook = vi.fn();
    const current = snapshot();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          onRestoreFinishedRun,
          onUpdatePublishedMetrics,
          onBuildRecommendedBook,
          selectedRunId: null,
          snapshot: homeSnapshot({
            projects: current.projects,
            recommendation: {
              title: "Follow-up to Finished Ledger",
              topicParagraph: "A recommended clean mystery based on profitable trophy signals.",
              confidence: "high",
              why: "Profit and sales are strongest here.",
              evidence: ["12 sales", "$45 profit"],
            },
            finishedBooks: [
              {
                finishedId: "2026-05-22T12-30-00-000Z-book-run",
                runId: "finished-book-run",
                title: "Finished Ledger",
                subtitle: "A published book",
                penName: "Northstar House",
                genre: "clean commercial mystery",
                status: "publish-ready",
                kind: "full",
                version: 8,
                finishedAt: "2026-05-22T12:30:00.000Z",
                coverPath: "/books/finished-book-run/cover.tiff",
                coverSource: "KDP upload cover",
                publishProof: {
                  destination: "amazon-kdp",
                  publishedAt: "2026-05-22T12:30:00.000Z",
                  category: "Mystery",
                },
                metrics: {
                  totalSales: 12,
                  totalRevenueUsd: 60,
                  totalProfitUsd: 45,
                  adSpendUsd: 5,
                  reviewCount: 3,
                  snapshots: [],
                },
                targetWords: 1600,
                draftedWords: 1600,
                chapterCount: 6,
                paragraphCount: 24,
                artifactLinks: {},
              },
            ],
          }),
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Trophy room");
    expect(container.textContent).toContain("Your published-book trophy room");
    expect(container.textContent).toContain("Finished Ledger");
    expect(container.textContent).toContain("cover.tiff");
    expect((container.textContent ?? "").replace(/\s+/g, " ")).toContain(
      "Cover used: KDP upload cover",
    );
    expect(container.textContent).toContain("12 sales");
    expect(container.textContent).toContain("$45 profit");
    expect(container.textContent).toContain("Next book recommendation");
    expect(container.querySelector(".book-writer-finished-mini")).toBeNull();
    expect(
      container.querySelectorAll('.book-writer-term-help[aria-label^="Trophy room:"]'),
    ).toHaveLength(1);

    const moveBack = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.startsWith("Move Finished Ledger back to library"),
    );
    moveBack?.click();

    expect(onRestoreFinishedRun).toHaveBeenCalledWith("2026-05-22T12-30-00-000Z-book-run");

    const recommendationButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Build this recommended book"),
    );
    recommendationButton?.click();
    expect(onBuildRecommendedBook).toHaveBeenCalledWith(
      "A recommended clean mystery based on profitable trophy signals.",
    );
  });

  it("shows Trophy Room only on the home page and keeps build/setup pages focused", () => {
    const container = document.createElement("div");
    const current = {
      ...snapshot(),
      finishedBooks: [
        {
          finishedId: "finished-ledger",
          runId: "finished-book-run",
          title: "Finished Ledger",
          subtitle: "A published book",
          penName: "Northstar House",
          genre: "clean commercial mystery",
          status: "publish-ready" as const,
          kind: "full" as const,
          version: 8,
          finishedAt: "2026-05-22T12:30:00.000Z",
          coverPath: "/books/finished-book-run/cover.tiff",
          coverSource: "KDP upload cover",
          targetWords: 1600,
          draftedWords: 1600,
          chapterCount: 6,
          paragraphCount: 24,
          artifactLinks: {},
        },
      ],
    };

    render(
      renderBookWriterDashboard(
        props({
          activeView: "brief",
          snapshot: current,
        }),
      ),
      container,
    );
    expect(container.querySelectorAll(".book-writer-trophy-room")).toHaveLength(0);

    render(
      renderBookWriterDashboard(
        props({
          activeView: "brief",
          snapshot: homeSnapshot({
            projects: current.projects,
            finishedBooks: current.finishedBooks,
          }),
          selectedRunId: null,
        }),
      ),
      container,
    );

    const trophyRoom = container.querySelector(".book-writer-trophy-room");
    const styleText = container.querySelector("style")?.textContent ?? "";

    expect(container.querySelectorAll(".book-writer-trophy-room")).toHaveLength(1);
    expect(container.querySelectorAll(".book-writer-trophy-stage")).toHaveLength(1);
    expect(container.querySelector(".book-writer-guided-workspace")).toBeNull();
    expect(container.querySelector(".book-writer-finished-mini")).toBeNull();
    expect(trophyRoom).not.toBeNull();
    expect(trophyRoom?.classList.contains("book-writer-trophy-room--top")).toBe(true);
    expect(styleText).toContain(".book-writer-trophy-stage");
    expect(styleText).toContain(".book-writer-trophy-room--top {\n        position: sticky;");
    expect(styleText).not.toContain(".book-writer-trophy-room--top *");
    expect(styleText).toContain("book-writer-trophy-scroll-compact");
    expect(styleText).toContain("book-writer-trophy-scroll-away");
    expect(styleText).toContain("max-height: 240px");
    expect(styleText).toContain("min-height: min(440px, 72vh)");
    expect(styleText).toContain("grid-auto-columns: minmax(240px, 82vw)");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "brief",
          newBookSetupOpen: true,
          snapshot: current,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".book-writer-trophy-room")).toHaveLength(0);
    expect(container.querySelector(".book-writer-guided-workspace")).not.toBeNull();
  });

  it("shows landing as trophies first, then completed books", () => {
    const onSelectRun = vi.fn();
    const current = snapshot();
    const completedProject = {
      ...current.projects[0],
      runId: "completed-book-run",
      title: "Completed Ledger",
      status: "publish-ready" as const,
      draftedWords: 1600,
    };
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          onSelectRun,
          selectedRunId: null,
          snapshot: homeSnapshot({
            projects: [current.projects[0], completedProject],
          }),
        }),
      ),
      container,
    );

    const trophyRoom = container.querySelector(".book-writer-trophy-room");
    const completedSection = container.querySelector(".book-writer-completed-shelf");
    expect(trophyRoom).not.toBeNull();
    expect(completedSection).not.toBeNull();
    expect(
      trophyRoom!.compareDocumentPosition(completedSection!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.textContent).toContain("Completed books");
    expect(container.textContent).toContain("Completed Ledger");
    expect(container.textContent).toContain("1 waiting");
    expect(container.textContent).toContain("published trophies");

    const openCompleted = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("aria-label")?.includes("completed book Completed Ledger"),
    );
    openCompleted?.click();
    expect(onSelectRun).toHaveBeenCalledWith("completed-book-run");
  });

  it("celebrates newly added books with sparkles and a dismiss action", () => {
    const onDismissCelebration = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          celebration: {
            id: "book-run",
            title: "Bridge Ledger",
            kind: "created",
            at: Date.now(),
          },
          onDismissCelebration,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("New book added!");
    expect(container.textContent).toContain("Bridge Ledger joined your library.");
    expect(container.querySelector("style")?.textContent).toContain("book-writer-balloon-pop");
    expect(container.querySelector("style")?.textContent).toContain("book-writer-firework");

    container.querySelector<HTMLButtonElement>(".book-writer-celebration__dismiss")?.click();
    expect(onDismissCelebration).toHaveBeenCalledOnce();
  });

  it("explains publish blockers with direct repair actions", () => {
    const onActiveViewChange = vi.fn();
    const onDraftPlan = vi.fn();
    const onPackagePlan = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "publish",
          mode: "advanced",
          snapshot: rejectedReviewSnapshot(),
          onActiveViewChange,
          onDraftPlan,
          onPackagePlan,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Fix publish blockers");
    expect(container.textContent).toContain("Quality check is reject");
    expect(container.textContent).toContain("Drafted word count is below the publishing minimum.");
    expect(container.textContent).toContain("Open Plan Paragraphs");
    expect(container.textContent).toContain("Check book quality again");

    const openParagraphs = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Open Plan Paragraphs"),
    );
    const generate = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Write missing Book Text"),
    );
    const recheck = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Check book quality again"),
    );
    openParagraphs?.click();
    generate?.click();
    recheck?.click();

    expect(onActiveViewChange).toHaveBeenCalledWith("paragraphs");
    expect(onDraftPlan).toHaveBeenCalledTimes(1);
    expect(onPackagePlan).toHaveBeenCalledTimes(1);
  });

  it("puts Fix this with AI first in the beginner publish path", () => {
    const onRequestAiAction = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "publish",
          snapshot: rejectedReviewSnapshot(),
          onRequestAiAction,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Your book is not ready yet.");
    expect(container.textContent).toContain("Main issue:");
    const fix = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Fix this with AI"),
    );
    fix?.click();
    expect(onRequestAiAction).toHaveBeenCalledWith("fix");
  });

  it("wires package and publish actions", () => {
    const onPackagePlan = vi.fn();
    const onPreparePublish = vi.fn();
    const onPreparePublishWithCoverStrategy = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "publish",
          mode: "advanced",
          snapshot: approvedPrePublishSnapshot(),
          onPackagePlan,
          onPreparePublish,
          onPreparePublishWithCoverStrategy,
        }),
      ),
      container,
    );

    const packageButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("title")?.startsWith("Check book quality"),
    );
    const publishButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.getAttribute("title")?.startsWith("Prepare publishing"),
    );
    packageButton?.click();
    publishButton?.click();

    expect(onPreparePublishWithCoverStrategy).toHaveBeenCalledWith("upload");
    expect(onPreparePublish).not.toHaveBeenCalled();
    expect(onPackagePlan).toHaveBeenCalledTimes(1);
  });

  it("makes the publish page choose the safe next action instead of exposing a dead publish button", () => {
    const onPackagePlan = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "publish",
          mode: "advanced",
          onPackagePlan,
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Publish prep not ready yet");
    expect(container.textContent).toContain("Check book quality first");
    expect(container.textContent).toContain(
      "No quality package yet. Run Check book quality first.",
    );

    const checkFirst = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Check book quality first"),
    );
    checkFirst?.click();
    expect(onPackagePlan).toHaveBeenCalledTimes(1);
  });

  it("shows exact KDP upload handoff when the dry-run is ready", () => {
    const onFinishRun = vi.fn();
    const onRequestAiHelp = vi.fn();
    const container = document.createElement("div");

    render(
      renderBookWriterDashboard(
        props({
          activeView: "publish",
          snapshot: approvedPublishSnapshot(),
          onFinishRun,
          onRequestAiHelp,
        }),
      ),
      container,
    );

    const kdpLink = container.querySelector<HTMLAnchorElement>(
      'a[href="https://kdp.amazon.com/en_US/bookshelf"]',
    );
    expect(kdpLink?.textContent).toContain("Open KDP Bookshelf");
    expect(container.textContent).toContain("Exact files to use in KDP");
    expect(container.textContent).toContain("/books/book-run/ebook.epub");
    expect(container.textContent).toContain("/books/book-run/cover.tiff");
    expect(container.textContent).toContain("Final KDP submit is intentionally blocked.");
    expect(container.textContent).toContain("Open KDP and follow the checklist");
    expect(container.textContent).toContain("Mark published · Move to Trophy Room");
    expect(container.textContent).toContain("Cover brief");
    expect(container.textContent).toContain("Local AI cover prompt");
    expect(container.textContent).toContain("Generate Local AI Cover");
    expect(container.textContent).toContain("Create Editable SVG Concept");
    expect(
      container.querySelectorAll(".book-writer-cover-studio .book-writer-ai-help").length,
    ).toBeGreaterThanOrEqual(12);

    const improveCoverBrief = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".book-writer-cover-studio .book-writer-ai-help",
      ),
    ).find((button) => button.textContent?.includes("Improve"));
    improveCoverBrief?.click();
    expect(onRequestAiHelp).toHaveBeenCalledWith({ target: "coverBrief", intent: "improve" });

    const finish = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Mark published"),
    );
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    finish?.click();
    expect(onFinishRun).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    container.querySelector<HTMLInputElement>('[data-publish-proof="operatorConfirmed"]')!.checked =
      true;
    finish?.click();
    expect(onFinishRun).toHaveBeenCalledWith(
      "book-run",
      expect.objectContaining({
        destination: "amazon-kdp",
        publishedAt: expect.any(String),
        operatorConfirmed: true,
      }),
    );
    alert.mockRestore();
  });
});
