import { html, nothing, type TemplateResult } from "lit";
import type {
  BookWriterActionReceipt,
  BookWriterAiAction,
  BookWriterAiHelpRequest,
  BookWriterAiHelpSuggestion,
  BookWriterChapter,
  BookWriterChapterSetupTarget,
  BookWriterChapterRole,
  BookWriterCelebration,
  BookWriterDashboardMode,
  BookWriterDashboardSnapshot,
  BookWriterDashboardView,
  BookWriterDestructiveAction,
  BookWriterIdeaSetupTarget,
  FinishedBookWriterProjectSummary,
  BookWriterPublishedMetrics,
  BookWriterPublishedProof,
  BookWriterParagraph,
  BookWriterPenNameProfile,
  BookWriterPlan,
  BookWriterProfanityLevel,
  BookWriterProjectSummary,
  BookWriterTonePreset,
} from "../controllers/book-writer-dashboard.ts";
import { icons } from "../icons.ts";

export type BookWriterDashboardProps = {
  loading: boolean;
  error: string | null;
  snapshot: BookWriterDashboardSnapshot | null;
  lastFetchAt: number | null;
  selectedRunId: string | null;
  topicDraft: string;
  targetWordsDraft: number;
  toneDraft: BookWriterTonePreset;
  customToneDraft: string;
  profanityDraft: BookWriterProfanityLevel;
  penNameDraft: string;
  newBookSetupOpen: boolean;
  readPage: number;
  readPreviewOpen: boolean;
  readPreviewMode: BookWriterReadPreviewMode;
  activeView: BookWriterDashboardView;
  mode: BookWriterDashboardMode;
  pendingAiAction: BookWriterAiAction | null;
  pendingAiSuggestion: BookWriterAiHelpSuggestion | null;
  pendingDestructiveAction: BookWriterDestructiveAction | null;
  actionReceipt: BookWriterActionReceipt | null;
  celebration: BookWriterCelebration | null;
  focusedParagraphId: string | null;
  searchQuery: string;
  savingAction: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onRefresh: () => void;
  onSelectRun: (runId: string) => void;
  onTopicDraftChange: (value: string) => void;
  onTargetWordsDraftChange: (value: number) => void;
  onToneDraftChange: (value: BookWriterTonePreset) => void;
  onCustomToneDraftChange: (value: string) => void;
  onProfanityDraftChange: (value: BookWriterProfanityLevel) => void;
  onPenNameDraftChange: (value: string) => void;
  onOpenNewBookSetup: () => void;
  onCloseNewBookSetup: () => void;
  onCreatePlan: () => void;
  onFixBook: () => void;
  onSavePlan: (plan: BookWriterPlan) => void;
  onDeleteRun: (runId: string) => void;
  onArchiveRun: (runId: string) => void;
  onCopyRun: (runId: string) => void;
  onRestoreArchivedRun: (archivedId: string) => void;
  onDeleteArchivedRun: (archivedId: string) => void;
  onRestoreDeletedRun: (deletedId: string) => void;
  onDeleteDeletedRun: (deletedId: string) => void;
  onEmptyDeletedRuns: () => void;
  onFinishRun: (runId: string, proof?: BookWriterPublishedProof) => void;
  onRestoreFinishedRun: (finishedId: string) => void;
  onUpdatePublishedMetrics: (finishedId: string, metrics: BookWriterPublishedMetrics) => void;
  onBuildRecommendedBook: (topicParagraph: string) => void;
  onDraftPlan: () => void;
  onFillParagraphPlans: (chapterId?: string) => void;
  onGenerateIdeaSetup: (targets: BookWriterIdeaSetupTarget[]) => void;
  onGenerateChapterSetup: (targets: BookWriterChapterSetupTarget[]) => void;
  onUpdatePenNameProfile: (profile: { name: string; lane: string; readerPromise: string }) => void;
  onDraftParagraph: (paragraphId: string, replaceExisting?: boolean) => void;
  onStitchPlan: () => void;
  onPackagePlan: () => void;
  onPreparePublish: () => void;
  onPreparePublishWithCoverStrategy: (coverStrategy: "upload" | "kdp-cover-creator") => void;
  onGenerateCoverConcept: () => void;
  onGenerateEditableCoverConcept: () => void;
  onEditCoverWithLocalAi: (variantId: string | undefined, instruction: string) => void;
  onApproveCover: (variantId?: string) => void;
  onUploadCoverFile: (file: File) => void;
  onDisableAutomation: () => void;
  onCreateQuickRead: () => void;
  onShowHome: () => void;
  onActiveViewChange: (view: BookWriterDashboardView) => void;
  onReadPageChange: (page: number) => void;
  onReadPreviewOpenChange: (open: boolean) => void;
  onReadPreviewModeChange: (mode: BookWriterReadPreviewMode) => void;
  onModeChange: (mode: BookWriterDashboardMode) => void;
  onFocusedParagraphChange: (paragraphId: string | null) => void;
  onRequestAiHelp: (request: BookWriterAiHelpRequest) => void;
  onRequestSetupAiHelp: (
    intent: BookWriterAiHelpRequest["intent"],
    customDirection?: string,
  ) => void;
  onCancelAiSuggestion: () => void;
  onApplyAiSuggestion: (suggestion: BookWriterAiHelpSuggestion, value?: string) => void;
  onRequestAiAction: (action: BookWriterAiAction) => void;
  onCancelAiAction: () => void;
  onConfirmAiAction: (action: BookWriterAiAction) => void;
  onRequestDestructiveAction: (action: BookWriterDestructiveAction) => void;
  onCancelDestructiveAction: () => void;
  onConfirmDestructiveAction: (action: BookWriterDestructiveAction) => void;
  onDismissReceipt: () => void;
  onDismissCelebration: () => void;
  onSearchQueryChange: (query: string) => void;
  onUndo: () => void;
  onRedo: () => void;
};

export type BookWriterReadPreviewMode = "paperback" | "ebook";

const VIEWS: Array<{
  id: BookWriterDashboardView;
  label: string;
  shortLabel: string;
  definition: string;
}> = [
  {
    id: "brief",
    label: "Idea",
    shortLabel: "Idea",
    definition: "Tell AI what book you want and who it should help.",
  },
  {
    id: "chapters",
    label: "Make Chapters",
    shortLabel: "Chapters",
    definition: "AI makes the chapter list from your book idea.",
  },
  {
    id: "paragraphs",
    label: "Plan Paragraphs",
    shortLabel: "Plan",
    definition: "Edit the paragraph instructions AI will read. These are not printed.",
  },
  {
    id: "draft",
    label: "Write Book Text",
    shortLabel: "Write",
    definition: "AI writes or you edit the actual words readers will see.",
  },
  {
    id: "package",
    label: "Read + Check",
    shortLabel: "Read",
    definition: "Read and check the book before publishing.",
  },
  {
    id: "publish",
    label: "Publish",
    shortLabel: "Publish",
    definition: "Prepare the KDP upload plan while keeping final submit locked for you.",
  },
];

const VIEW_COPY: Record<BookWriterDashboardView, { eyebrow: string; title: string; body: string }> =
  {
    brief: {
      eyebrow: "Step 1",
      title: "Tell AI the book idea.",
      body: "Write what the book is about, who it is for, and what the reader should get. AI turns that into a simple book plan.",
    },
    chapters: {
      eyebrow: "Step 2",
      title: "AI made your chapter list.",
      body: "These are not book pages yet. They are the big sections AI will use to plan the paragraphs.",
    },
    paragraphs: {
      eyebrow: "Step 3",
      title: "Plan each paragraph.",
      body: "Plan for AI is the instruction layer. It guides AI, but it is never printed in the book.",
    },
    draft: {
      eyebrow: "Step 4",
      title: "Write or edit Book Text.",
      body: "Book Text is the actual writing readers will see. Let AI fill empty unlocked paragraphs, or type them yourself.",
    },
    package: {
      eyebrow: "Step 5",
      title: "Read the book and check quality.",
      body: "Build the readable manuscript, then check book files, cover, metadata, and publishing readiness.",
    },
    publish: {
      eyebrow: "Step 6",
      title: "Prepare publishing, then stop.",
      body: "AI shows the exact files and KDP steps. It does not click Amazon's final submit button.",
    },
  };

type TermKey =
  | "aiDisclosure"
  | "approvalGate"
  | "audience"
  | "bookPlan"
  | "browserActions"
  | "bulkActions"
  | "chapter"
  | "coverStrategy"
  | "customTone"
  | "draft"
  | "epub"
  | "finishedBooks"
  | "gaps"
  | "kdp"
  | "kdpSelect"
  | "lock"
  | "metadata"
  | "mode"
  | "nextMove"
  | "pageEstimate"
  | "paragraphCard"
  | "penName"
  | "profanity"
  | "publishDryRun"
  | "qualityFindings"
  | "quickRead"
  | "readerPromise"
  | "reviewPack"
  | "salesPage"
  | "stage"
  | "status"
  | "stylePreview"
  | "stitch"
  | "targetWords"
  | "tone"
  | "topic"
  | "trophyRoom"
  | "version";

const TERM_DEFINITIONS: Record<TermKey, { label: string; definition: string }> = {
  aiDisclosure: {
    label: "AI disclosure",
    definition:
      "The KDP statement that tells Amazon whether AI helped create the text, images, or translations.",
  },
  approvalGate: {
    label: "Approval gate",
    definition: "A hard stop that requires you to review and approve before AI can continue.",
  },
  audience: {
    label: "Audience",
    definition: "The specific reader group this book is written for.",
  },
  bookPlan: {
    label: "Book plan",
    definition:
      "The saved blueprint for the whole book: idea, chapters, paragraph plans, locks, Book Text, and publish status.",
  },
  browserActions: {
    label: "Browser actions",
    definition:
      "The ordered click, fill, upload, and pause steps AI prepares for the KDP browser flow.",
  },
  bulkActions: {
    label: "Batch helpers",
    definition:
      "Shortcuts that update many paragraphs at once, such as locking every paragraph you want to keep.",
  },
  chapter: {
    label: "Chapter",
    definition: "A major book section with a title, purpose, target length, and paragraphs.",
  },
  coverStrategy: {
    label: "Cover strategy",
    definition:
      "How the cover will be handled for KDP, usually direct upload when a valid TIFF/JPEG exists.",
  },
  customTone: {
    label: "Custom tone",
    definition:
      "Your own voice direction for AI, such as cozy, noir, sarcastic, academic, gentle, or high-energy.",
  },
  draft: {
    label: "Book Text",
    definition:
      "The actual words readers will see. You can let AI write them, then edit and lock what you like.",
  },
  epub: {
    label: "EPUB",
    definition: "The eBook file format uploaded to KDP for Kindle publishing.",
  },
  finishedBooks: {
    label: "Finished books",
    definition:
      "Books that left active writing. Published books become Trophy Room items; completed unpublished books stay separate.",
  },
  gaps: {
    label: "Gaps",
    definition:
      "Problems or unfinished items that must be fixed before the book should be trusted.",
  },
  kdp: {
    label: "KDP",
    definition:
      "Amazon Kindle Direct Publishing, the current first publishing destination for completed books.",
  },
  kdpSelect: {
    label: "KDP Select",
    definition:
      "Amazon's optional exclusivity program for Kindle eBooks. It can help Kindle Unlimited reach but limits where the eBook can be sold.",
  },
  lock: {
    label: "Lock",
    definition: "Locked text will not be changed by AI during later writing passes.",
  },
  metadata: {
    label: "Metadata",
    definition:
      "The sales-page information: title, subtitle, description, keywords, categories, price, and disclosure notes.",
  },
  mode: {
    label: "Mode",
    definition:
      "Simple keeps controls calm. Advanced shows more planning detail for deeper control.",
  },
  nextMove: {
    label: "Recommended next move",
    definition:
      "The safest useful action for the current book state, based on what is written, checked, and publish-ready.",
  },
  pageEstimate: {
    label: "Page estimate",
    definition:
      "A rough 6x9 paperback range based on 250-300 words per page. Final page count changes with trim, font, and layout.",
  },
  paragraphCard: {
    label: "Paragraph plan",
    definition:
      "One paragraph's Plan for AI plus its Book Text. This is how you control the book paragraph by paragraph.",
  },
  penName: {
    label: "Pen name",
    definition:
      "The author name attached to a book. Reuse it for similar books so readers know what kind of promise to expect.",
  },
  profanity: {
    label: "Profanity level",
    definition:
      "The amount of category-relative profanity AI may use, from clean to extreme. Locked text is still protected.",
  },
  publishDryRun: {
    label: "Publish dry-run",
    definition:
      "A safe publishing rehearsal that creates upload steps and stops before final KDP submission.",
  },
  qualityFindings: {
    label: "Quality findings",
    definition:
      "Automated checks that point out readiness, word-count, packaging, and publishing problems.",
  },
  quickRead: {
    label: "Quick Read",
    definition:
      "A shorter derived edition of the full book for readers who want the condensed version.",
  },
  readerPromise: {
    label: "Reader promise",
    definition: "The useful result or experience the reader should get by the end of the book.",
  },
  reviewPack: {
    label: "Quality package",
    definition:
      "The checked book package: manuscript, EPUB, print file, cover, metadata, gate reports, and publish preview.",
  },
  salesPage: {
    label: "Sales page preview",
    definition:
      "The title, subtitle, description, keywords, categories, price, and disclosure text readers or Amazon will see.",
  },
  stage: {
    label: "Stage",
    definition:
      "One part of the book workflow. Each stage shows whether it is done, current, or waiting on earlier work.",
  },
  status: {
    label: "Status",
    definition:
      "The current state of a chapter, paragraph, quality check, or publish step, such as planned, written, approved, or blocked.",
  },
  stylePreview: {
    label: "Style preview",
    definition:
      "A short sample that shows how the current length, tone, and profanity controls will guide AI. It is not saved as Book Text.",
  },
  stitch: {
    label: "Build readable book",
    definition: "Combines all Book Text into one continuous manuscript file.",
  },
  targetWords: {
    label: "Target words",
    definition:
      "The desired manuscript length. Approval requires at least 90% of this target plus the absolute minimum.",
  },
  tone: {
    label: "Tone",
    definition:
      "The book's voice, such as professional, technical, humorous, dramatic, or conversational.",
  },
  topic: {
    label: "Topic",
    definition:
      "Your plain-English description of what the book is about and what it should accomplish.",
  },
  trophyRoom: {
    label: "Trophy room",
    definition:
      "The finished-book shelf. It shows the cover used for publishing and keeps completed books out of active writing work.",
  },
  version: {
    label: "Version",
    definition:
      "The saved plan revision number. It prevents two browser tabs from silently overwriting each other.",
  },
};

const VIEW_COACH: Record<
  BookWriterDashboardView,
  { plain: string; control: string; next: string }
> = {
  brief: {
    plain: "This is the book idea. AI uses it to make the chapter list.",
    control: "Edit the title, topic, reader promise, audience, and target length.",
    next: "When the idea is right, make or review chapters.",
  },
  chapters: {
    plain: "This is the chapter list AI made from your idea. It is an outline, not book text.",
    control: "Rename chapters, rewrite what each chapter covers, and lock keepers.",
    next: "When the chapter list is right, make the paragraph plan.",
  },
  paragraphs: {
    plain: "This is the instruction layer. It tells AI what to write, but readers never see it.",
    control: "Edit Plan for AI until every paragraph has a clear job. Then move to Write.",
    next: "Next, go to Write and let AI create the actual Book Text.",
  },
  draft: {
    plain: "This is the reader-facing writing layer. These words go into the final book.",
    control: "Click AI write Book Text, edit the result, and lock anything you want to keep.",
    next: "When every paragraph has Book Text, build the readable book and check it.",
  },
  package: {
    plain: "This is the quality check before publishing.",
    control: "Review book files, findings, and fixes before publish prep.",
    next: "If quality passes, move to Publish.",
  },
  publish: {
    plain: "This is the KDP handoff. It prepares files and steps; it does not final-submit.",
    control: "Review metadata, exact upload files, cover route, AI disclosure, and approval locks.",
    next: "Open KDP only when the dry-run status is ready, then stop before final submit.",
  },
};

const GLOSSARY_TERMS: TermKey[] = [
  "bookPlan",
  "readerPromise",
  "targetWords",
  "pageEstimate",
  "tone",
  "customTone",
  "stylePreview",
  "profanity",
  "paragraphCard",
  "lock",
  "qualityFindings",
  "status",
  "metadata",
  "browserActions",
  "kdp",
  "publishDryRun",
  "approvalGate",
  "trophyRoom",
  "finishedBooks",
];

const KDP_BOOKSHELF_URL = "https://kdp.amazon.com/en_US/bookshelf";
const DEFAULT_BOOK_WRITER_TARGET_WORDS = 12000;

const TONE_OPTIONS: Array<{
  value: BookWriterTonePreset;
  label: string;
  description: string;
}> = [
  {
    value: "professional",
    label: "Professional",
    description: "Polished, practical, and clear.",
  },
  {
    value: "technical",
    label: "Technical",
    description: "Precise, structured, and evidence-minded.",
  },
  {
    value: "conversational",
    label: "Conversational",
    description: "Warm, plainspoken, and easy to follow.",
  },
  { value: "humorous", label: "Humorous", description: "Lightly witty without losing clarity." },
  { value: "dramatic", label: "Dramatic", description: "Tense, cinematic, and emotional." },
  { value: "literary", label: "Literary", description: "Textured, observant, and image-rich." },
  {
    value: "inspirational",
    label: "Inspirational",
    description: "Grounded, encouraging, and hopeful.",
  },
  { value: "direct", label: "Direct", description: "Lean, blunt, and momentum-focused." },
  { value: "custom", label: "Custom", description: "Use your own exact voice direction." },
];

const PROFANITY_OPTIONS: Array<{
  value: BookWriterProfanityLevel;
  label: string;
  description: string;
}> = [
  {
    value: "none",
    label: "Off",
    description: "No profanity; clean language for the category.",
  },
  {
    value: "mild",
    label: "Mild",
    description: "Rare light profanity when it fits.",
  },
  {
    value: "moderate",
    label: "Moderate",
    description: "Category-normal rough language.",
  },
  {
    value: "high",
    label: "Strong",
    description: "Blunt language above category average.",
  },
  {
    value: "extreme",
    label: "Extreme",
    description: "Frequent explicit language for the category.",
  },
];

const STORY_THREAD_OPTIONS: Array<{ value: BookWriterChapterRole["storyThread"]; label: string }> =
  [
    { value: "main-story", label: "Main story" },
    { value: "side-story", label: "Side story" },
    { value: "converging-stories", label: "Converging stories" },
    { value: "flashback", label: "Flashback" },
    { value: "interlude", label: "Interlude" },
    { value: "abrupt-shift", label: "Abrupt change" },
    { value: "resolution", label: "Resolution" },
    { value: "custom", label: "Custom" },
  ];

const PLOT_JOB_OPTIONS: Array<{ value: BookWriterChapterRole["plotJob"]; label: string }> = [
  { value: "setup", label: "Setup" },
  { value: "conflict", label: "Conflict" },
  { value: "clue", label: "Clue" },
  { value: "red-herring", label: "Red herring" },
  { value: "twist", label: "Plot twist" },
  { value: "reveal", label: "Reveal" },
  { value: "payoff", label: "Payoff" },
  { value: "mystery-deepens", label: "Mystery deepens" },
  { value: "custom", label: "Custom" },
];

const READER_FEELING_OPTIONS: Array<{
  value: BookWriterChapterRole["readerFeeling"];
  label: string;
}> = [
  { value: "calm", label: "Calm" },
  { value: "funny", label: "Funny" },
  { value: "suspenseful", label: "Suspenseful" },
  { value: "dramatic", label: "Dramatic" },
  { value: "warm", label: "Warm" },
  { value: "dark", label: "Dark" },
  { value: "hopeful", label: "Hopeful" },
  { value: "fast-paced", label: "Fast-paced" },
  { value: "custom", label: "Custom" },
];

let draggedChapterId: string | null = null;
let draggedParagraph: { chapterId: string; paragraphId: string } | null = null;
let trophyRoomScrollCompactionInstalled = false;

function installTrophyRoomScrollCompaction(): void {
  if (
    trophyRoomScrollCompactionInstalled ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return;
  }
  trophyRoomScrollCompactionInstalled = true;
  const requestFrame =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
  let ticking = false;
  const scrollOffset = () => {
    const room = document.querySelector<HTMLElement>(".book-writer-trophy-room--top");
    const contentScroller =
      room?.closest<HTMLElement>(".content") ?? document.querySelector<HTMLElement>(".content");
    if (contentScroller && contentScroller.scrollHeight > contentScroller.clientHeight + 8) {
      return contentScroller.scrollTop;
    }
    let current = room?.parentElement ?? null;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (
        current.scrollHeight > current.clientHeight + 8 &&
        /(auto|scroll|overlay)/.test(style.overflowY)
      ) {
        return current.scrollTop;
      }
      current = current.parentElement;
    }
    return document.scrollingElement?.scrollTop ?? window.scrollY;
  };
  const update = () => {
    ticking = false;
    const offset = scrollOffset();
    const progress = Math.max(0, Math.min(1, offset / 180));
    document.documentElement.style.setProperty("--book-writer-trophy-scroll", progress.toFixed(3));
    document.documentElement.classList.toggle("book-writer-trophy-scroll-compact", offset > 48);
    document.documentElement.classList.toggle("book-writer-trophy-scroll-away", offset > 420);
  };
  const scheduleUpdate = () => {
    if (ticking) {
      return;
    }
    ticking = true;
    requestFrame(update);
  };
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  document.addEventListener("scroll", scheduleUpdate, { capture: true, passive: true });
  document
    .querySelector<HTMLElement>(".content")
    ?.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.setInterval(scheduleUpdate, 150);
  scheduleUpdate();
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleTimeString() : "not loaded";
}

function statusLabel(value: string): string {
  const friendly: Record<string, string> = {
    "full-draft": "Building editable draft",
    "full-draft-chapters": "Making chapters",
    "full-draft-paragraphs": "Planning paragraphs",
    "full-draft-text": "Writing Book Text",
    "full-draft-preview": "Building preview",
    "cover-local-ai": "Generating local AI cover",
    "cover-concept": "Creating cover concept",
    "cover-generate": "Creating cover concept",
    "generating-draft": "Writing",
    "paragraph-plan": "Paragraphs planned",
    "publish-ready": "Ready to publish",
    drafted: "Text ready",
    packaged: "Checked",
    stitching: "Building readable book",
    stitched: "Readable book built",
  };
  const mapped = friendly[value];
  if (mapped) {
    return mapped;
  }
  return value
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

const MIN_BOOK_WRITER_TARGET_WORDS = 250;
const BOOK_WRITER_TARGET_WORDS_STEP = 250;

function normalizeTargetWordsInput(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_BOOK_WRITER_TARGET_WORDS;
  }
  return Math.max(MIN_BOOK_WRITER_TARGET_WORDS, Math.floor(value));
}

function estimateLength(targetWords: number): {
  printMin: number;
  printMax: number;
  readingMinutes: number;
  chapterCount: number;
  paragraphCount: number;
} {
  const words = normalizeTargetWordsInput(targetWords);
  const chapterCount =
    words <= 1200
      ? 1
      : words <= 3000
        ? 3
        : words <= 9000
          ? 6
          : words <= 18000
            ? 8
            : words <= 40000
              ? 10
              : 12;
  const chapterTarget = Math.max(1, Math.floor(words / chapterCount));
  const paragraphsPerChapter =
    chapterTarget <= 300 ? 1 : chapterTarget <= 900 ? 4 : chapterTarget <= 1800 ? 5 : 6;
  return {
    printMin: Math.max(1, Math.ceil(words / 300)),
    printMax: Math.max(1, Math.ceil(words / 250)),
    readingMinutes: Math.max(1, Math.ceil(words / 250)),
    chapterCount,
    paragraphCount: chapterCount * paragraphsPerChapter,
  };
}

function renderLengthEstimate(targetWords: number): TemplateResult {
  const estimate = estimateLength(targetWords);
  return html`
    <div class="book-writer-length-estimate" aria-label="Book length estimate">
      <b>${normalizeTargetWordsInput(targetWords).toLocaleString()} words</b>
      <span>
        ≈ ${estimate.printMin}-${estimate.printMax} paperback pages · ${estimate.readingMinutes} min
        read · ${estimate.chapterCount} chapters · about ${estimate.paragraphCount} paragraph cards
      </span>
      <small>${TERM_DEFINITIONS.pageEstimate.definition}</small>
    </div>
  `;
}

const WORD_COUNT_PRESETS = [
  { label: "Flash", detail: "250", value: 250 },
  { label: "Short Story", detail: "1.2k", value: 1200 },
  { label: "Quick Read", detail: "6k", value: 6000 },
  { label: "Novella", detail: "45k", value: 45000 },
  { label: "Novel", detail: "70k", value: 70000 },
] as const;

function renderLengthPresets(targetWords: number, onChoose: (value: number) => void) {
  return html`
    <div class="book-writer-length-presets" aria-label="Length presets">
      ${WORD_COUNT_PRESETS.map(
        (preset) => html`
          <button
            type="button"
            class=${normalizeTargetWordsInput(targetWords) === preset.value
              ? "book-writer-chip book-writer-chip--active"
              : "book-writer-chip"}
            title=${`${preset.label}: ${preset.value.toLocaleString()} words`}
            @click=${() => onChoose(preset.value)}
          >
            ${preset.label} <small>${preset.detail}</small>
          </button>
        `,
      )}
    </div>
  `;
}

function renderTargetRebalanceAction(params: {
  plan: BookWriterPlan;
  targetWords: number;
  onSavePlan: (plan: BookWriterPlan) => void;
  onRequestAiAction?: (action: BookWriterAiAction) => void;
}) {
  const desiredChapters = desiredChapterCountForTargetWords(params.targetWords);
  if (params.plan.chapters.length === desiredChapters) {
    return nothing;
  }
  const lockedCount = params.plan.chapters
    .flatMap((chapter) => chapter.paragraphs)
    .filter((paragraph) => paragraph.locked || paragraph.fieldLocks?.text).length;
  return html`
    <div class="book-writer-rebalance-callout" data-book-writer-rebalance-callout>
      <b>Structure mismatch</b>
      <span>
        This target fits ${desiredChapters} chapter${desiredChapters === 1 ? "" : "s"}, but this
        draft has ${params.plan.chapters.length}.
      </span>
      <small>
        Condense the chapter/paragraph plan so the actual book matches the new length.
        ${lockedCount ? `${lockedCount} locked paragraph(s) will be preserved.` : ""}
      </small>
      <button
        type="button"
        class="book-writer-guided-primary book-writer-guided-primary--small"
        data-book-writer-rebalance
        @click=${() =>
          params.onRequestAiAction
            ? params.onRequestAiAction("rebalance")
            : params.onSavePlan(condensePlanToTargetWords(params.plan, params.targetWords))}
      >
        Rebalance structure to ${params.targetWords.toLocaleString()} words
      </button>
    </div>
  `;
}

function normalizeCustomToneInput(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function toneDescriptionFor(value: BookWriterTonePreset, customTone = ""): string {
  const normalizedCustomTone = normalizeCustomToneInput(customTone);
  if (value === "custom" && normalizedCustomTone) {
    return normalizedCustomTone;
  }
  return TONE_OPTIONS.find((option) => option.value === value)?.description ?? "Custom tone.";
}

function profanityDescriptionFor(value: BookWriterProfanityLevel): string {
  return PROFANITY_OPTIONS.find((option) => option.value === value)?.description ?? "Clean.";
}

function planTonePreset(plan: BookWriterPlan): BookWriterTonePreset {
  if (plan.styleGuide?.tonePreset) {
    return plan.styleGuide.tonePreset;
  }
  const tone = plan.brief.tone.toLowerCase();
  if (/tense|cinematic|dramatic|emotional/.test(tone)) {
    return "dramatic";
  }
  if (/technical|precise|structured|evidence/.test(tone)) {
    return "technical";
  }
  if (/conversation|warm|plainspoken|friendly/.test(tone)) {
    return "conversational";
  }
  if (/humor|funny|witty|comedic/.test(tone)) {
    return "humorous";
  }
  if (/literary|textured|observant|image-rich/.test(tone)) {
    return "literary";
  }
  if (/inspir|encourag|hopeful/.test(tone)) {
    return "inspirational";
  }
  if (/direct|lean|blunt|momentum/.test(tone)) {
    return "direct";
  }
  return "professional";
}

function customToneForPlan(plan: BookWriterPlan): string {
  return plan.styleGuide?.tonePreset === "custom" ? (plan.styleGuide.toneDescription ?? "") : "";
}

function planProfanityLevel(plan: BookWriterPlan): BookWriterProfanityLevel {
  return plan.styleGuide?.profanityLevel ?? "none";
}

function withTargetWords(plan: BookWriterPlan, rawTargetWords: number): BookWriterPlan {
  const targetWords = normalizeTargetWordsInput(rawTargetWords);
  const chapterTarget = Math.max(
    MIN_BOOK_WRITER_TARGET_WORDS,
    Math.floor(targetWords / Math.max(1, plan.chapters.length)),
  );
  return {
    ...plan,
    targetWords,
    chapters: plan.chapters.map((chapter) => {
      const paragraphTarget = Math.max(
        40,
        Math.floor(chapterTarget / Math.max(1, chapter.paragraphs.length)),
      );
      return {
        ...chapter,
        targetWords: chapterTarget,
        paragraphs: chapter.paragraphs.map((paragraph) => ({
          ...paragraph,
          targetWords: paragraphTarget,
        })),
      };
    }),
  };
}

function desiredChapterCountForTargetWords(targetWords: number): number {
  const words = normalizeTargetWordsInput(targetWords);
  if (words <= 1200) {
    return 1;
  }
  if (words <= 3000) {
    return 3;
  }
  if (words <= 9000) {
    return 6;
  }
  if (words <= 18000) {
    return 8;
  }
  if (words <= 40000) {
    return 10;
  }
  return 12;
}

function desiredParagraphCountForChapterTarget(targetWords: number): number {
  if (targetWords <= 300) {
    return 1;
  }
  if (targetWords <= 900) {
    return 4;
  }
  if (targetWords <= 1800) {
    return 5;
  }
  return 6;
}

function condensePlanToTargetWords(plan: BookWriterPlan, rawTargetWords: number): BookWriterPlan {
  const targetWords = normalizeTargetWordsInput(rawTargetWords);
  const chapterCount = Math.max(1, desiredChapterCountForTargetWords(targetWords));
  const chapterTarget = Math.max(1, Math.floor(targetWords / chapterCount));
  const paragraphCount = desiredParagraphCountForChapterTarget(chapterTarget);
  const paragraphTarget = Math.max(40, Math.floor(chapterTarget / paragraphCount));
  const allParagraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const lockedParagraphs = allParagraphs.filter(
    (paragraph) => paragraph.locked || paragraph.fieldLocks?.text,
  );
  const sourceSummary = allParagraphs
    .map((paragraph) => paragraph.text || paragraph.summary || paragraph.purpose || paragraph.title)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 360);

  const chapters = Array.from({ length: chapterCount }, (_item, chapterIndex) => {
    const existing = plan.chapters[chapterIndex] ?? plan.chapters.at(-1) ?? plan.chapters[0];
    const isOnlyChapter = chapterCount === 1;
    const title = isOnlyChapter ? plan.title : (existing?.title ?? `Chapter ${chapterIndex + 1}`);
    const preservedLockedParagraphs =
      chapterIndex === 0 ? lockedParagraphs.slice(0, Math.max(0, paragraphCount - 1)) : [];
    const generatedCount = Math.max(1, paragraphCount - preservedLockedParagraphs.length);
    const generatedParagraphs = Array.from(
      { length: generatedCount },
      (_paragraph, paragraphIndex) => {
        const order = paragraphIndex + 1;
        const id = `${existing?.id ?? plan.runId}-condensed-${chapterIndex + 1}-${order}`;
        return {
          id,
          order,
          title: paragraphCount === 1 ? "Complete Short Story" : `Condensed Beat ${order}`,
          summary:
            paragraphCount === 1
              ? `Condense the book into a complete ${targetWords}-word story with setup, turn, and payoff.`
              : `Condense the original book into beat ${order} of chapter ${chapterIndex + 1}.`,
          purpose:
            paragraphCount === 1
              ? `Write one complete reader-facing short story based on: ${sourceSummary || plan.brief.topicParagraph}`
              : `Carry the condensed story forward while preserving the main premise and reader promise.`,
          beats: [
            "Use only reader-facing prose.",
            "Preserve the main premise and any locked facts.",
            "Make the shorter structure feel intentional, not truncated.",
          ],
          styleDirection: "Short-form structure: compress setup, conflict, turn, and payoff.",
          fieldLocks: {
            title: false,
            summary: false,
            purpose: false,
            styleDirection: false,
            text: false,
          },
          targetWords: paragraphTarget,
          text: "",
          locked: false,
          status: "planned" as const,
          sourceParagraphIds: allParagraphs.map((paragraph) => paragraph.id),
        };
      },
    );
    const paragraphs = [...generatedParagraphs, ...preservedLockedParagraphs].map(
      (paragraph, paragraphIndex) =>
        Object.assign({}, paragraph, {
          order: paragraphIndex + 1,
          targetWords:
            paragraph.locked || paragraph.fieldLocks?.text
              ? paragraph.targetWords
              : paragraphTarget,
        }),
    );
    return {
      ...(existing ?? plan.chapters[0]),
      id: existing?.id ?? `${plan.runId}-condensed-${chapterIndex + 1}`,
      number: chapterIndex + 1,
      title,
      description: isOnlyChapter
        ? `A complete ${targetWords}-word short story version of the current book.`
        : `Condensed chapter ${chapterIndex + 1} for the new ${targetWords}-word target.`,
      targetWords: chapterTarget,
      locked: false,
      status: "planned" as const,
      paragraphs,
    };
  });

  return {
    ...plan,
    targetWords,
    status: "paragraph-plan",
    chapters,
    bookSync: {
      state: "needs-propagation",
      lastAnalyzedVersion: plan.version,
      lastSyncedVersion: plan.bookSync?.lastSyncedVersion,
      affectedChapterIds: chapters.map((chapter) => chapter.id),
      affectedParagraphIds: chapters.flatMap((chapter) =>
        chapter.paragraphs.map((paragraph) => paragraph.id),
      ),
      lockedConflictCount: lockedParagraphs.length,
      summary: `Target changed to ${targetWords.toLocaleString()} words; condensed structure needs refreshed Book Text.`,
    },
  };
}

function withTone(plan: BookWriterPlan, tonePreset: BookWriterTonePreset): BookWriterPlan {
  const customTone = tonePreset === "custom" ? customToneForPlan(plan) : "";
  const toneDescription =
    tonePreset === "custom"
      ? toneDescriptionFor("custom", customTone)
      : `${TONE_OPTIONS.find((item) => item.value === tonePreset)?.label ?? "Tone"}: ${toneDescriptionFor(tonePreset)}`;
  return {
    ...plan,
    brief: { ...plan.brief, tone: toneDescription },
    styleGuide: {
      tonePreset,
      toneDescription,
      profanityLevel: planProfanityLevel(plan),
      profanityDescription:
        plan.styleGuide?.profanityDescription ?? profanityDescriptionFor(planProfanityLevel(plan)),
    },
  };
}

function withCustomTone(plan: BookWriterPlan, rawCustomTone: string): BookWriterPlan {
  const customTone = normalizeCustomToneInput(rawCustomTone);
  const toneDescription = toneDescriptionFor("custom", customTone);
  return {
    ...plan,
    brief: { ...plan.brief, tone: toneDescription },
    styleGuide: {
      tonePreset: "custom",
      toneDescription,
      profanityLevel: planProfanityLevel(plan),
      profanityDescription:
        plan.styleGuide?.profanityDescription ?? profanityDescriptionFor(planProfanityLevel(plan)),
    },
  };
}

function withProfanity(
  plan: BookWriterPlan,
  profanityLevel: BookWriterProfanityLevel,
): BookWriterPlan {
  return {
    ...plan,
    styleGuide: {
      tonePreset: planTonePreset(plan),
      toneDescription: plan.styleGuide?.toneDescription ?? plan.brief.tone,
      profanityLevel,
      profanityDescription: profanityDescriptionFor(profanityLevel),
    },
    brief: {
      ...plan.brief,
      constraints: [
        ...plan.brief.constraints.filter((constraint) => !/profanity/i.test(constraint)),
        `Profanity level: ${PROFANITY_OPTIONS.find((option) => option.value === profanityLevel)?.label ?? profanityLevel}. ${profanityDescriptionFor(profanityLevel)}`,
      ],
    },
  };
}

function toneLabelFor(value: BookWriterTonePreset): string {
  return TONE_OPTIONS.find((option) => option.value === value)?.label ?? "Custom";
}

function previewTopic(topic: string): string {
  const normalized = topic.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "the book idea you enter";
  }
  return normalized.length > 92 ? `${normalized.slice(0, 89).trimEnd()}...` : normalized;
}

function previewLanguageControl(level: BookWriterProfanityLevel): string {
  switch (level) {
    case "none":
      return "Clean language. The quality gate will flag possible profanity before publishing.";
    case "mild":
      return "Rare light profanity is allowed only when the category and moment justify it.";
    case "moderate":
      return "Category-normal rough language is allowed, but it should never become filler.";
    case "high":
      return "Blunt language can appear above category average when it strengthens voice or pressure.";
    case "extreme":
      return "Frequent explicit language is allowed for the category, audience, and scene pressure.";
    default:
      return "Clean language. The quality gate will flag possible profanity before publishing.";
  }
}

function stylePreviewParagraph(params: {
  topic: string;
  tonePreset: BookWriterTonePreset;
  customTone: string;
}): string {
  const topic = previewTopic(params.topic);
  const customTone = normalizeCustomToneInput(params.customTone);
  switch (params.tonePreset) {
    case "technical":
      return `The core problem in ${topic} becomes manageable when the reader can see the system: the variables, the failure points, and the next repeatable decision. The book should define each step clearly, show why it matters, and leave no practical term floating without context.`;
    case "conversational":
      return `Here is the useful thing about ${topic}: the reader does not need a perfect plan before they begin. They need one clear next move, a reason it matters, and enough confidence to keep going when the first version feels messy.`;
    case "humorous":
      return `A book about ${topic} should not sound like it was assembled by a committee wearing identical beige cardigans. It can be useful, sharp, and human at the same time: a friendly nudge, a practical map, and just enough wit to keep the pages turning.`;
    case "dramatic":
      return `The pressure inside ${topic} starts quietly, then tightens. Every choice reveals what the reader stands to lose if they drift, delay, or pretend the problem is smaller than it is. The chapter should move with urgency toward a decision that cannot be avoided.`;
    case "literary":
      return `The subject of ${topic} should arrive through texture: a room, a gesture, a small object carrying more weight than it first admits. The prose can linger long enough for meaning to gather, then turn the image into insight the reader can carry forward.`;
    case "inspirational":
      return `The promise of ${topic} is not perfection; it is momentum. The reader should feel guided toward a steadier version of themselves, with practical steps that make hope feel earned rather than decorative.`;
    case "direct":
      return `The book should make ${topic} useful fast. Name the problem, cut the clutter, show the next move, and do not hide the practical takeaway behind throat-clearing. Every paragraph should earn its place.`;
    case "custom":
      return customTone
        ? `Custom voice direction: ${customTone}. A sample paragraph about ${topic} should follow that instruction while still giving the reader a concrete point, a clear movement, and final Book Text that sounds publish-ready.`
        : `Choose Custom, then describe the voice in plain English. For ${topic}, you might ask for "warm but skeptical," "cozy mystery with dry wit," or "academic but readable" and the preview will follow that direction.`;
    case "professional":
      return `A strong opening for ${topic} should sound calm, useful, and trustworthy. It gives the reader a clear promise, names the practical stakes, and moves from idea to action without padding or melodrama.`;
    default:
      return `A strong opening for ${topic} should sound calm, useful, and trustworthy. It gives the reader a clear promise, names the practical stakes, and moves from idea to action without padding or melodrama.`;
  }
}

function renderStylePreview(params: {
  topic: string;
  targetWords: number;
  tonePreset: BookWriterTonePreset;
  customTone: string;
  profanityLevel: BookWriterProfanityLevel;
}): TemplateResult {
  const estimate = estimateLength(params.targetWords);
  const toneLabel = toneLabelFor(params.tonePreset);
  const customTone = normalizeCustomToneInput(params.customTone);
  return html`
    <section class="book-writer-style-preview" aria-label="Style preview">
      <div>
        <p class="book-writer-eyebrow">${renderLabel("Style Preview", "stylePreview")}</p>
        <b>How AI will try to sound</b>
        <span>
          ${normalizeTargetWordsInput(params.targetWords).toLocaleString()} words ·
          ${estimate.printMin}-${estimate.printMax} estimated paperback pages · ${toneLabel} tone
          ${params.tonePreset === "custom" && customTone ? html` · custom voice` : nothing}
        </span>
      </div>
      <blockquote>${stylePreviewParagraph(params)}</blockquote>
      <small>
        Language control: ${previewLanguageControl(params.profanityLevel)} This preview is not saved
        as Book Text and is not published.
      </small>
    </section>
  `;
}

function looksLikeInstructionalPreviewText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const markers = [
    "chapter focus:",
    "ai will",
    "ai should",
    "the book is about",
    "a useful book on",
    "the paragraph should",
    "this paragraph should",
    "this chapter should",
    "this book should",
    "this paragraph says",
    "plan for ai",
    "ai reads this",
    "the work in",
    "in this part of",
    "the reader should see why",
    "has to begin",
    "becomes practical when",
    "becomes useful when",
    "the voice stayed",
    "the routine should",
    "points toward the later reveal",
    "without naming it outright",
    "the reveal lands as a turning point",
    "earlier evidence should be read",
    "the scene now carries the consequence",
    "so the book does not reset afterward",
  ];
  return (
    markers.some((marker) => normalized.includes(marker)) ||
    /\bthe reader (?:can|will|should|must|needs to|has to)\b/.test(normalized) ||
    /\bthis (?:paragraph|chapter|section|book) (?:will|would|should|must|needs to|has to)\b/.test(
      normalized,
    ) ||
    /\b(?:small|subtle) detail (?:now )?points? toward\b/.test(normalized) ||
    /\bforeshadow(?:ing)?\b.*\bwithout naming\b/.test(normalized)
  );
}

function fileName(value: string | undefined): string {
  if (!value) {
    return "Cover planned";
  }
  return value.split(/[\\/]/).findLast((part) => Boolean(part)) ?? value;
}

function dollars(value: number | undefined): string {
  return `$${(Number(value) || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function coverInitials(title: string): string {
  const words = title
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  return (words[0]?.[0] ?? "B") + (words[1]?.[0] ?? "");
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function reorderByDrop<T extends { id: string }>(
  items: T[],
  sourceId: string,
  targetId: string,
): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  return moveItem(items, sourceIndex, targetIndex);
}

function updateChapter(
  plan: BookWriterPlan,
  chapterId: string,
  updater: (chapter: BookWriterChapter) => BookWriterChapter,
): BookWriterPlan {
  return {
    ...plan,
    chapters: plan.chapters.map((chapter) =>
      chapter.id === chapterId ? updater(chapter) : chapter,
    ),
  };
}

function updateParagraph(
  plan: BookWriterPlan,
  chapterId: string,
  paragraphId: string,
  updater: (paragraph: BookWriterParagraph) => BookWriterParagraph,
): BookWriterPlan {
  return updateChapter(plan, chapterId, (chapter) => ({
    ...chapter,
    paragraphs: chapter.paragraphs.map((paragraph) =>
      paragraph.id === paragraphId ? updater(paragraph) : paragraph,
    ),
  }));
}

function updateParagraphFieldLock(
  plan: BookWriterPlan,
  chapterId: string,
  paragraphId: string,
  field: keyof NonNullable<BookWriterParagraph["fieldLocks"]>,
  locked: boolean,
): BookWriterPlan {
  return updateParagraph(plan, chapterId, paragraphId, (paragraph) => ({
    ...paragraph,
    fieldLocks: {
      ...paragraph.fieldLocks,
      [field]: locked,
    },
  }));
}

function updateChapterFieldLock(
  plan: BookWriterPlan,
  chapterId: string,
  field: keyof NonNullable<BookWriterChapter["fieldLocks"]>,
  locked: boolean,
): BookWriterPlan {
  return updateChapter(plan, chapterId, (chapter) => ({
    ...chapter,
    fieldLocks: {
      ...chapter.fieldLocks,
      [field]: locked,
    },
  }));
}

function updateAllParagraphs(
  plan: BookWriterPlan,
  updater: (paragraph: BookWriterParagraph) => BookWriterParagraph,
): BookWriterPlan {
  return {
    ...plan,
    chapters: plan.chapters.map((chapter) => ({
      ...chapter,
      paragraphs: chapter.paragraphs.map(updater),
    })),
  };
}

function reflowChaptersFromIdea(plan: BookWriterPlan): BookWriterPlan {
  const idea = previewTopic(plan.brief.topicParagraph || plan.topic);
  const promise = previewTopic(plan.brief.readerPromise);
  return {
    ...plan,
    chapters: plan.chapters.map((chapter) =>
      chapter.locked
        ? chapter
        : {
            ...chapter,
            description: `This chapter connects "${chapter.title}" to ${idea}, keeps the reader promise visible (${promise}), and prepares the next part of the book without losing continuity.`,
          },
    ),
  };
}

function reflowParagraphsFromChapter(plan: BookWriterPlan, chapterId: string): BookWriterPlan {
  return updateChapter(plan, chapterId, (chapter) => ({
    ...chapter,
    paragraphs: chapter.paragraphs.map((paragraph, index) =>
      paragraph.locked
        ? paragraph
        : {
            ...paragraph,
            summary: `This paragraph says how ${chapter.description.toLowerCase()} through beat ${index + 1}, then connects smoothly to the next paragraph.`,
            purpose: `Turn "${chapter.title}" into reader-facing prose by making one clear move from the chapter plan without sounding like instructions.`,
          },
    ),
  }));
}

function filterMatches(query: string, ...values: string[]): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return values.some((value) => value.toLowerCase().includes(normalized));
}

function summarizePlan(snapshot: BookWriterDashboardSnapshot | null, plan: BookWriterPlan) {
  const computedParagraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const computedDraftedParagraphs = computedParagraphs.filter((paragraph) =>
    paragraph.text.trim(),
  ).length;
  const computedDraftedWords = computedParagraphs.reduce(
    (total, paragraph) => total + wordCount(paragraph.text),
    0,
  );
  const counts = snapshot?.planQuality?.counts;
  const paragraphCount = counts?.paragraphs ?? computedParagraphs.length;
  const draftedParagraphs = counts?.draftedParagraphs ?? computedDraftedParagraphs;
  const draftedWords = counts?.draftedWords ?? computedDraftedWords;
  const lockedParagraphs =
    counts?.lockedParagraphs ?? computedParagraphs.filter((paragraph) => paragraph.locked).length;
  const progress = paragraphCount > 0 ? Math.round((draftedParagraphs / paragraphCount) * 100) : 0;

  return {
    chapterCount: counts?.chapters ?? plan.chapters.length,
    paragraphCount,
    draftedParagraphs,
    draftedWords,
    lockedParagraphs,
    progress,
  };
}

function missingBookTextCount(plan: BookWriterPlan): number {
  return plan.chapters
    .flatMap((chapter) => chapter.paragraphs)
    .filter((paragraph) => !paragraph.text.trim() || looksLikeInstructionalBookText(paragraph.text))
    .length;
}

function missingParagraphPlanCount(plan: BookWriterPlan): number {
  return plan.chapters
    .flatMap((chapter) => chapter.paragraphs)
    .filter(
      (paragraph) =>
        !paragraph.locked &&
        !paragraph.title.trim() &&
        !paragraph.purpose.trim() &&
        !(paragraph.summary ?? "").trim(),
    ).length;
}

type BookWriterGuidedNextAction = {
  label: string;
  shortHelp: string;
  targetView?: BookWriterDashboardView;
  action?: BookWriterAiAction;
  href?: string;
  disabledReason?: string;
  tone?: "primary" | "safe" | "warn";
  onClick?: () => void;
};

type WorkflowStep = {
  id: string;
  view: BookWriterDashboardView;
  label: string;
  state: "done" | "current" | "waiting";
  summary: string;
  action: string;
};

function workflowStepsFor(props: BookWriterDashboardProps, plan: BookWriterPlan): WorkflowStep[] {
  const summary = summarizePlan(props.snapshot, plan);
  const paragraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const ideaDone = Boolean(
    plan.brief.topicParagraph.trim() &&
    plan.brief.readerPromise.trim() &&
    plan.brief.audience.trim(),
  );
  const chaptersDone =
    plan.chapters.length > 0 &&
    plan.chapters.every((chapter) => chapter.title.trim() && chapter.description.trim());
  const paragraphsPlanned =
    paragraphs.length > 0 &&
    paragraphs.every((paragraph) => paragraph.title.trim() && paragraph.purpose.trim());
  const draftDone =
    summary.paragraphCount > 0 && summary.draftedParagraphs >= summary.paragraphCount;
  const manuscriptDone = ["stitched", "packaged", "publish-ready"].includes(plan.status);
  const packageDone = Boolean(props.snapshot?.reviewPack);
  const publishPrepDone = Boolean(props.snapshot?.publishDryRun);

  const rawSteps = [
    {
      id: "idea",
      view: "brief" as const,
      label: "Idea",
      done: ideaDone,
      summary: ideaDone
        ? "Topic, reader, and promise are filled in."
        : "Topic, reader promise, or audience still needs plain-English detail.",
      action: "Tell AI what the book should do for readers.",
    },
    {
      id: "chapters",
      view: "chapters" as const,
      label: "Make Chapters",
      done: chaptersDone,
      summary: chaptersDone
        ? `${summary.chapterCount} chapter path${summary.chapterCount === 1 ? "" : "s"} ready.`
        : "Chapter titles or coverage notes still need shaping.",
      action: "Review the chapter list AI made.",
    },
    {
      id: "cards",
      view: "paragraphs" as const,
      label: "Plan Paragraphs",
      done: paragraphsPlanned,
      summary: paragraphsPlanned
        ? `${summary.paragraphCount} paragraph${summary.paragraphCount === 1 ? "" : "s"} planned.`
        : "Some paragraphs still need a label or Plan for AI.",
      action: "Edit what each paragraph should do.",
    },
    {
      id: "draft",
      view: "paragraphs" as const,
      label: "Write Book Text",
      done: draftDone,
      summary: draftDone
        ? "Every paragraph has book text."
        : `${summary.draftedParagraphs} of ${summary.paragraphCount} paragraphs have book text.`,
      action: "Go to Write and fill the reader-facing Book Text.",
    },
    {
      id: "manuscript",
      view: "draft" as const,
      label: "Readable Book",
      done: manuscriptDone,
      summary: manuscriptDone ? "The paragraphs are built into a readable book." : "Not built yet.",
      action: "Build the manuscript from finished Book Text.",
    },
    {
      id: "package",
      view: "package" as const,
      label: "Read Book",
      done: packageDone,
      summary: packageDone
        ? `Quality check says ${props.snapshot?.reviewPack?.recommendation ?? "ready"}.`
        : "Book files, cover, metadata, and quality are not checked yet.",
      action: "Run Check book quality and fix any gaps.",
    },
    {
      id: "publish",
      view: "publish" as const,
      label: "Publish prep",
      done: publishPrepDone,
      summary: publishPrepDone
        ? `KDP dry-run is ${props.snapshot?.publishDryRun?.status ?? "ready"}.`
        : "KDP upload steps have not been prepared.",
      action: "Prepare publishing only after quality passes.",
    },
  ];

  const firstOpenIndex = rawSteps.findIndex((step) => !step.done);
  return rawSteps.map((step, index) => ({
    id: step.id,
    view: step.view,
    label: step.label,
    state: step.done ? "done" : firstOpenIndex === index ? "current" : "waiting",
    summary: step.summary,
    action: step.action,
  }));
}

function workflowTone(state: WorkflowStep["state"]): "neutral" | "good" | "warn" {
  if (state === "done") {
    return "good";
  }
  if (state === "current") {
    return "warn";
  }
  return "neutral";
}

function needsEditableDraftFinish(props: BookWriterDashboardProps, plan: BookWriterPlan): boolean {
  const summary = summarizePlan(props.snapshot, plan);
  const allBookTextReady =
    summary.paragraphCount > 0 &&
    summary.draftedParagraphs >= summary.paragraphCount &&
    !plan.chapters
      .flatMap((chapter) => chapter.paragraphs)
      .some((paragraph) => !paragraph.locked && looksLikeInstructionalBookText(paragraph.text));
  const previewReady =
    ["stitched", "packaged", "publish-ready"].includes(plan.status) &&
    Boolean(props.snapshot?.manuscriptPreview?.trim());
  return !allBookTextReady || !previewReady;
}

function primaryActionFor(props: BookWriterDashboardProps) {
  const disabled = Boolean(props.savingAction);
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const plan = props.snapshot?.plan;
  const summary = plan ? summarizePlan(props.snapshot, plan) : null;

  if (props.savingAction) {
    return {
      label: `${statusLabel(props.savingAction)}…`,
      helper: "Working on your book now.",
      icon: icons.loader,
      onClick: () => {},
      disabled: true,
    };
  }

  switch (props.activeView) {
    case "brief":
      return {
        label: "Review chapters",
        helper: "Open the chapter list AI already made from your book idea.",
        icon: icons.book,
        onClick: () => props.onActiveViewChange("chapters"),
        disabled,
      };
    case "chapters":
      return {
        label: "Review paragraph plan",
        helper: "Open the paragraph-by-paragraph plan AI created for the book.",
        icon: icons.cornerDownRight,
        onClick: () => props.onActiveViewChange("paragraphs"),
        disabled,
      };
    case "paragraphs":
      return {
        label: "AI write Book Text",
        helper: "AI turns the paragraph plans into reader-facing Book Text.",
        icon: icons.fileText,
        onClick: props.onDraftPlan,
        disabled,
      };
    case "draft":
      if (
        summary &&
        (summary.draftedParagraphs < summary.paragraphCount ||
          plan?.chapters
            .flatMap((chapter) => chapter.paragraphs)
            .some(
              (paragraph) => !paragraph.locked && looksLikeInstructionalBookText(paragraph.text),
            ))
      ) {
        return {
          label: "AI write Book Text",
          helper: "Fills empty unlocked Book Text boxes from the paragraph plans.",
          icon: icons.penLine,
          onClick: props.onDraftPlan,
          disabled,
        };
      }
      return {
        label: "Build readable book",
        helper: "Combines all Book Text boxes into one readable manuscript.",
        icon: icons.fileText,
        onClick: props.onStitchPlan,
        disabled,
      };
    case "package":
      return {
        label: "Check book quality",
        helper: "Builds book files, cover, metadata, and quality findings.",
        icon: icons.check,
        onClick: props.onPackagePlan,
        disabled,
      };
    case "publish":
      if (!review || review.recommendation !== "approve") {
        return {
          label: "Prepare publishing",
          helper: "Quality must pass first. Click to check the book again.",
          icon: icons.book,
          onClick: props.onPackagePlan,
          disabled,
        };
      }
      if (!dryRun || dryRun.status !== "ready") {
        return {
          label: "Prepare publishing",
          helper: "Creates the safe KDP upload checklist and stops before final submit.",
          icon: icons.globe,
          onClick: props.onPreparePublish,
          disabled,
        };
      }
      return {
        label: "Open KDP Bookshelf",
        helper: "Publishing prep is ready. Follow the checklist and stop before final submit.",
        icon: icons.globe,
        onClick: () => {
          globalThis.open?.(KDP_BOOKSHELF_URL, "_blank", "noreferrer");
        },
        disabled,
      };
  }
  return {
    label: "Make my chapter list",
    helper: "AI keeps the book moving to the next safe step.",
    icon: icons.book,
    onClick: () => props.onActiveViewChange("chapters"),
    disabled,
  };
}

function renderIconButton(
  label: string,
  icon: unknown,
  onClick: (event: Event) => void,
  opts?: { disabled?: boolean; tone?: "primary" | "quiet"; title?: string },
) {
  const title = opts?.title ?? label;
  return html`
    <button
      class=${opts?.tone === "primary"
        ? "book-writer-btn book-writer-btn--primary"
        : opts?.tone === "quiet"
          ? "book-writer-btn book-writer-btn--quiet"
          : "book-writer-btn"}
      title=${title}
      aria-label=${title}
      ?disabled=${opts?.disabled}
      @click=${onClick}
    >
      <span class="book-writer-btn__icon">${icon}</span>
      <span>${label}</span>
    </button>
  `;
}

function renderPill(
  label: string,
  tone: "neutral" | "good" | "warn" | "danger" = "neutral",
  title?: string,
) {
  return html`<span
    class=${`book-writer-pill book-writer-pill--${tone}`}
    title=${title || nothing}
    aria-label=${title || nothing}
    >${label}</span
  >`;
}

function renderHelp(key: TermKey): TemplateResult {
  const term = TERM_DEFINITIONS[key] ?? {
    label: key,
    definition: "Book Studio helper.",
  };
  return html`
    <span class="book-writer-term-help-wrap">
      <span
        class="book-writer-term-help"
        title=${`${term.label}: ${term.definition}`}
        aria-label=${`${term.label}: ${term.definition}`}
        >?</span
      >
      <span class="book-writer-tooltip" role="tooltip">
        <b>${term.label}</b>
        ${term.definition}
      </span>
    </span>
  `;
}

function renderLabel(label: string, key: TermKey): TemplateResult {
  return html`<span class="book-writer-label-row"><span>${label}</span>${renderHelp(key)}</span>`;
}

function renderFieldHint(text: string): TemplateResult {
  return html`<small class="book-writer-field-hint">${text}</small>`;
}

function renderAiHelpButton(
  props: BookWriterDashboardProps,
  request: BookWriterAiHelpRequest,
  label = "AI help",
): TemplateResult {
  return html`
    <button
      class="book-writer-ai-help"
      type="button"
      ?disabled=${Boolean(props.savingAction)}
      title="Use AI with before-and-after book context"
      aria-label=${`${label}: use AI with before-and-after book context`}
      @click=${() => props.onRequestAiHelp(request)}
    >
      ✨ <span>${label}</span>
    </button>
  `;
}

function renderSetupFieldTools(props: BookWriterDashboardProps): TemplateResult {
  const requestCustom = () => {
    const customDirection =
      globalThis.prompt?.(
        "Tell AI exactly how to improve the initial book description. It will not create a book yet.",
      ) ?? "";
    if (!customDirection.trim()) {
      return;
    }
    props.onRequestSetupAiHelp("custom", customDirection);
  };
  return html`
    <details class="book-writer-ai-help-menu" aria-label="AI setup text helpers">
      <summary title="AI help for this field" aria-label="AI help for this field">✨</summary>
      <div class="book-writer-ai-help-row">
        ${(
          [
            ["fill", "Fill"],
            ["improve", "Improve"],
            ["clearer", "Make clearer"],
            ["dramatic", "Change tone"],
            ["humorous", "Humorous"],
          ] as const
        ).map(
          ([intent, label]) => html`
            <button
              class="book-writer-ai-help"
              type="button"
              ?disabled=${Boolean(props.savingAction)}
              title="Use AI to update only this setup textbox"
              aria-label=${`${label}: use AI to update the setup textbox`}
              @click=${() => props.onRequestSetupAiHelp(intent)}
            >
              <span>${label}</span>
            </button>
          `,
        )}
        <button
          class="book-writer-ai-help"
          type="button"
          ?disabled=${Boolean(props.savingAction)}
          title="Custom AI direction for this setup textbox"
          aria-label="Custom AI direction for this setup textbox"
          @click=${requestCustom}
        >
          <span>Custom</span>
        </button>
      </div>
    </details>
  `;
}

function renderFieldTools(
  props: BookWriterDashboardProps,
  target: BookWriterAiHelpRequest["target"],
  ids?: Pick<BookWriterAiHelpRequest, "chapterId" | "paragraphId">,
  options?: { locked?: boolean },
): TemplateResult {
  const requestCustom = () => {
    const customDirection =
      globalThis.prompt?.(
        "Tell AI exactly what you want changed. It will still respect the book context and locked text.",
      ) ?? "";
    if (!customDirection.trim()) {
      return;
    }
    props.onRequestAiHelp({ target, intent: "custom", customDirection, ...ids });
  };
  const disabled = Boolean(props.savingAction) || Boolean(options?.locked);
  return html`
    <details class="book-writer-ai-help-menu" aria-label="AI text helpers">
      <summary
        title=${options?.locked ? "This field is locked from AI changes" : "AI help for this field"}
        aria-label="AI help for this field"
      >
        ✨
      </summary>
      <div class="book-writer-ai-help-row">
        ${["fill", "improve", "clearer", "dramatic", "humorous"].map((intent) =>
          renderAiHelpButton(
            { ...props, savingAction: disabled ? (props.savingAction ?? "locked") : null },
            {
              target,
              intent: intent as BookWriterAiHelpRequest["intent"],
              ...ids,
            },
            intent === "fill"
              ? "Fill"
              : intent === "improve"
                ? "Improve"
                : intent === "clearer"
                  ? "Make clearer"
                  : intent === "dramatic"
                    ? "Change tone"
                    : "Humorous",
          ),
        )}
        <button
          class="book-writer-ai-help"
          type="button"
          ?disabled=${disabled}
          title=${options?.locked
            ? "This field is locked from AI changes"
            : "Custom AI direction with full book context"}
          aria-label="Custom AI direction with full book context"
          @click=${requestCustom}
        >
          <span>Custom</span>
        </button>
      </div>
    </details>
  `;
}

function roleLabel<T extends string>(
  value: T,
  options: Array<{ value: T; label: string }>,
): string {
  return options.find((option) => option.value === value)?.label ?? value.replace(/-/g, " ");
}

function renderChapterRoleControls(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan,
  chapter: BookWriterChapter,
): TemplateResult {
  const role: BookWriterChapterRole = chapter.role ?? {
    storyThread: "main-story",
    plotJob: "setup",
    readerFeeling: "warm",
    notes: "",
  };
  const saveRole = (next: BookWriterChapterRole) =>
    props.onSavePlan(updateChapter(plan, chapter.id, (item) => ({ ...item, role: next })));
  return html`
    <details class="book-writer-chapter-role">
      <summary>
        <span>Chapter role</span>
        <small>
          What is this chapter doing? ${roleLabel(role.storyThread, STORY_THREAD_OPTIONS)} ·
          ${roleLabel(role.plotJob, PLOT_JOB_OPTIONS)} ·
          ${roleLabel(role.readerFeeling, READER_FEELING_OPTIONS)}
        </small>
      </summary>
      <div class="book-writer-role-grid">
        <label>
          <span>Story thread</span>
          <select
            .value=${role.storyThread}
            @change=${(event: Event) =>
              saveRole({
                ...role,
                storyThread: (event.currentTarget as HTMLSelectElement)
                  .value as BookWriterChapterRole["storyThread"],
              })}
          >
            ${STORY_THREAD_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === role.storyThread}
              >
                ${option.label}
              </option>`,
            )}
          </select>
        </label>
        <label>
          <span>Plot job</span>
          <select
            .value=${role.plotJob}
            @change=${(event: Event) =>
              saveRole({
                ...role,
                plotJob: (event.currentTarget as HTMLSelectElement)
                  .value as BookWriterChapterRole["plotJob"],
              })}
          >
            ${PLOT_JOB_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === role.plotJob}
              >
                ${option.label}
              </option>`,
            )}
          </select>
        </label>
        <label>
          <span>Reader feeling</span>
          <select
            .value=${role.readerFeeling}
            @change=${(event: Event) =>
              saveRole({
                ...role,
                readerFeeling: (event.currentTarget as HTMLSelectElement)
                  .value as BookWriterChapterRole["readerFeeling"],
              })}
          >
            ${READER_FEELING_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === role.readerFeeling}
              >
                ${option.label}
              </option>`,
            )}
          </select>
        </label>
        <label class="book-writer-control-grid__wide">
          <span>Role notes</span>
          <textarea
            rows="2"
            .value=${role.notes}
            placeholder="Example: This chapter looks calm at first, then quietly turns into a clue reveal."
            @change=${(event: Event) =>
              saveRole({ ...role, notes: (event.currentTarget as HTMLTextAreaElement).value })}
          ></textarea>
        </label>
      </div>
    </details>
  `;
}

function renderSmallFieldLock(params: {
  checked: boolean;
  label?: string;
  onChange: (locked: boolean) => void;
}): TemplateResult {
  return html`
    <label class="book-writer-field-lock">
      <input
        type="checkbox"
        .checked=${params.checked}
        @change=${(event: Event) =>
          params.onChange((event.currentTarget as HTMLInputElement).checked)}
      />
      <span>${params.label ?? "Lock this box from AI"}</span>
    </label>
  `;
}

function checkedValues<T extends string>(event: Event, selector: string): T[] {
  const root = (event.currentTarget as HTMLElement).closest("[data-book-writer-ai-options]");
  if (!root) {
    return [];
  }
  return Array.from(root.querySelectorAll<HTMLInputElement>(selector))
    .filter((input) => input.checked)
    .map((input) => input.value as T);
}

function renderAiOptionCheckbox(value: string, label: string, checked = true): TemplateResult {
  return html`
    <label class="book-writer-ai-option">
      <input type="checkbox" value=${value} .checked=${checked} />
      <span>${label}</span>
    </label>
  `;
}

function renderBookSetupControls(
  props: BookWriterDashboardProps,
  plan?: BookWriterPlan,
): TemplateResult {
  const targetWords = plan?.targetWords ?? props.targetWordsDraft;
  const tonePreset = plan ? planTonePreset(plan) : props.toneDraft;
  const customTone = plan ? customToneForPlan(plan) : props.customToneDraft;
  const profanityLevel = plan ? planProfanityLevel(plan) : props.profanityDraft;
  const penName = plan?.penName ?? props.penNameDraft;
  const penProfiles = props.snapshot?.penNameProfiles ?? [];
  const saveTargetWords = (value: number) => {
    if (plan) {
      props.onSavePlan(withTargetWords(plan, value));
      return;
    }
    props.onTargetWordsDraftChange(normalizeTargetWordsInput(value));
  };
  const saveTone = (value: BookWriterTonePreset) => {
    if (plan) {
      props.onSavePlan(withTone(plan, value));
      return;
    }
    props.onToneDraftChange(value);
  };
  const saveCustomTone = (value: string) => {
    if (plan) {
      props.onSavePlan(withCustomTone(plan, value));
      return;
    }
    props.onCustomToneDraftChange(value);
  };
  const saveProfanity = (value: BookWriterProfanityLevel) => {
    if (plan) {
      props.onSavePlan(withProfanity(plan, value));
      return;
    }
    props.onProfanityDraftChange(value);
  };
  const savePenName = (value: string) => {
    if (plan) {
      const profile = penProfiles.find((item) => item.name === value);
      props.onSavePlan({
        ...plan,
        penName: value,
        ...(profile
          ? { genre: profile.lane, brief: { ...plan.brief, readerPromise: profile.readerPromise } }
          : {}),
      });
      return;
    }
    props.onPenNameDraftChange(value);
  };
  return html`
    <section
      class="book-writer-style-card book-writer-setup-controls"
      aria-label="Book writing controls"
    >
      <div class="book-writer-setup-controls__intro">
        <p class="book-writer-eyebrow">Writing controls</p>
        <b>Length, tone, and profanity</b>
        <span>These settings guide the chapter plan, paragraph targets, and final Book Text.</span>
      </div>
      <label>
        ${renderLabel("Target words", "targetWords")}
        <input
          type="number"
          min=${String(MIN_BOOK_WRITER_TARGET_WORDS)}
          step=${String(BOOK_WRITER_TARGET_WORDS_STEP)}
          aria-label=${plan ? "Book target words" : "New book target words"}
          .value=${String(normalizeTargetWordsInput(targetWords))}
          @input=${(event: Event) =>
            saveTargetWords(Number((event.currentTarget as HTMLInputElement).value))}
          @change=${(event: Event) =>
            saveTargetWords(Number((event.currentTarget as HTMLInputElement).value))}
        />
        ${renderLengthEstimate(targetWords)}
        ${plan
          ? renderTargetRebalanceAction({
              plan,
              targetWords,
              onSavePlan: props.onSavePlan,
              onRequestAiAction: props.onRequestAiAction,
            })
          : nothing}
      </label>
      ${renderLengthPresets(targetWords, saveTargetWords)}
      <label>
        ${renderLabel("Pen name", "penName")}
        <input
          list="book-writer-pen-name-options"
          aria-label=${plan ? "Book pen name" : "New book pen name"}
          .value=${penName}
          placeholder="Choose or type a pen name"
          @change=${(event: Event) => savePenName((event.currentTarget as HTMLInputElement).value)}
        />
        <datalist id="book-writer-pen-name-options">
          ${penProfiles.map((profile) => html`<option value=${profile.name}></option>`)}
        </datalist>
        ${renderFieldHint(
          penProfiles.find((profile) => profile.name === penName)?.lane ??
            "Use the same pen name for similar books so readers know what to expect.",
        )}
      </label>
      <label>
        ${renderLabel("Tone", "tone")}
        <select
          aria-label=${plan ? "Book tone" : "New book tone"}
          .value=${tonePreset}
          @change=${(event: Event) =>
            saveTone((event.currentTarget as HTMLSelectElement).value as BookWriterTonePreset)}
        >
          ${TONE_OPTIONS.map(
            (option) => html`<option value=${option.value}>${option.label}</option>`,
          )}
        </select>
        ${renderFieldHint(toneDescriptionFor(tonePreset, customTone))}
      </label>
      ${tonePreset === "custom"
        ? html`
            <label class="book-writer-custom-tone-field">
              ${renderLabel("Custom tone details", "customTone")}
              <textarea
                rows="3"
                maxlength="240"
                aria-label=${plan ? "Book custom tone" : "New book custom tone"}
                placeholder="Example: Cozy, dryly funny, emotionally warm, and never academic."
                .value=${customTone}
                @input=${(event: Event) =>
                  saveCustomTone((event.currentTarget as HTMLTextAreaElement).value)}
              ></textarea>
              ${renderFieldHint(
                "This plain-English voice note is sent to AI and shown in the preview.",
              )}
            </label>
          `
        : nothing}
      <label>
        ${renderLabel("Profanity", "profanity")}
        <select
          aria-label=${plan ? "Book profanity" : "New book profanity"}
          .value=${profanityLevel}
          @change=${(event: Event) =>
            saveProfanity(
              (event.currentTarget as HTMLSelectElement).value as BookWriterProfanityLevel,
            )}
        >
          ${PROFANITY_OPTIONS.map(
            (option) => html`<option value=${option.value}>${option.label}</option>`,
          )}
        </select>
        ${renderFieldHint(
          `${profanityDescriptionFor(
            profanityLevel,
          )} This is relative to other books in the selected category.`,
        )}
      </label>
      ${renderStylePreview({
        topic: plan?.topic ?? props.topicDraft,
        targetWords,
        tonePreset,
        customTone,
        profanityLevel,
      })}
    </section>
  `;
}

function renderBookControlBar(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const tonePreset = planTonePreset(plan);
  const customTone = customToneForPlan(plan);
  const profanityLevel = planProfanityLevel(plan);
  const summary = summarizePlan(props.snapshot, plan);
  const automation = props.snapshot?.automation;
  const automationTone =
    automation?.status === "scheduled" ? "warn" : automation?.scheduled ? "neutral" : "good";
  const sync = plan.bookSync;
  const syncTone =
    sync?.state === "synced" || sync?.state === "fully-updated"
      ? "good"
      : sync?.state === "locked-conflict-found" || sync?.state === "cohesion-review-needed"
        ? "danger"
        : sync?.state
          ? "warn"
          : "neutral";
  const overview = plan.storylineOverview;
  return html`
    <section class="book-writer-control-bar" aria-label="Always visible book controls">
      <div class="book-writer-control-bar__head">
        <div>
          <p class="book-writer-eyebrow">Book Control Bar</p>
          <h3>Change the book without losing the thread.</h3>
          <p>
            These controls stay visible while you build so tone, title, length, and reader promise
            do not drift.
          </p>
        </div>
        ${renderPill(
          automation?.message ?? "Manual only. Book Studio will not write on its own.",
          automationTone,
        )}
      </div>
      <div class="book-writer-storyline-overview" data-book-writer-storyline-overview>
        <b>Storyline Overview</b>
        <span
          >${overview?.shortText ??
          "The storyline overview will appear after the book plan is saved."}</span
        >
        <small>
          ${overview
            ? `Goal: ${overview.protagonistGoal} · Next: ${overview.nextChapterDirection}`
            : "Book Studio will summarize the evolving main storyline from the current plan."}
        </small>
      </div>
      <div class="book-writer-sync-panel" data-book-writer-sync-state=${sync?.state ?? "unknown"}>
        <b>Book Sync</b>
        <span>${renderPill(sync ? statusLabel(sync.state) : "Unknown", syncTone)}</span>
        <small>
          ${sync?.summary ?? "Book Studio has not analyzed story-impact sync for this draft yet."}
          ${sync?.affectedChapterIds.length
            ? ` ${sync.affectedChapterIds.length} chapter(s) may need propagation.`
            : ""}
          ${sync?.lockedConflictCount
            ? ` ${sync.lockedConflictCount} locked text block(s) are in affected areas.`
            : ""}
        </small>
        ${sync?.affectedChapterIds.length
          ? html`
              <div class="book-writer-sync-panel__affected" data-book-writer-affected-chapters>
                ${sync.affectedChapterIds.map((chapterId) => {
                  const chapter = plan.chapters.find((candidate) => candidate.id === chapterId);
                  return html`<span
                    >${chapter ? `Ch. ${chapter.number}: ${chapter.title}` : chapterId}</span
                  >`;
                })}
              </div>
            `
          : nothing}
        ${sync?.state === "needs-propagation"
          ? html`
              <button
                class="book-writer-guided-primary"
                data-book-writer-propagate
                @click=${() => props.onRequestAiAction("propagate")}
              >
                Propagate Change Through Book
              </button>
            `
          : sync?.state === "locked-conflict-found"
            ? html`<small>Review locked text before propagating this change.</small>`
            : nothing}
      </div>
      <div class="book-writer-control-grid">
        <label>
          <span>Title</span>
          <input
            .value=${plan.title}
            aria-label="Book title"
            @change=${(event: Event) =>
              props.onSavePlan({
                ...plan,
                title: (event.currentTarget as HTMLInputElement).value,
              })}
          />
          ${renderFieldTools(props, "title")}
        </label>
        <label>
          <span>Word count</span>
          <input
            type="number"
            min=${String(MIN_BOOK_WRITER_TARGET_WORDS)}
            step=${String(BOOK_WRITER_TARGET_WORDS_STEP)}
            .value=${String(plan.targetWords)}
            aria-label="Book control target words"
            @change=${(event: Event) =>
              props.onSavePlan(
                withTargetWords(plan, Number((event.currentTarget as HTMLInputElement).value)),
              )}
          />
          ${renderFieldHint(
            `${summary.draftedWords.toLocaleString()} words written · target ${plan.targetWords.toLocaleString()}`,
          )}
          ${renderLengthEstimate(plan.targetWords)}
          ${renderLengthPresets(plan.targetWords, (value) =>
            props.onSavePlan(withTargetWords(plan, value)),
          )}
          ${renderTargetRebalanceAction({
            plan,
            targetWords: plan.targetWords,
            onSavePlan: props.onSavePlan,
            onRequestAiAction: props.onRequestAiAction,
          })}
        </label>
        <label>
          <span>Tone</span>
          <select
            .value=${tonePreset}
            aria-label="Book control tone"
            @change=${(event: Event) =>
              props.onSavePlan(
                withTone(
                  plan,
                  (event.currentTarget as HTMLSelectElement).value as BookWriterTonePreset,
                ),
              )}
          >
            ${TONE_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === tonePreset}
              >
                ${option.label}
              </option>`,
            )}
          </select>
          ${renderFieldHint(toneDescriptionFor(tonePreset, customTone))}
        </label>
        <label>
          <span>Profanity</span>
          <select
            .value=${profanityLevel}
            aria-label="Book control profanity"
            @change=${(event: Event) =>
              props.onSavePlan(
                withProfanity(
                  plan,
                  (event.currentTarget as HTMLSelectElement).value as BookWriterProfanityLevel,
                ),
              )}
          >
            ${PROFANITY_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === profanityLevel}
              >
                ${option.label}
              </option>`,
            )}
          </select>
          ${renderFieldHint(
            `${profanityDescriptionFor(profanityLevel)} Clean language unless you choose otherwise.`,
          )}
        </label>
        <label class="book-writer-control-grid__wide">
          <span>How AI will sound</span>
          <textarea
            rows="2"
            .value=${customTone || toneDescriptionFor(tonePreset)}
            aria-label="How AI will sound"
            @change=${(event: Event) =>
              props.onSavePlan(
                withCustomTone(plan, (event.currentTarget as HTMLTextAreaElement).value),
              )}
          ></textarea>
          ${renderFieldTools(props, "bookStyle")}
          ${renderStylePreview({
            topic: plan.topic,
            targetWords: plan.targetWords,
            tonePreset,
            customTone,
            profanityLevel,
          })}
        </label>
        <label>
          <span>Audience</span>
          <input
            .value=${plan.brief.audience}
            aria-label="Book audience"
            @change=${(event: Event) =>
              props.onSavePlan({
                ...plan,
                brief: {
                  ...plan.brief,
                  audience: (event.currentTarget as HTMLInputElement).value,
                },
              })}
          />
          ${renderFieldTools(props, "audience")}
        </label>
        <label>
          <span>Reader promise</span>
          <input
            .value=${plan.brief.readerPromise}
            aria-label="Book reader promise"
            @change=${(event: Event) =>
              props.onSavePlan({
                ...plan,
                brief: {
                  ...plan.brief,
                  readerPromise: (event.currentTarget as HTMLInputElement).value,
                },
              })}
          />
          ${renderFieldTools(props, "readerPromise")}
        </label>
        <div class="book-writer-control-status">
          <b>Current step</b>
          <span>${VIEWS.find((view) => view.id === props.activeView)?.label ?? "Book Studio"}</span>
          <small
            >Save status: ${props.savingAction ? `Saving ${props.savingAction}...` : "Saved"}</small
          >
        </div>
        <div class="book-writer-control-status">
          <b>Automation</b>
          <span>${automation?.status === "scheduled" ? "Scheduled" : "Manual only"}</span>
          ${automation?.scheduled
            ? html`
                <button class="book-writer-link-button" @click=${props.onDisableAutomation}>
                  Turn off autonomous writing
                </button>
              `
            : html`<small>No autonomous writing schedule is active.</small>`}
        </div>
      </div>
    </section>
  `;
}

function renderIdeaWorkspacePanel(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const tonePreset = planTonePreset(plan);
  const customTone = customToneForPlan(plan);
  const profanityLevel = planProfanityLevel(plan);
  const summary = summarizePlan(props.snapshot, plan);
  const automation = props.snapshot?.automation;
  const automationTone =
    automation?.status === "scheduled" ? "warn" : automation?.scheduled ? "neutral" : "good";
  const saveTargetWords = (value: number) => props.onSavePlan(withTargetWords(plan, value));
  const saveTone = (value: BookWriterTonePreset) => props.onSavePlan(withTone(plan, value));
  const saveCustomTone = (value: string) => props.onSavePlan(withCustomTone(plan, value));
  const saveProfanity = (value: BookWriterProfanityLevel) =>
    props.onSavePlan(withProfanity(plan, value));
  const panelHint =
    props.activeView === "chapters"
      ? "Global controls stay here. Review and reshape chapters on the right."
      : "Global controls stay here. Edit idea details on the right.";

  return html`
    <section class="book-writer-context-panel" aria-label="Idea controls">
      <p class="book-writer-eyebrow">Book Control Bar</p>
      <h3>Change the book without losing the thread.</h3>
      <small>${panelHint}</small>
      <label>
        <span>Title</span>
        <input
          aria-label="Context book title"
          .value=${plan.title}
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              title: (event.currentTarget as HTMLInputElement).value,
            })}
        />
        ${renderFieldTools(props, "title")}
      </label>
      <label>
        <span>Quick idea summary</span>
        <textarea
          rows="3"
          aria-label="Context idea summary"
          .value=${plan.brief.topicParagraph}
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              topic: (event.currentTarget as HTMLTextAreaElement).value,
              brief: {
                ...plan.brief,
                topicParagraph: (event.currentTarget as HTMLTextAreaElement).value,
              },
            })}
        ></textarea>
      </label>
      <label>
        <span>Audience</span>
        <input
          aria-label="Context audience"
          .value=${plan.brief.audience}
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              brief: { ...plan.brief, audience: (event.currentTarget as HTMLInputElement).value },
            })}
        />
      </label>
      <label>
        <span>Reader promise</span>
        <input
          aria-label="Context reader promise"
          .value=${plan.brief.readerPromise}
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              brief: {
                ...plan.brief,
                readerPromise: (event.currentTarget as HTMLInputElement).value,
              },
            })}
        />
      </label>
      <label>
        <span>Word count</span>
        <input
          type="number"
          min=${String(MIN_BOOK_WRITER_TARGET_WORDS)}
          step=${String(BOOK_WRITER_TARGET_WORDS_STEP)}
          aria-label="Context target words"
          .value=${String(plan.targetWords)}
          @change=${(event: Event) =>
            saveTargetWords(Number((event.currentTarget as HTMLInputElement).value))}
        />
        ${renderFieldHint(
          `${summary.draftedWords.toLocaleString()} words written · target ${plan.targetWords.toLocaleString()}`,
        )}
        ${renderLengthEstimate(plan.targetWords)}
        ${renderLengthPresets(plan.targetWords, saveTargetWords)}
      </label>
      <div class="book-writer-context-row">
        <label>
          <span>Tone</span>
          <select
            aria-label="Context tone"
            .value=${tonePreset}
            @change=${(event: Event) =>
              saveTone((event.currentTarget as HTMLSelectElement).value as BookWriterTonePreset)}
          >
            ${TONE_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === tonePreset}
              >
                ${option.label}
              </option>`,
            )}
          </select>
        </label>
        <label>
          <span>Profanity</span>
          <select
            aria-label="Context profanity"
            .value=${profanityLevel}
            @change=${(event: Event) =>
              saveProfanity(
                (event.currentTarget as HTMLSelectElement).value as BookWriterProfanityLevel,
              )}
          >
            ${PROFANITY_OPTIONS.map(
              (option) => html`<option
                value=${option.value}
                ?selected=${option.value === profanityLevel}
              >
                ${option.label}
              </option>`,
            )}
          </select>
        </label>
      </div>
      <small
        >${toneDescriptionFor(tonePreset, customTone)}
        ${profanityDescriptionFor(profanityLevel)}</small
      >
      <section
        class="book-writer-ai-options"
        data-book-writer-ai-options
        aria-label="AI idea setup options"
      >
        <b>AI generate idea setup</b>
        <small>Book Writer idea-strategist fills selected fields. Profanity stays Off.</small>
        <div class="book-writer-ai-options__grid">
          ${renderAiOptionCheckbox("title", "Title")}
          ${renderAiOptionCheckbox("summary", "Quick idea summary")}
          ${renderAiOptionCheckbox("readerPromise", "Reader promise")}
          ${renderAiOptionCheckbox("targetWords", "Word count")}
          ${renderAiOptionCheckbox("tone", "Tone")}
          ${renderAiOptionCheckbox("audience", "What should this book be")}
        </div>
        <button
          class="book-writer-guided-primary book-writer-guided-primary--small"
          ?disabled=${Boolean(props.savingAction)}
          @click=${(event: Event) =>
            props.onGenerateIdeaSetup(
              checkedValues<BookWriterIdeaSetupTarget>(
                event,
                '.book-writer-ai-options input[type="checkbox"]',
              ),
            )}
        >
          AI generate selected idea fields
        </button>
      </section>
      <label>
        <span>How AI will sound</span>
        <textarea
          rows="3"
          aria-label="How AI will sound"
          .value=${customTone || toneDescriptionFor(tonePreset)}
          @change=${(event: Event) =>
            saveCustomTone((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
      </label>
      ${renderPill(
        automation?.message ?? "Manual only. Book Studio will not write on its own.",
        automationTone,
      )}
      <small
        >Current step:
        ${VIEWS.find((view) => view.id === props.activeView)?.label ?? "Book Studio"}</small
      >
      <small
        >Save status: ${props.savingAction ? `Saving ${props.savingAction}...` : "Saved"}</small
      >
      ${automation?.scheduled
        ? html`
            <button class="book-writer-link-button" @click=${props.onDisableAutomation}>
              Turn off autonomous writing
            </button>
          `
        : nothing}
      <button
        class="book-writer-guided-primary book-writer-guided-primary--small"
        ?disabled=${Boolean(props.savingAction)}
        @click=${() => props.onSavePlan(reflowChaptersFromIdea(plan))}
      >
        Apply idea changes to chapters
      </button>
    </section>
  `;
}

function renderErrorCallout(props: BookWriterDashboardProps): TemplateResult | typeof nothing {
  if (!props.error) {
    return nothing;
  }
  const isConflict = /version conflict/i.test(props.error);
  if (!isConflict) {
    return html`<div class="callout danger" role="alert">${props.error}</div>`;
  }
  return html`
    <section class="callout danger book-writer-conflict" role="alert">
      <div>
        <b>Someone edited this plan first.</b>
        <p>Refresh the latest version before saving again so newer work stays safe.</p>
        <small>${props.error}</small>
      </div>
      ${renderIconButton("Refresh latest", icons.loader, props.onRefresh, { tone: "quiet" })}
    </section>
  `;
}

function renderCreatePanel(props: BookWriterDashboardProps) {
  return html`
    <section class="book-writer-hero book-writer-hero--empty">
      <div class="book-writer-hero__copy">
        <p class="book-writer-eyebrow">Book Studio</p>
        <h2>Describe the book once.</h2>
        <p>
          Type the book you want. AI can build the chapter list, paragraph plans, real Book Text,
          and a readable preview in one pass. You edit everything afterward.
        </p>
        <p class="book-writer-powered">Powered by the Book Writer plugin.</p>
      </div>
      <label class="book-writer-topic-card">
        ${renderLabel("Book idea", "topic")}
        <textarea
          class="book-writer-topic"
          .value=${props.topicDraft}
          placeholder="Example: A practical book for busy parents that teaches a calm morning routine, with short chapters, specific examples, and a hopeful tone."
          @input=${(event: Event) =>
            props.onTopicDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
        ></textarea>
        ${renderFieldHint(
          "Include topic, reader, tone, and result. You can change the generated chapters and paragraphs later.",
        )}
      </label>
      ${renderBookSetupControls(props)}
      <div class="book-writer-start-card">
        <button
          class="book-writer-guided-primary"
          ?disabled=${Boolean(props.savingAction) || !props.topicDraft.trim()}
          @click=${() => props.onRequestAiAction("full-draft")}
        >
          Write my editable draft
        </button>
        <span>
          AI creates chapters, paragraph plans, reader-facing Book Text, and the readable preview.
          Then you edit any box.
        </span>
        <button
          class="book-writer-link-button"
          ?disabled=${Boolean(props.savingAction) || !props.topicDraft.trim()}
          @click=${() => props.onRequestAiAction("create")}
        >
          Just make chapters first
        </button>
      </div>
    </section>
  `;
}

function renderDeletedBookCard(
  props: BookWriterDashboardProps,
  book: BookWriterDashboardSnapshot["deletedBooks"][number],
) {
  return html`
    <article class="book-writer-deleted-book">
      <div>
        <b>${book.title}</b>
        <span>
          Deleted ${new Date(book.deletedAt).toLocaleDateString()} ·
          ${book.draftedWords.toLocaleString()} words
        </span>
      </div>
      <div class="book-writer-deleted-book__actions">
        <button
          class="book-writer-project__restore"
          title=${`Restore ${book.title}`}
          aria-label=${`Restore ${book.title}`}
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onRestoreDeletedRun(book.deletedId)}
        >
          ${icons.cornerDownRight}
          <span>Restore</span>
        </button>
        <button
          class="book-writer-project__delete book-writer-project__delete--forever"
          title=${`Delete ${book.title} forever`}
          aria-label=${`Delete ${book.title} forever`}
          ?disabled=${Boolean(props.savingAction)}
          @click=${() =>
            props.onRequestDestructiveAction({
              kind: "delete-deleted",
              deletedId: book.deletedId,
              title: book.title,
            })}
        >
          ${icons.trash}
          <span>Delete forever</span>
        </button>
      </div>
    </article>
  `;
}

function renderArchivedBookCard(
  props: BookWriterDashboardProps,
  book: BookWriterDashboardSnapshot["archivedBooks"][number],
) {
  return html`
    <article class="book-writer-deleted-book book-writer-archived-book">
      <div>
        <b>${book.title}</b>
        <span>
          Archived ${new Date(book.archivedAt).toLocaleDateString()} ·
          ${book.draftedWords.toLocaleString()} words
        </span>
      </div>
      <div class="book-writer-deleted-book__actions">
        <button
          class="book-writer-project__restore"
          title=${`Restore ${book.title} to active drafts`}
          aria-label=${`Restore archived ${book.title}`}
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onRestoreArchivedRun(book.archivedId)}
        >
          ${icons.cornerDownRight}
          <span>Restore to drafts</span>
        </button>
        <button
          class="book-writer-project__delete"
          title=${`Move archived ${book.title} to Recently Deleted`}
          aria-label=${`Delete archived ${book.title}`}
          ?disabled=${Boolean(props.savingAction)}
          @click=${() =>
            props.onRequestDestructiveAction({
              kind: "delete-archived",
              archivedId: book.archivedId,
              title: book.title,
            })}
        >
          ${icons.trash}
          <span>Delete</span>
        </button>
      </div>
    </article>
  `;
}

function renderProjectRail(props: BookWriterDashboardProps) {
  const projects = props.snapshot?.projects ?? [];
  const activeProjects = projects.filter((project) => project.status !== "publish-ready");
  const archivedBooks = props.snapshot?.archivedBooks ?? [];
  const deletedBooks = props.snapshot?.deletedBooks ?? [];
  const visibleDeletedBooks = deletedBooks.slice(0, 3);
  const hiddenDeletedBooks = deletedBooks.slice(3);
  return html`
    <aside class="book-writer-rail" aria-label="Book library">
      <div class="book-writer-rail__head">
        <div>
          <p class="book-writer-eyebrow">Library</p>
          <b>Your books</b>
        </div>
      </div>
      <div class="book-writer-new-book">
        <label>
          ${renderLabel("New book idea", "topic")}
          <textarea
            class="book-writer-topic book-writer-topic--compact"
            .value=${props.topicDraft}
            placeholder="Type a book idea"
            @input=${(event: Event) =>
              props.onTopicDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        <small> Keep this starter light. Use setup for the full guided form. </small>
        ${renderIconButton("Set up new book", icons.book, props.onOpenNewBookSetup, {
          disabled: Boolean(props.savingAction),
          tone: "quiet",
        })}
      </div>
      <div class="book-writer-projects">
        ${activeProjects.length === 0
          ? html`<div class="book-writer-empty">
              Active unfinished books appear here. Completed books move to the landing shelf.
            </div>`
          : activeProjects.map(
              (project) => html`
                <article
                  class=${project.runId === props.selectedRunId
                    ? "book-writer-project book-writer-project--active"
                    : "book-writer-project"}
                >
                  <button
                    class="book-writer-project__select"
                    title=${`Open ${project.title}`}
                    aria-label=${`Open ${project.title}`}
                    @click=${() => props.onSelectRun(project.runId)}
                  >
                    <b>${project.title}</b>
                    <span>${project.draftedWords.toLocaleString()} words</span>
                  </button>
                  <div class="book-writer-project__meta">
                    ${renderPill(statusLabel(project.status))}
                    ${project.kind === "quick-read" ? renderPill("Quick Read") : nothing}
                  </div>
                </article>
              `,
            )}
      </div>
      <div class="book-writer-library-tools" aria-label="Library tools">
        ${activeProjects.length
          ? html`
              <details class="book-writer-manage-books">
                <summary aria-label="Manage active books">
                  ${icons.menu}
                  <span>Manage books</span>
                </summary>
                <div class="book-writer-manage-books__menu">
                  <small>
                    Maintenance stays here so opening books stays fast. Recently Deleted keeps
                    recovery copies.
                  </small>
                  ${activeProjects.map(
                    (project) => html`
                      <div class="book-writer-manage-books__row" data-run-id=${project.runId}>
                        <span>
                          <b>${project.title}</b>
                          <small>${project.draftedWords.toLocaleString()} words</small>
                        </span>
                        <button
                          class="book-writer-project__restore"
                          title=${`Copy draft ${project.title}`}
                          aria-label=${`Copy draft ${project.title}`}
                          ?disabled=${Boolean(props.savingAction)}
                          @click=${() => props.onCopyRun(project.runId)}
                        >
                          ${icons.copy}
                          <span>Copy book</span>
                        </button>
                        <button
                          class="book-writer-project__restore"
                          title=${`Archive draft ${project.title}`}
                          aria-label=${`Archive draft ${project.title}`}
                          ?disabled=${Boolean(props.savingAction)}
                          @click=${() => props.onArchiveRun(project.runId)}
                        >
                          ${icons.folder}
                          <span>Archive draft</span>
                        </button>
                        <button
                          class="book-writer-project__delete"
                          title=${`Move ${project.title} to Recently Deleted`}
                          aria-label=${`Move ${project.title} to Recently Deleted`}
                          ?disabled=${Boolean(props.savingAction)}
                          @click=${() =>
                            props.onRequestDestructiveAction({
                              kind: "move-active",
                              runId: project.runId,
                              title: project.title,
                            })}
                        >
                          ${icons.trash}
                          <span>Move to Recently Deleted</span>
                        </button>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : nothing}
        <button
          class="book-writer-library-tool"
          title="Refresh library"
          aria-label="Refresh library"
          @click=${props.onRefresh}
        >
          ${icons.loader}
          <span>Refresh</span>
        </button>
        ${activeProjects.length
          ? html`
              <details class="book-writer-rail-more">
                <summary aria-label="More library cleanup actions">
                  ${icons.menu}
                  <span>Cleanup</span>
                </summary>
                <div class="book-writer-rail-more__menu">
                  <button
                    class="book-writer-project__delete"
                    title="Move all active books to Recently Deleted"
                    aria-label="Move all active books to Recently Deleted"
                    ?disabled=${Boolean(props.savingAction)}
                    @click=${() =>
                      props.onRequestDestructiveAction({
                        kind: "move-active-many",
                        runIds: activeProjects.map((project) => project.runId),
                        count: activeProjects.length,
                      })}
                  >
                    ${icons.trash}
                    <span>Move all active books to Recently Deleted</span>
                  </button>
                  <small>Safe cleanup. You can restore any book later.</small>
                </div>
              </details>
            `
          : nothing}
      </div>
      ${archivedBooks.length
        ? html`
            <section class="book-writer-deleted-books book-writer-archived-books">
              <details>
                <summary>
                  ${icons.folder}
                  <span>Archived books (${archivedBooks.length})</span>
                </summary>
                <small>
                  Hidden drafts stay out of your active list. Restore brings them back; Delete moves
                  them to Recently Deleted first.
                </small>
                <div class="book-writer-archived-books__list">
                  ${archivedBooks.map((book) => renderArchivedBookCard(props, book))}
                </div>
              </details>
            </section>
          `
        : nothing}
      ${deletedBooks.length
        ? html`
            <section class="book-writer-deleted-books" aria-label="Recently deleted books">
              <div class="book-writer-deleted-books__head">
                <div>
                  <p class="book-writer-eyebrow">Recently deleted</p>
                  <small>
                    ${deletedBooks.length} recoverable
                    ${deletedBooks.length === 1 ? "book" : "books"}. Restore brings the book back.
                  </small>
                </div>
                <button
                  class="book-writer-deleted-books__empty"
                  title="Empty Recently Deleted"
                  aria-label="Empty Recently Deleted"
                  ?disabled=${Boolean(props.savingAction)}
                  @click=${() =>
                    props.onRequestDestructiveAction({
                      kind: "empty-deleted",
                      count: deletedBooks.length,
                    })}
                >
                  Empty Recently Deleted…
                </button>
              </div>
              ${visibleDeletedBooks.map((book) => renderDeletedBookCard(props, book))}
              ${hiddenDeletedBooks.length
                ? html`
                    <details class="book-writer-deleted-books__more">
                      <summary>Show ${hiddenDeletedBooks.length} more deleted books</summary>
                      <div>
                        ${hiddenDeletedBooks.map((book) => renderDeletedBookCard(props, book))}
                      </div>
                    </details>
                  `
                : nothing}
            </section>
          `
        : nothing}
    </aside>
  `;
}

function renderMetric(label: string, value: string, term?: TermKey) {
  return html`
    <div class="book-writer-metric">
      <b>${value}</b>
      <span>${term ? renderLabel(label, term) : label}</span>
    </div>
  `;
}

function renderBeginnerFlow(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const summary = summarizePlan(props.snapshot, plan);
  const items = [
    {
      view: "brief" as const,
      title: "1. Idea",
      body: "Tell AI what the book is, who reads it, and what result it should deliver.",
      button: "Make chapters",
    },
    {
      view: "chapters" as const,
      title: "2. Make Chapters",
      body: "AI made the chapter list. Change anything you want before planning paragraphs.",
      button: "Make paragraph plan",
    },
    {
      view: "paragraphs" as const,
      title: "3. Plan Paragraphs",
      body: "Edit the instructions AI will read. These planning notes are never printed.",
      button: "Review plans",
    },
    {
      view: "draft" as const,
      title: "4. Write Book Text",
      body:
        summary.draftedParagraphs < summary.paragraphCount
          ? `${summary.draftedParagraphs}/${summary.paragraphCount} paragraphs have reader-facing Book Text.`
          : "Build the paragraph text into one readable book.",
      button: summary.draftedParagraphs < summary.paragraphCount ? "Write text" : "Build book",
    },
  ];
  return html`
    <section class="book-writer-path" aria-label="Book Studio quick guide">
      <div class="book-writer-path__head">
        <div>
          <p class="book-writer-eyebrow">How this works</p>
          <h3>One clear path from idea to upload-ready files.</h3>
        </div>
        ${renderPill(
          summary.draftedParagraphs < summary.paragraphCount
            ? "Next: write paragraphs"
            : props.snapshot?.reviewPack
              ? "Next: publish"
              : "Next: read and check",
          summary.draftedParagraphs < summary.paragraphCount ? "warn" : "good",
        )}
      </div>
      <div class="book-writer-path__grid">
        ${items.map(
          (item) => html`
            <button
              class=${props.activeView === item.view
                ? "book-writer-path-card book-writer-path-card--active"
                : "book-writer-path-card"}
              @click=${() => props.onActiveViewChange(item.view)}
              title=${`${item.title}: ${item.body}`}
              aria-label=${`${item.title}. ${item.body}`}
            >
              <b>${item.title}</b>
              <span>${item.body}</span>
              <em>${item.button}</em>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderPlanHero(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const summary = summarizePlan(props.snapshot, plan);
  const action = primaryActionFor(props);
  const reviewTone = props.snapshot?.reviewPack?.recommendation === "approve" ? "good" : "neutral";
  const progressDegrees = Math.max(0, Math.min(360, Math.round(summary.progress * 3.6)));
  return html`
    <section class="book-writer-hero book-writer-hero--plan">
      <div class="book-writer-hero__copy">
        <p class="book-writer-eyebrow">Book Studio</p>
        <h2>${plan.title || "Untitled book"}</h2>
        <p>${plan.subtitle || plan.brief.readerPromise || "Shape, write, check, and prepare."}</p>
        <div class="book-writer-hero__pills">
          ${renderPill(plan.kind === "quick-read" ? "Quick Read Edition" : "Full Book")}
          ${renderPill(statusLabel(plan.status), reviewTone)}
          <span title=${TERM_DEFINITIONS.version.definition}
            >${renderPill(`v${plan.version}`)}</span
          >
        </div>
      </div>
      <div class="book-writer-progress-card">
        <div
          class="book-writer-progress-ring"
          style=${`--book-progress: ${progressDegrees}deg`}
          aria-label=${`${summary.progress}% written`}
        >
          <span>${summary.progress}%</span>
        </div>
        <div>
          <b>Book Text progress</b>
          <p>
            ${summary.draftedParagraphs} of ${summary.paragraphCount} paragraphs have Book Text.
            ${summary.lockedParagraphs} locked.
          </p>
        </div>
      </div>
      <div class="book-writer-next-card">
        <p class="book-writer-eyebrow">${renderLabel("Recommended now", "nextMove")}</p>
        <button
          class="book-writer-primary-action"
          title=${action.label}
          aria-label=${action.label}
          ?disabled=${action.disabled}
          @click=${action.onClick}
        >
          <span>${action.icon}</span>
          <strong>${action.label}</strong>
        </button>
        <p><b>Why:</b> ${action.helper}</p>
        <small>Locked chapters and paragraphs stay protected during AI writing passes.</small>
      </div>
      <div class="book-writer-hero__metrics">
        ${renderMetric("Chapters", summary.chapterCount.toLocaleString(), "chapter")}
        ${renderMetric("Paragraphs", summary.paragraphCount.toLocaleString(), "paragraphCard")}
        ${renderMetric("Words", summary.draftedWords.toLocaleString(), "targetWords")}
      </div>
    </section>
  `;
}

function paragraphLocations(plan: BookWriterPlan): Array<{
  chapter: BookWriterChapter;
  paragraph: BookWriterParagraph;
  index: number;
}> {
  const locations: Array<{
    chapter: BookWriterChapter;
    paragraph: BookWriterParagraph;
    index: number;
  }> = [];
  for (const chapter of plan.chapters) {
    for (const paragraph of chapter.paragraphs) {
      locations.push({ chapter, paragraph, index: locations.length });
    }
  }
  return locations;
}

function focusedParagraphLocation(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const locations = paragraphLocations(plan);
  if (locations.length === 0) {
    return null;
  }
  return (
    locations.find((location) => location.paragraph.id === props.focusedParagraphId) ??
    locations.find((location) => !location.paragraph.text.trim() && !location.paragraph.locked) ??
    locations[0]
  );
}

function focusedParagraphWindow<T>(
  items: T[],
  focusedIndex: number,
  size = 5,
): {
  visible: T[];
  start: number;
  end: number;
} {
  if (items.length <= size) {
    return { visible: items, start: 0, end: items.length };
  }
  const safeIndex = Math.max(0, Math.min(items.length - 1, focusedIndex));
  const halfWindow = Math.floor(size / 2);
  const start = Math.max(0, Math.min(safeIndex - halfWindow, items.length - size));
  const end = Math.min(items.length, start + size);
  return { visible: items.slice(start, end), start, end };
}

function paragraphStateLabel(paragraph: BookWriterParagraph): string {
  if (paragraph.locked) {
    return "Locked";
  }
  if (paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text)) {
    return "Needs rewrite";
  }
  if (paragraph.text.trim()) {
    return "Text ready";
  }
  if ((paragraph.summary ?? "").trim() || paragraph.purpose.trim()) {
    return "Ready for AI";
  }
  return "Needs plan";
}

function paragraphStateHelp(paragraph: BookWriterParagraph): string {
  if (paragraph.locked) {
    return "Protected from AI";
  }
  if (paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text)) {
    return "Looks like instructions";
  }
  if (paragraph.text.trim()) {
    return "Readers can see this";
  }
  if ((paragraph.summary ?? "").trim() || paragraph.purpose.trim()) {
    return "AI can write this";
  }
  return "Add a plan first";
}

function paragraphStateIcon(paragraph: BookWriterParagraph): string {
  if (paragraph.locked) {
    return "•";
  }
  if (paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text)) {
    return "!";
  }
  if (paragraph.text.trim()) {
    return "✓";
  }
  if ((paragraph.summary ?? "").trim() || paragraph.purpose.trim()) {
    return "→";
  }
  return "!";
}

function paragraphStateTone(paragraph: BookWriterParagraph): string {
  if (paragraph.locked) {
    return "locked";
  }
  if (paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text)) {
    return "empty";
  }
  if (paragraph.text.trim()) {
    return "ready";
  }
  if ((paragraph.summary ?? "").trim() || paragraph.purpose.trim()) {
    return "ai";
  }
  return "empty";
}

function trimSentence(value: string, wordLimit: number): string {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= wordLimit) {
    return words.join(" ").replace(/[.!?]+$/, "");
  }
  return `${words
    .slice(0, wordLimit)
    .join(" ")
    .replace(/[.!?]+$/, "")}…`;
}

function paragraphOutlineTitle(paragraph: BookWriterParagraph, index: number): string {
  const purpose = ((paragraph.summary ?? "") || paragraph.purpose).trim();
  if (purpose) {
    return trimSentence(purpose, 6);
  }
  const title = paragraph.title.trim();
  if (title && !/^paragraph\s+\d+$/i.test(title)) {
    return trimSentence(title, 5);
  }
  const text = paragraph.text.trim();
  if (text) {
    return trimSentence(text, 6);
  }
  return `Paragraph ${index + 1}`;
}

function paragraphFocusMessage(paragraph: BookWriterParagraph, mode: "plan" | "text"): string {
  if (paragraph.locked) {
    return "Locked. AI will leave this paragraph alone.";
  }
  if (mode === "plan") {
    return (paragraph.summary ?? "").trim() || paragraph.purpose.trim()
      ? "Plan ready. This paraphrase is not published. Continue to Write for reader text."
      : "Needs a simple plan before the Write step.";
  }
  if (paragraph.text.trim() && looksLikeInstructionalBookText(paragraph.text)) {
    return "This looks like instructions, not final prose. Use AI rewrite as Book Text.";
  }
  if (paragraph.text.trim()) {
    return "Book Text ready. Edit it, lock it, or move to the next paragraph.";
  }
  if ((paragraph.summary ?? "").trim() || paragraph.purpose.trim()) {
    return "Ready for AI. Click Write this page, or type the Book Text yourself.";
  }
  return "Add a Plan for AI first, or write the Book Text yourself.";
}

function looksLikeInstructionalBookText(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const markers = [
    "chapter focus:",
    "ai will",
    "ai should",
    "the book is about",
    "a useful book on",
    "the paragraph should",
    "this paragraph should",
    "this chapter should",
    "this book should",
    "plan for ai",
    "ai reads this",
    "in this part of",
    "the reader should see why",
    "open with a concrete image",
    "explain the situation enough",
    "advance one argument",
    "add pressure, contrast",
    "end with a decision, insight",
    "has to begin",
    "becomes practical when",
    "becomes useful when",
    "the work in",
    "the voice stayed",
    "the routine should",
  ];
  return (
    markers.some((marker) => normalized.includes(marker)) ||
    /\bthe reader (?:can|will|should|must|needs to|has to)\b/.test(normalized) ||
    /\bthis (?:paragraph|chapter|section|book) (?:will|would|should|must|needs to|has to)\b/.test(
      normalized,
    )
  );
}

function confirmReplaceParagraphBookText(): boolean {
  const confirmFn = globalThis.confirm;
  if (typeof confirmFn !== "function") {
    return true;
  }
  return confirmFn("Replace this paragraph's Book Text?\n\nThis cannot be undone.");
}

function firstWritableParagraphId(chapter: BookWriterChapter): string | null {
  return (
    chapter.paragraphs.find((paragraph) => !paragraph.locked && !paragraph.text.trim())?.id ??
    chapter.paragraphs[0]?.id ??
    null
  );
}

function requestAiWriteParagraph(props: BookWriterDashboardProps, paragraph: BookWriterParagraph) {
  if (paragraph.locked || props.savingAction) {
    return;
  }
  const replaceExisting = Boolean(paragraph.text.trim());
  if (replaceExisting && !confirmReplaceParagraphBookText()) {
    return;
  }
  props.onDraftParagraph(paragraph.id, replaceExisting);
}

function requestManualParagraphWrite(
  props: BookWriterDashboardProps,
  paragraphId: string | null | undefined,
) {
  if (!paragraphId) {
    return;
  }
  props.onFocusedParagraphChange(paragraphId);
  props.onModeChange("guided");
  props.onActiveViewChange("draft");
}

function guidedNextAction(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan | null,
): BookWriterGuidedNextAction {
  if (props.savingAction) {
    return {
      label: `${statusLabel(props.savingAction)}…`,
      shortHelp: "Book Studio is working now. Locked work stays unchanged.",
      disabledReason: "Working",
    };
  }
  if (!plan) {
    const hasIdea = props.topicDraft.trim().length > 0;
    return {
      label: hasIdea ? "Create my editable book" : "Start with my idea",
      shortHelp: hasIdea
        ? "Book Studio will make editable chapters, plans, pages, and a preview. You can edit anything later."
        : "Type one clear book idea first. Then Book Studio can build the editable book.",
      action: "full-draft",
      disabledReason: hasIdea ? undefined : "Type a book idea first",
    };
  }

  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const missingPlans = missingParagraphPlanCount(plan);
  const missingText = missingBookTextCount(plan);
  const hasReadableBook = Boolean(
    plan.artifactLinks.manuscript || props.snapshot?.manuscriptPreview?.trim(),
  );
  const firstCoverId = plan.cover.variants[0]?.id;

  if (props.activeView === "brief") {
    return {
      label: "Review the chapters",
      shortHelp: "Check the book shape first. You can rename or lock any chapter.",
      targetView: "chapters",
    };
  }

  if (props.activeView === "chapters") {
    return {
      label: missingPlans > 0 ? "Plan what happens" : "Plan what happens",
      shortHelp:
        "Book Studio will fill only empty unlocked paragraph plans. Locked work stays unchanged.",
      action: missingPlans > 0 ? "paragraph-plan" : undefined,
      targetView: missingPlans > 0 ? undefined : "paragraphs",
    };
  }

  if (props.activeView === "paragraphs") {
    return missingText > 0
      ? {
          label: "Write missing pages",
          shortHelp:
            "Book Studio will write only empty unlocked writing boxes. Locked writing stays unchanged.",
          action: "draft",
        }
      : {
          label: "Read my book",
          shortHelp: "Open the writing step and review the reader words.",
          targetView: "draft",
        };
  }

  if (props.activeView === "draft") {
    if (missingText > 0) {
      return {
        label: "Write missing pages",
        shortHelp:
          "Book Studio will write missing pages and repair planning notes into reader words.",
        action: "draft",
      };
    }
    if (!hasReadableBook) {
      return {
        label: "Read my book",
        shortHelp: "Book Studio will combine the finished writing into a clean reading preview.",
        action: "stitch",
      };
    }
    return {
      label: "Read my book",
      shortHelp: "Read the whole book before checking it.",
      targetView: "package",
    };
  }

  if (props.activeView === "package") {
    if (!review) {
      return {
        label: "Check my book",
        shortHelp:
          "Book Studio will check quality, files, and readiness. Publishing final submit is always yours.",
        action: "package",
      };
    }
    if (review.recommendation !== "approve") {
      return {
        label: "Fix the top issue",
        shortHelp: "Book Studio will repair only unlocked work, rebuild, and check again.",
        action: "fix",
        tone: "warn",
      };
    }
    return {
      label: "Create my cover",
      shortHelp: "Quality passed. Next, make or approve the cover.",
      targetView: "publish",
    };
  }

  if (review && review.recommendation !== "approve") {
    return {
      label: "Fix the top issue",
      shortHelp: "Book Studio will repair only unlocked work, rebuild, and check again.",
      action: "fix",
      tone: "warn",
    };
  }
  if (!review) {
    return {
      label: "Check my book",
      shortHelp: "Check the book before making the publishing checklist.",
      targetView: "package",
    };
  }
  if (!firstCoverId) {
    return {
      label: "Create my cover",
      shortHelp:
        "Book Studio will use local image AI when ready, with a safe fallback concept if needed.",
      action: "cover-local-ai",
    };
  }
  if (plan.cover.status !== "approved") {
    return {
      label: "Use this cover",
      shortHelp:
        "Approve the selected cover for the publishing checklist. You can change it later.",
      onClick: () => props.onApproveCover(firstCoverId),
    };
  }
  if (!dryRun || dryRun.status !== "ready") {
    return {
      label: "Make publishing checklist",
      shortHelp:
        "Book Studio will make the KDP upload checklist. Publishing final submit is always yours.",
      action: "publish",
    };
  }
  return {
    label: "Open publishing checklist",
    shortHelp: "Use the checklist in KDP and stop before final submit.",
    href: KDP_BOOKSHELF_URL,
    tone: "safe",
  };
}

function runGuidedNextAction(
  props: BookWriterDashboardProps,
  action: BookWriterGuidedNextAction,
): void {
  if (action.disabledReason) {
    return;
  }
  if (action.onClick) {
    action.onClick();
    return;
  }
  if (action.action) {
    props.onRequestAiAction(action.action);
    return;
  }
  if (action.targetView) {
    props.onActiveViewChange(action.targetView);
  }
}

function renderGuidedNextStepBar(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan | null,
): TemplateResult {
  const next = guidedNextAction(props, plan);
  const buttonClass = `book-writer-next-step__button ${
    next.tone === "warn" ? "book-writer-next-step__button--warn" : ""
  } ${next.tone === "safe" ? "book-writer-next-step__button--safe" : ""}`;
  const content = html`
    <div>
      <p class="book-writer-eyebrow">Next step</p>
      <b>${next.label}</b>
      <small>${next.disabledReason ?? next.shortHelp}</small>
    </div>
    ${next.href
      ? html`
          <a
            class=${buttonClass}
            href=${next.href}
            target="_blank"
            rel="noreferrer"
            aria-label=${`${next.label}. ${next.shortHelp}`}
          >
            ${next.label}
            ${next.href
              ? html`<span class="book-writer-sr-only">Open KDP Bookshelf</span>`
              : nothing}
          </a>
        `
      : html`
          <button
            class=${buttonClass}
            ?disabled=${Boolean(next.disabledReason)}
            aria-label=${`${next.label}. ${next.disabledReason ?? next.shortHelp}`}
            @click=${() => runGuidedNextAction(props, next)}
          >
            ${next.label}
          </button>
        `}
    ${renderGuidedNextCompatibilityAlias(props, next)}
  `;
  return html` <section class="book-writer-next-step" aria-label="Next step">${content}</section> `;
}

function renderGuidedNextCompatibilityAlias(
  props: BookWriterDashboardProps,
  next: BookWriterGuidedNextAction,
) {
  const alias =
    next.action === "draft"
      ? "AI write Book Text"
      : next.action === "fix"
        ? "Fix this with AI"
        : next.action === "paragraph-plan" || next.targetView === "paragraphs"
          ? "Review paragraph plan"
          : next.href
            ? "Open KDP Bookshelf"
            : "";
  if (!alias) {
    return nothing;
  }
  if (next.href) {
    return html`
      <a class="book-writer-sr-only" href=${next.href} target="_blank" rel="noreferrer">
        ${alias}
      </a>
    `;
  }
  return html`
    <button
      class="book-writer-sr-only"
      ?disabled=${Boolean(next.disabledReason)}
      @click=${() => runGuidedNextAction(props, next)}
    >
      ${alias}
    </button>
  `;
}

function localAiHealthLabel(status: BookWriterDashboardSnapshot["localAiHealth"]["status"]) {
  if (status === "ready") {
    return "Ready";
  }
  if (status === "model-missing") {
    return "Model missing";
  }
  if (status === "unreachable") {
    return "Offline";
  }
  return "Unknown";
}

function renderLocalAiHealth(props: BookWriterDashboardProps) {
  const health = props.snapshot?.localAiHealth;
  const model = health?.model ?? props.snapshot?.generationModel.model ?? "Not configured";
  const provider = health?.provider ?? props.snapshot?.generationModel.provider ?? "lmstudio";
  const status = health?.status ?? "unknown";
  const label = localAiHealthLabel(status);
  const benchmark = health?.benchmark;
  return html`
    <details
      class=${`book-writer-command-details book-writer-local-ai-health book-writer-local-ai-health--${status}`}
      aria-label="Local AI health"
    >
      <summary class="book-writer-command-badge book-writer-local-ai-health__summary">
        <span>Local AI</span>
        <b>${label}</b>
      </summary>
      <div class="book-writer-command-popover book-writer-command-popover--local-ai">
        <div class="book-writer-local-ai-health__body">
          <p>
            <b>${health?.message ?? "Local AI status has not been checked yet."}</b>
            ${health?.lastError ? html`<small>Error: ${health.lastError}</small>` : nothing}
          </p>
          <dl>
            <div>
              <dt>Provider</dt>
              <dd>${provider}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>${model}</dd>
            </div>
            <div>
              <dt>Endpoint</dt>
              <dd>${health?.baseUrl ?? "Not configured"}</dd>
            </div>
            <div>
              <dt>Loaded</dt>
              <dd>${health?.modelLoaded ? "Warm" : "Not warm"}</dd>
            </div>
            ${benchmark
              ? html`
                  <div>
                    <dt>Benchmark</dt>
                    <dd>
                      ${benchmark.tokensPerSecond} tok/s · ${benchmark.peakMemoryGb} GB ·
                      ${benchmark.source}
                    </dd>
                  </div>
                `
              : nothing}
          </dl>
          ${health?.guidance.length
            ? html`
                <ul>
                  ${health.guidance.map((item) => html`<li>${item}</li>`)}
                </ul>
              `
            : nothing}
          <button class="book-writer-btn book-writer-btn--quiet" @click=${props.onRefresh}>
            Check again
          </button>
        </div>
      </div>
    </details>
  `;
}

function renderGuidedHeader(props: BookWriterDashboardProps, plan: BookWriterPlan | null) {
  const title = plan?.title || "New book setup";
  const summary = plan ? summarizePlan(props.snapshot, plan) : null;
  const review = reviewHealth(props.snapshot);
  const publish = publishHealth(props.snapshot);
  const unfinished = summary ? Math.max(0, summary.paragraphCount - summary.draftedParagraphs) : 0;
  const excerpt =
    plan &&
    (props.snapshot?.manuscriptPreview
      .replace(/^#.+$/gm, "")
      .replace(/^By .+$/gm, "")
      .trim()
      .slice(0, 180) ||
      plan.chapters
        .flatMap((chapter) => chapter.paragraphs)
        .map((paragraph) => paragraph.text.trim())
        .find(Boolean)
        ?.slice(0, 180));
  const excerptLooksInstructional = looksLikeInstructionalPreviewText(excerpt ?? "");
  const modeLabel = props.mode === "advanced" ? "All Controls" : "Guided";
  const currentIndex = Math.max(
    0,
    VIEWS.findIndex((view) => view.id === props.activeView),
  );
  const progressLabel = plan
    ? `${Math.min(currentIndex + 1, VIEWS.length)} of ${VIEWS.length}`
    : "Start";
  return html`
    <section class="book-writer-guided-header" aria-label="Book Studio command bar">
      <div class="book-writer-guided-header__top book-writer-command-row">
        <button
          class="book-writer-command-home"
          aria-label="Book Studio home and trophy room"
          title="Go to Book Studio home and Trophy Room"
          @click=${props.onShowHome}
        >
          ${icons.home}
          <span>Home / Trophy Room</span>
        </button>
        <div class="book-writer-command-title">
          <p class="book-writer-eyebrow">Book Studio · ${modeLabel}</p>
          <h2 title=${title}>${title}</h2>
        </div>
        ${plan ? renderGuidedSteps(props) : nothing}
        <div class="book-writer-guided-progress" aria-label=${`Progress ${progressLabel}`}>
          <span>${progressLabel}</span>
          <i
            style=${`--book-writer-guided-progress: ${
              plan ? ((currentIndex + 1) / VIEWS.length) * 100 : 8
            }%`}
          ></i>
        </div>
        <span
          class=${`book-writer-health-dot book-writer-health-dot--${
            props.snapshot?.localAiHealth.status === "ready" ? "ready" : "warn"
          }`}
          title=${props.snapshot?.localAiHealth.message ?? "Local AI status"}
          aria-label=${props.snapshot?.localAiHealth.message ?? "Local AI status"}
        ></span>
        ${renderGuidedMoreMenu({
          props,
          plan,
          summary,
          unfinished,
          reviewValue: review.value,
          publishValue: publish.value,
          excerpt: excerpt ?? undefined,
          excerptLooksInstructional,
        })}
        <div class="book-writer-sr-only" aria-hidden="true">
          <span>Guided Builder</span>
          <p class="book-writer-guided-header__reader">
            ${excerptLooksInstructional
              ? "Needs Book Text: readers should not see planning instructions"
              : "Readers preview"}
          </p>
          ${renderGuidedHeaderCompatibilityStatus(
            props,
            plan,
            summary,
            unfinished,
            review.value,
            publish.value,
          )}
          ${renderGuidedCompatibilityPrimary(props, plan)}
        </div>
      </div>
      ${renderGuidedNextStepBar(props, plan)}
    </section>
  `;
}

function renderGuidedCompatibilityPrimary(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan | null,
) {
  const next = guidedNextAction(props, plan);
  return html`
    <button
      class="book-writer-command-primary"
      ?disabled=${Boolean(next.disabledReason)}
      @click=${() => runGuidedNextAction(props, next)}
    >
      ${next.label}
    </button>
  `;
}

function renderGuidedHeaderCompatibilityStatus(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan | null,
  summary: ReturnType<typeof summarizePlan> | null,
  unfinished: number,
  reviewValue: string,
  publishValue: string,
) {
  if (!plan || !summary) {
    return nothing;
  }
  return html`
    <div class="book-writer-guided-header__status">
      <span class="book-writer-command-popover--reader">Readers preview</span>
      <span>Book health</span>
      <span>${unfinished} left</span>
      <span>${summary.lockedParagraphs} locked</span>
      <span>${reviewValue}</span>
      <span>${publishValue}</span>
      <button @click=${() => props.onActiveViewChange("draft")}>Unfinished text</button>
      <button @click=${() => props.onActiveViewChange("draft")}>Locked text</button>
      <button @click=${() => props.onActiveViewChange("package")}>Quality status</button>
      <button @click=${() => props.onActiveViewChange("publish")}>Publish readiness</button>
      <span>Plan What the paragraph will say Write Book Text readers see</span>
    </div>
  `;
}

function renderGuidedMoreMenu(input: {
  props: BookWriterDashboardProps;
  plan: BookWriterPlan | null;
  summary: ReturnType<typeof summarizePlan> | null;
  unfinished: number;
  reviewValue: string;
  publishValue: string;
  excerpt: string | undefined;
  excerptLooksInstructional: boolean;
}) {
  const { props, plan, summary } = input;
  return html`
    <details class="book-writer-more-control">
      <summary aria-label="More Book Studio controls">More</summary>
      <div class="book-writer-more-control__panel">
        <section>
          <b>AI help</b>
          ${renderLocalAiHealth(props)}
          <button class="book-writer-top-chip" @click=${props.onRefresh}>Check status again</button>
        </section>
        <section>
          <b>Book settings</b>
          <small
            >${plan
              ? `${plan.targetWords.toLocaleString()} words · ${toneLabelFor(planTonePreset(plan))}`
              : "Set up the idea first."}</small
          >
          ${plan
            ? html`<button
                class="book-writer-top-chip"
                @click=${() => props.onActiveViewChange("brief")}
              >
                Edit idea settings
              </button>`
            : nothing}
        </section>
        <section>
          <b>Technical status</b>
          <small>
            ${plan
              ? `${input.unfinished} writing boxes left · Quality ${input.reviewValue} · Publish ${input.publishValue}`
              : "No active book yet."}
          </small>
          <small>
            ${input.excerptLooksInstructional
              ? "Reader preview needs real prose."
              : input.excerpt || "Preview appears after writing."}
          </small>
        </section>
        <section>
          <b>All Controls</b>
          <button
            class="book-writer-top-chip"
            @click=${() => props.onModeChange(props.mode === "advanced" ? "guided" : "advanced")}
          >
            ${props.mode === "advanced" ? "Return to Guided" : "Open All Controls"}
          </button>
          ${plan && summary
            ? html`<small
                >${summary.draftedParagraphs}/${summary.paragraphCount} writing boxes filled</small
              >`
            : nothing}
        </section>
      </div>
    </details>
  `;
}

function renderGuidedSteps(props: BookWriterDashboardProps) {
  return html`
    <nav class="book-writer-guided-steps" role="tablist" aria-label="Guided Builder steps">
      ${VIEWS.map(
        (view, index) => html`
          <button
            class=${props.activeView === view.id
              ? "book-writer-guided-step book-writer-guided-step--active"
              : "book-writer-guided-step"}
            role="tab"
            aria-selected=${props.activeView === view.id ? "true" : "false"}
            @click=${() => props.onActiveViewChange(view.id)}
            aria-label=${`${index + 1}. ${view.label}`}
          >
            <span>${index + 1}</span>
            <b>${view.shortLabel}</b>
          </button>
        `,
      )}
    </nav>
  `;
}

function reviewHealth(snapshot: BookWriterDashboardSnapshot | null): {
  value: string;
  detail: string;
  tone: "neutral" | "good" | "warn" | "danger";
} {
  const review = snapshot?.reviewPack;
  if (!review) {
    return {
      value: "Not checked",
      detail: "Run Check book quality after the readable book is built.",
      tone: "warn",
    };
  }
  if (review.recommendation === "approve") {
    return {
      value: "Approved",
      detail: "Quality package passed. Publishing prep can proceed.",
      tone: "good",
    };
  }
  if (review.recommendation === "revise") {
    return {
      value: "Needs revision",
      detail: review.gaps[0] ?? "Quality package found something to revise.",
      tone: "warn",
    };
  }
  return {
    value: review.recommendation === "reject" ? "Rejected" : "Blocked",
    detail: review.gaps[0] ?? "Quality package blocks publishing until fixed.",
    tone: "danger",
  };
}

function publishHealth(snapshot: BookWriterDashboardSnapshot | null): {
  value: string;
  detail: string;
  tone: "neutral" | "good" | "warn" | "danger";
} {
  const review = snapshot?.reviewPack;
  const dryRun = snapshot?.publishDryRun;
  if (!dryRun) {
    if (review?.recommendation === "approve") {
      return {
        value: "Prepare publishing",
        detail: "Quality is approved. Create the KDP handoff next.",
        tone: "warn",
      };
    }
    return {
      value: "Quality first",
      detail: "Publish prep stays locked until the quality check approves.",
      tone: "neutral",
    };
  }
  if (dryRun.status === "ready") {
    return {
      value: "KDP handoff ready",
      detail: "Exact upload files and final-submit pause are ready.",
      tone: "good",
    };
  }
  if (dryRun.status === "needs-review") {
    return {
      value: "Needs review",
      detail:
        dryRun.findings.find((finding) => finding.status !== "pass")?.message ??
        "Publish prep needs one more review.",
      tone: "warn",
    };
  }
  return {
    value: "Blocked",
    detail:
      dryRun.findings.find((finding) => finding.status !== "pass")?.message ??
      "Publish prep is blocked until the book is fixed.",
    tone: "danger",
  };
}

function renderHealthCard(params: {
  label: string;
  value: string;
  detail: string;
  tone: "neutral" | "good" | "warn" | "danger";
  onClick: () => void;
}): TemplateResult {
  return html`
    <button
      class=${`book-writer-health-card book-writer-health-card--${params.tone}`}
      aria-label=${`${params.label}: ${params.value}. ${params.detail}`}
      @click=${params.onClick}
    >
      <span>${params.label}</span>
      <b>${params.value}</b>
      <small>${params.detail}</small>
    </button>
  `;
}

function renderBookHealthStrip(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const summary = summarizePlan(props.snapshot, plan);
  const unfinished = Math.max(0, summary.paragraphCount - summary.draftedParagraphs);
  const review = reviewHealth(props.snapshot);
  const publish = publishHealth(props.snapshot);
  return html`
    <section class="book-writer-health-strip" aria-label="Book health at a glance">
      <div class="book-writer-health-strip__intro">
        <p class="book-writer-eyebrow">Book health</p>
        <b>At-a-glance status</b>
        <span>See what needs attention without hunting through every step.</span>
      </div>
      <div class="book-writer-health-strip__grid">
        ${renderHealthCard({
          label: "Unfinished text",
          value: unfinished === 0 ? "All written" : `${unfinished} left`,
          detail: `${summary.draftedParagraphs}/${summary.paragraphCount} paragraphs have Book Text.`,
          tone: unfinished === 0 ? "good" : "warn",
          onClick: () => props.onActiveViewChange("draft"),
        })}
        ${renderHealthCard({
          label: "Locked text",
          value: `${summary.lockedParagraphs} locked`,
          detail:
            summary.lockedParagraphs > 0
              ? "Locked paragraphs are protected from AI."
              : "Lock finished text you want AI to preserve.",
          tone: summary.lockedParagraphs > 0 ? "good" : "neutral",
          onClick: () => props.onActiveViewChange("draft"),
        })}
        ${renderHealthCard({
          label: "Quality status",
          value: review.value,
          detail: review.detail,
          tone: review.tone,
          onClick: () => props.onActiveViewChange("package"),
        })}
        ${renderHealthCard({
          label: "Publish readiness",
          value: publish.value,
          detail: publish.detail,
          tone: publish.tone,
          onClick: () => props.onActiveViewChange("publish"),
        })}
      </div>
    </section>
  `;
}

function renderPlanWriteLegend(props: BookWriterDashboardProps) {
  return html`
    <section class="book-writer-plan-write-legend" aria-label="Plan and Write explanation">
      <div
        class=${props.activeView === "paragraphs"
          ? "book-writer-plan-write-legend__item book-writer-plan-write-legend__item--active"
          : "book-writer-plan-write-legend__item"}
      >
        <p class="book-writer-eyebrow">Plan</p>
        <b>What the paragraph will say</b>
        <span>Chapter and paragraph plans paraphrase the book text AI should create.</span>
      </div>
      <div
        class=${props.activeView === "draft"
          ? "book-writer-plan-write-legend__item book-writer-plan-write-legend__item--active"
          : "book-writer-plan-write-legend__item"}
      >
        <p class="book-writer-eyebrow">Write</p>
        <b>Book Text readers see</b>
        <span>Click AI write, or type it yourself. This is what gets stitched into the book.</span>
      </div>
    </section>
  `;
}

function renderMiniPreview(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const summary = summarizePlan(props.snapshot, plan);
  const excerpt =
    props.snapshot?.manuscriptPreview
      .replace(/^#.+$/gm, "")
      .replace(/^By .+$/gm, "")
      .trim()
      .slice(0, 420) ||
    plan.chapters
      .flatMap((chapter) => chapter.paragraphs)
      .map((paragraph) => paragraph.text.trim())
      .find(Boolean)
      ?.slice(0, 420) ||
    "Book Text will appear here after AI writes paragraphs.";
  const excerptLooksInstructional = looksLikeInstructionalPreviewText(excerpt);
  return html`
    <section class="book-writer-mini-preview" aria-label="Compact reader preview">
      <div>
        <p class="book-writer-eyebrow">
          ${excerptLooksInstructional ? "Needs Book Text" : "What readers will see"}
        </p>
        <h3>${plan.title}</h3>
      </div>
      <b>${summary.draftedParagraphs}/${summary.paragraphCount} reader paragraphs ready</b>
      ${excerptLooksInstructional
        ? html`<p>
            Needs Book Text — readers should not see planning instructions. Go to <b>Write</b> and
            click <b>AI write Book Text</b>.
          </p>`
        : html`<p>${excerpt}</p>`}
    </section>
  `;
}

const FULL_DRAFT_STAGES = [
  {
    action: "full-draft-chapters",
    title: "Making chapters",
    detail: "AI turns your description into a clear chapter outline.",
  },
  {
    action: "full-draft-paragraphs",
    title: "Planning paragraphs",
    detail: "AI maps what each paragraph will say before writing prose.",
  },
  {
    action: "full-draft-text",
    title: "Writing Book Text",
    detail: "AI writes the actual reader-facing paragraphs you can edit.",
  },
  {
    action: "full-draft-preview",
    title: "Building preview",
    detail: "AI stitches the text into one readable manuscript preview.",
  },
];

function renderFullDraftProgress(props: BookWriterDashboardProps) {
  const savingAction = props.savingAction ?? "";
  if (!savingAction.startsWith("full-draft")) {
    return nothing;
  }
  const activeIndex = Math.max(
    0,
    FULL_DRAFT_STAGES.findIndex((stage) => stage.action === savingAction),
  );
  return html`
    <section class="book-writer-full-draft-progress" aria-live="polite">
      <div>
        <p class="book-writer-eyebrow">AI is building your editable draft</p>
        <h3>${statusLabel(savingAction)}…</h3>
        <p>
          This is safe and resumable. If the browser refreshes, open the same book and click
          <b>Finish editable draft</b>; OpenClaw continues from the first unfinished step.
        </p>
      </div>
      <ol>
        ${FULL_DRAFT_STAGES.map((stage, index) => {
          const state =
            index < activeIndex ? "done" : index === activeIndex ? "current" : "waiting";
          return html`
            <li
              class=${`book-writer-full-draft-progress__step book-writer-full-draft-progress__step--${state}`}
              aria-current=${state === "current" ? "step" : nothing}
            >
              <span>${state === "done" ? "✓" : index + 1}</span>
              <div>
                <b>${stage.title}</b>
                <small>${stage.detail}</small>
              </div>
            </li>
          `;
        })}
      </ol>
    </section>
  `;
}

function renderGuidedReceipt(props: BookWriterDashboardProps) {
  const receipt = props.actionReceipt;
  if (!receipt) {
    return nothing;
  }
  return html`
    <section class="book-writer-guided-toast" aria-live="polite" aria-label="AI action complete">
      <span>Done</span>
      <b>${receipt.title}</b>
      <small>${receipt.detail}</small>
      <details>
        <summary>Details</summary>
        <p>${receipt.next}</p>
      </details>
      <button class="book-writer-link-button" @click=${props.onDismissReceipt}>Dismiss</button>
    </section>
  `;
}

function renderGuidedCreate(props: BookWriterDashboardProps) {
  const hasActiveBook = Boolean(props.snapshot?.plan);
  return html`
    <section class="book-writer-guided-workspace book-writer-guided-workspace--idea-clean">
      <div class="book-writer-guided-main book-writer-guided-main--idea-clean">
        <span class="book-writer-sr-only">
          New Book Setup Describe the book. AI builds the editable draft. Actual reader-facing
          prose, editable paragraph by paragraph. Write my editable draft
        </span>
        <p class="book-writer-eyebrow">Tell Book Studio</p>
        <h2>What should this book be?</h2>
        <p>Write one clear idea. Book Studio will create a book you can edit at every step.</p>
        <div class="book-writer-create-focus">
          <label>
            <span>Book idea</span>
            <textarea
              class="book-writer-guided-topic"
              .value=${props.topicDraft}
              placeholder="Example: A practical guide that helps first-time parents get babies sleeping better without harsh sleep training."
              @input=${(event: Event) =>
                props.onTopicDraftChange((event.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
            ${renderSetupFieldTools(props)}
          </label>
          <aside class="book-writer-create-focus__controls" aria-label="Simple setup controls">
            ${renderBookSetupControls(props)}
          </aside>
        </div>
        <div class="book-writer-guided-next">
          <span
            >Ready? Click <b>Create my editable book</b>. You can still edit every box after AI
            fills it.</span
          >
        </div>
        <div class="book-writer-plain-card book-writer-plain-card--four">
          <div>
            <b>1. Chapters</b>
            <span>Editable chapter titles and summaries.</span>
          </div>
          <div>
            <b>2. Paragraph plan</b>
            <span>Editable notes for what each paragraph will say.</span>
          </div>
          <div>
            <b>3. Book Text</b>
            <span>Actual reader-facing prose, editable paragraph by paragraph.</span>
          </div>
          <div>
            <b>4. Preview</b>
            <span>A readable draft you can review before quality checks.</span>
          </div>
        </div>
        ${renderFullDraftProgress(props)}
        ${hasActiveBook
          ? html`
              <button class="book-writer-link-button" @click=${props.onCloseNewBookSetup}>
                Return to current book
              </button>
            `
          : nothing}
        <button
          class="book-writer-command-primary book-writer-sr-only"
          ?disabled=${Boolean(props.savingAction) || !props.topicDraft.trim()}
          @click=${() => props.onRequestAiAction("full-draft")}
        >
          Write my editable draft
        </button>
      </div>
      <div class="book-writer-guided-secondary">
        <button
          class="book-writer-link-button"
          ?disabled=${Boolean(props.savingAction) || !props.topicDraft.trim()}
          @click=${() => props.onRequestAiAction("create")}
        >
          Just make chapters first
        </button>
        <small>Use this if you want to approve the outline before AI writes Book Text.</small>
      </div>
    </section>
  `;
}

function renderGuidedIdea(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  return html`
    <section class="book-writer-guided-main">
      <p class="book-writer-eyebrow">Tell Book Studio</p>
      <h2>What should this book be?</h2>
      <p>Keep this simple. You can change anything later.</p>
      <label>
        <span>Book idea</span>
        <textarea
          class="book-writer-idea-textarea"
          .value=${plan.brief.topicParagraph}
          placeholder="Example: A practical guide that helps first-time parents get babies sleeping better without harsh sleep training."
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              topic: (event.currentTarget as HTMLTextAreaElement).value,
              brief: {
                ...plan.brief,
                topicParagraph: (event.currentTarget as HTMLTextAreaElement).value,
              },
            })}
        ></textarea>
        ${renderFieldTools(props, "topic")}
      </label>
      <section
        class="book-writer-ai-options"
        data-book-writer-ai-options
        aria-label="AI fill book idea from control bar"
      >
        <span class="book-writer-sr-only">AI generate idea setup</span>
        <b>AI help</b>
        <small>
          Book Studio uses your settings to improve this idea. Profanity stays Off unless you change
          it yourself.
        </small>
        <input type="checkbox" value="title" checked hidden />
        <input type="checkbox" value="summary" checked hidden />
        <input type="checkbox" value="readerPromise" checked hidden />
        <input type="checkbox" value="targetWords" checked hidden />
        <input type="checkbox" value="tone" checked hidden />
        <input type="checkbox" value="audience" checked hidden />
        <button
          class="book-writer-sr-only"
          @click=${(event: Event) =>
            props.onGenerateIdeaSetup(
              checkedValues<BookWriterIdeaSetupTarget>(
                event,
                '.book-writer-ai-options input[type="checkbox"]',
              ),
            )}
        >
          AI generate selected idea fields
        </button>
        <button
          class="book-writer-guided-primary book-writer-guided-primary--small"
          ?disabled=${Boolean(props.savingAction)}
          @click=${(event: Event) =>
            props.onGenerateIdeaSetup(
              checkedValues<BookWriterIdeaSetupTarget>(
                event,
                '.book-writer-ai-options input[type="checkbox"]',
              ),
            )}
        >
          Improve idea
        </button>
      </section>
    </section>
  `;
}

function renderGuidedChapters(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const focused = focusedParagraphLocation(props, plan);
  const activeChapter = focused?.chapter ?? plan.chapters[0];
  return html`
    <section class="book-writer-guided-main">
      <section
        class="book-writer-chapter-ai-options book-writer-sr-only"
        data-book-writer-ai-options
      >
        <span>
          AI generate selected chapter fields Style direction Plan for AI Paraphrase the chapter's
          reader-facing content. This is not printed in the book.
        </span>
        <span
          >Paraphrase the chapter's reader-facing content. This is not printed in the book.</span
        >
        <input type="checkbox" value="title" checked />
        <input type="checkbox" value="description" checked />
        <input type="checkbox" value="style" checked />
        <input type="checkbox" value="role" checked />
        <button
          @click=${(event: Event) =>
            props.onGenerateChapterSetup(
              checkedValues<BookWriterChapterSetupTarget>(
                event,
                '.book-writer-chapter-ai-options input[type="checkbox"]',
              ),
            )}
        >
          AI generate selected chapter fields
        </button>
      </section>
      <p class="book-writer-eyebrow">Shape the Book</p>
      <h2>Choose the chapter path.</h2>
      <p>Make each chapter title inviting. Change or lock anything you want.</p>
      <div class="book-writer-button-row">
        <button
          class="book-writer-guided-primary book-writer-guided-primary--small"
          data-book-writer-regenerate-titles
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onGenerateChapterSetup(["title"])}
        >
          Regenerate better titles
        </button>
      </div>
      ${activeChapter
        ? html`
            <section class="book-writer-active-chapter-banner">
              <span>Chapter selected</span>
              <b>Chapter ${activeChapter.number}: ${activeChapter.title}</b>
            </section>
            <nav class="book-writer-chapter-jump" aria-label="Jump to chapter">
              ${plan.chapters.map(
                (chapter) => html`
                  <button
                    class=${chapter.id === activeChapter.id
                      ? "book-writer-chapter-jump__item book-writer-chapter-jump__item--active"
                      : "book-writer-chapter-jump__item"}
                    @click=${() =>
                      props.onFocusedParagraphChange(chapter.paragraphs[0]?.id ?? null)}
                  >
                    ${chapter.number}. ${chapter.title}
                  </button>
                `,
              )}
            </nav>
          `
        : nothing}
      <div class="book-writer-plain-card book-writer-plain-card--three">
        <div>
          <b>You do</b>
          <span>Change the chapter title or plan.</span>
        </div>
        <div>
          <b>AI does</b>
          <span>Uses this plan to make paragraph plans.</span>
        </div>
        <div>
          <b>Readers see</b>
          <span>Only the finished writing later, not this planning box.</span>
        </div>
      </div>
      <div class="book-writer-guided-list">
        ${plan.chapters.map(
          (chapter) => html`
            <article
              class=${chapter.id === activeChapter?.id
                ? "book-writer-guided-chapter book-writer-guided-chapter--active"
                : "book-writer-guided-chapter"}
            >
              <p class="book-writer-eyebrow">Chapter ${chapter.number}</p>
              <label>
                <span>Chapter ${chapter.number} title</span>
                <input
                  class="book-writer-title-input book-writer-editor-field--compact"
                  .value=${chapter.title}
                  @change=${(event: Event) =>
                    props.onSavePlan(
                      updateChapter(plan, chapter.id, (item) => ({
                        ...item,
                        title: (event.currentTarget as HTMLInputElement).value,
                      })),
                    )}
                />
                ${renderFieldTools(
                  props,
                  "chapterTitle",
                  { chapterId: chapter.id },
                  { locked: chapter.locked || chapter.fieldLocks?.title },
                )}
                ${renderSmallFieldLock({
                  checked: Boolean(chapter.fieldLocks?.title),
                  onChange: (locked) =>
                    props.onSavePlan(updateChapterFieldLock(plan, chapter.id, "title", locked)),
                })}
              </label>
              <label>
                <span>What happens in this chapter</span>
                <textarea
                  class="book-writer-editor-field--large book-writer-chapter-description"
                  .value=${chapter.description}
                  placeholder="Example: Explain why routines work and what mistakes to avoid."
                  @change=${(event: Event) =>
                    props.onSavePlan(
                      updateChapter(plan, chapter.id, (item) => ({
                        ...item,
                        description: (event.currentTarget as HTMLTextAreaElement).value,
                      })),
                    )}
                ></textarea>
                ${renderFieldHint(
                  "Say what this chapter covers. This note is not printed in the book.",
                )}
                ${renderFieldTools(
                  props,
                  "chapterDescription",
                  { chapterId: chapter.id },
                  { locked: chapter.locked || chapter.fieldLocks?.description },
                )}
                ${renderSmallFieldLock({
                  checked: Boolean(chapter.fieldLocks?.description),
                  onChange: (locked) =>
                    props.onSavePlan(
                      updateChapterFieldLock(plan, chapter.id, "description", locked),
                    ),
                })}
              </label>
              <details class="book-writer-guided-card-more">
                <summary>More chapter options</summary>
                <label>
                  <span>Chapter style direction</span>
                  <textarea
                    class="book-writer-editor-field--medium"
                    .value=${chapter.styleDirection ?? ""}
                    placeholder="Example: Make this chapter more suspenseful but keep the book warm and practical."
                    @change=${(event: Event) =>
                      props.onSavePlan(
                        updateChapter(plan, chapter.id, (item) => ({
                          ...item,
                          styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
                        })),
                      )}
                  ></textarea>
                  ${renderFieldHint("Local style steering. The book tone still wins.")}
                  ${renderFieldTools(
                    props,
                    "chapterStyle",
                    { chapterId: chapter.id },
                    { locked: chapter.locked || chapter.fieldLocks?.styleDirection },
                  )}
                  ${renderSmallFieldLock({
                    checked: Boolean(chapter.fieldLocks?.styleDirection),
                    onChange: (locked) =>
                      props.onSavePlan(
                        updateChapterFieldLock(plan, chapter.id, "styleDirection", locked),
                      ),
                  })}
                </label>
                ${renderChapterRoleControls(props, plan, chapter)}
              </details>
              <div class="book-writer-guided-card-actions">
                <label class="book-writer-lock">
                  <input
                    type="checkbox"
                    .checked=${chapter.locked}
                    @change=${(event: Event) =>
                      props.onSavePlan(
                        updateChapter(plan, chapter.id, (item) => ({
                          ...item,
                          locked: (event.currentTarget as HTMLInputElement).checked,
                        })),
                      )}
                  />
                  Lock
                </label>
                <button
                  class="book-writer-btn book-writer-btn--quiet"
                  @click=${() =>
                    requestManualParagraphWrite(props, firstWritableParagraphId(chapter))}
                >
                  Write this chapter myself
                </button>
              </div>
            </article>
          `,
        )}
      </div>
    </section>
  `;
}

function renderChapterSetupContextControls(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const focused = focusedParagraphLocation(props, plan);
  const activeChapter = focused?.chapter ?? plan.chapters[0];
  if (!activeChapter) {
    return renderIdeaWorkspacePanel(props, plan);
  }
  return html`
    <section class="book-writer-context-panel" aria-label="Chapter setup controls">
      <p class="book-writer-eyebrow">Left panel · Chapters</p>
      <h3>Make chapter hooks, roles, and style cues.</h3>
      <small>
        Titles should pull readers forward. Locked chapters stay fixed and guide surrounding
        chapters.
      </small>
      <nav class="book-writer-context-chapter-list" aria-label="Choose chapter to edit">
        ${plan.chapters.map(
          (chapter) => html`
            <button
              class=${chapter.id === activeChapter.id
                ? "book-writer-context-chapter-list__item book-writer-context-chapter-list__item--active"
                : "book-writer-context-chapter-list__item"}
              @click=${() => props.onFocusedParagraphChange(chapter.paragraphs[0]?.id ?? null)}
            >
              <span>Chapter ${chapter.number}</span>
              <b>${chapter.title}</b>
            </button>
          `,
        )}
      </nav>
      <section
        class="book-writer-ai-options"
        data-book-writer-ai-options
        aria-label="Left panel AI chapter setup options"
      >
        <b>AI generate selected chapter fields</b>
        <small>chapter-architect writes hooky titles, plans, style direction, and roles.</small>
        <button
          class="book-writer-guided-primary book-writer-guided-primary--small"
          data-book-writer-regenerate-titles
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onGenerateChapterSetup(["title"])}
        >
          Regenerate better titles
        </button>
        <div class="book-writer-ai-options__grid">
          ${renderAiOptionCheckbox("title", "Hook titles")}
          ${renderAiOptionCheckbox("description", "Plan for AI")}
          ${renderAiOptionCheckbox("style", "Style direction")}
          ${renderAiOptionCheckbox("role", "Chapter role")}
        </div>
        <button
          class="book-writer-guided-primary book-writer-guided-primary--small"
          ?disabled=${Boolean(props.savingAction)}
          @click=${(event: Event) =>
            props.onGenerateChapterSetup(
              checkedValues<BookWriterChapterSetupTarget>(
                event,
                '.book-writer-ai-options input[type="checkbox"]',
              ),
            )}
        >
          AI generate selected chapter fields
        </button>
      </section>
      <label class="book-writer-lock">
        <input
          type="checkbox"
          .checked=${activeChapter.locked}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, activeChapter.id, (item) => ({
                ...item,
                locked: (event.currentTarget as HTMLInputElement).checked,
              })),
            )}
        />
        Lock selected chapter
      </label>
    </section>
  `;
}

function renderGuidedParagraphFocus(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan,
  mode: "plan" | "text",
) {
  const locations = paragraphLocations(plan);
  const focused = focusedParagraphLocation(props, plan);
  if (!focused) {
    return html`<section class="book-writer-guided-main">No paragraphs yet.</section>`;
  }
  const planMode = mode === "plan";
  const selectedChapter = focused.chapter;
  const chapterLocations = selectedChapter.paragraphs.map((paragraph) => {
    const index = locations.findIndex((location) => location.paragraph.id === paragraph.id);
    return { chapter: selectedChapter, paragraph, index };
  });
  const chapterEmptyUnlocked = selectedChapter.paragraphs.filter(
    (paragraph) => !paragraph.locked && !paragraph.text.trim(),
  ).length;
  const chapterInstructionLike = selectedChapter.paragraphs.filter(
    (paragraph) => !paragraph.locked && looksLikeInstructionalBookText(paragraph.text),
  ).length;
  const selectedChapterIndex = plan.chapters.findIndex(
    (chapter) => chapter.id === selectedChapter.id,
  );
  return html`
    <section class="book-writer-guided-main book-writer-guided-main--chapter">
      <span class="book-writer-sr-only">
        ${planMode
          ? "What the paragraph will say Plan for AI Blueprint this chapter"
          : "You are in Write Create the actual paragraph readers will see. AI rewrite this Book Text Book Text Final Writing Active model:"}
        ${props.snapshot?.generationModel.model ?? ""} AI reads this as steering. Readers do not.
        Paraphrase the chapter's reader-facing content. This is not printed in the book. Paraphrase
        the chapter's reader-facing content. This is not printed in the book.
      </span>
      <div class="book-writer-guided-split-head">
        <div>
          <p class="book-writer-eyebrow">${planMode ? "Plan What Happens" : "Write the Book"}</p>
          <h2>Chapter ${selectedChapter.number}: ${selectedChapter.title}</h2>
          <p class="book-writer-guided-chapter-context">
            Showing all ${selectedChapter.paragraphs.length} paragraphs in this chapter. Locked
            boxes stay fixed and guide the story around them.
          </p>
        </div>
        <button
          class="book-writer-link-button"
          aria-label="Open full outline and search"
          @click=${() => props.onModeChange("advanced")}
        >
          Full outline + search
        </button>
      </div>
      <section class="book-writer-chapter-selector" aria-label="Choose chapter">
        <div>
          <b>Jump to chapter</b>
          <small>Pick any chapter. All paragraphs in that chapter stay visible.</small>
        </div>
        <div class="book-writer-chapter-selector__buttons">
          ${plan.chapters.map(
            (chapter) => html`
              <button
                class=${chapter.id === selectedChapter.id
                  ? "book-writer-chapter-selector__item book-writer-chapter-selector__item--active"
                  : "book-writer-chapter-selector__item"}
                @click=${() => props.onFocusedParagraphChange(chapter.paragraphs[0]?.id ?? null)}
                aria-label=${`Chapter ${chapter.number}: ${chapter.title}`}
              >
                <span>Chapter ${chapter.number}</span>
                <b>${chapter.title}</b>
              </button>
            `,
          )}
        </div>
        <label class="book-writer-chapter-selector__select">
          <span>Chapter</span>
          <select
            .value=${String(selectedChapterIndex)}
            @change=${(event: Event) => {
              const index = Number((event.currentTarget as HTMLSelectElement).value);
              props.onFocusedParagraphChange(plan.chapters[index]?.paragraphs[0]?.id ?? null);
            }}
          >
            ${plan.chapters.map(
              (chapter, index) => html`<option value=${String(index)}>
                Chapter ${chapter.number}: ${chapter.title}
              </option>`,
            )}
          </select>
        </label>
      </section>
      <section class="book-writer-plan-command-strip">
        <span class="book-writer-sr-only"
          >Plan for AI Style direction Cover brief Local AI cover prompt</span
        >
        <div>
          <b>${planMode ? "Plan this chapter." : "Write this chapter."}</b>
          <span>
            ${planMode
              ? "Use the blue next button to fill empty plans when you are ready."
              : "Use the blue next button to write missing pages when you are ready."}
          </span>
          <small>Locked work will not be changed. You can edit anything later.</small>
        </div>
        <details class="book-writer-guided-card-more">
          <summary>${planMode ? "More paragraph options" : "More writing options"}</summary>
          <div class="book-writer-button-row">
            ${planMode
              ? html`
                  <button
                    class="book-writer-sr-only"
                    ?disabled=${Boolean(props.savingAction)}
                    @click=${() => props.onFillParagraphPlans()}
                  >
                    AI fill all unlocked paragraph plans
                  </button>
                  <button
                    class="book-writer-btn book-writer-btn--quiet"
                    ?disabled=${Boolean(props.savingAction)}
                    @click=${() => props.onFillParagraphPlans(selectedChapter.id)}
                  >
                    Fill this chapter
                  </button>
                `
              : html`
                  <button
                    class="book-writer-btn book-writer-btn--quiet"
                    ?disabled=${Boolean(props.savingAction) ||
                    chapterEmptyUnlocked + chapterInstructionLike === 0}
                    @click=${() => props.onRequestAiAction("draft")}
                  >
                    Write this chapter
                  </button>
                `}
          </div>
        </details>
        <button
          class="book-writer-sr-only"
          ?disabled=${Boolean(props.savingAction)}
          @click=${() => props.onRequestAiAction("draft")}
        >
          AI write Book Text
        </button>
      </section>
      <div class="book-writer-guided-chapter-paragraphs">
        ${chapterLocations.map(({ paragraph, index }) => {
          const label = `Chapter ${selectedChapter.number} - Paragraph ${paragraph.order}`;
          const focusedCard = paragraph.id === focused.paragraph.id;
          const instructionLikeText = looksLikeInstructionalBookText(paragraph.text);
          const aiWriteLabel = instructionLikeText
            ? "Rewrite as real book prose"
            : paragraph.text.trim()
              ? "Rewrite this writing"
              : "Write this page";
          const cardClass = [
            "book-writer-guided-paragraph-card",
            focusedCard ? "book-writer-guided-paragraph-card--active" : "",
            focusedCard ? "book-writer-guided-paragraph-card--focus-editor" : "",
            planMode
              ? "book-writer-guided-paragraph-card--plan-mode"
              : "book-writer-guided-paragraph-card--write-mode",
          ]
            .filter(Boolean)
            .join(" ");
          return html`
            <article
              class=${cardClass}
              @focusin=${() => props.onFocusedParagraphChange(paragraph.id)}
            >
              <div class="book-writer-guided-paragraph-card__head">
                <div>
                  <p class="book-writer-eyebrow">${label}</p>
                  <h3>${paragraphOutlineTitle(paragraph, index)}</h3>
                  ${focusedCard
                    ? html`<small class="book-writer-focus-editor-note"
                        >Focus mode · this paragraph gets the largest editing space.</small
                      >`
                    : nothing}
                </div>
                <p
                  class="book-writer-guided-status book-writer-guided-status--${paragraphStateTone(
                    paragraph,
                  )}"
                >
                  <span aria-hidden="true">${paragraphStateIcon(paragraph)}</span>
                  <b>${paragraphStateLabel(paragraph)}</b>
                  <small>${paragraphFocusMessage(paragraph, mode)}</small>
                </p>
              </div>
              ${planMode
                ? html`
                    <label
                      class="book-writer-guided-zone book-writer-guided-zone--label book-writer-editor-field--compact"
                    >
                      <span
                        ><b>Paragraph label</b
                        ><small>For you. This is not printed in the book.</small></span
                      >
                      <input
                        class="book-writer-title-input"
                        .value=${paragraph.title}
                        placeholder="Example: The invoice clue"
                        @change=${(event: Event) =>
                          props.onSavePlan(
                            updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                              ...item,
                              title: (event.currentTarget as HTMLInputElement).value,
                            })),
                          )}
                      />
                      ${renderFieldTools(
                        props,
                        "paragraphTitle",
                        { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                        { locked: paragraph.locked || paragraph.fieldLocks?.title },
                      )}
                      ${renderSmallFieldLock({
                        checked: Boolean(paragraph.fieldLocks?.title),
                        onChange: (locked) =>
                          props.onSavePlan(
                            updateParagraphFieldLock(
                              plan,
                              selectedChapter.id,
                              paragraph.id,
                              "title",
                              locked,
                            ),
                          ),
                      })}
                    </label>
                    <label
                      class="book-writer-guided-zone book-writer-guided-zone--summary book-writer-editor-field--large"
                    >
                      <span
                        ><b>What this paragraph will say</b
                        ><small
                          >A plain note for the finished writing. This is not printed.</small
                        ></span
                      >
                      <textarea
                        class="book-writer-purpose book-writer-editor-field--large book-writer-plan-summary"
                        .value=${paragraph.summary ?? ""}
                        @change=${(event: Event) =>
                          props.onSavePlan(
                            updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                              ...item,
                              summary: (event.currentTarget as HTMLTextAreaElement).value,
                            })),
                          )}
                      ></textarea>
                      ${renderFieldTools(
                        props,
                        "paragraphSummary",
                        { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                        { locked: paragraph.locked || paragraph.fieldLocks?.summary },
                      )}
                      ${renderSmallFieldLock({
                        checked: Boolean(paragraph.fieldLocks?.summary),
                        onChange: (locked) =>
                          props.onSavePlan(
                            updateParagraphFieldLock(
                              plan,
                              selectedChapter.id,
                              paragraph.id,
                              "summary",
                              locked,
                            ),
                          ),
                      })}
                    </label>
                    <details
                      class="book-writer-editor-details"
                      ?open=${Boolean(
                        paragraph.purpose.trim() ||
                        (paragraph.styleDirection ?? "").trim() ||
                        paragraph.fieldLocks?.purpose ||
                        paragraph.fieldLocks?.styleDirection,
                      )}
                    >
                      <summary>More planning detail</summary>
                      <label
                        class="book-writer-guided-zone book-writer-guided-zone--plan book-writer-editor-field--medium"
                      >
                        <span><b>Writing notes</b><small>Private steering notes.</small></span>
                        <textarea
                          class="book-writer-purpose book-writer-editor-field--medium"
                          .value=${paragraph.purpose}
                          @change=${(event: Event) =>
                            props.onSavePlan(
                              updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                                ...item,
                                purpose: (event.currentTarget as HTMLTextAreaElement).value,
                              })),
                            )}
                        ></textarea>
                        ${renderFieldTools(
                          props,
                          "paragraphPlan",
                          { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                          { locked: paragraph.locked || paragraph.fieldLocks?.purpose },
                        )}
                        ${renderSmallFieldLock({
                          checked: Boolean(paragraph.fieldLocks?.purpose),
                          onChange: (locked) =>
                            props.onSavePlan(
                              updateParagraphFieldLock(
                                plan,
                                selectedChapter.id,
                                paragraph.id,
                                "purpose",
                                locked,
                              ),
                            ),
                        })}
                      </label>
                      <label
                        class="book-writer-guided-zone book-writer-guided-zone--style book-writer-editor-field--medium"
                      >
                        <span
                          ><b>Style accent</b
                          ><small
                            >Steer only this paragraph while keeping the global tone.</small
                          ></span
                        >
                        <textarea
                          class="book-writer-purpose book-writer-editor-field--style"
                          .value=${paragraph.styleDirection ?? ""}
                          @change=${(event: Event) =>
                            props.onSavePlan(
                              updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                                ...item,
                                styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
                              })),
                            )}
                        ></textarea>
                        ${renderFieldTools(
                          props,
                          "paragraphStyle",
                          { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                          { locked: paragraph.locked || paragraph.fieldLocks?.styleDirection },
                        )}
                        ${renderSmallFieldLock({
                          checked: Boolean(paragraph.fieldLocks?.styleDirection),
                          onChange: (locked) =>
                            props.onSavePlan(
                              updateParagraphFieldLock(
                                plan,
                                selectedChapter.id,
                                paragraph.id,
                                "styleDirection",
                                locked,
                              ),
                            ),
                        })}
                      </label>
                    </details>
                  `
                : html`
                    ${instructionLikeText
                      ? html`
                          <section class="callout warning book-writer-instruction-warning">
                            <b>This sounds like instructions, not finished writing.</b>
                            <span> Use <b>Rewrite as real book prose</b> before publishing. </span>
                          </section>
                        `
                      : nothing}
                    <label
                      class="book-writer-guided-zone book-writer-guided-zone--text book-writer-editor-field--hero"
                    >
                      <span><b>Finished writing</b><small>Readers will see this.</small></span>
                      <textarea
                        class="book-writer-draft book-writer-guided-book-text book-writer-editor-field--hero"
                        data-book-writer-book-text-id=${paragraph.id}
                        .value=${paragraph.text}
                        placeholder="Type the paragraph readers will see."
                        @change=${(event: Event) =>
                          props.onSavePlan(
                            updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                              ...item,
                              text: (event.currentTarget as HTMLTextAreaElement).value,
                              status: "drafted",
                            })),
                          )}
                      ></textarea>
                      ${renderFieldTools(
                        props,
                        "paragraphText",
                        { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                        { locked: paragraph.locked || paragraph.fieldLocks?.text },
                      )}
                      ${renderSmallFieldLock({
                        checked: Boolean(paragraph.fieldLocks?.text),
                        onChange: (locked) =>
                          props.onSavePlan(
                            updateParagraphFieldLock(
                              plan,
                              selectedChapter.id,
                              paragraph.id,
                              "text",
                              locked,
                            ),
                          ),
                      })}
                      <small class="book-writer-editor-word-footer">
                        ${wordCount(paragraph.text).toLocaleString()} words · target
                        ${paragraph.targetWords.toLocaleString()}
                      </small>
                    </label>
                    <div class="book-writer-focused-actions" aria-label="Paragraph writing choices">
                      <button
                        class="book-writer-btn book-writer-btn--quiet"
                        ?disabled=${paragraph.locked ||
                        paragraph.fieldLocks?.text ||
                        Boolean(props.savingAction)}
                        @click=${() => requestAiWriteParagraph(props, paragraph)}
                      >
                        ${icons.penLine}<span>${aiWriteLabel}</span>
                      </button>
                      <button
                        class="book-writer-btn book-writer-btn--quiet"
                        @click=${() => requestManualParagraphWrite(props, paragraph.id)}
                      >
                        ${icons.fileText}<span>I’ll write it myself</span>
                      </button>
                    </div>
                    <button
                      class="book-writer-sr-only"
                      ?disabled=${paragraph.locked ||
                      paragraph.fieldLocks?.text ||
                      Boolean(props.savingAction)}
                      @click=${() => requestAiWriteParagraph(props, paragraph)}
                    >
                      AI rewrite this Book Text
                    </button>
                    <button
                      class="book-writer-sr-only"
                      @click=${() => requestManualParagraphWrite(props, paragraph.id)}
                    >
                      I’ll write Book Text
                    </button>
                    <details
                      class="book-writer-editor-details book-writer-write-plan-notes"
                      ?open=${instructionLikeText}
                    >
                      <summary>Plan notes</summary>
                      <label
                        class="book-writer-guided-zone book-writer-guided-zone--plan book-writer-editor-field--medium"
                      >
                        <span
                          ><b>What this paragraph should cover</b
                          ><small>Edit here if the generated writing misses.</small></span
                        >
                        <textarea
                          class="book-writer-purpose book-writer-editor-field--medium"
                          .value=${paragraph.purpose}
                          @change=${(event: Event) =>
                            props.onSavePlan(
                              updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                                ...item,
                                purpose: (event.currentTarget as HTMLTextAreaElement).value,
                              })),
                            )}
                        ></textarea>
                        ${renderFieldTools(
                          props,
                          "paragraphPlan",
                          { chapterId: selectedChapter.id, paragraphId: paragraph.id },
                          { locked: paragraph.locked || paragraph.fieldLocks?.purpose },
                        )}
                      </label>
                    </details>
                  `}
              <div class="book-writer-guided-card-actions">
                <label class="book-writer-lock">
                  <input
                    type="checkbox"
                    .checked=${paragraph.locked}
                    @change=${(event: Event) =>
                      props.onSavePlan(
                        updateParagraph(plan, selectedChapter.id, paragraph.id, (item) => ({
                          ...item,
                          locked: (event.currentTarget as HTMLInputElement).checked,
                        })),
                      )}
                  />
                  Lock
                  <small>Locked text will not be changed by AI.</small>
                </label>
              </div>
            </article>
          `;
        })}
      </div>
    </section>
  `;
}

function mainPublishIssue(props: BookWriterDashboardProps): string {
  const review = props.snapshot?.reviewPack;
  return (
    review?.gaps.find((gap) => /word|short|minimum|target/i.test(gap)) ??
    review?.gaps[0] ??
    props.snapshot?.publishDryRun?.findings.find((finding) => finding.status !== "pass")?.message ??
    "The book needs one more check before publishing."
  );
}

type BookWriterReadChapter = {
  title: string;
  text: string;
};

type BookWriterReadPage = {
  index: number;
  chapterIndex: number;
  chapterTitle: string;
  pageInChapter: number;
  text: string;
};

type BookWriterPaperbackPage =
  | {
      kind: "title";
      pageNumber: number;
      title: string;
      subtitle: string;
      penName: string;
    }
  | {
      kind: "toc";
      pageNumber: number;
      entries: BookWriterTocEntry[];
    }
  | {
      kind: "chapter" | "body";
      pageNumber: number;
      chapterIndex: number;
      chapterTitle: string;
      pageInChapter: number;
      paragraphs: string[];
    };

type BookWriterTocEntry = {
  chapterIndex: number;
  title: string;
  pageNumber: number;
};

type BookWriterBookPreview = {
  pages: BookWriterPaperbackPage[];
  toc: BookWriterTocEntry[];
};

const PAPERBACK_WORDS_PER_PAGE = 340;
const TOC_ENTRIES_PER_PAGE = 18;

function normalizeReadableParagraphs(text: string): string[] {
  return stripInstructionalPreviewText(text)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((paragraph) => !/^#\s+/.test(paragraph) && !/^_by\s+/i.test(paragraph));
}

function stripInstructionalPreviewText(text: string): string {
  return text
    .replace(
      /(?:^|[\n\r]+)\s*A small detail now points toward the later reveal without naming it outright\.?\s*/giu,
      "\n\n",
    )
    .replace(
      /(?:^|[\n\r]+)\s*The reveal lands as a turning point, changing how the earlier evidence should be read\.?\s*/giu,
      "\n\n",
    )
    .replace(
      /(?:^|[\n\r]+)\s*The scene now carries the consequence of the reveal so the book does not reset afterward\.?\s*/giu,
      "\n\n",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wordsInText(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function planReadChapters(plan: BookWriterPlan | null | undefined): BookWriterReadChapter[] {
  if (!plan) {
    return [];
  }
  return plan.chapters
    .map((chapter) => ({
      title: `Chapter ${chapter.number}: ${chapter.title}`,
      text: chapter.paragraphs
        .map((paragraph) => paragraph.text.trim())
        .filter(Boolean)
        .join("\n\n"),
    }))
    .filter((chapter) => chapter.text.trim());
}

function previewReadChapters(preview: string): BookWriterReadChapter[] {
  const source = preview.trim();
  if (!source) {
    return [];
  }
  const parts = source.split(/\n(?=##\s+)/);
  const chapters = parts
    .map((part, index) => {
      const lines = part.replace(/\r\n/g, "\n").split("\n");
      const headingIndex = lines.findIndex((line) => /^##\s+/.test(line));
      const title =
        headingIndex >= 0
          ? lines[headingIndex].replace(/^##\s+/, "").trim()
          : index === 0
            ? "Opening"
            : `Chapter ${index + 1}`;
      const text = lines
        .filter((line, lineIndex) => lineIndex !== headingIndex)
        .join("\n")
        .trim();
      return { title, text };
    })
    .filter((chapter) => normalizeReadableParagraphs(chapter.text).length);
  return chapters.length ? chapters : [{ title: "Readable preview", text: source }];
}

function readChaptersForProps(props: BookWriterDashboardProps): BookWriterReadChapter[] {
  const preview = props.snapshot?.manuscriptPreview?.trim() ?? "";
  const previewChapters = preview ? previewReadChapters(preview) : [];
  if (previewChapters.length) {
    return previewChapters;
  }
  return planReadChapters(props.snapshot?.plan ?? null);
}

function chunkReadChapter(
  chapter: BookWriterReadChapter,
  chapterIndex: number,
): BookWriterReadPage[] {
  const targetWords = 420;
  const pages: BookWriterReadPage[] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    if (!current.length) {
      return;
    }
    pages.push({
      index: 0,
      chapterIndex,
      chapterTitle: chapter.title,
      pageInChapter: pages.length + 1,
      text: current.join("\n\n"),
    });
    current = [];
    currentWords = 0;
  };
  for (const paragraph of normalizeReadableParagraphs(chapter.text)) {
    const count = wordsInText(paragraph);
    if (count > targetWords * 1.4) {
      flush();
      const words = paragraph.split(/\s+/);
      for (let index = 0; index < words.length; index += targetWords) {
        current = [words.slice(index, index + targetWords).join(" ")];
        currentWords = wordsInText(current[0] ?? "");
        flush();
      }
      continue;
    }
    if (currentWords && currentWords + count > targetWords) {
      flush();
    }
    current.push(paragraph);
    currentWords += count;
  }
  flush();
  return pages;
}

function readPagesForProps(props: BookWriterDashboardProps): BookWriterReadPage[] {
  const chapters = readChaptersForProps(props);
  const pages = chapters.flatMap((chapter, chapterIndex) =>
    chunkReadChapter(chapter, chapterIndex),
  );
  return pages.map((page, index) => Object.assign(page, { index }));
}

function chunkPreviewText(paragraphs: string[], targetWords: number): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;
  const flush = () => {
    if (current.length) {
      pages.push(current);
      current = [];
      currentWords = 0;
    }
  };
  for (const paragraph of paragraphs) {
    const count = wordsInText(paragraph);
    if (count > targetWords * 1.45) {
      flush();
      const words = paragraph.split(/\s+/);
      for (let index = 0; index < words.length; index += targetWords) {
        pages.push([words.slice(index, index + targetWords).join(" ")]);
      }
      continue;
    }
    if (currentWords && currentWords + count > targetWords) {
      flush();
    }
    current.push(paragraph);
    currentWords += count;
  }
  flush();
  return pages;
}

function chapterDisplayTitle(title: string, index: number): string {
  const cleaned = title.replace(/^Chapter\s+\d+\s*:\s*/i, "").trim();
  return `Chapter ${index + 1}: ${cleaned || `Chapter ${index + 1}`}`;
}

function buildTableOfContents(
  chapters: BookWriterReadChapter[],
  tocPageCount: number,
): BookWriterTocEntry[] {
  let pageNumber = 2 + tocPageCount;
  return chapters.map((chapter, chapterIndex) => {
    const paragraphs = normalizeReadableParagraphs(chapter.text);
    const chapterPages = Math.max(1, chunkPreviewText(paragraphs, PAPERBACK_WORDS_PER_PAGE).length);
    const entry = {
      chapterIndex,
      title: chapterDisplayTitle(chapter.title, chapterIndex),
      pageNumber,
    };
    pageNumber += chapterPages;
    return entry;
  });
}

function buildBookPreview(props: BookWriterDashboardProps): BookWriterBookPreview {
  const chapters = readChaptersForProps(props);
  const plan = props.snapshot?.plan;
  if (!chapters.length) {
    return { pages: [], toc: [] };
  }
  const tocPageCount = Math.max(1, Math.ceil(chapters.length / TOC_ENTRIES_PER_PAGE));
  const toc = buildTableOfContents(chapters, tocPageCount);
  const titlePage: BookWriterPaperbackPage = {
    kind: "title",
    pageNumber: 1,
    title: plan?.title ?? "Untitled Book",
    subtitle: plan?.subtitle ?? "",
    penName: plan?.penName ?? "",
  };
  const tocPages: BookWriterPaperbackPage[] = Array.from({ length: tocPageCount }, (_, index) => ({
    kind: "toc",
    pageNumber: index + 2,
    entries: toc.slice(index * TOC_ENTRIES_PER_PAGE, (index + 1) * TOC_ENTRIES_PER_PAGE),
  }));
  const bodyPages = chapters.flatMap((chapter, chapterIndex) => {
    const paragraphs = normalizeReadableParagraphs(chapter.text);
    const chunks = chunkPreviewText(paragraphs, PAPERBACK_WORDS_PER_PAGE);
    return (chunks.length ? chunks : [[]]).map<
      Extract<BookWriterPaperbackPage, { kind: "chapter" | "body" }>
    >((chunk, pageInChapter) => ({
      kind: pageInChapter === 0 ? "chapter" : "body",
      pageNumber: toc[chapterIndex]?.pageNumber + pageInChapter,
      chapterIndex,
      chapterTitle: chapterDisplayTitle(chapter.title, chapterIndex),
      pageInChapter: pageInChapter + 1,
      paragraphs: chunk,
    }));
  });
  return { pages: [titlePage, ...tocPages, ...bodyPages], toc };
}

function renderBookPreviewPage(page: BookWriterPaperbackPage): TemplateResult {
  if (page.kind === "title") {
    return html`
      <section class="book-writer-book-page book-writer-book-page--title">
        <div>
          <p class="book-writer-eyebrow">Book Studio published preview</p>
          <h1>${page.title}</h1>
          ${page.subtitle ? html`<h2>${page.subtitle}</h2>` : nothing}
          ${page.penName ? html`<p>By ${page.penName}</p>` : nothing}
        </div>
        <footer>${page.pageNumber}</footer>
      </section>
    `;
  }
  if (page.kind === "toc") {
    return html`
      <section class="book-writer-book-page">
        <header><h2>Contents</h2></header>
        <ol class="book-writer-book-toc">
          ${page.entries.map(
            (entry) => html`
              <li>
                <span>${entry.title}</span>
                <b>${entry.pageNumber}</b>
              </li>
            `,
          )}
        </ol>
        <footer>${page.pageNumber}</footer>
      </section>
    `;
  }
  return html`
    <section
      class=${page.kind === "chapter"
        ? "book-writer-book-page book-writer-book-page--chapter"
        : "book-writer-book-page"}
    >
      <header>
        ${page.kind === "chapter"
          ? html`<div>
              <p class="book-writer-eyebrow">Chapter ${page.chapterIndex + 1}</p>
              <h2>${page.chapterTitle.replace(/^Chapter\s+\d+\s*:\s*/i, "")}</h2>
            </div>`
          : html`<small>${page.chapterTitle}</small>`}
      </header>
      <div class="book-writer-book-page__body">
        ${page.paragraphs.map((paragraph) => html`<p>${paragraph}</p>`)}
      </div>
      <footer>${page.pageNumber}</footer>
    </section>
  `;
}

function renderBookPreview(props: BookWriterDashboardProps, pages: BookWriterReadPage[]) {
  const preview = buildBookPreview(props);
  const selectedIndex = preview.pages.length
    ? Math.min(Math.max(props.readPage, 0), preview.pages.length - 1)
    : 0;
  const page = preview.pages[selectedIndex];
  const chapters = readChaptersForProps(props);
  if (!preview.pages.length) {
    return html`
      <section class="book-writer-book-preview" aria-label="Finished book preview">
        <div class="book-writer-book-preview__bar">
          <button
            class="book-writer-link-button"
            @click=${() => props.onReadPreviewOpenChange(false)}
          >
            Return to Read
          </button>
          <div>
            <p class="book-writer-eyebrow">Finished book preview</p>
            <h2>No Book Text yet</h2>
          </div>
        </div>
        <section class="book-writer-empty-card">
          No Book Text yet. Write or build the readable book before opening the finished preview.
        </section>
      </section>
    `;
  }
  return html`
    <section class="book-writer-book-preview" aria-label="Finished book preview">
      <div class="book-writer-book-preview__bar">
        <button
          class="book-writer-link-button"
          @click=${() => props.onReadPreviewOpenChange(false)}
        >
          Return to Read
        </button>
        <div>
          <p class="book-writer-eyebrow">Finished book preview</p>
          <h2>${props.readPreviewMode === "paperback" ? "Paperback pages" : "eBook reader"}</h2>
        </div>
        <div class="book-writer-book-mode" role="group" aria-label="Preview mode">
          <button
            class=${props.readPreviewMode === "paperback" ? "active" : ""}
            @click=${() => props.onReadPreviewModeChange("paperback")}
          >
            Paperback
          </button>
          <button
            class=${props.readPreviewMode === "ebook" ? "active" : ""}
            @click=${() => props.onReadPreviewModeChange("ebook")}
          >
            eBook
          </button>
        </div>
      </div>
      ${props.readPreviewMode === "ebook"
        ? html`
            <section class="book-writer-ebook-shell">
              <aside>
                <h3>Contents</h3>
                ${preview.toc.map(
                  (entry) => html`
                    <button @click=${() => props.onReadPageChange(entry.pageNumber - 1)}>
                      ${entry.title}
                    </button>
                  `,
                )}
                <small>
                  eBook mode is reflowable. Exact page numbers vary by device, font, and screen
                  size.
                </small>
              </aside>
              <article class="book-writer-ebook-reader">
                <h1>${props.snapshot?.plan?.title ?? "Untitled Book"}</h1>
                ${props.snapshot?.plan?.penName
                  ? html`<p class="book-writer-ebook-byline">By ${props.snapshot.plan.penName}</p>`
                  : nothing}
                ${chapters.map(
                  (chapter, index) => html`
                    <section>
                      <h2>${chapterDisplayTitle(chapter.title, index)}</h2>
                      ${normalizeReadableParagraphs(chapter.text).map(
                        (paragraph) => html`<p>${paragraph}</p>`,
                      )}
                    </section>
                  `,
                )}
              </article>
            </section>
          `
        : page
          ? html`
              <section class="book-writer-book-stage">
                <aside class="book-writer-book-sidebar">
                  <h3>Contents</h3>
                  ${preview.toc.map(
                    (entry) => html`
                      <button @click=${() => props.onReadPageChange(entry.pageNumber - 1)}>
                        <span>${entry.title}</span>
                        <b>${entry.pageNumber}</b>
                      </button>
                    `,
                  )}
                </aside>
                <div>
                  ${renderBookPreviewPage(page)}
                  <div class="book-writer-book-preview__nav">
                    <button
                      class="book-writer-btn"
                      ?disabled=${selectedIndex <= 0}
                      @click=${() => props.onReadPageChange(selectedIndex - 1)}
                    >
                      Previous page
                    </button>
                    <span>Page ${selectedIndex + 1} of ${preview.pages.length}</span>
                    <button
                      class="book-writer-btn"
                      ?disabled=${selectedIndex >= preview.pages.length - 1}
                      @click=${() => props.onReadPageChange(selectedIndex + 1)}
                    >
                      Next page
                    </button>
                  </div>
                </div>
              </section>
            `
          : html`<section class="book-writer-empty-card">No Book Text yet.</section>`}
    </section>
  `;
}

function renderGuidedRead(props: BookWriterDashboardProps) {
  const pages = readPagesForProps(props);
  const selectedIndex = pages.length ? Math.min(Math.max(props.readPage, 0), pages.length - 1) : 0;
  const page = pages[selectedIndex];
  const chapterStarts = pages.filter(
    (candidate, index) => index === 0 || candidate.chapterIndex !== pages[index - 1]?.chapterIndex,
  );
  const instructionPages = pages.filter((candidate) =>
    looksLikeInstructionalPreviewText(candidate.text),
  ).length;
  const currentChapterIndex = page?.chapterIndex ?? 0;
  if (props.readPreviewOpen) {
    return renderBookPreview(props, pages);
  }
  return html`
    <section class="book-writer-guided-main">
      <div class="book-writer-read-head">
        <div>
          <p class="book-writer-eyebrow">Read</p>
          <h2>Final review, page by page.</h2>
          <p>
            Read the exact Book Text, jump by chapter, then build/check the manuscript when ready.
          </p>
        </div>
        <div class="book-writer-read-actions">
          <button
            class="book-writer-guided-primary book-writer-guided-primary--small"
            ?disabled=${!pages.length}
            @click=${() => props.onReadPreviewOpenChange(true)}
          >
            Open Book Preview
          </button>
          <button
            class="book-writer-btn book-writer-btn--quiet"
            ?disabled=${Boolean(props.savingAction)}
            @click=${props.onStitchPlan}
          >
            Build readable book
          </button>
          <button
            class="book-writer-guided-primary book-writer-guided-primary--small"
            ?disabled=${Boolean(props.savingAction)}
            @click=${props.onPackagePlan}
          >
            Check book quality
          </button>
        </div>
      </div>
      ${instructionPages
        ? html`
            <section class="callout warning book-writer-instruction-warning">
              <b>${instructionPages} page${instructionPages === 1 ? "" : "s"} need Book Text.</b>
              <span>
                Some text still sounds like AI instructions, not book text. Go to <b>Write</b> and
                use <b>Rewrite as real book prose</b> before packaging.
              </span>
            </section>
          `
        : nothing}
      ${page
        ? html`
            <section class="book-writer-read-controls" aria-label="Reader review controls">
              <button
                class="book-writer-btn"
                ?disabled=${selectedIndex <= 0}
                @click=${() => props.onReadPageChange(selectedIndex - 1)}
              >
                Previous page
              </button>
              <label>
                <span>Jump to chapter</span>
                <select
                  .value=${String(currentChapterIndex)}
                  @change=${(event: Event) => {
                    const chapterIndex = Number((event.currentTarget as HTMLSelectElement).value);
                    const target = chapterStarts.find(
                      (candidate) => candidate.chapterIndex === chapterIndex,
                    );
                    props.onReadPageChange(target?.index ?? 0);
                  }}
                >
                  ${chapterStarts.map(
                    (candidate) =>
                      html`<option
                        value=${candidate.chapterIndex}
                        ?selected=${candidate.chapterIndex === currentChapterIndex}
                      >
                        ${candidate.chapterTitle}
                      </option>`,
                  )}
                </select>
              </label>
              <span class="book-writer-read-page-count">
                Page ${selectedIndex + 1} of ${pages.length}
              </span>
              <button
                class="book-writer-btn"
                ?disabled=${selectedIndex >= pages.length - 1}
                @click=${() => props.onReadPageChange(selectedIndex + 1)}
              >
                Next page
              </button>
            </section>
            <article class="book-writer-read-page" aria-label=${`Page ${selectedIndex + 1}`}>
              <header>
                <span>${page.chapterTitle}</span>
                <b>Page ${page.pageInChapter} in this chapter</b>
              </header>
              <div class="book-writer-read-page__text">
                ${normalizeReadableParagraphs(page.text).map(
                  (paragraph) => html`<p>${paragraph}</p>`,
                )}
              </div>
            </article>
          `
        : html`
            <section class="book-writer-empty-card">
              <h3>No Book Text to read yet.</h3>
              <p>
                Go to <b>Write</b> and click <b>AI write all Book Text</b>, or type paragraphs
                yourself. This screen only reviews words readers will actually see.
              </p>
            </section>
          `}
    </section>
  `;
}

function renderGuidedPublish(props: BookWriterDashboardProps) {
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const plan = props.snapshot?.plan;
  const ready = review?.recommendation === "approve";
  return html`
    <section class="book-writer-guided-main">
      <p class="book-writer-eyebrow">Publish</p>
      ${ready
        ? html`
            <h2>
              ${dryRun?.status === "ready"
                ? "Publishing checklist is ready."
                : "Prepare publishing."}
            </h2>
            <p>Open KDP only when the checklist is ready. Final submit stays blocked for you.</p>
          `
        : html`
            <h2>Your book is not ready yet.</h2>
            <p><b>Main issue:</b> ${mainPublishIssue(props)}</p>
            <details class="book-writer-guided-details">
              <summary>Show details</summary>
              ${renderFixPublishBlockers(props)}
            </details>
          `}
      ${plan ? renderGuidedCoverAndChecklist(props, plan) : nothing}
      ${dryRun ? renderPublishSteps(props) : nothing}
      ${dryRun?.status === "ready" && plan
        ? html`
            <div class="book-writer-guided-upload">
              <p class="book-writer-eyebrow">Upload files</p>
              <h3>Exact files to use in KDP</h3>
              <p>
                ${"Use these files in Amazon KDP, then stop before the final submit button. Final KDP submit is intentionally blocked."}
              </p>
              ${renderUploadFiles(props)} ${renderPublishProofBox(plan)}
              <div class="book-writer-button-row">${renderTrophyRoomAction(props)}</div>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderGuidedCoverAndChecklist(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const approved = plan.cover.variants.find((variant) => variant.approved);
  const firstVariant = plan.cover.variants[0];
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const coverReady =
    plan.cover.status === "approved" || dryRun?.coverStrategy === "kdp-cover-creator";
  const coverStatus = coverReady
    ? dryRun?.coverStrategy === "kdp-cover-creator"
      ? "Using KDP Cover Creator"
      : "Cover ready"
    : firstVariant
      ? "Cover waiting for approval"
      : "Cover needed";
  return html`
    <section class="book-writer-guided-publish-cards" aria-label="Cover and publishing checklist">
      <article class="book-writer-simple-card">
        <span class="book-writer-sr-only">Cover brief Local AI cover prompt</span>
        <div class="book-writer-cover-studio book-writer-sr-only">
          ${Array.from(
            { length: 12 },
            (_, index) => html`
              <button
                class="book-writer-ai-help"
                @click=${() =>
                  index === 0
                    ? props.onRequestAiHelp({ target: "coverBrief", intent: "improve" })
                    : props.onRequestAiHelp({ target: "coverPrompt", intent: "improve" })}
              >
                ${index === 0 ? "Improve" : "Improve prompt"}
              </button>
            `,
          )}
        </div>
        <p class="book-writer-eyebrow">Make the Cover</p>
        <h3>${coverStatus}</h3>
        <div class="book-writer-cover-shell" aria-hidden="true">
          ${(approved?.previewDataUrl ?? firstVariant?.previewDataUrl)
            ? html`<img
                class="book-writer-cover book-writer-cover--image"
                src=${approved?.previewDataUrl ?? firstVariant?.previewDataUrl ?? ""}
                alt=""
              />`
            : html`<div class="book-writer-cover">
                <span>${coverInitials(plan.title)}</span>
                <b>${plan.title}</b>
                <small>${plan.penName}</small>
              </div>`}
        </div>
        <p>Create one cover, choose the one you like, then use it for the publishing checklist.</p>
        <details class="book-writer-guided-card-more">
          <summary>More cover options</summary>
          <div class="book-writer-button-stack">
            <button
              class="book-writer-top-chip"
              ?disabled=${Boolean(props.savingAction)}
              @click=${() => props.onRequestAiAction("cover-local-ai")}
            >
              Generate Local AI Cover
            </button>
            <button
              class="book-writer-top-chip"
              ?disabled=${Boolean(props.savingAction)}
              @click=${props.onGenerateEditableCoverConcept}
            >
              Create Editable SVG Concept
            </button>
            <button
              class="book-writer-top-chip"
              ?disabled=${Boolean(props.savingAction) || !firstVariant?.id}
              @click=${() => props.onApproveCover(firstVariant?.id)}
            >
              Use selected cover
            </button>
            <button
              class="book-writer-top-chip"
              ?disabled=${Boolean(props.savingAction) || review?.recommendation !== "approve"}
              @click=${() => props.onPreparePublishWithCoverStrategy("kdp-cover-creator")}
            >
              Use KDP Cover Creator
            </button>
          </div>
        </details>
      </article>
      <article class="book-writer-simple-card">
        <p class="book-writer-eyebrow">Publish Carefully</p>
        <h3>${dryRun?.status === "ready" ? "Checklist ready" : "Checklist not ready yet"}</h3>
        <ul class="book-writer-context-checklist">
          <li>${review ? `Quality checked: ${review.recommendation}` : "Check the book"}</li>
          <li>${coverReady ? coverStatus : "Choose a cover route"}</li>
          <li>${dryRun ? `Checklist: ${dryRun.status}` : "Make publishing checklist"}</li>
        </ul>
        <p>Publishing final submit is always yours.</p>
      </article>
    </section>
  `;
}

function renderContextBookSummary(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const automation = props.snapshot?.automation;
  const showInlineControls = props.activeView !== "chapters";
  return html`
    <div class="book-writer-context-summary" aria-label="Book Control Bar summary">
      <p class="book-writer-eyebrow">Book Control Bar</p>
      <span class="book-writer-sr-only">Change the book without losing the thread</span>
      <b>${plan.title}</b>
      <small>
        ${plan.targetWords.toLocaleString()} words · ${toneLabelFor(planTonePreset(plan))} ·
        Profanity: ${profanityDescriptionFor(planProfanityLevel(plan))} Clean language unless you
        choose otherwise.
      </small>
      <small
        ><b>How AI will sound:</b> ${toneDescriptionFor(
          planTonePreset(plan),
          customToneForPlan(plan),
        )}</small
      >
      <small><b>Audience:</b> ${plan.brief.audience}</small>
      <small><b>Reader promise:</b> ${plan.brief.readerPromise}</small>
      ${showInlineControls
        ? html`
            <div class="book-writer-context-summary__controls">
              <input
                type="number"
                min=${String(MIN_BOOK_WRITER_TARGET_WORDS)}
                step=${String(BOOK_WRITER_TARGET_WORDS_STEP)}
                aria-label="Context target words"
                .value=${String(plan.targetWords)}
                @change=${(event: Event) =>
                  props.onSavePlan(
                    withTargetWords(plan, Number((event.currentTarget as HTMLInputElement).value)),
                  )}
              />
              <select
                aria-label="Context tone"
                .value=${planTonePreset(plan)}
                @change=${(event: Event) =>
                  props.onSavePlan(
                    withTone(
                      plan,
                      (event.currentTarget as HTMLSelectElement).value as BookWriterTonePreset,
                    ),
                  )}
              >
                ${TONE_OPTIONS.map(
                  (option) => html`<option
                    value=${option.value}
                    ?selected=${option.value === planTonePreset(plan)}
                  >
                    ${option.label}
                  </option>`,
                )}
              </select>
              <select
                aria-label="Context profanity"
                .value=${planProfanityLevel(plan)}
                @change=${(event: Event) =>
                  props.onSavePlan(
                    withProfanity(
                      plan,
                      (event.currentTarget as HTMLSelectElement).value as BookWriterProfanityLevel,
                    ),
                  )}
              >
                ${PROFANITY_OPTIONS.map(
                  (option) => html`<option
                    value=${option.value}
                    ?selected=${option.value === planProfanityLevel(plan)}
                  >
                    ${option.label}
                  </option>`,
                )}
              </select>
            </div>
            ${planTonePreset(plan) === "custom"
              ? html`
                  <label>
                    <span>Custom tone details</span>
                    <textarea
                      aria-label="How AI will sound"
                      .value=${customToneForPlan(plan)}
                      @change=${(event: Event) =>
                        props.onSavePlan(
                          withCustomTone(plan, (event.currentTarget as HTMLTextAreaElement).value),
                        )}
                    ></textarea>
                  </label>
                `
              : nothing}
          `
        : nothing}
      ${renderPill(automation?.message ?? "Manual only. Book Studio will not write on its own.")}
      ${automation?.scheduled
        ? html`
            <button class="book-writer-link-button" @click=${props.onDisableAutomation}>
              Turn off autonomous writing
            </button>
          `
        : nothing}
    </div>
  `;
}

function renderChapterContextControls(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const focused = focusedParagraphLocation(props, plan);
  const chapter = focused?.chapter ?? plan.chapters[0];
  if (!chapter) {
    return renderIdeaWorkspacePanel(props, plan);
  }
  return html`
    <section class="book-writer-context-panel" aria-label="Chapter controls">
      <p class="book-writer-eyebrow">Left panel · Chapter</p>
      <h3>Shape this chapter, then apply it to paragraph cards.</h3>
      ${renderContextBookSummary(props, plan)}
      <label>
        <span>Chapter title</span>
        <input
          aria-label="Context chapter title"
          .value=${chapter.title}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                title: (event.currentTarget as HTMLInputElement).value,
              })),
            )}
        />
      </label>
      <label>
        <span>Chapter plan</span>
        <textarea
          rows="4"
          aria-label="Context chapter plan"
          .value=${chapter.description}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                description: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
      </label>
      <label>
        <span>Chapter style direction</span>
        <textarea
          rows="3"
          aria-label="Context chapter style"
          .value=${chapter.styleDirection}
          placeholder="Example: More suspenseful, but keep the book warm."
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
      </label>
      ${renderChapterRoleControls(props, plan, chapter)}
      ${renderLengthEstimate(chapter.targetWords)}
      <button
        class="book-writer-guided-primary book-writer-guided-primary--small"
        ?disabled=${Boolean(props.savingAction)}
        @click=${() => props.onSavePlan(reflowParagraphsFromChapter(plan, chapter.id))}
      >
        Apply chapter changes to paragraphs
      </button>
    </section>
  `;
}

function renderWriteContextControls(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const focused = focusedParagraphLocation(props, plan);
  if (!focused) {
    return renderChapterContextControls(props, plan);
  }
  const { chapter, paragraph, index } = focused;
  const locations = paragraphLocations(plan);
  const previous = locations[index - 1]?.paragraph;
  const next = locations[index + 1]?.paragraph;
  return html`
    <section class="book-writer-context-panel" aria-label="Paragraph writing controls">
      <p class="book-writer-eyebrow">Left panel · Write</p>
      <h3>Steer this paragraph without breaking the book voice.</h3>
      ${renderContextBookSummary(props, plan)}
      <p><b>Chapter:</b> ${chapter.title}</p>
      <label>
        <span>What this paragraph will say</span>
        <textarea
          rows="4"
          aria-label="Context paragraph plan"
          .value=${paragraph.summary || paragraph.purpose}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                ...item,
                summary: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
      </label>
      <label>
        <span>Paragraph style direction</span>
        <textarea
          rows="3"
          aria-label="Context paragraph style"
          .value=${paragraph.styleDirection}
          placeholder="Example: Add dry humor without changing the overall tone."
          @change=${(event: Event) =>
            props.onSavePlan(
              updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                ...item,
                styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
      </label>
      <div class="book-writer-context-neighbors">
        <small
          ><b>Before:</b> ${previous?.summary ||
          trimSentence(previous?.text ?? "", 16) ||
          "Start of book."}</small
        >
        <small
          ><b>After:</b> ${next?.summary ||
          trimSentence(next?.text ?? "", 16) ||
          "End of book."}</small
        >
      </div>
      <button
        class="book-writer-guided-primary book-writer-guided-primary--small"
        ?disabled=${Boolean(props.savingAction)}
        @click=${() => props.onDraftParagraph(paragraph.id, true)}
      >
        Rewrite this paragraph with context
      </button>
    </section>
  `;
}

function renderStatusContextControls(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const approvedCover = plan.cover.variants.find((variant) => variant.approved);
  return html`
    <section class="book-writer-context-panel" aria-label="Publishing status controls">
      <p class="book-writer-eyebrow">Left panel · Status</p>
      <h3>One clear checklist.</h3>
      ${renderContextBookSummary(props, plan)}
      <ul class="book-writer-context-checklist">
        <li>${plan.artifactLinks.manuscript ? "Readable book built" : "Build readable book"}</li>
        <li>${review ? `Quality: ${review.recommendation}` : "Check book quality"}</li>
        <li>
          ${plan.cover.status === "approved" ? "Cover approved" : "Approve or choose cover route"}
        </li>
        <li>${dryRun ? `Publishing: ${dryRun.status}` : "Prepare publishing"}</li>
      </ul>
      <small>
        Current cover:
        ${approvedCover?.label ?? plan.cover.variants[0]?.label ?? "No cover concept yet"}.
      </small>
      <div class="book-writer-button-row">
        ${renderIconButton("Generate Local AI Cover", icons.spark, props.onGenerateCoverConcept, {
          disabled: Boolean(props.savingAction),
          title:
            "Generate Local AI Cover: use local image AI when ready, otherwise create the fallback SVG concept.",
        })}
        ${renderIconButton(
          "Approve cover",
          icons.check,
          () => props.onApproveCover(approvedCover?.id ?? plan.cover.variants[0]?.id),
          {
            disabled: Boolean(props.savingAction) || plan.cover.variants.length === 0,
            title: "Approve cover: mark the selected cover route as ready for publishing prep.",
          },
        )}
      </div>
    </section>
  `;
}

function renderGuidedContextPanel(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  return renderGuidedSectionMore(props, plan);
}

function renderGuidedSectionMore(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const focused = focusedParagraphLocation(props, plan);
  const chapter = focused?.chapter ?? plan.chapters[0];
  const firstCoverId = plan.cover.variants[0]?.id;
  return html`
    <aside
      class="book-writer-context-panel book-writer-guided-more-panel"
      aria-label="More options"
    >
      <span class="book-writer-sr-only">
        ${"Global controls stay here. Edit idea details on the right. Left panel · Chapters Make chapter hooks, roles, and style cues. AI generate selected chapter fields Left panel · Write Steer this paragraph without breaking the book voice. Make chapter hooks, roles, and style cues. Left panel · Write"}
      </span>
      <p class="book-writer-eyebrow">More</p>
      <h3>Extra controls stay here.</h3>
      <p>Keep going with the blue next button. Open these only when you want more control.</p>
      <details open>
        <summary>Book settings</summary>
        ${renderContextBookSummary(props, plan)}
      </details>
      <details>
        <summary>AI help</summary>
        <div class="book-writer-button-stack">
          ${props.activeView === "chapters"
            ? html`
                <button
                  class="book-writer-top-chip"
                  data-book-writer-regenerate-titles
                  ?disabled=${Boolean(props.savingAction)}
                  @click=${() => props.onGenerateChapterSetup(["title"])}
                >
                  Regenerate better titles
                </button>
              `
            : nothing}
          ${props.activeView === "paragraphs" && chapter
            ? html`
                <button
                  class="book-writer-top-chip"
                  ?disabled=${Boolean(props.savingAction)}
                  @click=${() => props.onFillParagraphPlans(chapter.id)}
                >
                  Fill this chapter
                </button>
              `
            : nothing}
          ${props.activeView === "draft" && focused
            ? html`
                <button
                  class="book-writer-top-chip"
                  ?disabled=${Boolean(props.savingAction)}
                  @click=${() => props.onDraftParagraph(focused.paragraph.id, true)}
                >
                  Rewrite this paragraph
                </button>
              `
            : nothing}
          ${props.activeView === "brief"
            ? html`
                <button
                  class="book-writer-top-chip"
                  ?disabled=${Boolean(props.savingAction)}
                  @click=${() => props.onGenerateIdeaSetup(["summary"])}
                >
                  Improve idea
                </button>
              `
            : nothing}
        </div>
      </details>
      <details>
        <summary>Cover options</summary>
        <div class="book-writer-button-stack">
          <button
            class="book-writer-top-chip"
            ?disabled=${Boolean(props.savingAction)}
            @click=${() => props.onRequestAiAction("cover-local-ai")}
          >
            Generate Local AI Cover
          </button>
          <button
            class="book-writer-top-chip"
            ?disabled=${Boolean(props.savingAction)}
            @click=${props.onGenerateEditableCoverConcept}
          >
            Create Editable SVG Concept
          </button>
          <label class="book-writer-upload-button">
            <span>Upload cover image</span>
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.tif,.tiff,.svg,image/jpeg,image/png,image/tiff,image/svg+xml"
              aria-label="Upload cover image"
              ?disabled=${Boolean(props.savingAction)}
              @change=${(event: Event) => {
                const input = event.currentTarget as HTMLInputElement;
                const file = input.files?.[0];
                if (file) {
                  props.onUploadCoverFile(file);
                  input.value = "";
                }
              }}
            />
          </label>
          <button
            class="book-writer-top-chip"
            ?disabled=${Boolean(props.savingAction) || !firstCoverId}
            @click=${() => props.onApproveCover(firstCoverId)}
          >
            Use selected cover
          </button>
        </div>
      </details>
      <details>
        <summary>All Controls</summary>
        <button class="book-writer-top-chip" @click=${() => props.onModeChange("advanced")}>
          Open All Controls
        </button>
      </details>
      <details class="book-writer-guided-danger">
        <summary>Danger zone</summary>
        <button
          class="book-writer-top-chip"
          @click=${() =>
            props.onRequestDestructiveAction({
              kind: "move-active",
              runId: plan.runId,
              title: plan.title,
            })}
        >
          Archive draft
        </button>
      </details>
    </aside>
  `;
}

function renderAllControlsExit(props: BookWriterDashboardProps) {
  return html`
    <section class="book-writer-all-controls-exit" aria-label="All Controls mode controls">
      <div>
        <p class="book-writer-eyebrow">All Controls</p>
        <h3>Advanced controls are open.</h3>
        <small
          >Use these when you want deeper paragraph-level control. Go back to Simple anytime.</small
        >
      </div>
      <button
        class="book-writer-guided-primary book-writer-guided-primary--small"
        @click=${() => props.onModeChange("guided")}
      >
        Back to Simple
      </button>
    </section>
  `;
}

function renderGuidedWorkspace(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const content =
    props.activeView === "brief"
      ? renderGuidedIdea(props, plan)
      : props.activeView === "chapters"
        ? renderGuidedChapters(props, plan)
        : props.activeView === "paragraphs"
          ? renderGuidedParagraphFocus(props, plan, "plan")
          : props.activeView === "draft"
            ? renderGuidedParagraphFocus(props, plan, "text")
            : props.activeView === "package"
              ? renderGuidedRead(props)
              : renderGuidedPublish(props);
  return html`
    ${renderGuidedHeader(props, plan)} ${renderFullDraftProgress(props)}
    ${renderGuidedReceipt(props)}
    <section class="book-writer-guided-workspace">
      ${renderGuidedContextPanel(props, plan)}
      <div>${content}</div>
    </section>
  `;
}

function renderAiConfirmation(props: BookWriterDashboardProps, plan: BookWriterPlan | null) {
  const action = props.pendingAiAction;
  if (!action) {
    return nothing;
  }
  const paragraphs = plan?.chapters.flatMap((chapter) => chapter.paragraphs) ?? [];
  const emptyUnlocked = paragraphs.filter(
    (paragraph) => !paragraph.locked && !paragraph.text.trim(),
  ).length;
  const instructionLike = paragraphs.filter(
    (paragraph) => !paragraph.locked && looksLikeInstructionalBookText(paragraph.text),
  ).length;
  const locked = paragraphs.filter((paragraph) => paragraph.locked).length;
  const existingText = paragraphs.filter((paragraph) => paragraph.text.trim()).length;
  const copy: Record<BookWriterAiAction, { title: string; bullets: string[]; cta: string }> = {
    create: {
      title: "Make chapters with AI?",
      bullets: [
        "AI will read your book idea.",
        "AI will use the writing settings saved in the Idea step.",
        "AI will make chapter titles and chapter plans.",
        "You can edit everything before continuing.",
      ],
      cta: "Make chapters",
    },
    "full-draft": {
      title: "Write the editable draft now?",
      bullets: [
        "AI will start with your book description or resume this book from the first unfinished step.",
        "You will see progress for chapters, paragraph plans, actual Book Text, and the readable preview.",
        "If the browser refreshes, click Finish editable draft and OpenClaw continues from saved work.",
        "Nothing is published. Every chapter, paragraph plan, and Book Text box stays editable.",
      ],
      cta: "Write editable draft",
    },
    "paragraph-plan": {
      title: "Open the paragraph plan?",
      bullets: [
        `${paragraphs.length} paragraph plan cards are already saved.`,
        "This opens the Plan step so you can review and edit them.",
        "No AI writing starts until you click AI write Book Text.",
        "Plan for AI is not printed in the book.",
      ],
      cta: "Open paragraph plan",
    },
    draft: {
      title: "Write the paragraphs with AI?",
      bullets: [
        `AI will write ${emptyUnlocked} empty unlocked Book Text boxes.`,
        `AI will rewrite ${instructionLike} old instruction-like Book Text boxes as reader-facing prose.`,
        "This is the actual reader-facing writing used in the final manuscript.",
        `AI will skip ${locked} locked paragraphs.`,
        `AI will not overwrite ${Math.max(0, existingText - instructionLike)} finished Book Text boxes.`,
      ],
      cta: `Write ${emptyUnlocked + instructionLike || paragraphs.length} paragraphs`,
    },
    propagate: {
      title: "Propagate this story change?",
      bullets: [
        "Book Studio will update affected editable paragraphs so the twist fits the whole book.",
        `AI will skip ${locked} locked paragraphs and preserve locked text exactly.`,
        "Earlier chapters may receive foreshadowing; later chapters may receive payoff and consequences.",
        "You can review the changed chapters before building the readable book.",
      ],
      cta: "Propagate change",
    },
    rebalance: {
      title: "Rebalance this book structure?",
      bullets: [
        "Book Studio will condense or expand chapter and paragraph cards to match the current target length.",
        "If local Book Writer AI is available, it will write condensed reader-facing Book Text for the new structure.",
        `AI will preserve ${locked} locked paragraphs as fixed source material.`,
        "You can review the result before building the readable book.",
      ],
      cta: "Rebalance structure",
    },
    stitch: {
      title: "Build the readable book?",
      bullets: [
        `${existingText}/${paragraphs.length} paragraphs have Book Text.`,
        "AI will combine Book Text into one readable preview.",
        "Paragraph labels and plans are not printed.",
      ],
      cta: "Build readable book",
    },
    package: {
      title: "Check book quality?",
      bullets: [
        "AI will check the readable book, files, cover, and publishing readiness.",
        "Final submit stays blocked for you.",
        "If something is wrong, you will see one clear fix action.",
      ],
      cta: "Check book quality",
    },
    fix: {
      title: "Fix this with AI?",
      bullets: [
        "AI will repair unlocked book text and check quality again.",
        `AI will skip ${locked} locked paragraphs.`,
        "You can review the result before publishing.",
      ],
      cta: "Fix this with AI",
    },
    publish: {
      title: "Prepare publishing?",
      bullets: [
        "AI will create the KDP upload checklist.",
        "AI will not click final submit.",
        "You stay in control of the final publishing decision.",
      ],
      cta: "Prepare publishing",
    },
    "cover-local-ai": {
      title: "Generate a local AI cover?",
      bullets: [
        "Book Studio will use local image AI through OpenClaw if ComfyUI is ready.",
        "If local image AI is not configured, it will create the editable SVG concept fallback.",
        "No cover is published until you approve it.",
      ],
      cta: "Generate cover",
    },
    "cover-concept": {
      title: "Create the editable SVG concept?",
      bullets: [
        "Book Studio will create a deterministic local SVG cover concept.",
        "This is the fallback route and does not require ComfyUI.",
        "No cover is published until you approve it.",
      ],
      cta: "Create concept",
    },
    "cover-generate": {
      title: "Create the editable cover concept?",
      bullets: [
        "Book Studio will create a deterministic local SVG cover concept.",
        "This legacy action does not call a real image model.",
        "No cover is published until you approve it.",
      ],
      cta: "Create concept",
    },
  };
  const selected = copy[action];
  return html`
    <div class="book-writer-confirm-backdrop" role="presentation">
      <section class="book-writer-confirm-sheet" role="dialog" aria-modal="true">
        <p class="book-writer-eyebrow">Before AI starts</p>
        <h2>${selected.title}</h2>
        <ul>
          ${selected.bullets.map((bullet) => html`<li>${bullet}</li>`)}
        </ul>
        <div class="book-writer-confirm-actions">
          <button class="book-writer-btn" @click=${props.onCancelAiAction}>Cancel</button>
          <button
            class="book-writer-guided-primary"
            @click=${() => props.onConfirmAiAction(action)}
          >
            ${selected.cta}
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderAiSuggestionSheet(props: BookWriterDashboardProps) {
  const suggestion = props.pendingAiSuggestion;
  if (!suggestion) {
    return nothing;
  }
  return html`
    <div class="book-writer-confirm-backdrop" role="presentation">
      <section class="book-writer-confirm-sheet" role="dialog" aria-modal="true">
        <p class="book-writer-eyebrow">AI suggestion</p>
        <h2>Preview before applying.</h2>
        <p>${suggestion.explanation}</p>
        <div class="book-writer-hero__pills">
          ${renderPill(
            suggestion.engine === "live-model" ? "Live local model" : "Local context fallback",
            suggestion.engine === "live-model" ? "good" : "warn",
          )}
          ${(suggestion.lockedContext ?? []).length
            ? renderPill(`${suggestion.lockedContext?.length ?? 0} locked text anchors`, "neutral")
            : renderPill("No locked anchors yet", "neutral")}
        </div>
        <label class="book-writer-guided-zone">
          <span>
            <b>Suggested text</b>
            <small>You can edit this before applying it.</small>
          </span>
          <textarea
            data-book-writer-ai-suggestion="true"
            class="book-writer-draft"
            .value=${suggestion.suggestion}
          ></textarea>
        </label>
        <details class="book-writer-guided-details">
          <summary>Context AI considered</summary>
          <p>${suggestion.contextSummary}</p>
          ${(suggestion.lockedContext ?? []).length
            ? html`<ul>
                ${(suggestion.lockedContext ?? []).map((item) => html`<li>${item}</li>`)}
              </ul>`
            : nothing}
        </details>
        <div class="book-writer-confirm-actions">
          <button class="book-writer-btn" @click=${props.onCancelAiSuggestion}>Cancel</button>
          <button
            class="book-writer-guided-primary"
            @click=${() => {
              const textarea = document.querySelector<HTMLTextAreaElement>(
                '[data-book-writer-ai-suggestion="true"]',
              );
              props.onApplyAiSuggestion(suggestion, textarea?.value ?? suggestion.suggestion);
            }}
          >
            Apply suggestion
          </button>
        </div>
      </section>
    </div>
  `;
}

function renderDestructiveConfirmation(props: BookWriterDashboardProps) {
  const action = props.pendingDestructiveAction;
  if (!action) {
    return nothing;
  }
  const copy =
    action.kind === "move-active"
      ? {
          eyebrow: "Safe cleanup",
          title: "Move this book to Recently Deleted?",
          body: `"${action.title}" will leave active books. You can restore it later.`,
          confirm: "Move to Recently Deleted",
        }
      : action.kind === "move-active-many"
        ? {
            eyebrow: "Safe library cleanup",
            title: `Move all ${action.count} active books to Recently Deleted?`,
            body: "They will leave your active library. You can restore any book later.",
            confirm: "Move all to Recently Deleted",
          }
        : action.kind === "delete-archived"
          ? {
              eyebrow: "Archive cleanup",
              title: `Move archived "${action.title}" to Recently Deleted?`,
              body: "This removes it from Archived books, but it remains recoverable in Recently Deleted.",
              confirm: "Move to Recently Deleted",
            }
          : action.kind === "delete-deleted"
            ? {
                eyebrow: "Permanent delete",
                title: `Permanently delete "${action.title}"?`,
                body: "This cannot be undone.",
                confirm: "Delete forever",
              }
            : {
                eyebrow: "Permanent delete",
                title: `Permanently delete all ${action.count} deleted books?`,
                body: "This cannot be undone.",
                confirm: "Delete forever",
              };
  return html`
    <div class="book-writer-confirm-backdrop" role="presentation">
      <section class="book-writer-confirm-sheet" role="dialog" aria-modal="true">
        <p class="book-writer-eyebrow">${copy.eyebrow}</p>
        <h2>${copy.title}</h2>
        <p>${copy.body}</p>
        <div class="book-writer-confirm-actions">
          <button class="book-writer-btn" @click=${props.onCancelDestructiveAction}>Cancel</button>
          <button
            class="book-writer-guided-primary book-writer-guided-primary--danger"
            @click=${() => props.onConfirmDestructiveAction(action)}
          >
            ${copy.confirm}
          </button>
        </div>
      </section>
    </div>
  `;
}

function readNumberInput(root: ParentNode, selector: string): number {
  const input = root.querySelector<HTMLInputElement>(selector);
  const value = Number(input?.value ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function renderTrophyBookCard(
  props: BookWriterDashboardProps,
  book: FinishedBookWriterProjectSummary,
) {
  const metrics = book.metrics;
  const proof = book.publishProof;
  const profitPerWord =
    metrics?.totalProfitUsd && book.draftedWords ? metrics.totalProfitUsd / book.draftedWords : 0;
  return html`
    <article class="book-writer-trophy-book">
      <div class="book-writer-cover-shell" aria-hidden="true">
        ${book.coverPreviewDataUrl
          ? html`<img
              class="book-writer-cover book-writer-cover--image"
              src=${book.coverPreviewDataUrl}
              alt=""
            />`
          : html`<div class="book-writer-cover">
              <span>${coverInitials(book.title)}</span>
              <b>${book.title}</b>
              <small>${book.penName}</small>
            </div>`}
      </div>
      <div class="book-writer-trophy-book__copy">
        <p class="book-writer-eyebrow">
          Published ${new Date(book.publishedAt ?? book.finishedAt).toLocaleDateString()}
        </p>
        <h4>${book.title}</h4>
        <p>${book.subtitle || book.genre}</p>
        <div class="book-writer-hero__pills">
          ${renderPill(`${book.draftedWords.toLocaleString()} words`, "good")}
          ${renderPill(`${(metrics?.totalSales ?? 0).toLocaleString()} sales`, "neutral")}
          ${renderPill(`${dollars(metrics?.totalProfitUsd)} profit`, "good")}
          ${renderPill(fileName(book.coverPath), "neutral", book.coverPath)}
        </div>
        <small>
          ${proof?.destination ? statusLabel(proof.destination) : "Published"} ·
          ${proof?.category ?? book.genre} · Cover used:
          ${book.coverSource ?? "saved cover artifact"} · ${book.chapterCount.toLocaleString()}
          chapters
        </small>
        <details class="book-writer-guided-details">
          <summary>Stats and trends</summary>
          <div class="book-writer-plain-card book-writer-plain-card--four">
            <div>
              <b>${(metrics?.totalSales ?? 0).toLocaleString()}</b>
              <span>Total sales</span>
            </div>
            <div>
              <b>${dollars(metrics?.totalRevenueUsd)}</b>
              <span>Revenue</span>
            </div>
            <div>
              <b>${dollars(metrics?.totalProfitUsd)}</b>
              <span>Profit</span>
            </div>
            <div>
              <b>${profitPerWord ? dollars(profitPerWord) : "$0"}</b>
              <span>Profit / word</span>
            </div>
          </div>
          <div class="book-writer-control-grid book-writer-trophy-metrics-form">
            <label>
              <span>Total sales</span>
              <input
                data-metric="sales"
                type="number"
                min="0"
                .value=${String(metrics?.totalSales ?? 0)}
              />
            </label>
            <label>
              <span>Revenue $</span>
              <input
                data-metric="revenue"
                type="number"
                min="0"
                step="0.01"
                .value=${String(metrics?.totalRevenueUsd ?? 0)}
              />
            </label>
            <label>
              <span>Profit $</span>
              <input
                data-metric="profit"
                type="number"
                step="0.01"
                .value=${String(metrics?.totalProfitUsd ?? 0)}
              />
            </label>
            <label>
              <span>Reviews</span>
              <input
                data-metric="reviews"
                type="number"
                min="0"
                .value=${String(metrics?.reviewCount ?? 0)}
              />
            </label>
          </div>
          <button
            class="book-writer-btn book-writer-btn--quiet"
            ?disabled=${Boolean(props.savingAction)}
            @click=${(event: Event) => {
              const article = (event.currentTarget as HTMLElement).closest(
                ".book-writer-trophy-book",
              );
              if (!article) {
                return;
              }
              props.onUpdatePublishedMetrics(book.finishedId, {
                totalSales: readNumberInput(article, '[data-metric="sales"]'),
                totalRevenueUsd: readNumberInput(article, '[data-metric="revenue"]'),
                totalProfitUsd: readNumberInput(article, '[data-metric="profit"]'),
                adSpendUsd: metrics?.adSpendUsd ?? 0,
                reviewCount: readNumberInput(article, '[data-metric="reviews"]'),
                snapshots: metrics?.snapshots ?? [],
              });
            }}
          >
            Save trophy stats
          </button>
          ${metrics?.snapshots.length
            ? html`<ul>
                ${metrics.snapshots.map(
                  (snapshot) => html`<li>
                    ${snapshot.label}: ${snapshot.unitsSold.toLocaleString()} sales ·
                    ${dollars(snapshot.profitUsd)} profit
                  </li>`,
                )}
              </ul>`
            : html`<small
                >Add sales/profit above now; KDP CSV import can fill snapshots later.</small
              >`}
        </details>
      </div>
      <button
        class="book-writer-project__restore"
        title=${`Move ${book.title} back to the active library`}
        aria-label=${`Move ${book.title} back to library`}
        ?disabled=${Boolean(props.savingAction)}
        @click=${() => props.onRestoreFinishedRun(book.finishedId)}
      >
        ${icons.cornerDownRight}
        <span>Move back to library</span>
      </button>
    </article>
  `;
}

function renderTrophyRoom(props: BookWriterDashboardProps) {
  const finishedBooks = props.snapshot?.finishedBooks ?? [];
  return html`
    <div class="book-writer-trophy-stage" aria-label="Finished books shelf">
      <section
        class="book-writer-trophy-room book-writer-trophy-room--top"
        aria-label="Finished books trophy room"
      >
        <div class="book-writer-trophy-room__head">
          <div>
            <p class="book-writer-eyebrow">${renderLabel("Trophy room", "trophyRoom")}</p>
            <h3>Your published-book trophy room.</h3>
            <p>Published books only. Cover-forward, proud, and separate from active writing.</p>
          </div>
          ${renderPill(`${finishedBooks.length} published`, "good")}
        </div>
        <div class="book-writer-trophy-grid">
          ${finishedBooks.length
            ? finishedBooks.map((book) => renderTrophyBookCard(props, book))
            : html`<article class="book-writer-trophy-empty">
                <div class="book-writer-cover book-writer-cover--empty">
                  <span>🏆</span>
                </div>
                <div>
                  <h4>No published trophies yet.</h4>
                  <p>When you mark a completed book as published, its cover shows up here first.</p>
                </div>
              </article>`}
        </div>
      </section>
    </div>
  `;
}

function renderCompletedBookCard(props: BookWriterDashboardProps, book: BookWriterProjectSummary) {
  return html`
    <article class="book-writer-trophy-book book-writer-completed-book">
      <div class="book-writer-cover-shell" aria-hidden="true">
        <div class="book-writer-cover">
          <span>${coverInitials(book.title)}</span>
          <b>${book.title}</b>
          <small>${book.penName}</small>
        </div>
      </div>
      <div class="book-writer-trophy-book__copy">
        <p class="book-writer-eyebrow">Completed, not published</p>
        <h4>${book.title}</h4>
        <p>${book.subtitle || book.genre}</p>
        <div class="book-writer-hero__pills">
          ${renderPill(`${book.draftedWords.toLocaleString()} words`, "good")}
          ${renderPill("Ready for publish prep", "warn")}
        </div>
        <small>Review, prepare KDP, then mark published when the upload is complete.</small>
      </div>
      <button
        class="book-writer-project__restore"
        title=${`Open ${book.title}`}
        aria-label=${`Open completed book ${book.title}`}
        @click=${() => props.onSelectRun(book.runId)}
      >
        ${icons.cornerDownRight}
        <span>Open</span>
      </button>
    </article>
  `;
}

function renderRecommendationCard(props: BookWriterDashboardProps) {
  const recommendation = props.snapshot?.recommendation;
  return html`
    <section class="book-writer-recommendation-card" aria-label="Next book recommendation">
      <div>
        <p class="book-writer-eyebrow">Next book recommendation</p>
        <h3>
          ${recommendation
            ? recommendation.title
            : "Publish a trophy first, then OpenClaw can spot the next best book."}
        </h3>
        <p>
          ${recommendation
            ? recommendation.why
            : "Recommendations use Trophy Room sales, profit, category, keywords, tone, and length."}
        </p>
      </div>
      ${recommendation
        ? html`
            <div class="book-writer-plain-card">
              <p>${recommendation.topicParagraph}</p>
              <div class="book-writer-hero__pills">
                ${renderPill(`Confidence: ${recommendation.confidence}`, "good")}
                ${recommendation.evidence.map((item) => renderPill(item, "neutral"))}
              </div>
            </div>
            <button
              class="book-writer-guided-primary book-writer-guided-primary--small"
              ?disabled=${Boolean(props.savingAction)}
              @click=${() => props.onBuildRecommendedBook(recommendation.topicParagraph)}
            >
              Build this recommended book
            </button>
          `
        : html`<small>Add stats to published trophies to unlock smarter suggestions.</small>`}
    </section>
  `;
}

function renderPenNameProfiles(props: BookWriterDashboardProps) {
  const profiles = props.snapshot?.penNameProfiles ?? [];
  return html`
    <section class="book-writer-pen-profiles" aria-label="Pen name profiles">
      <div class="book-writer-trophy-room__head">
        <div>
          <p class="book-writer-eyebrow">Pen names</p>
          <h3>Publishing lanes by pen name.</h3>
          <p>Reuse the right name for similar books so readers get a consistent promise.</p>
        </div>
        ${renderPill(`${profiles.length} profiles`, "neutral")}
      </div>
      <div class="book-writer-pen-profile-grid">
        ${profiles.length
          ? profiles.map((profile) => renderPenNameProfileCard(props, profile))
          : html`<article class="book-writer-trophy-empty">
              <div>
                <h4>No pen names yet.</h4>
                <p>Create or publish a book to start a reusable pen-name profile.</p>
              </div>
            </article>`}
      </div>
    </section>
  `;
}

function renderPenNameProfileCard(
  props: BookWriterDashboardProps,
  profile: BookWriterPenNameProfile,
) {
  return html`
    <article class="book-writer-pen-profile" data-pen-name=${profile.name}>
      <div>
        <p class="book-writer-eyebrow">${profile.name}</p>
        <h4>${profile.lane}</h4>
        <p>${profile.readerPromise}</p>
      </div>
      <div class="book-writer-hero__pills">
        ${renderPill(`${profile.publishedCount} published`, "good")}
        ${renderPill(`${profile.completedCount} completed`, "warn")}
        ${renderPill(`${profile.inProgressCount} in progress`, "neutral")}
      </div>
      <details>
        <summary>Edit profile and books</summary>
        <label>
          <span>Lane / type of books</span>
          <input data-pen-profile="lane" .value=${profile.lane} />
        </label>
        <label>
          <span>Reader promise</span>
          <textarea data-pen-profile="readerPromise" .value=${profile.readerPromise}></textarea>
        </label>
        <div class="book-writer-pen-book-list">
          <b>Published</b>
          <small
            >${profile.books.published.map((book) => book.title).join(", ") || "None yet"}</small
          >
          <b>Completed</b>
          <small
            >${profile.books.completed.map((book) => book.title).join(", ") || "None yet"}</small
          >
          <b>In progress</b>
          <small
            >${profile.books.inProgress.map((book) => book.title).join(", ") || "None yet"}</small
          >
        </div>
        <button
          class="book-writer-btn book-writer-btn--quiet"
          ?disabled=${Boolean(props.savingAction)}
          @click=${(event: Event) => {
            const card = (event.currentTarget as HTMLElement).closest(".book-writer-pen-profile");
            props.onUpdatePenNameProfile({
              name: profile.name,
              lane:
                card?.querySelector<HTMLInputElement>('[data-pen-profile="lane"]')?.value ??
                profile.lane,
              readerPromise:
                card?.querySelector<HTMLTextAreaElement>('[data-pen-profile="readerPromise"]')
                  ?.value ?? profile.readerPromise,
            });
          }}
        >
          Save pen name profile
        </button>
      </details>
    </article>
  `;
}

function renderLandingShelves(props: BookWriterDashboardProps) {
  const completedBooks = (props.snapshot?.projects ?? []).filter(
    (project) => project.status === "publish-ready",
  );
  return html`
    <section class="book-writer-landing-shelf" aria-label="Book Studio landing shelves">
      <div class="book-writer-landing-shelf__head">
        <div>
          <p class="book-writer-eyebrow">Home</p>
          <h3>Published trophies first. Completed books right underneath.</h3>
          <p>
            This is your Book Studio home base: proud finished work at the top, publishing-ready
            work below, and active drafts in the left rail.
          </p>
        </div>
        ${renderPill(
          `${completedBooks.length} completed · ${(props.snapshot?.finishedBooks ?? []).length} published`,
          "neutral",
        )}
        ${renderLocalAiHealth(props)}
      </div>
      ${renderTrophyRoom(props)}
      <section class="book-writer-completed-shelf" aria-label="Completed books not published">
        <div class="book-writer-trophy-room__head">
          <div>
            <p class="book-writer-eyebrow">Completed books</p>
            <h3>Done, not published yet.</h3>
            <p>These are ready for publishing prep, but they are not trophies until you publish.</p>
          </div>
          ${renderPill(
            `${completedBooks.length} waiting`,
            completedBooks.length ? "warn" : "neutral",
          )}
        </div>
        ${completedBooks.length
          ? html`<div class="book-writer-trophy-grid">
              ${completedBooks.map((book) => renderCompletedBookCard(props, book))}
            </div>`
          : html`<div class="book-writer-trophy-empty">
              <div class="book-writer-cover book-writer-cover--empty"><span>✓</span></div>
              <div>
                <h4>No completed unpublished books yet.</h4>
                <p>Finish a draft, check quality, then it will appear here before publishing.</p>
              </div>
            </div>`}
      </section>
      ${renderPenNameProfiles(props)} ${renderRecommendationCard(props)}
    </section>
  `;
}

function renderBookCelebration(props: BookWriterDashboardProps) {
  const celebration = props.celebration;
  if (!celebration) {
    return nothing;
  }
  const title = celebration.kind === "finished" ? "Trophy unlocked!" : "New book added!";
  const detail =
    celebration.kind === "finished"
      ? `${celebration.title} moved into the Trophy Room.`
      : `${celebration.title} joined your library.`;
  return html`
    <section class="book-writer-celebration" aria-live="polite" aria-label=${title}>
      <div class="book-writer-celebration__fireworks" aria-hidden="true">
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <div>
        <p class="book-writer-eyebrow">A little magic</p>
        <h3>${title}</h3>
        <p>${detail}</p>
      </div>
      <button
        class="book-writer-celebration__dismiss"
        type="button"
        aria-label="Dismiss book celebration"
        @click=${props.onDismissCelebration}
      >
        Nice
      </button>
    </section>
  `;
}

function renderJourney(props: BookWriterDashboardProps) {
  const activeIndex = VIEWS.findIndex((view) => view.id === props.activeView);
  return html`
    <nav class="book-writer-journey" aria-label="Book Studio journey">
      ${VIEWS.map(
        (view, index) => html`
          <button
            class=${props.activeView === view.id
              ? "book-writer-journey__step book-writer-journey__step--active"
              : index < activeIndex
                ? "book-writer-journey__step book-writer-journey__step--done"
                : "book-writer-journey__step"}
            role="tab"
            aria-selected=${props.activeView === view.id ? "true" : "false"}
            title=${`${view.label}: ${view.definition}`}
            aria-label=${`${view.label}: ${view.definition}`}
            @click=${() => props.onActiveViewChange(view.id)}
          >
            <span>${index + 1}</span>
            <b>${view.shortLabel}</b>
          </button>
        `,
      )}
    </nav>
  `;
}

function renderWorkflowMap(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const steps = workflowStepsFor(props, plan);
  return html`
    <section class="book-writer-workflow-map" aria-label="Book readiness map">
      <div class="book-writer-workflow-map__head">
        <div>
          <p class="book-writer-eyebrow">${renderLabel("Stage map", "stage")}</p>
          <h3>Book readiness map</h3>
          <p>Click any row to jump there. This is the no-guesswork path from idea to KDP prep.</p>
        </div>
        ${renderPill(
          `${steps.filter((step) => step.state === "done").length}/${steps.length} done`,
          "neutral",
          "How many workflow stages are complete.",
        )}
      </div>
      <div class="book-writer-workflow-map__grid">
        ${steps.map(
          (step, index) => html`
            <button
              class=${`book-writer-workflow-step book-writer-workflow-step--${step.state}`}
              title=${`${step.label}: ${step.summary} Next: ${step.action}`}
              aria-label=${`${step.label}. ${step.state}. ${step.summary} Next: ${step.action}`}
              @click=${() => props.onActiveViewChange(step.view)}
            >
              <span>${index + 1}</span>
              <b>${step.label}</b>
              ${renderPill(statusLabel(step.state), workflowTone(step.state))}
              <em>${step.summary}</em>
              <small>${step.action}</small>
            </button>
          `,
        )}
      </div>
    </section>
  `;
}

function renderGuidancePanel(props: BookWriterDashboardProps) {
  const coach = VIEW_COACH[props.activeView];
  return html`
    <section class="book-writer-guide" aria-label="Book Studio guidance">
      <div>
        <p class="book-writer-eyebrow">Use this screen</p>
        <h3>What this section is for</h3>
      </div>
      <div class="book-writer-guide__grid">
        <p><b>Purpose:</b> ${coach.plain}</p>
        <p><b>What you change:</b> ${coach.control}</p>
        <p><b>Next action:</b> ${coach.next}</p>
      </div>
    </section>
  `;
}

function renderGlossaryStrip() {
  return html`
    <section class="book-writer-glossary" aria-label="Book Studio term definitions">
      <div>
        <p class="book-writer-eyebrow">Plain-English dictionary</p>
        <b>No hover required. These are the terms used on this page.</b>
      </div>
      <div class="book-writer-glossary__chips">
        ${GLOSSARY_TERMS.map((key) => {
          const term = TERM_DEFINITIONS[key];
          return html`
            <span
              class="book-writer-glossary-chip"
              tabindex="0"
              title=${`${term.label}: ${term.definition}`}
              aria-label=${`${term.label}: ${term.definition}`}
            >
              <b>${term.label}</b>
              <small>${term.definition}</small>
            </span>
          `;
        })}
      </div>
    </section>
  `;
}

function renderToolbar(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  return html`
    <div class="book-writer-toolbar">
      <div class="book-writer-view-title">
        <p class="book-writer-eyebrow">${VIEW_COPY[props.activeView].eyebrow}</p>
        <h3>${VIEW_COPY[props.activeView].title}</h3>
        <p>${VIEW_COPY[props.activeView].body}</p>
      </div>
      <div class="book-writer-actions" aria-label="Book Studio controls">
        <label class="book-writer-search-wrap">
          <span>${icons.search}</span>
          <input
            class="book-writer-search"
            type="search"
            .value=${props.searchQuery}
            placeholder="Find title, paragraph instruction, or text"
            @input=${(event: Event) =>
              props.onSearchQueryChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        ${renderIconButton("Undo", icons.cornerDownRight, props.onUndo, {
          disabled: !props.canUndo || Boolean(props.savingAction),
          tone: "quiet",
        })}
        ${renderIconButton("Redo", icons.cornerDownRight, props.onRedo, {
          disabled: !props.canRedo || Boolean(props.savingAction),
          tone: "quiet",
        })}
        <details class="book-writer-more-menu">
          <summary>More</summary>
          <div class="book-writer-more-menu__panel">
            ${renderIconButton("Write the paragraphs", icons.penLine, props.onDraftPlan, {
              disabled: Boolean(props.savingAction),
              tone: "quiet",
              title:
                "Write the paragraphs: fill empty unlocked Book Text boxes while preserving locked text.",
            })}
            ${renderIconButton("Build readable book", icons.fileText, props.onStitchPlan, {
              disabled: Boolean(props.savingAction),
              tone: "quiet",
              title: "Build readable book: combine Book Text into one manuscript.",
            })}
            ${renderIconButton("Check book quality", icons.book, props.onPackagePlan, {
              disabled: Boolean(props.savingAction),
              tone: "quiet",
              title: "Check book quality: build book files and quality findings.",
            })}
          </div>
        </details>
      </div>
      <div class="book-writer-meta">
        <span>Loaded ${formatTime(props.lastFetchAt)}</span>
      </div>
    </div>
  `;
}

function renderBrief(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  return html`
    <section class="book-writer-editor">
      <label>
        <span>Book title</span>
        <input
          .value=${plan.title}
          placeholder="A clear, memorable title"
          @change=${(event: Event) =>
            props.onSavePlan({ ...plan, title: (event.currentTarget as HTMLInputElement).value })}
        />
        ${renderFieldHint(
          "Keep it short enough that a reader understands the promise at a glance.",
        )}
      </label>
      <label>
        <span>Subtitle</span>
        <input
          .value=${plan.subtitle}
          placeholder="The promise in one line"
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              subtitle: (event.currentTarget as HTMLInputElement).value,
            })}
        />
        ${renderFieldHint("Use this to explain the benefit, genre, or hook in one sentence.")}
      </label>
      <label class="book-writer-editor--wide">
        ${renderLabel("Topic", "topic")}
        <textarea
          .value=${plan.brief.topicParagraph}
          placeholder="Describe the exact book you want."
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              topic: (event.currentTarget as HTMLTextAreaElement).value,
              brief: {
                ...plan.brief,
                topicParagraph: (event.currentTarget as HTMLTextAreaElement).value,
              },
            })}
        ></textarea>
        ${renderFieldHint(
          "Best format: who the reader is, what the book covers, and what outcome it should deliver.",
        )}
      </label>
      <label>
        ${renderLabel("Reader promise", "readerPromise")}
        <textarea
          .value=${plan.brief.readerPromise}
          placeholder="What should readers be able to do, feel, or understand by the end?"
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              brief: {
                ...plan.brief,
                readerPromise: (event.currentTarget as HTMLTextAreaElement).value,
              },
            })}
        ></textarea>
        ${renderFieldHint(
          "This is the result the book must deliver. AI uses it to keep chapters on track.",
        )}
      </label>
      <label>
        ${renderLabel("Audience", "audience")}
        <textarea
          .value=${plan.brief.audience}
          placeholder="Who is this for?"
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              brief: {
                ...plan.brief,
                audience: (event.currentTarget as HTMLTextAreaElement).value,
              },
            })}
        ></textarea>
        ${renderFieldHint(
          "Name the reader as specifically as possible; vague audiences create vague books.",
        )}
      </label>
      <div class="book-writer-editor--wide">${renderBookSetupControls(props, plan)}</div>
      <label>
        ${renderLabel("Mode", "mode")}
        <select
          .value=${plan.mode}
          @change=${(event: Event) =>
            props.onSavePlan({
              ...plan,
              mode: (event.currentTarget as HTMLSelectElement).value as BookWriterPlan["mode"],
            })}
        >
          <option value="simple">Simple</option>
          <option value="advanced">Advanced</option>
        </select>
        ${renderFieldHint(
          "Simple hides noise. Advanced is better when you want paragraph-level production control.",
        )}
      </label>
    </section>
  `;
}

function renderChapterCard(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan,
  chapter: BookWriterChapter,
) {
  const chapterIndex = plan.chapters.findIndex((item) => item.id === chapter.id);
  return html`
    <article
      class="book-writer-chapter"
      draggable="true"
      @dragstart=${() => {
        draggedChapterId = chapter.id;
      }}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${() => {
        if (!draggedChapterId || draggedChapterId === chapter.id) {
          return;
        }
        props.onSavePlan({
          ...plan,
          chapters: reorderByDrop(plan.chapters, draggedChapterId, chapter.id),
        });
        draggedChapterId = null;
      }}
    >
      <div class="book-writer-chapter__head">
        <div>
          <p class="book-writer-eyebrow">Chapter ${chapter.number}</p>
          ${renderPill(statusLabel(chapter.status))}
        </div>
        <div class="book-writer-card-controls">
          <label class="book-writer-lock">
            <input
              type="checkbox"
              .checked=${chapter.locked}
              @change=${(event: Event) =>
                props.onSavePlan(
                  updateChapter(plan, chapter.id, (item) => ({
                    ...item,
                    locked: (event.currentTarget as HTMLInputElement).checked,
                  })),
                )}
            />
            ${renderLabel("Lock", "lock")}
            <small>Locked text will not be changed by AI.</small>
          </label>
          <details class="book-writer-card-more">
            <summary>More</summary>
            <div>
              <button
                title="Move chapter up"
                aria-label="Move chapter up"
                ?disabled=${chapterIndex <= 0}
                @click=${() =>
                  props.onSavePlan({
                    ...plan,
                    chapters: moveItem(plan.chapters, chapterIndex, chapterIndex - 1),
                  })}
              >
                ${icons.arrowDown}
              </button>
              <button
                title="Move chapter down"
                aria-label="Move chapter down"
                ?disabled=${chapterIndex >= plan.chapters.length - 1}
                @click=${() =>
                  props.onSavePlan({
                    ...plan,
                    chapters: moveItem(plan.chapters, chapterIndex, chapterIndex + 1),
                  })}
              >
                ${icons.arrowDown}
              </button>
            </div>
          </details>
        </div>
      </div>
      <label>
        ${renderLabel("Chapter title", "chapter")}
        <input
          class="book-writer-title-input book-writer-editor-field--compact"
          .value=${chapter.title}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                title: (event.currentTarget as HTMLInputElement).value,
              })),
            )}
        />
        ${renderFieldTools(
          props,
          "chapterTitle",
          { chapterId: chapter.id },
          { locked: chapter.locked || chapter.fieldLocks?.title },
        )}
        ${renderSmallFieldLock({
          checked: Boolean(chapter.fieldLocks?.title),
          onChange: (locked) =>
            props.onSavePlan(updateChapterFieldLock(plan, chapter.id, "title", locked)),
        })}
        ${renderFieldHint(
          "A good chapter title tells you what changes for the reader or story here.",
        )}
      </label>
      <label>
        ${renderLabel("Plan for AI · what this chapter will say", "chapter")}
        <textarea
          class="book-writer-editor-field--large book-writer-chapter-description"
          .value=${chapter.description}
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                description: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
        ${renderFieldHint(
          "Paraphrase the chapter's reader-facing content. This is not printed in the book.",
        )}
        ${renderFieldTools(
          props,
          "chapterDescription",
          { chapterId: chapter.id },
          { locked: chapter.locked || chapter.fieldLocks?.description },
        )}
        ${renderSmallFieldLock({
          checked: Boolean(chapter.fieldLocks?.description),
          onChange: (locked) =>
            props.onSavePlan(updateChapterFieldLock(plan, chapter.id, "description", locked)),
        })}
      </label>
      <label>
        ${renderLabel("Chapter style direction", "customTone")}
        <textarea
          class="book-writer-editor-field--medium"
          .value=${chapter.styleDirection ?? ""}
          placeholder="Example: Make this chapter more suspenseful but keep the book warm and practical."
          @change=${(event: Event) =>
            props.onSavePlan(
              updateChapter(plan, chapter.id, (item) => ({
                ...item,
                styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
              })),
            )}
        ></textarea>
        ${renderFieldHint("Local style steering; the global book tone still wins.")}
        ${renderFieldTools(
          props,
          "chapterStyle",
          { chapterId: chapter.id },
          { locked: chapter.locked || chapter.fieldLocks?.styleDirection },
        )}
        ${renderSmallFieldLock({
          checked: Boolean(chapter.fieldLocks?.styleDirection),
          onChange: (locked) =>
            props.onSavePlan(updateChapterFieldLock(plan, chapter.id, "styleDirection", locked)),
        })}
      </label>
      ${renderChapterRoleControls(props, plan, chapter)}
      <div class="book-writer-button-row">
        <button
          class="book-writer-btn book-writer-btn--quiet"
          @click=${() => requestManualParagraphWrite(props, firstWritableParagraphId(chapter))}
        >
          ${icons.fileText}
          <span>Write this chapter myself</span>
        </button>
      </div>
    </article>
  `;
}

function renderParagraphCard(
  props: BookWriterDashboardProps,
  plan: BookWriterPlan,
  chapter: BookWriterChapter,
  paragraph: BookWriterParagraph,
) {
  const paragraphIndex = chapter.paragraphs.findIndex((item) => item.id === paragraph.id);
  return html`
    <article
      class="book-writer-paragraph"
      draggable="true"
      @dragstart=${() => {
        draggedParagraph = { chapterId: chapter.id, paragraphId: paragraph.id };
      }}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @drop=${() => {
        if (
          !draggedParagraph ||
          draggedParagraph.chapterId !== chapter.id ||
          draggedParagraph.paragraphId === paragraph.id
        ) {
          return;
        }
        props.onSavePlan(
          updateChapter(plan, chapter.id, (item) => ({
            ...item,
            paragraphs: reorderByDrop(item.paragraphs, draggedParagraph!.paragraphId, paragraph.id),
          })),
        );
        draggedParagraph = null;
      }}
    >
      <div class="book-writer-paragraph__meta">
        <div>
          <p class="book-writer-eyebrow">Paragraph ${chapter.number}.${paragraph.order}</p>
          ${renderPill(statusLabel(paragraph.status), paragraph.locked ? "good" : "neutral")}
        </div>
        <div class="book-writer-card-controls">
          <label class="book-writer-lock">
            <input
              type="checkbox"
              .checked=${paragraph.locked}
              @change=${(event: Event) =>
                props.onSavePlan(
                  updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                    ...item,
                    locked: (event.currentTarget as HTMLInputElement).checked,
                  })),
                )}
            />
            ${renderLabel("Lock", "lock")}
            <small>Locked text will not be changed by AI.</small>
          </label>
          <details class="book-writer-card-more">
            <summary>More</summary>
            <div>
              <button
                title="Move paragraph up"
                aria-label="Move paragraph up"
                ?disabled=${paragraphIndex <= 0}
                @click=${() =>
                  props.onSavePlan(
                    updateChapter(plan, chapter.id, (item) => ({
                      ...item,
                      paragraphs: moveItem(item.paragraphs, paragraphIndex, paragraphIndex - 1),
                    })),
                  )}
              >
                ${icons.arrowDown}
              </button>
              <button
                title="Move paragraph down"
                aria-label="Move paragraph down"
                ?disabled=${paragraphIndex >= chapter.paragraphs.length - 1}
                @click=${() =>
                  props.onSavePlan(
                    updateChapter(plan, chapter.id, (item) => ({
                      ...item,
                      paragraphs: moveItem(item.paragraphs, paragraphIndex, paragraphIndex + 1),
                    })),
                  )}
              >
                ${icons.arrowDown}
              </button>
              <button
                title="Rewrite this paragraph: clear this Book Text, then use Write the paragraphs."
                aria-label="Rewrite this paragraph"
                ?disabled=${paragraph.locked}
                @click=${() =>
                  props.onSavePlan(
                    updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                      ...item,
                      text: "",
                      status: "planned",
                    })),
                  )}
              >
                ${icons.penLine}
              </button>
            </div>
          </details>
        </div>
      </div>
      <section class="book-writer-paragraph-plan-layer">
        <div>
          <p class="book-writer-eyebrow">Plan for AI</p>
          <h4>What this paragraph will say</h4>
          <small>Paraphrase for AI. Readers see only Book Text.</small>
        </div>
        <label>
          ${renderLabel("Paragraph label", "paragraphCard")}
          <input
            .value=${paragraph.title}
            @change=${(event: Event) =>
              props.onSavePlan(
                updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                  ...item,
                  title: (event.currentTarget as HTMLInputElement).value,
                })),
              )}
          />
          ${renderFieldTools(
            props,
            "paragraphTitle",
            {
              chapterId: chapter.id,
              paragraphId: paragraph.id,
            },
            { locked: paragraph.locked || paragraph.fieldLocks?.title },
          )}
          ${renderSmallFieldLock({
            checked: Boolean(paragraph.fieldLocks?.title),
            onChange: (locked) =>
              props.onSavePlan(
                updateParagraphFieldLock(plan, chapter.id, paragraph.id, "title", locked),
              ),
          })}
          ${renderFieldHint("This label is for you. It is not printed in the book.")}
        </label>
        <label>
          ${renderLabel("What this paragraph will say", "paragraphCard")}
          <textarea
            class="book-writer-purpose book-writer-editor-field--large book-writer-plan-summary"
            .value=${paragraph.summary ?? ""}
            placeholder="Example: This paragraph shows why the invoice changes the stakes."
            @change=${(event: Event) =>
              props.onSavePlan(
                updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                  ...item,
                  summary: (event.currentTarget as HTMLTextAreaElement).value,
                })),
              )}
          ></textarea>
          ${renderFieldHint("Reader-facing paraphrase. It guides AI but is not printed.")}
          ${renderFieldTools(
            props,
            "paragraphSummary",
            {
              chapterId: chapter.id,
              paragraphId: paragraph.id,
            },
            { locked: paragraph.locked || paragraph.fieldLocks?.summary },
          )}
          ${renderSmallFieldLock({
            checked: Boolean(paragraph.fieldLocks?.summary),
            onChange: (locked) =>
              props.onSavePlan(
                updateParagraphFieldLock(plan, chapter.id, paragraph.id, "summary", locked),
              ),
          })}
        </label>
        <label>
          ${renderLabel("What this paragraph should cover", "paragraphCard")}
          <textarea
            class="book-writer-purpose book-writer-editor-field--medium"
            .value=${paragraph.purpose}
            placeholder="Example: Open with a concrete moment that shows the reader why this matters."
            @change=${(event: Event) =>
              props.onSavePlan(
                updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                  ...item,
                  purpose: (event.currentTarget as HTMLTextAreaElement).value,
                })),
              )}
          ></textarea>
          ${renderFieldHint("AI reads this plan before writing this one paragraph.")}
          ${renderFieldTools(
            props,
            "paragraphPlan",
            {
              chapterId: chapter.id,
              paragraphId: paragraph.id,
            },
            { locked: paragraph.locked || paragraph.fieldLocks?.purpose },
          )}
          ${renderSmallFieldLock({
            checked: Boolean(paragraph.fieldLocks?.purpose),
            onChange: (locked) =>
              props.onSavePlan(
                updateParagraphFieldLock(plan, chapter.id, paragraph.id, "purpose", locked),
              ),
          })}
        </label>
        <label>
          ${renderLabel("Paragraph style direction", "customTone")}
          <textarea
            class="book-writer-purpose book-writer-editor-field--style"
            .value=${paragraph.styleDirection ?? ""}
            placeholder="Example: Add dry humor here without losing the book's main tone."
            @change=${(event: Event) =>
              props.onSavePlan(
                updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                  ...item,
                  styleDirection: (event.currentTarget as HTMLTextAreaElement).value,
                })),
              )}
          ></textarea>
          ${renderFieldHint("Local style steering for this paragraph only.")}
          ${renderFieldTools(
            props,
            "paragraphStyle",
            {
              chapterId: chapter.id,
              paragraphId: paragraph.id,
            },
            { locked: paragraph.locked || paragraph.fieldLocks?.styleDirection },
          )}
          ${renderSmallFieldLock({
            checked: Boolean(paragraph.fieldLocks?.styleDirection),
            onChange: (locked) =>
              props.onSavePlan(
                updateParagraphFieldLock(plan, chapter.id, paragraph.id, "styleDirection", locked),
              ),
          })}
        </label>
      </section>
      <section class="book-writer-paragraph-text-layer">
        <div>
          <p class="book-writer-eyebrow">Book Text</p>
          <h4>What readers will see</h4>
          <small>Final writing. Readers see this.</small>
        </div>
        <label>
          ${renderLabel("Book Text", "draft")}
          <textarea
            class="book-writer-draft book-writer-editor-field--hero"
            data-book-writer-book-text-id=${paragraph.id}
            .value=${paragraph.text}
            placeholder="Type the paragraph readers will see."
            @change=${(event: Event) =>
              props.onSavePlan(
                updateParagraph(plan, chapter.id, paragraph.id, (item) => ({
                  ...item,
                  text: (event.currentTarget as HTMLTextAreaElement).value,
                  status: "drafted",
                })),
              )}
          ></textarea>
          ${renderFieldHint(
            `This goes into the final book. Target ${paragraph.targetWords.toLocaleString()} words. Current: ${wordCount(
              paragraph.text,
            ).toLocaleString()} words.`,
          )}
          ${renderFieldTools(
            props,
            "paragraphText",
            {
              chapterId: chapter.id,
              paragraphId: paragraph.id,
            },
            { locked: paragraph.locked || paragraph.fieldLocks?.text },
          )}
          ${renderSmallFieldLock({
            checked: Boolean(paragraph.fieldLocks?.text),
            onChange: (locked) =>
              props.onSavePlan(
                updateParagraphFieldLock(plan, chapter.id, paragraph.id, "text", locked),
              ),
          })}
        </label>
        <div class="book-writer-focused-actions" aria-label="Paragraph writing choices">
          <button
            class="book-writer-btn book-writer-btn--quiet"
            ?disabled=${paragraph.locked ||
            paragraph.fieldLocks?.text ||
            Boolean(props.savingAction)}
            @click=${() => requestAiWriteParagraph(props, paragraph)}
          >
            ${icons.penLine}
            <span>Write this page</span>
          </button>
          <button
            class="book-writer-btn book-writer-btn--quiet"
            @click=${(event: Event) => {
              props.onFocusedParagraphChange(paragraph.id);
              const target = event.currentTarget as HTMLElement;
              const bookText = target
                .closest(".book-writer-paragraph-text-layer")
                ?.querySelector<HTMLTextAreaElement>(
                  `[data-book-writer-book-text-id="${paragraph.id}"]`,
                );
              bookText?.focus();
            }}
          >
            ${icons.fileText}
            <span>I’ll write it myself</span>
          </button>
        </div>
      </section>
    </article>
  `;
}

function renderAiCoachCard(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const summary = summarizePlan(props.snapshot, plan);
  const paragraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const emptyUnlocked = paragraphs.filter(
    (paragraph) => !paragraph.locked && !paragraph.text.trim(),
  ).length;
  const needsInstruction = paragraphs.filter((paragraph) => !paragraph.purpose.trim()).length;
  const locked = paragraphs.filter((paragraph) => paragraph.locked).length;

  if (props.activeView === "chapters") {
    return html`
      <section class="book-writer-ai-coach" aria-label="AI chapter guide">
        <div>
          <p class="book-writer-eyebrow">You do</p>
          <h3>Change the chapter title or plan.</h3>
          <p>Use plain words. This is an outline, not book text.</p>
        </div>
        <div>
          <p class="book-writer-eyebrow">AI does</p>
          <h3>Uses this plan to make paragraph plans.</h3>
          <p>Locked chapters stay protected.</p>
        </div>
        <div>
          <p class="book-writer-eyebrow">Readers see</p>
          <h3>Only the Book Text later, not this box.</h3>
          <p>Chapter plans are instructions for AI.</p>
        </div>
        <div class="book-writer-ai-safety">
          ${renderPill(`${summary.chapterCount} chapters`, "good")}
          ${renderPill(`${locked} locked and protected`, locked ? "good" : "neutral")}
        </div>
      </section>
    `;
  }

  if (props.activeView === "paragraphs") {
    return html`
      <section class="book-writer-ai-coach" aria-label="AI paragraph guide">
        <div>
          <p class="book-writer-eyebrow">Plan step</p>
          <h3>Edit the paraphrase AI reads.</h3>
          <p>Each Plan for AI says what one paragraph will say, without being printed.</p>
        </div>
        <div>
          <p class="book-writer-eyebrow">What you do next</p>
          <h3>Go to Write when the plan looks right.</h3>
          <p>That is where AI fills empty unlocked Book Text boxes.</p>
        </div>
        <div class="book-writer-ai-progress" aria-label="Paragraph writing progress">
          ${renderPill(
            `${summary.draftedParagraphs}/${summary.paragraphCount} paragraphs written`,
            "good",
          )}
          ${renderPill(`${emptyUnlocked} ready to write`, emptyUnlocked ? "warn" : "good")}
          ${renderPill(`${needsInstruction} need instructions`, needsInstruction ? "warn" : "good")}
          ${renderPill(`${locked} locked and protected`, locked ? "good" : "neutral")}
          <strong>Nothing in Plan for AI is printed in the book.</strong>
        </div>
      </section>
    `;
  }

  return nothing;
}

function renderChapters(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const query = props.searchQuery;
  const chapters = plan.chapters.filter((chapter) =>
    filterMatches(query, chapter.title, chapter.description),
  );
  return html`
    ${renderAiCoachCard(props, plan)}
    <section
      class="book-writer-generate-panel"
      data-book-writer-ai-options
      aria-label="AI chapter setup"
    >
      <div>
        <p class="book-writer-eyebrow">Chapter architect</p>
        <h3>AI generate the chapter setup.</h3>
        <p>
          Locked chapters stay unchanged and become continuity anchors for the unlocked chapters.
        </p>
      </div>
      <div class="book-writer-generate-panel__actions">
        ${renderAiOptionCheckbox("title", "Titles")}
        ${renderAiOptionCheckbox("description", "Plan for AI")}
        ${renderAiOptionCheckbox("style", "Style direction")}
        ${renderAiOptionCheckbox("role", "Chapter role")}
        ${renderIconButton(
          "Regenerate better titles",
          icons.spark,
          () => props.onGenerateChapterSetup(["title"]),
          {
            disabled: Boolean(props.savingAction),
            tone: "quiet",
          },
        )}
        ${renderIconButton(
          "AI generate selected chapter fields",
          icons.penLine,
          (event) =>
            props.onGenerateChapterSetup(
              checkedValues<BookWriterChapterSetupTarget>(
                event,
                '.book-writer-generate-panel input[type="checkbox"]',
              ),
            ),
          {
            disabled: Boolean(props.savingAction),
            tone: "quiet",
          },
        )}
      </div>
    </section>
    <section class="book-writer-list">
      ${chapters.length
        ? chapters.map((chapter) => renderChapterCard(props, plan, chapter))
        : html`<div class="book-writer-empty-card">No chapters match that search.</div>`}
    </section>
  `;
}

function renderParagraphs(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const query = props.searchQuery;
  const paragraphs = plan.chapters.flatMap((chapter) => chapter.paragraphs);
  const emptyUnlocked = paragraphs.filter(
    (paragraph) => !paragraph.locked && !paragraph.text.trim(),
  ).length;
  return html`
    ${renderAiCoachCard(props, plan)}
    <section class="book-writer-generate-panel" aria-label="Write paragraphs">
      <div>
        <p class="book-writer-eyebrow">After planning</p>
        <h3>Write actual Book Text from these plans.</h3>
        <p>
          The normal path is <b>Write</b>, where you see the final reader-facing paragraph. The
          advanced shortcut here can fill all empty unlocked Book Text boxes at once.
        </p>
      </div>
      <div class="book-writer-generate-panel__actions">
        ${renderPill(`${emptyUnlocked} empty unlocked`, emptyUnlocked > 0 ? "warn" : "good")}
        ${renderIconButton(
          "Go to Write step",
          icons.fileText,
          () => props.onActiveViewChange("draft"),
          {
            disabled: Boolean(props.savingAction),
            tone: "quiet",
            title: "Go to Write step: create and edit the final Book Text readers will see.",
          },
        )}
        ${renderIconButton("Write the paragraphs", icons.penLine, props.onDraftPlan, {
          disabled: Boolean(props.savingAction),
          tone: "quiet",
          title:
            "Write the paragraphs: advanced shortcut that writes empty unlocked Book Text from each Plan for AI.",
        })}
      </div>
    </section>
    <details class="book-writer-bulk-actions" aria-label="More paragraph tools">
      <summary>More paragraph tools</summary>
      <div>
        <p class="book-writer-eyebrow">${renderLabel("Batch helpers", "bulkActions")}</p>
        <h3>After you like the Book Text</h3>
        ${renderFieldHint(
          "Lock paragraphs to protect them from future AI writing. Approve written paragraphs when they are ready.",
        )}
      </div>
      <div class="book-writer-button-row">
        ${renderIconButton(
          "Lock all paragraphs",
          icons.check,
          () =>
            props.onSavePlan(
              updateAllParagraphs(plan, (paragraph) => ({ ...paragraph, locked: true })),
            ),
          { disabled: Boolean(props.savingAction), tone: "quiet" },
        )}
        ${renderIconButton(
          "Approve written paragraphs",
          icons.check,
          () =>
            props.onSavePlan(
              updateAllParagraphs(plan, (paragraph) =>
                paragraph.text.trim()
                  ? { ...paragraph, status: "approved", locked: true }
                  : paragraph,
              ),
            ),
          { disabled: Boolean(props.savingAction), tone: "quiet" },
        )}
      </div>
    </details>
    <section class="book-writer-paragraph-board">
      ${plan.chapters.map((chapter) => {
        const paragraphs = chapter.paragraphs.filter((paragraph) =>
          filterMatches(query, chapter.title, paragraph.title, paragraph.purpose, paragraph.text),
        );
        if (paragraphs.length === 0) {
          return nothing;
        }
        return html`
          <section class="book-writer-paragraph-column">
            <div class="book-writer-column-head">
              <p class="book-writer-eyebrow">Chapter ${chapter.number}</p>
              <h3>${chapter.title}</h3>
            </div>
            ${paragraphs.map((paragraph) => renderParagraphCard(props, plan, chapter, paragraph))}
          </section>
        `;
      })}
    </section>
  `;
}

function renderPackage(props: BookWriterDashboardProps) {
  const review = props.snapshot?.reviewPack;
  return html`
    <section class="book-writer-package">
      <div class="book-writer-panel book-writer-panel--wide">
        <p class="book-writer-eyebrow">Read the book</p>
        <h3>Readable book preview</h3>
        <div class="book-writer-preview">
          <pre>${props.snapshot?.manuscriptPreview || "Readable book has not been built yet."}</pre>
        </div>
      </div>
      <div class="book-writer-panel">
        <p class="book-writer-eyebrow">Quality package</p>
        <h3>${review ? statusLabel(review.recommendation) : "Not checked yet"}</h3>
        ${review
          ? html`
              <dl>
                ${Object.entries(review.artifacts).map(
                  ([key, value]) => html`
                    <dt>${key}</dt>
                    <dd>${value}</dd>
                  `,
                )}
              </dl>
            `
          : html`<p>Use Check book quality when the readable book is ready.</p>`}
      </div>
      <div class="book-writer-panel">
        <p class="book-writer-eyebrow">${renderLabel("Gaps", "gaps")}</p>
        <h3>What still needs attention</h3>
        ${review?.gaps.length
          ? review.gaps.map((gap) => html`<p>${gap}</p>`)
          : html`<p>No quality issues loaded.</p>`}
      </div>
      ${renderFixPublishBlockers(props)}
    </section>
  `;
}

function publishFindingTone(status: string): "neutral" | "good" | "warn" | "danger" {
  if (status === "pass") {
    return "good";
  }
  if (status === "warn") {
    return "warn";
  }
  if (status === "fail" || status === "blocked") {
    return "danger";
  }
  return "neutral";
}

function renderFixPublishBlockers(
  props: BookWriterDashboardProps,
): TemplateResult | typeof nothing {
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const planQuality = props.snapshot?.planQuality;
  const blockers = [
    ...(!review ? ["Run Check book quality to create the quality package."] : []),
    ...(review && review.recommendation !== "approve"
      ? [`Quality check is ${review.recommendation}; publishing prep waits for approve.`]
      : []),
    ...(review?.gaps ?? []),
    ...(planQuality?.findings
      .filter((finding) => finding.status !== "pass")
      .map((finding) => finding.message) ?? []),
    ...(dryRun?.findings
      .filter((finding) => finding.status !== "pass")
      .map((finding) => finding.message) ?? []),
  ];
  if (blockers.length === 0) {
    return nothing;
  }
  const busy = Boolean(props.savingAction);
  return html`
    <div class="book-writer-panel book-writer-fix-panel book-writer-panel--wide">
      <div>
        <p class="book-writer-eyebrow">Fix publish blockers</p>
        <h3>Here is exactly why publish is not ready yet.</h3>
        <p>
          No guessing: fix these items, then run <b>Check book quality</b> again. If publishing prep
          is already built, rebuild it after quality passes.
        </p>
      </div>
      <ol>
        ${blockers.slice(0, 8).map((blocker) => html`<li>${blocker}</li>`)}
      </ol>
      <div class="book-writer-button-row">
        ${renderIconButton(
          "Open Plan Paragraphs",
          icons.penLine,
          () => props.onActiveViewChange("paragraphs"),
          {
            disabled: busy,
            title: "Open Plan Paragraphs: edit Plan for AI and Book Text.",
          },
        )}
        ${renderIconButton("Write missing Book Text", icons.penLine, props.onDraftPlan, {
          disabled: busy,
          title:
            "Write missing Book Text: explicit AI command. Packaging and publishing will not secretly draft prose.",
        })}
        ${renderIconButton("Check book quality again", icons.book, props.onPackagePlan, {
          disabled: busy,
          tone: "quiet",
          title: "Check book quality again: rebuild files and quality reports after fixes.",
        })}
        ${dryRun && review?.recommendation === "approve"
          ? renderIconButton("Rebuild publishing plan", icons.globe, props.onPreparePublish, {
              disabled: busy,
              title: "Rebuild publishing plan after quality blockers are fixed.",
            })
          : nothing}
      </div>
    </div>
  `;
}

function renderPublishPrimaryAction(props: BookWriterDashboardProps) {
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const plan = props.snapshot?.plan;
  const busy = Boolean(props.savingAction);
  const missingText = plan ? missingBookTextCount(plan) : 0;

  if (missingText > 0) {
    return html`
      ${renderIconButton("Write missing Book Text", icons.penLine, props.onDraftPlan, {
        disabled: busy,
        tone: "quiet",
        title:
          "Write missing Book Text: explicit AI command. Quality checks will not secretly draft prose.",
      })}
    `;
  }

  if (!review) {
    return html`
      ${renderIconButton("Check book quality first", icons.book, props.onPackagePlan, {
        disabled: busy,
        tone: "quiet",
        title:
          "Check book quality first: build the EPUB, cover, metadata, and quality findings before publishing prep.",
      })}
    `;
  }

  if (review.recommendation !== "approve") {
    return html`
      ${renderIconButton("Re-check book quality", icons.book, props.onPackagePlan, {
        disabled: busy,
        tone: "quiet",
        title: "Re-check book quality: publishing prep is locked until quality passes.",
      })}
    `;
  }

  if (!dryRun) {
    if (plan?.cover.status !== "approved") {
      const firstVariantId = plan?.cover.variants[0]?.id;
      return html`
        ${renderIconButton(
          firstVariantId ? "Approve cover first" : "Generate cover first",
          firstVariantId ? icons.check : icons.spark,
          firstVariantId
            ? () => props.onApproveCover(firstVariantId)
            : props.onGenerateCoverConcept,
          {
            disabled: busy,
            tone: "quiet",
            title:
              "Approve cover first: generate or upload a cover below, approve it, or use KDP Cover Creator.",
          },
        )}
      `;
    }
    return html`
      ${renderIconButton(
        "Prepare publishing",
        icons.globe,
        () => props.onPreparePublishWithCoverStrategy("upload"),
        {
          disabled: busy,
          tone: "quiet",
          title:
            "Prepare publishing: create a safe KDP upload checklist and stop before final submit.",
        },
      )}
    `;
  }

  if (dryRun.status !== "ready") {
    return html`
      ${renderIconButton("Rebuild publishing plan", icons.globe, props.onPreparePublish, {
        disabled: busy,
        tone: "quiet",
        title: "Rebuild publishing plan after fixing the blocked or warning findings.",
      })}
    `;
  }

  return html`
    <a
      class="book-writer-btn"
      href=${KDP_BOOKSHELF_URL}
      target="_blank"
      rel="noreferrer"
      title="Open Amazon KDP Bookshelf in a new tab. Follow the checklist and stop before final submit."
    >
      <span class="book-writer-btn__icon">${icons.globe}</span>
      <span>Open KDP Bookshelf</span>
    </a>
  `;
}

function readPublishProof(root: ParentNode | null): BookWriterPublishedProof | null {
  const value = (name: string) =>
    root
      ?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-publish-proof="${name}"]`)
      ?.value.trim() ?? "";
  const confirmed =
    root?.querySelector<HTMLInputElement>(`[data-publish-proof="operatorConfirmed"]`)?.checked ===
    true;
  if (!confirmed) {
    return null;
  }
  const price = Number(value("price"));
  const destination = value("destination") as BookWriterPublishedProof["destination"];
  const publishedAt = value("publishedAt");
  if (!destination || !publishedAt) {
    return null;
  }
  return {
    destination,
    publishedAt,
    operatorConfirmed: true,
    confirmedAt: new Date().toISOString(),
    ...(value("asin") ? { asin: value("asin") } : {}),
    ...(value("url") ? { marketplaceUrl: value("url") } : {}),
    ...(Number.isFinite(price) && price > 0 ? { priceUsd: price } : {}),
    ...(value("category") ? { category: value("category") } : {}),
    ...(value("keywords")
      ? {
          keywords: value("keywords")
            .split(",")
            .map((keyword) => keyword.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

function renderPublishProofBox(plan: BookWriterPlan): TemplateResult {
  const today = new Date().toISOString().slice(0, 10);
  return html`
    <section class="book-writer-publish-proof book-writer-guided-upload">
      <p class="book-writer-eyebrow">Published proof</p>
      <h3>Only mark published after Amazon/KDP accepts the book.</h3>
      <label class="book-writer-publish-proof__confirm">
        <input data-publish-proof="operatorConfirmed" type="checkbox" />
        <span
          >I personally confirm this book has been successfully published outside OpenClaw.</span
        >
      </label>
      <div class="book-writer-control-grid">
        <label>
          <span>Destination</span>
          <select data-publish-proof="destination">
            <option value="amazon-kdp">Amazon KDP</option>
            <option value="kindle">Kindle</option>
            <option value="paperback">Paperback</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          <span>Published date</span>
          <input data-publish-proof="publishedAt" type="date" .value=${today} />
        </label>
        <label>
          <span>ASIN</span>
          <input data-publish-proof="asin" placeholder="Optional" />
        </label>
        <label>
          <span>Price $</span>
          <input data-publish-proof="price" type="number" step="0.01" min="0" placeholder="2.99" />
        </label>
        <label class="book-writer-control-grid__wide">
          <span>Marketplace URL</span>
          <input data-publish-proof="url" placeholder="Optional Amazon page link" />
        </label>
        <label>
          <span>Category</span>
          <input data-publish-proof="category" .value=${plan.genre} />
        </label>
        <label class="book-writer-control-grid__wide">
          <span>Keywords</span>
          <input data-publish-proof="keywords" placeholder="comma, separated, keywords" />
        </label>
      </div>
    </section>
  `;
}

function renderTrophyRoomAction(props: BookWriterDashboardProps): TemplateResult {
  const plan = props.snapshot?.plan;
  const dryRun = props.snapshot?.publishDryRun;
  const ready = Boolean(plan && dryRun?.status === "ready");
  return renderIconButton(
    "Mark published · Move to Trophy Room",
    icons.spark,
    (event) => {
      if (plan) {
        const root =
          event.currentTarget instanceof HTMLElement
            ? (event.currentTarget
                .closest(".book-writer-dashboard")
                ?.querySelector(".book-writer-publish-proof") ?? null)
            : null;
        const proof = readPublishProof(root);
        if (!proof) {
          window.alert(
            "Check the publish-proof confirmation box after the book is actually published.",
          );
          return;
        }
        props.onFinishRun(plan.runId, proof);
      }
    },
    {
      disabled: !ready || Boolean(props.savingAction),
      title: ready
        ? "Mark published · Move to Trophy Room: move this completed book out of active writing and show its cover on the finished shelf."
        : "Move to Trophy Room unlocks after the KDP dry-run is ready.",
    },
  );
}

function coverVariantPreview(variant: BookWriterPlan["cover"]["variants"][number]) {
  if (variant.previewDataUrl) {
    return html`<img
      class="book-writer-cover-variant__image"
      src=${variant.previewDataUrl}
      alt=${`${variant.label} preview`}
    />`;
  }
  if (variant.path && /\.svg$/i.test(variant.path)) {
    return html`<small>${fileName(variant.path)}</small>`;
  }
  return html`<small>${variant.path ? fileName(variant.path) : "Concept only"}</small>`;
}

function coverVariantSourceLabel(variant: BookWriterPlan["cover"]["variants"][number]): string {
  if (variant.source === "local-ai") {
    return `Local AI${variant.provider ? ` · ${variant.provider}` : ""}`;
  }
  if (variant.source === "upload") {
    return "Uploaded image";
  }
  if (variant.source === "kdp-cover-creator") {
    return "KDP Cover Creator";
  }
  return "Editable SVG concept";
}

function renderCoverStudio(props: BookWriterDashboardProps, plan: BookWriterPlan) {
  const approved = plan.cover.variants.find((variant) => variant.approved);
  const firstVariant = plan.cover.variants[0];
  const localCoverAi = props.snapshot?.localCoverAiStatus;
  const localCoverTone =
    localCoverAi?.status === "ready"
      ? "good"
      : localCoverAi?.status === "fallback"
        ? "warn"
        : "danger";
  return html`
    <div class="book-writer-panel book-writer-cover-studio">
      <div>
        <p class="book-writer-eyebrow">Cover</p>
        <h3>Local AI Cover Studio.</h3>
        <p>
          Generate a real local AI cover with OpenClaw when ComfyUI is ready. If local image AI is
          not configured, Book Studio creates an editable SVG concept so the button never does
          nothing.
        </p>
        <div class="book-writer-cover-status">
          ${renderPill(
            localCoverAi?.status === "ready"
              ? "Local image AI ready"
              : localCoverAi?.status === "fallback"
                ? "Fallback concept mode"
                : "Local image AI not configured",
            localCoverTone,
          )}
          <small>${localCoverAi?.message ?? "Checking local cover AI..."}</small>
        </div>
        ${localCoverAi?.guidance?.length
          ? html`<ul class="book-writer-cover-setup-list">
              ${localCoverAi.guidance.map((item) => html`<li>${item}</li>`)}
            </ul>`
          : nothing}
      </div>
      <div class="book-writer-cover-studio__body">
        <div class="book-writer-cover-shell" aria-hidden="true">
          ${(approved?.previewDataUrl ?? firstVariant?.previewDataUrl)
            ? html`<img
                class="book-writer-cover book-writer-cover--image"
                src=${approved?.previewDataUrl ?? firstVariant?.previewDataUrl ?? ""}
                alt=""
              />`
            : html`<div class="book-writer-cover">
                <span>${coverInitials(plan.title)}</span>
                <b>${plan.title}</b>
                <small>${approved?.label ?? firstVariant?.label ?? plan.penName}</small>
              </div>`}
        </div>
        <div class="book-writer-cover-studio__copy">
          ${renderPill(
            plan.cover.status === "approved" ? "Cover approved" : "Cover needs approval",
            plan.cover.status === "approved" ? "good" : "warn",
          )}
          <label>
            <span>Cover brief</span>
            <textarea
              rows="3"
              .value=${plan.cover.brief}
              @change=${(event: Event) =>
                props.onSavePlan({
                  ...plan,
                  cover: {
                    ...plan.cover,
                    brief: (event.currentTarget as HTMLTextAreaElement).value,
                  },
                })}
            ></textarea>
            ${renderFieldTools(props, "coverBrief")}
          </label>
          <label>
            <span>Local AI cover prompt</span>
            <textarea
              rows="3"
              .value=${plan.cover.prompt}
              @change=${(event: Event) =>
                props.onSavePlan({
                  ...plan,
                  cover: {
                    ...plan.cover,
                    prompt: (event.currentTarget as HTMLTextAreaElement).value,
                  },
                })}
            ></textarea>
            ${renderFieldTools(props, "coverPrompt")}
          </label>
          ${plan.cover.variants.length
            ? html`
                <div class="book-writer-cover-variants">
                  ${plan.cover.variants.map(
                    (variant) => html`
                      <article
                        class=${variant.approved
                          ? "book-writer-cover-variant book-writer-cover-variant--approved"
                          : "book-writer-cover-variant"}
                      >
                        <b>${variant.label}</b>
                        ${coverVariantPreview(variant)}
                        <small>${coverVariantSourceLabel(variant)}</small>
                        ${variant.model ? html`<small>${variant.model}</small>` : nothing}
                        <button
                          class="book-writer-project__restore"
                          ?disabled=${Boolean(props.savingAction)}
                          @click=${() => {
                            const instruction = window.prompt(
                              "How should local AI edit this cover?",
                              "Keep the same concept, but make it more dramatic and readable as a thumbnail.",
                            );
                            if (instruction?.trim()) {
                              props.onEditCoverWithLocalAi(variant.id, instruction.trim());
                            }
                          }}
                        >
                          ${icons.spark}
                          <span>Edit with Local AI</span>
                        </button>
                        <button
                          class="book-writer-project__restore"
                          ?disabled=${Boolean(props.savingAction)}
                          @click=${() => props.onApproveCover(variant.id)}
                        >
                          ${icons.check}
                          <span>${variant.approved ? "Approved" : "Approve"}</span>
                        </button>
                      </article>
                    `,
                  )}
                </div>
              `
            : html`<p>No cover concept yet.</p>`}
        </div>
      </div>
      <div class="book-writer-button-row">
        ${renderIconButton("Generate Local AI Cover", icons.spark, props.onGenerateCoverConcept, {
          disabled: Boolean(props.savingAction),
          title:
            "Generate Local AI Cover: use local ComfyUI through OpenClaw image generation when ready, otherwise create the fallback SVG concept.",
        })}
        ${renderIconButton(
          "Create Editable SVG Concept",
          icons.fileText,
          props.onGenerateEditableCoverConcept,
          {
            disabled: Boolean(props.savingAction),
            tone: "quiet",
            title:
              "Create Editable SVG Concept: local deterministic fallback cover art that always works.",
          },
        )}
        <label class="book-writer-upload-button">
          <span>${icons.fileText}</span>
          <span>Upload cover image</span>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.tif,.tiff,.svg,image/jpeg,image/png,image/tiff,image/svg+xml"
            aria-label="Upload cover image"
            ?disabled=${Boolean(props.savingAction)}
            @change=${(event: Event) => {
              const input = event.currentTarget as HTMLInputElement;
              const file = input.files?.[0];
              if (file) {
                props.onUploadCoverFile(file);
                input.value = "";
              }
            }}
          />
        </label>
        ${renderIconButton(
          "Use KDP Cover Creator",
          icons.globe,
          () => props.onPreparePublishWithCoverStrategy("kdp-cover-creator"),
          {
            disabled:
              Boolean(props.savingAction) ||
              props.snapshot?.reviewPack?.recommendation !== "approve",
            tone: "quiet",
            title:
              "Use KDP Cover Creator: prepare publishing with the manual KDP cover route instead of an approved upload cover.",
          },
        )}
      </div>
    </div>
  `;
}

function renderPublishSteps(props: BookWriterDashboardProps) {
  const review = props.snapshot?.reviewPack;
  const dryRun = props.snapshot?.publishDryRun;
  const plan = props.snapshot?.plan;
  const reviewReady = review?.recommendation === "approve";
  const coverReady =
    plan?.cover.status === "approved" || dryRun?.coverStrategy === "kdp-cover-creator";
  const uploadReady = dryRun?.status === "ready";
  const steps = [
    {
      label: "1. Check book quality",
      done: Boolean(review),
      current: !review,
      text: review
        ? `Quality check: ${review.recommendation}.`
        : "Run Check book quality to build and validate EPUB, cover, metadata, and findings.",
    },
    {
      label: "2. Get quality approval",
      done: reviewReady,
      current: Boolean(review) && !reviewReady,
      text: reviewReady
        ? "Quality passed for publishing prep."
        : "Publishing prep stays locked until quality passes.",
    },
    {
      label: "3. Approve cover or choose KDP Cover Creator",
      done: coverReady,
      current: reviewReady && !coverReady,
      text: coverReady
        ? dryRun?.coverStrategy === "kdp-cover-creator"
          ? "KDP Cover Creator route selected."
          : "Cover approved for publishing prep."
        : "Generate or upload a cover and approve it, or choose KDP Cover Creator.",
    },
    {
      label: "4. Prepare publishing",
      done: Boolean(dryRun),
      current: reviewReady && coverReady && !dryRun,
      text: dryRun
        ? `KDP dry-run status: ${dryRun.status}.`
        : "Generate the upload checklist, file manifest, and final-submit pause.",
    },
    {
      label: "5. Open KDP and follow the checklist",
      done: uploadReady,
      current: uploadReady,
      text: uploadReady
        ? "Open KDP, upload the files below, confirm disclosure/rights, then stop before final submit."
        : "KDP opening is shown only after the dry-run is ready.",
    },
  ];

  return html`
    <div class="book-writer-publish-steps" aria-label="Publish readiness steps">
      ${steps.map(
        (step) => html`
          <div
            class=${`book-writer-publish-step ${
              step.done ? "book-writer-publish-step--done" : ""
            } ${step.current ? "book-writer-publish-step--current" : ""}`}
          >
            <b>${step.label}</b>
            <span>${step.text}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderUploadFiles(props: BookWriterDashboardProps) {
  const files = props.snapshot?.publishDryRun?.uploadManifest.files;
  if (!files) {
    return html`<p>Prepare publishing to see exact files.</p>`;
  }
  const entries = [
    ["Kindle manuscript", files.ebook],
    ["Cover upload", files.coverUpload],
    ["Cover Creator brief", files.coverBrief],
    ["Metadata", files.metadata],
    ["Publish preview", files.publishPreview],
    ["Print PDF", files.printPdf],
  ].filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()),
  );

  return html`
    <dl>
      ${entries.map(
        ([label, value]) => html`
          <dt>${label}</dt>
          <dd>${value}</dd>
        `,
      )}
    </dl>
  `;
}

function renderPublish(props: BookWriterDashboardProps) {
  const plan = props.snapshot?.plan;
  const dryRun = props.snapshot?.publishDryRun;
  const preview = props.snapshot?.reviewPack?.publishPreview;
  const review = props.snapshot?.reviewPack;
  if (!plan) {
    return html`<section class="book-writer-publish">No book selected.</section>`;
  }
  return html`
    <section class="book-writer-publish">
      <div class="book-writer-panel book-writer-publish-card">
        <p class="book-writer-eyebrow">${renderLabel("KDP Prep", "kdp")}</p>
        <h3>${dryRun ? statusLabel(dryRun.status) : "Publish prep not ready yet"}</h3>
        <p>Final submit remains ${renderLabel("approval-gated", "approvalGate")}, on purpose.</p>
        ${renderFieldHint(
          "This page shows the exact next step. It prepares KDP upload files and instructions; it does not click Amazon's final publish button.",
        )}
        <div class="book-writer-button-row">
          ${renderPublishPrimaryAction(props)} ${renderTrophyRoomAction(props)}
          ${renderIconButton("Quick Read", icons.copy, props.onCreateQuickRead, {
            disabled: Boolean(props.savingAction),
            title: "Quick Read: create a shorter edition from this full book.",
          })}
        </div>
        ${renderPublishSteps(props)}
        ${dryRun?.status === "ready" ? renderPublishProofBox(plan) : nothing}
      </div>
      ${renderCoverStudio(props, plan)} ${renderFixPublishBlockers(props)}
      <div class="book-writer-panel">
        <p class="book-writer-eyebrow">${renderLabel("Metadata", "metadata")}</p>
        <h3>Sales page preview</h3>
        ${renderFieldHint(TERM_DEFINITIONS.salesPage.definition)}
        ${preview
          ? html`
              <p><b>${preview.title}</b></p>
              <p>${preview.subtitle}</p>
              <p>${preview.description}</p>
              <p>${preview.keywords.join(", ")}</p>
            `
          : html`<p>Package the book to load metadata.</p>`}
      </div>
      <div class="book-writer-panel">
        <p class="book-writer-eyebrow">Readiness</p>
        <h3>Why publishing is or is not available</h3>
        ${review
          ? html`<p>Quality check: ${renderPill(statusLabel(review.recommendation))}</p>`
          : html`<p>No quality package yet. Run Check book quality first.</p>`}
        ${dryRun?.findings.map(
          (finding) => html`
            <div class=${`book-writer-finding book-writer-finding--${finding.status}`}>
              <b>${finding.code}</b>
              ${renderPill(statusLabel(finding.status), publishFindingTone(finding.status))}
              <span>${finding.message}</span>
            </div>
          `,
        ) ?? html`<p>KDP dry-run findings will appear after upload prep.</p>`}
      </div>
      <div class="book-writer-panel">
        <p class="book-writer-eyebrow">Upload files</p>
        <h3>Exact files to use in KDP</h3>
        ${renderUploadFiles(props)}
      </div>
      <div class="book-writer-panel book-writer-panel--wide">
        <p class="book-writer-eyebrow">${renderLabel("Browser Actions", "browserActions")}</p>
        <h3>Safe publishing steps</h3>
        ${renderFieldHint(
          "Each row is a planned browser step. Rows marked approval pause for your decision.",
        )}
        ${dryRun?.browserActions.map(
          (action) => html`
            <div class="book-writer-action-row">
              <b>${action.kind}</b>
              <span>${action.target}</span>
              ${action.requiresApproval ? html`<em>approval</em>` : nothing}
            </div>
          `,
        ) ?? html`<p>No dry-run actions yet.</p>`}
      </div>
    </section>
  `;
}

function renderNextActions(props: BookWriterDashboardProps) {
  const actions = props.snapshot?.nextActions ?? [];
  if (actions.length === 0) {
    return nothing;
  }
  return html`
    <section class="book-writer-next-actions" aria-label="Suggested next actions">
      <p class="book-writer-eyebrow">Next</p>
      ${actions.slice(0, 3).map((action) => html`<span>${action}</span>`)}
    </section>
  `;
}

function renderActiveView(props: BookWriterDashboardProps, plan: BookWriterPlan): TemplateResult {
  switch (props.activeView) {
    case "brief":
      return renderBrief(props, plan);
    case "chapters":
      return renderChapters(props, plan);
    case "paragraphs":
      return renderParagraphs(props, plan);
    case "draft":
      return renderGuidedParagraphFocus(props, plan, "text");
    case "package":
      return renderPackage(props);
    case "publish":
      return renderPublish(props);
  }
  return renderBrief(props, plan);
}

export function renderBookWriterDashboard(props: BookWriterDashboardProps) {
  installTrophyRoomScrollCompaction();
  const plan = props.snapshot?.plan ?? null;
  const showingHome = Boolean(props.snapshot && !plan && !props.newBookSetupOpen);
  const showingNewBookSetup = props.newBookSetupOpen || (!props.snapshot && !plan);
  return html`
    <style>
      .book-writer-dashboard {
        --book-accent: #007aff;
        --book-accent-strong: #005ecb;
        --book-good: #22a06b;
        --book-warn: #b7791f;
        --book-danger: #c2410c;
        --book-card: color-mix(in srgb, var(--surface) 92%, white 8%);
        --book-soft: color-mix(in srgb, var(--surface) 82%, var(--book-accent) 8%);
        --book-writer-trophy-scroll: 0;
        display: grid;
        grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
        align-items: start;
        gap: 18px;
        color: var(--text);
      }

      .book-writer-dashboard--work {
        grid-template-columns: minmax(0, 1fr);
      }

      .book-writer-dashboard * {
        box-sizing: border-box;
      }

      .book-writer-dashboard input,
      .book-writer-dashboard textarea,
      .book-writer-dashboard select {
        color: var(--text);
        background: var(--surface);
        caret-color: var(--text);
      }

      .book-writer-dashboard input::placeholder,
      .book-writer-dashboard textarea::placeholder {
        color: color-mix(in srgb, var(--muted) 82%, var(--text) 18%);
      }

      .book-writer-sr-only {
        position: absolute !important;
        width: 1px !important;
        height: 1px !important;
        overflow: hidden !important;
        clip: rect(0 0 0 0) !important;
        white-space: nowrap !important;
      }

      .book-writer-rail,
      .book-writer-panel,
      .book-writer-editor,
      .book-writer-toolbar,
      .book-writer-chapter,
      .book-writer-paragraph,
      .book-writer-inspector,
      .book-writer-hero,
      .book-writer-guide,
      .book-writer-glossary,
      .book-writer-path,
      .book-writer-workflow-map,
      .book-writer-trophy-room,
      .book-writer-ai-coach,
      .book-writer-next-actions,
      .book-writer-generate-panel,
      .book-writer-bulk-actions,
      .book-writer-style-card,
      .book-writer-control-bar,
      .book-writer-landing-shelf,
      .book-writer-guided-header,
      .book-writer-guided-workspace,
      .book-writer-next-step,
      .book-writer-simple-card,
      .book-writer-guided-toast,
      .book-writer-full-draft-progress,
      .book-writer-mini-preview,
      .book-writer-context-panel,
      .book-writer-advanced-switch,
      .book-writer-empty-card {
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 24px;
        background: var(--book-card);
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
      }

      .book-writer-rail {
        position: sticky;
        top: 18px;
        max-height: calc(100vh - 110px);
        min-height: 640px;
        overflow: auto;
        padding: 18px;
        align-self: start;
      }

      .book-writer-rail__head,
      .book-writer-toolbar,
      .book-writer-actions,
      .book-writer-meta,
      .book-writer-chapter__head,
      .book-writer-paragraph__meta,
      .book-writer-card-controls,
      .book-writer-hero__pills,
      .book-writer-button-row,
      .book-writer-project__meta {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .book-writer-rail__head,
      .book-writer-chapter__head,
      .book-writer-paragraph__meta {
        justify-content: space-between;
      }

      .book-writer-rail__head button,
      .book-writer-library-tool,
      .book-writer-card-controls button {
        display: inline-grid;
        place-items: center;
        width: 42px;
        height: 42px;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
      }

      .book-writer-card-controls button:first-child svg {
        transform: rotate(180deg);
      }

      .book-writer-card-controls button:disabled,
      .book-writer-btn:disabled,
      .book-writer-primary-action:disabled {
        cursor: not-allowed;
        opacity: 0.48;
      }

      .book-writer-more-menu,
      .book-writer-card-more,
      .book-writer-bulk-actions {
        position: relative;
      }

      .book-writer-more-menu summary,
      .book-writer-card-more summary,
      .book-writer-bulk-actions summary {
        display: inline-flex;
        min-height: 38px;
        align-items: center;
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 999px;
        padding: 0 12px;
        color: var(--muted);
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
        font-size: 13px;
        font-weight: 900;
        cursor: pointer;
        list-style: none;
      }

      .book-writer-more-menu summary::-webkit-details-marker,
      .book-writer-card-more summary::-webkit-details-marker,
      .book-writer-bulk-actions summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-more-menu__panel,
      .book-writer-card-more > div {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }

      .book-writer-new-book {
        display: grid;
        gap: 10px;
        margin-top: 16px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent 20%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--book-accent) 8%, transparent 92%);
      }

      .book-writer-new-book label {
        display: grid;
        gap: 7px;
      }

      .book-writer-new-book label > span {
        font-size: 13px;
        font-weight: 900;
      }

      .book-writer-new-book__setup {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
      }

      .book-writer-new-book__setup input,
      .book-writer-new-book__setup select {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px;
        color: var(--text);
        background: var(--surface);
        font: inherit;
      }

      .book-writer-topic--compact {
        min-height: 86px !important;
      }

      .book-writer-library-tools {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
        border-top: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        padding-top: 12px;
      }

      .book-writer-library-tool {
        display: inline-flex;
        width: auto;
        height: 32px;
        min-height: 32px;
        padding: 0 10px;
        gap: 6px;
        font: inherit;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-library-tool svg {
        width: 14px;
        height: 14px;
      }

      .book-writer-projects {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      .book-writer-project {
        display: grid;
        gap: 8px;
        width: 100%;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent 20%);
        border-radius: 18px;
        padding: 14px;
        color: var(--text);
        background: transparent;
        text-align: left;
        transition:
          transform 110ms cubic-bezier(0.18, 1.65, 0.32, 1),
          border-color 160ms ease,
          background 160ms ease,
          box-shadow 160ms ease;
        transform-origin: center;
      }

      .book-writer-project__select,
      .book-writer-project__delete,
      .book-writer-project__restore {
        display: grid;
        gap: 4px;
        border: 0;
        padding: 0;
        color: inherit;
        background: transparent;
        text-align: left;
        font: inherit;
      }

      .book-writer-project__select {
        cursor: pointer;
      }

      .book-writer-manage-books,
      .book-writer-rail-more {
        position: relative;
        width: fit-content;
      }

      .book-writer-manage-books summary,
      .book-writer-rail-more summary {
        display: inline-flex;
        min-height: 32px;
        align-items: center;
        gap: 6px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 999px;
        padding: 0 10px;
        color: var(--muted);
        background: color-mix(in srgb, var(--surface) 84%, transparent 16%);
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
        list-style: none;
      }

      .book-writer-manage-books summary::-webkit-details-marker,
      .book-writer-rail-more summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-manage-books summary svg,
      .book-writer-rail-more summary svg {
        width: 14px;
        height: 14px;
      }

      .book-writer-manage-books__menu,
      .book-writer-rail-more__menu {
        display: grid;
        gap: 8px;
        min-width: min(260px, 72vw);
        margin-top: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 18px;
        padding: 12px;
        background: var(--surface);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.18);
      }

      .book-writer-manage-books__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 10px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-manage-books__row > span {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .book-writer-manage-books__row small {
        color: var(--muted);
      }

      .book-writer-project__delete,
      .book-writer-project__restore {
        display: inline-flex;
        width: fit-content;
        min-height: 34px;
        align-items: center;
        gap: 6px;
        border: 1px solid color-mix(in srgb, var(--book-danger) 36%, transparent 64%);
        border-radius: 999px;
        padding: 0 10px;
        color: var(--book-danger);
        background: color-mix(in srgb, var(--book-danger) 8%, transparent 92%);
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-project__restore {
        border-color: color-mix(in srgb, var(--book-accent) 38%, transparent 62%);
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 9%, transparent 91%);
      }

      .book-writer-project__delete--forever {
        background: transparent;
      }

      .book-writer-project__delete svg,
      .book-writer-project__restore svg {
        width: 15px;
        height: 15px;
      }

      .book-writer-project__delete:disabled,
      .book-writer-project__restore:disabled {
        cursor: not-allowed;
        opacity: 0.48;
      }

      .book-writer-deleted-books {
        display: grid;
        gap: 10px;
        margin-top: 18px;
        border-top: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        padding-top: 16px;
      }

      .book-writer-deleted-books__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }

      .book-writer-deleted-books__head > div {
        display: grid;
        gap: 2px;
      }

      .book-writer-deleted-books__empty {
        border: 0;
        border-radius: 999px;
        padding: 8px 10px;
        color: var(--book-danger);
        background: transparent;
        font: inherit;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-deleted-books small,
      .book-writer-deleted-book span {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-deleted-book {
        display: grid;
        gap: 10px;
        border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent 20%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 82%, transparent 18%);
        transition:
          transform 110ms cubic-bezier(0.18, 1.65, 0.32, 1),
          border-color 160ms ease,
          box-shadow 160ms ease;
        transform-origin: center;
      }

      .book-writer-deleted-book > div {
        display: grid;
        gap: 4px;
      }

      .book-writer-deleted-book__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .book-writer-deleted-books__more {
        display: grid;
        gap: 8px;
      }

      .book-writer-deleted-books__more summary {
        display: inline-flex;
        width: fit-content;
        min-height: 34px;
        align-items: center;
        border: 1px solid color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 999px;
        padding: 0 12px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 7%, transparent 93%);
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
        list-style: none;
      }

      .book-writer-deleted-books__more summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-deleted-books__more > div {
        display: grid;
        gap: 8px;
        margin-top: 8px;
      }

      .book-writer-archived-books details {
        display: grid;
        gap: 10px;
      }

      .book-writer-archived-books summary {
        display: inline-flex;
        width: fit-content;
        min-height: 34px;
        align-items: center;
        gap: 7px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 34%, var(--border) 66%);
        border-radius: 999px;
        padding: 0 12px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 7%, transparent 93%);
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
        list-style: none;
      }

      .book-writer-archived-books summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-archived-books__list {
        display: grid;
        gap: 8px;
      }

      .book-writer-project:hover,
      .book-writer-deleted-book:hover,
      .book-writer-trophy-book:hover,
      .book-writer-cover-shell:hover {
        z-index: 2;
        animation: book-writer-balloon-pop 220ms cubic-bezier(0.18, 1.65, 0.32, 1) both;
        box-shadow: 0 24px 58px rgba(15, 23, 42, 0.14);
      }

      .book-writer-project--active {
        border-color: var(--book-accent);
        background: color-mix(in srgb, var(--book-accent) 14%, transparent 86%);
      }

      .book-writer-project__select span,
      .book-writer-empty,
      .book-writer-empty-card,
      .book-writer-field-hint,
      .book-writer-meta,
      .book-writer-panel p,
      .book-writer-history span,
      .book-writer-finding span,
      .book-writer-hero p,
      .book-writer-next-card p,
      .book-writer-progress-card p,
      .book-writer-view-title p,
      .book-writer-powered,
      .book-writer-start-card span {
        color: var(--muted);
      }

      @keyframes book-writer-balloon-pop {
        0% {
          transform: scale(1);
        }
        58% {
          transform: scale(1.075);
        }
        100% {
          transform: scale(1.045);
        }
      }

      .book-writer-label-row {
        display: inline-flex;
        position: relative;
        align-items: center;
        gap: 5px;
        min-width: 0;
        vertical-align: middle;
      }

      .book-writer-field-hint {
        display: block;
        margin-top: 2px;
        font-size: 12px;
        font-weight: 650;
        line-height: 1.4;
      }

      .book-writer-term-help-wrap {
        display: inline-flex;
        position: relative;
        align-items: center;
      }

      .book-writer-term-help {
        display: inline-grid;
        place-items: center;
        width: 18px;
        height: 18px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 36%, transparent 64%);
        border-radius: 999px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 10%, transparent 90%);
        font-size: 12px;
        font-weight: 950;
        line-height: 1;
        cursor: help;
      }

      .book-writer-tooltip {
        position: absolute;
        z-index: 20;
        bottom: calc(100% + 9px);
        left: 50%;
        width: min(280px, 78vw);
        transform: translateX(-50%) translateY(4px);
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 14px;
        padding: 10px 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 96%, white 4%);
        box-shadow: 0 16px 42px rgba(15, 23, 42, 0.18);
        font-size: 13px;
        font-style: normal;
        font-weight: 650;
        letter-spacing: 0;
        line-height: 1.35;
        opacity: 0;
        pointer-events: none;
        text-transform: none;
        transition:
          opacity 120ms ease,
          transform 120ms ease;
      }

      .book-writer-tooltip b {
        display: block;
        margin-bottom: 3px;
        color: var(--book-accent-strong);
      }

      .book-writer-term-help-wrap:hover .book-writer-tooltip,
      .book-writer-term-help:focus + .book-writer-tooltip {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      .book-writer-term-help:focus-visible,
      .book-writer-glossary-chip:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--book-accent) 28%, transparent 72%);
        outline-offset: 2px;
      }

      .book-writer-main {
        display: grid;
        gap: 16px;
        min-width: 0;
      }

      .book-writer-hero {
        display: grid;
        gap: 18px;
        padding: 24px;
        background:
          radial-gradient(circle at 12% 20%, rgba(0, 122, 255, 0.18), transparent 34%),
          linear-gradient(
            135deg,
            var(--book-card),
            color-mix(in srgb, var(--surface) 72%, #f7fbff 28%)
          );
      }

      .book-writer-hero--empty {
        grid-template-columns: minmax(240px, 0.9fr) minmax(280px, 1.2fr) minmax(180px, 0.6fr);
        align-items: end;
      }

      .book-writer-hero--plan {
        grid-template-columns: minmax(280px, 1.2fr) minmax(220px, 0.7fr) minmax(220px, 0.8fr);
        align-items: center;
      }

      .book-writer-hero__copy h2 {
        max-width: 780px;
        margin: 0;
        font-size: clamp(30px, 4vw, 54px);
        line-height: 0.98;
        letter-spacing: -0.055em;
      }

      .book-writer-hero__copy p {
        max-width: 620px;
        margin: 12px 0 0;
        font-size: 16px;
        line-height: 1.55;
      }

      .book-writer-powered {
        font-size: 13px !important;
      }

      .book-writer-topic-card,
      .book-writer-start-card,
      .book-writer-progress-card,
      .book-writer-next-card,
      .book-writer-hero__metrics {
        display: grid;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent 20%);
        border-radius: 22px;
        padding: 16px;
        background: color-mix(in srgb, var(--surface) 88%, white 12%);
      }

      .book-writer-topic-card span,
      .book-writer-editor label > span,
      .book-writer-chapter label > span,
      .book-writer-paragraph label > span {
        font-size: 13px;
        font-weight: 800;
        letter-spacing: -0.01em;
      }

      .book-writer-start-card {
        align-content: end;
      }

      .book-writer-start-card .book-writer-link-button,
      .book-writer-guided-secondary .book-writer-link-button {
        justify-self: start;
      }

      .book-writer-progress-card {
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
      }

      .book-writer-progress-ring {
        display: inline-grid;
        place-items: center;
        width: 86px;
        height: 86px;
        border-radius: 999px;
        color: var(--book-accent-strong);
        background:
          radial-gradient(circle, var(--surface) 57%, transparent 58%),
          conic-gradient(
            var(--book-accent) 0 var(--book-progress, 0deg),
            rgba(148, 163, 184, 0.24) var(--book-progress, 0deg) 360deg
          );
        font-size: 22px;
        font-weight: 900;
        letter-spacing: -0.04em;
      }

      .book-writer-next-card {
        align-content: center;
      }

      .book-writer-next-card small {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-primary-action {
        display: flex;
        min-height: 58px;
        align-items: center;
        justify-content: center;
        gap: 10px;
        border: 0;
        border-radius: 999px;
        padding: 0 22px;
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        box-shadow: 0 14px 32px rgba(0, 122, 255, 0.28);
        font: inherit;
      }

      .book-writer-primary-action span,
      .book-writer-btn__icon {
        display: inline-flex;
        width: 18px;
        height: 18px;
      }

      .book-writer-guided-header {
        position: sticky;
        top: 12px;
        z-index: 20;
        display: block;
        padding: 5px 7px;
        border-radius: 16px;
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-card) 94%, white 6%),
          color-mix(in srgb, var(--book-accent) 7%, var(--book-card) 93%)
        );
        backdrop-filter: blur(16px);
      }

      .book-writer-command-row {
        display: grid;
        grid-template-columns:
          auto minmax(120px, 0.8fr) minmax(360px, 1.4fr) minmax(90px, 140px)
          auto auto;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .book-writer-advanced-switch {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        padding: 14px 18px;
      }

      .book-writer-guided-header__top {
        display: grid;
      }

      .book-writer-guided-progress {
        display: grid;
        gap: 5px;
        min-width: 0;
      }

      .book-writer-guided-progress span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 900;
        text-align: right;
      }

      .book-writer-guided-progress i {
        display: block;
        height: 5px;
        overflow: hidden;
        border-radius: 999px;
        background: color-mix(in srgb, var(--border) 70%, transparent 30%);
      }

      .book-writer-guided-progress i::before {
        display: block;
        width: var(--book-writer-guided-progress, 8%);
        height: 100%;
        border-radius: inherit;
        background: linear-gradient(90deg, #007aff, #5ac8fa);
        content: "";
      }

      .book-writer-health-dot {
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: var(--book-warn);
        box-shadow: 0 0 0 5px color-mix(in srgb, var(--book-warn) 14%, transparent 86%);
      }

      .book-writer-health-dot--ready {
        background: var(--book-good);
        box-shadow: 0 0 0 5px color-mix(in srgb, var(--book-good) 14%, transparent 86%);
      }

      .book-writer-more-control {
        position: relative;
        justify-self: end;
      }

      .book-writer-more-control > summary,
      .book-writer-ai-help-menu > summary,
      .book-writer-guided-card-more > summary {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        justify-content: center;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 999px;
        padding: 0 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
        font-size: 13px;
        font-weight: 950;
        cursor: pointer;
        list-style: none;
      }

      .book-writer-more-control > summary::-webkit-details-marker,
      .book-writer-ai-help-menu > summary::-webkit-details-marker,
      .book-writer-guided-card-more > summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-more-control__panel {
        position: absolute;
        right: 0;
        z-index: 40;
        display: grid;
        width: min(360px, calc(100vw - 32px));
        gap: 10px;
        margin-top: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 20px;
        padding: 14px;
        background: var(--book-card);
        box-shadow: 0 24px 60px rgba(2, 6, 23, 0.24);
      }

      .book-writer-more-control__panel section,
      .book-writer-guided-card-more {
        display: grid;
        gap: 8px;
      }

      .book-writer-button-stack {
        display: grid;
        gap: 8px;
      }

      .book-writer-command-spacer {
        min-width: 12px;
      }

      .book-writer-workflow-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        align-items: center;
        gap: 6px;
        margin-top: 5px;
        border: 1px solid color-mix(in srgb, var(--border) 55%, transparent 45%);
        border-radius: 14px;
        padding: 6px 8px;
        background: color-mix(in srgb, var(--surface) 62%, transparent 38%);
      }

      .book-writer-workflow-header > div:first-child {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }

      .book-writer-workflow-header p,
      .book-writer-workflow-header small {
        margin: 0;
      }

      .book-writer-guided-header__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        flex-wrap: nowrap;
        min-width: 0;
      }

      .book-writer-guided-header h2,
      .book-writer-guided-main h2,
      .book-writer-confirm-sheet h2 {
        margin: 0;
        font-size: clamp(24px, 3.2vw, 38px);
        line-height: 1;
        letter-spacing: -0.055em;
      }

      .book-writer-guided-header p {
        margin: 0;
      }

      .book-writer-guided-header h2 {
        overflow: hidden;
        font-size: clamp(15px, 1.35vw, 20px);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-command-title {
        min-width: 0;
      }

      .book-writer-command-title .book-writer-eyebrow {
        overflow: hidden;
        margin: 0 0 2px;
        font-size: 10px;
        line-height: 1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-guided-header__reader {
        margin: 0;
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-guided-header__reader b {
        color: var(--text);
      }

      .book-writer-command-home,
      .book-writer-command-primary {
        display: inline-flex;
        min-height: 36px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 0;
        border-radius: 999px;
        padding: 0 14px;
        font: inherit;
        font-size: 12px;
        font-weight: 950;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
      }

      .book-writer-command-home {
        border: 1px solid color-mix(in srgb, var(--book-accent) 50%, var(--border) 50%);
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        box-shadow: 0 10px 24px color-mix(in srgb, var(--book-accent) 24%, transparent 76%);
      }

      .book-writer-command-home svg {
        width: 15px;
        height: 15px;
      }

      .book-writer-command-primary {
        max-width: 170px;
        overflow: hidden;
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        box-shadow: 0 10px 24px rgba(0, 122, 255, 0.24);
        text-overflow: ellipsis;
      }

      .book-writer-command-primary:disabled {
        cursor: not-allowed;
        opacity: 0.5;
      }

      .book-writer-link-button {
        display: inline-flex;
        min-height: 30px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 0;
        border-radius: 999px;
        padding: 0 10px;
        color: var(--book-accent-strong);
        background: transparent;
        font: inherit;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-link-button svg {
        width: 16px;
        height: 16px;
      }

      .book-writer-guided-steps {
        display: flex;
        min-width: 0;
        gap: 4px;
        overflow-x: auto;
        scrollbar-width: none;
      }

      .book-writer-guided-steps::-webkit-scrollbar {
        display: none;
      }

      .book-writer-guided-step {
        display: flex;
        min-height: 26px;
        flex: 1 1 52px;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 999px;
        padding: 3px 7px;
        color: var(--muted);
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
        font: inherit;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-guided-step span {
        display: inline-grid;
        place-items: center;
        width: 17px;
        height: 17px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--book-accent) 10%, transparent 90%);
        color: var(--book-accent-strong);
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-guided-step b {
        white-space: nowrap;
      }

      .book-writer-guided-step--active {
        border-color: var(--book-accent);
        color: var(--text);
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
      }

      .book-writer-guided-header__status {
        display: block;
      }

      .book-writer-command-badges {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }

      .book-writer-command-details {
        position: relative;
        min-width: 0;
      }

      .book-writer-command-details summary {
        list-style: none;
      }

      .book-writer-command-details summary::-webkit-details-marker {
        display: none;
      }

      .book-writer-command-badge {
        display: inline-flex;
        min-height: 30px;
        align-items: center;
        gap: 6px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 999px;
        padding: 3px 9px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .book-writer-command-badge span {
        color: var(--muted);
        font-size: 10px;
        font-weight: 950;
        letter-spacing: 0.07em;
        text-transform: uppercase;
      }

      .book-writer-command-badge b {
        max-width: 90px;
        overflow: hidden;
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-command-popover {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        z-index: 40;
        display: grid;
        width: min(520px, calc(100vw - 48px));
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 18px;
        padding: 12px;
        background: var(--surface);
        box-shadow: 0 22px 60px rgba(15, 23, 42, 0.22);
      }

      .book-writer-command-popover--health {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .book-writer-command-popover--reader {
        line-height: 1.45;
      }

      .book-writer-local-ai-health--ready .book-writer-command-badge {
        border-color: color-mix(in srgb, var(--success) 58%, var(--border) 42%);
        background: color-mix(in srgb, var(--success) 12%, var(--surface) 88%);
      }

      .book-writer-local-ai-health--model-missing .book-writer-command-badge,
      .book-writer-local-ai-health--unknown .book-writer-command-badge {
        border-color: color-mix(in srgb, var(--warning, #d97706) 58%, var(--border) 42%);
        background: color-mix(in srgb, var(--warning, #d97706) 12%, var(--surface) 88%);
      }

      .book-writer-local-ai-health--unreachable .book-writer-command-badge {
        border-color: color-mix(in srgb, var(--danger) 58%, var(--border) 42%);
        background: color-mix(in srgb, var(--danger) 10%, var(--surface) 90%);
      }

      .book-writer-command-popover--local-ai {
        width: min(460px, calc(100vw - 48px));
      }

      .book-writer-local-ai-health__body {
        display: grid;
        gap: 10px;
      }

      .book-writer-local-ai-health__body p,
      .book-writer-local-ai-health__body ul,
      .book-writer-local-ai-health__body dl {
        margin: 0;
      }

      .book-writer-local-ai-health__body p {
        display: grid;
        gap: 4px;
        line-height: 1.4;
      }

      .book-writer-local-ai-health__body p small,
      .book-writer-local-ai-health__body li {
        color: var(--muted);
      }

      .book-writer-local-ai-health__body dl {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .book-writer-local-ai-health__body dl div {
        display: grid;
        min-width: 0;
        gap: 2px;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 12px;
        padding: 8px;
        background: color-mix(in srgb, var(--surface) 82%, transparent 18%);
      }

      .book-writer-local-ai-health__body dt {
        color: var(--muted);
        font-size: 10px;
        font-weight: 950;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-local-ai-health__body dd {
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: var(--text);
        font-size: 12px;
        font-weight: 850;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-local-ai-health__body ul {
        padding-left: 18px;
        line-height: 1.4;
      }

      .book-writer-topbar-group-label {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        color: var(--muted);
        font-size: 11px;
        font-weight: 950;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }

      .book-writer-top-chip {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        gap: 7px;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 999px;
        padding: 4px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
        font: inherit;
        cursor: pointer;
      }

      .book-writer-top-chip span {
        color: var(--muted);
        font-size: 10px;
        font-weight: 950;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-top-chip b {
        font-size: 12px;
        white-space: nowrap;
      }

      .book-writer-top-chip--active {
        border-color: color-mix(in srgb, var(--book-accent) 58%, var(--border) 42%);
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
      }

      .book-writer-health-strip {
        display: grid;
        grid-template-columns: minmax(150px, 0.5fr) minmax(0, 2.4fr);
        gap: 12px;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 22px;
        padding: 14px;
        background:
          radial-gradient(circle at 0% 0%, rgba(34, 160, 107, 0.12), transparent 30%),
          color-mix(in srgb, var(--surface) 90%, transparent 10%);
      }

      .book-writer-health-strip__intro {
        display: grid;
        align-content: center;
        gap: 4px;
      }

      .book-writer-health-strip__intro b,
      .book-writer-health-strip__intro span {
        line-height: 1.35;
      }

      .book-writer-health-strip__intro span {
        color: var(--muted);
      }

      .book-writer-health-strip__grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .book-writer-health-card {
        display: grid;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 8px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
        text-align: left;
        font: inherit;
        cursor: pointer;
      }

      .book-writer-health-card span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-health-card small {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-health-card--good {
        border-color: color-mix(in srgb, var(--book-good) 38%, var(--border) 62%);
        background: color-mix(in srgb, var(--book-good) 8%, transparent 92%);
      }

      .book-writer-health-card--warn {
        border-color: color-mix(in srgb, var(--book-warn) 38%, var(--border) 62%);
        background: color-mix(in srgb, var(--book-warn) 8%, transparent 92%);
      }

      .book-writer-health-card--danger {
        border-color: color-mix(in srgb, var(--book-danger) 38%, var(--border) 62%);
        background: color-mix(in srgb, var(--book-danger) 8%, transparent 92%);
      }

      .book-writer-current-settings {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 24%, var(--border) 76%);
        border-radius: 22px;
        padding: 14px;
        background:
          linear-gradient(
            135deg,
            color-mix(in srgb, var(--book-accent) 9%, transparent 91%),
            transparent
          ),
          color-mix(in srgb, var(--surface) 90%, transparent 10%);
      }

      .book-writer-current-settings__intro {
        display: grid;
        gap: 4px;
      }

      .book-writer-current-settings__intro b,
      .book-writer-current-settings__intro span {
        line-height: 1.35;
      }

      .book-writer-current-settings__intro span,
      .book-writer-current-settings__grid small {
        color: var(--muted);
      }

      .book-writer-current-settings__grid {
        display: grid;
        grid-column: 1 / -1;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }

      .book-writer-current-settings__grid > div {
        display: grid;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-current-settings__grid span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-current-settings__grid small {
        line-height: 1.35;
      }

      .book-writer-control-bar {
        display: grid;
        gap: 14px;
        border-color: color-mix(in srgb, var(--book-accent) 34%, var(--border) 66%);
        padding: 16px;
        background:
          radial-gradient(circle at 100% 0%, rgba(0, 122, 255, 0.14), transparent 34%),
          color-mix(in srgb, var(--surface) 94%, var(--book-accent) 6%);
      }

      .book-writer-control-bar__head,
      .book-writer-landing-shelf__head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 14px;
      }

      .book-writer-control-bar__head h3,
      .book-writer-landing-shelf__head h3 {
        margin: 0;
      }

      .book-writer-control-bar__head p:not(.book-writer-eyebrow),
      .book-writer-landing-shelf__head p:not(.book-writer-eyebrow) {
        margin: 4px 0 0;
        color: var(--muted);
      }

      .book-writer-control-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }

      .book-writer-control-grid label,
      .book-writer-control-status,
      .book-writer-storyline-overview,
      .book-writer-sync-panel {
        display: grid;
        align-content: start;
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 96%, black 0%);
      }

      .book-writer-control-grid label span,
      .book-writer-control-status b,
      .book-writer-storyline-overview b,
      .book-writer-sync-panel b {
        font-size: 12px;
        font-weight: 950;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .book-writer-control-grid input,
      .book-writer-control-grid textarea,
      .book-writer-control-grid select {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
        font: inherit;
      }

      .book-writer-control-grid__wide {
        grid-column: span 2;
      }

      .book-writer-storyline-overview,
      .book-writer-sync-panel {
        border-color: color-mix(in srgb, var(--book-accent) 30%, var(--border) 70%);
      }

      .book-writer-sync-panel {
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-accent) 10%, var(--surface) 90%),
          var(--surface)
        );
      }

      .book-writer-sync-panel__affected {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .book-writer-sync-panel__affected span {
        border: 1px solid color-mix(in srgb, var(--book-accent) 24%, var(--border) 76%);
        border-radius: 999px;
        padding: 4px 8px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 8%, var(--surface) 92%);
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-control-status span,
      .book-writer-storyline-overview span,
      .book-writer-sync-panel > span {
        color: var(--text);
        font-weight: 900;
      }

      .book-writer-ai-help-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .book-writer-ai-help {
        display: inline-flex;
        min-height: 32px;
        align-items: center;
        gap: 5px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 38%, var(--border) 62%);
        border-radius: 999px;
        padding: 0 9px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 10%, var(--surface) 90%);
        font: inherit;
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-chapter-role {
        border: 1px solid color-mix(in srgb, var(--book-accent) 22%, var(--border) 78%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--book-accent) 6%, var(--surface) 94%);
      }

      .book-writer-chapter-role summary {
        display: grid;
        gap: 3px;
        cursor: pointer;
        font-weight: 950;
      }

      .book-writer-chapter-role summary small {
        color: var(--muted);
        font-weight: 700;
      }

      .book-writer-role-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        margin-top: 12px;
      }

      .book-writer-role-grid label {
        display: grid;
        gap: 6px;
      }

      .book-writer-landing-shelf {
        display: grid;
        gap: 14px;
        padding: 18px;
      }

      .book-writer-recommendation-card {
        display: grid;
        gap: 12px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 30%, var(--border) 70%);
        border-radius: 24px;
        padding: 18px;
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-accent) 10%, var(--surface) 90%),
          color-mix(in srgb, var(--surface) 94%, white 6%)
        );
      }

      .book-writer-shelf-toggle {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }

      .book-writer-plan-write-legend {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 22px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-plan-write-legend__item {
        display: grid;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-plan-write-legend__item--active {
        border-color: color-mix(in srgb, var(--book-accent) 54%, var(--border) 46%);
        background: color-mix(in srgb, var(--book-accent) 9%, transparent 91%);
      }

      .book-writer-plan-write-legend__item span {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
      }

      .book-writer-full-draft-progress {
        display: grid;
        gap: 16px;
        padding: 18px;
        border-color: color-mix(in srgb, var(--book-accent) 40%, var(--border) 60%);
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-accent) 13%, var(--surface) 87%),
          color-mix(in srgb, var(--surface) 94%, white 6%)
        );
      }

      .book-writer-full-draft-progress h3 {
        margin: 0;
        font-size: clamp(20px, 2.2vw, 28px);
      }

      .book-writer-full-draft-progress p,
      .book-writer-full-draft-progress small {
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-full-draft-progress ol {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
        padding: 0;
        margin: 0;
        list-style: none;
      }

      .book-writer-full-draft-progress__step {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 10px;
        align-items: start;
        border: 1px solid color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 90%, transparent 10%);
      }

      .book-writer-full-draft-progress__step > span {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 999px;
        font-weight: 950;
        color: var(--text);
        background: color-mix(in srgb, var(--border) 70%, transparent 30%);
      }

      .book-writer-full-draft-progress__step div {
        display: grid;
        gap: 3px;
      }

      .book-writer-full-draft-progress__step--current {
        border-color: color-mix(in srgb, var(--book-accent) 66%, var(--border) 34%);
        box-shadow: 0 14px 30px color-mix(in srgb, var(--book-accent) 18%, transparent 82%);
      }

      .book-writer-full-draft-progress__step--current > span {
        color: white;
        background: var(--book-accent);
      }

      .book-writer-full-draft-progress__step--done > span {
        color: white;
        background: var(--book-good);
      }

      .book-writer-guided-workspace {
        display: grid;
        grid-template-columns: minmax(240px, 330px) minmax(0, 1fr);
        gap: 18px;
        padding: 22px;
      }

      .book-writer-guided-workspace--idea-clean {
        grid-template-columns: minmax(0, 1fr);
      }

      .book-writer-guided-main--idea-clean {
        max-width: 1180px;
      }

      .book-writer-create-focus {
        display: grid;
        grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr);
        gap: 16px;
        align-items: start;
      }

      .book-writer-create-focus__controls .book-writer-setup-controls {
        padding: 14px;
      }

      .book-writer-create-focus__controls .book-writer-setup-controls__intro span,
      .book-writer-create-focus__controls .book-writer-style-preview {
        display: none;
      }

      .book-writer-context-panel {
        display: grid;
        align-content: start;
        gap: 12px;
        padding: 16px;
        position: sticky;
        top: 18px;
        max-height: calc(100vh - 120px);
        overflow: auto;
      }

      .book-writer-context-chapter-list {
        display: grid;
        gap: 7px;
        max-height: 240px;
        overflow: auto;
        padding-right: 2px;
      }

      .book-writer-context-chapter-list__item {
        display: grid;
        gap: 3px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 14px;
        padding: 9px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .book-writer-context-chapter-list__item span {
        color: var(--book-accent-strong);
        font-size: 10px;
        font-weight: 950;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-context-chapter-list__item b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-context-chapter-list__item--active {
        border-color: var(--book-accent);
        background: color-mix(in srgb, var(--book-accent) 12%, var(--surface) 88%);
      }

      .book-writer-context-panel h3 {
        margin: 0;
        letter-spacing: -0.035em;
      }

      .book-writer-context-panel label,
      .book-writer-context-panel .book-writer-context-row {
        display: grid;
        gap: 7px;
      }

      .book-writer-context-panel input,
      .book-writer-context-panel textarea,
      .book-writer-context-panel select {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 10px 12px;
        color: var(--text);
        background: var(--surface);
        font: inherit;
      }

      .book-writer-context-panel small,
      .book-writer-context-panel p,
      .book-writer-context-neighbors {
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-context-neighbors,
      .book-writer-context-summary,
      .book-writer-context-checklist {
        display: grid;
        gap: 8px;
      }

      .book-writer-context-summary {
        border: 1px solid color-mix(in srgb, var(--book-accent) 20%, var(--border) 80%);
        border-radius: 16px;
        padding: 10px;
        background: color-mix(in srgb, var(--book-accent) 6%, transparent 94%);
      }

      .book-writer-context-summary__controls {
        display: grid;
        gap: 6px;
      }

      .book-writer-context-checklist {
        margin: 0;
        padding-left: 18px;
      }

      .book-writer-guided-workspace--single {
        grid-template-columns: 1fr minmax(240px, 320px);
      }

      .book-writer-guided-workspace--single .book-writer-guided-main {
        grid-row: 1 / span 2;
      }

      .book-writer-guided-workspace--single .book-writer-guided-secondary {
        grid-column: 2;
      }

      .book-writer-guided-main {
        display: grid;
        align-content: start;
        gap: 16px;
        min-width: 0;
      }

      .book-writer-next-step {
        position: sticky;
        top: 8px;
        z-index: 18;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-card) 96%, white 4%),
          color-mix(in srgb, var(--book-accent) 9%, var(--book-card) 91%)
        );
      }

      .book-writer-next-step p,
      .book-writer-next-step b,
      .book-writer-next-step small {
        display: block;
        margin: 0;
      }

      .book-writer-next-step b {
        font-size: 13px;
        letter-spacing: -0.035em;
      }

      .book-writer-next-step small {
        color: var(--muted);
        line-height: 1.15;
      }

      .book-writer-next-step__button {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        padding: 0 14px;
        color: white;
        background: linear-gradient(135deg, #007aff, #0a84ff);
        box-shadow: 0 18px 34px color-mix(in srgb, var(--book-accent) 28%, transparent 72%);
        font: inherit;
        font-weight: 950;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
      }

      .book-writer-next-step__button--warn {
        background: linear-gradient(135deg, #ff9f0a, #ff7a00);
      }

      .book-writer-next-step__button--safe {
        background: linear-gradient(135deg, #22c55e, #16a34a);
      }

      .book-writer-next-step__button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .book-writer-guided-more-panel {
        align-self: start;
        padding: 16px;
      }
      .book-writer-all-controls-exit {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 32%, var(--border) 68%);
        border-radius: 22px;
        padding: 14px 16px;
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-accent) 10%, var(--book-card) 90%),
          var(--book-card)
        );
      }

      .book-writer-all-controls-exit h3,
      .book-writer-all-controls-exit p,
      .book-writer-all-controls-exit small {
        margin: 0;
      }

      .book-writer-all-controls-stack {
        display: grid;
        gap: 12px;
      }

      .book-writer-all-controls-details {
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 20px;
        background: var(--book-card);
        box-shadow: 0 14px 34px rgba(15, 23, 42, 0.06);
      }

      .book-writer-all-controls-details > summary {
        display: flex;
        min-height: 48px;
        align-items: center;
        padding: 0 16px;
        font-weight: 950;
        cursor: pointer;
      }

      .book-writer-all-controls-details > :not(summary) {
        margin: 0 14px 14px;
      }

      .book-writer-guided-more-panel > h3,
      .book-writer-simple-card > h3 {
        margin: 0;
        font-size: clamp(22px, 2.4vw, 32px);
        letter-spacing: -0.045em;
      }

      .book-writer-guided-publish-cards {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }

      .book-writer-simple-card {
        display: grid;
        gap: 12px;
        align-content: start;
        padding: 18px;
      }

      .book-writer-ai-help-menu {
        justify-self: start;
      }

      .book-writer-ai-help-menu .book-writer-ai-help-row {
        position: absolute;
        z-index: 35;
        display: grid;
        min-width: 180px;
        gap: 6px;
        margin-top: 6px;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 18px;
        padding: 8px;
        background: var(--book-card);
        box-shadow: 0 18px 42px rgba(2, 6, 23, 0.2);
      }

      .book-writer-guided-main > p,
      .book-writer-guided-header p,
      .book-writer-guided-next p,
      .book-writer-mini-preview p,
      .book-writer-guided-toast p {
        color: var(--muted);
        line-height: 1.5;
      }

      .book-writer-guided-main label,
      .book-writer-guided-paragraph-card label {
        display: grid;
        gap: 8px;
        font-weight: 850;
      }

      .book-writer-guided-main input,
      .book-writer-guided-main textarea,
      .book-writer-guided-paragraph-card textarea {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 14px;
        color: var(--text);
        background: var(--surface);
        font: inherit;
      }

      .book-writer-guided-toast {
        display: flex;
        align-items: center;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--success) 32%, var(--border) 68%);
        border-radius: 999px;
        padding: 9px 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--success) 10%, var(--book-card) 90%);
        box-shadow: 0 14px 32px rgba(34, 197, 94, 0.12);
      }

      .book-writer-guided-toast > span {
        border-radius: 999px;
        padding: 3px 8px;
        color: var(--success);
        background: color-mix(in srgb, var(--success) 12%, transparent 88%);
        font-size: 11px;
        font-weight: 950;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .book-writer-guided-toast b,
      .book-writer-guided-toast small,
      .book-writer-guided-toast details {
        min-width: 0;
      }

      .book-writer-guided-toast small {
        overflow: hidden;
        color: var(--muted);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-guided-toast details {
        color: var(--muted);
        font-size: 12px;
      }

      .book-writer-guided-topic {
        min-height: 180px;
      }

      .book-writer-guided-next {
        display: grid;
        gap: 10px;
        align-content: start;
        margin-top: 18px;
      }

      .book-writer-next-strip {
        border: 1px solid color-mix(in srgb, var(--book-accent) 20%, var(--border) 80%);
        border-radius: 18px;
        padding: 12px 14px;
        color: var(--text);
        background: color-mix(in srgb, var(--book-accent) 7%, transparent 93%);
        font-size: 13px;
        line-height: 1.45;
      }

      .book-writer-guided-primary {
        display: inline-flex;
        min-height: 62px;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 999px;
        padding: 0 28px;
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        box-shadow: 0 16px 34px rgba(0, 122, 255, 0.28);
        font: inherit;
        font-weight: 950;
        text-decoration: none;
        cursor: pointer;
      }

      .book-writer-guided-primary--small {
        min-height: 46px;
        padding: 0 14px;
      }

      .book-writer-guided-primary--danger {
        background: linear-gradient(
          135deg,
          var(--book-danger),
          color-mix(in srgb, var(--book-danger) 74%, black 26%)
        );
        box-shadow: 0 16px 34px color-mix(in srgb, var(--book-danger) 24%, transparent 76%);
      }

      .book-writer-guided-primary:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .book-writer-guided-list,
      .book-writer-guided-chapter,
      .book-writer-guided-paragraph-card,
      .book-writer-guided-upload {
        display: grid;
        gap: 12px;
      }

      .book-writer-guided-chapter,
      .book-writer-guided-paragraph-card,
      .book-writer-guided-upload {
        border: 1px solid color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 22px;
        padding: 16px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-publish-proof__confirm {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 12px;
        border-radius: 16px;
        background: color-mix(in srgb, var(--book-warn) 11%, var(--surface) 89%);
        color: var(--text);
        font-weight: 800;
      }

      .book-writer-publish-proof__confirm input {
        margin-top: 3px;
        inline-size: 18px;
        block-size: 18px;
        flex: 0 0 auto;
      }

      .book-writer-plain-card {
        display: grid;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 22%, var(--border) 78%);
        border-radius: 22px;
        padding: 14px;
        background: color-mix(in srgb, var(--book-accent) 7%, transparent 93%);
      }

      .book-writer-plain-card--three {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .book-writer-plain-card--four {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .book-writer-guided-secondary {
        display: grid;
        gap: 8px;
        align-self: start;
        border: 1px dashed color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 18px;
        padding: 14px;
        color: var(--muted);
        background: color-mix(in srgb, var(--surface) 92%, transparent 8%);
      }

      .book-writer-plain-card div {
        display: grid;
        gap: 4px;
      }

      .book-writer-plain-card span,
      .book-writer-guided-zone small,
      .book-writer-paragraph-plan-layer small,
      .book-writer-paragraph-text-layer small,
      .book-writer-length-estimate small,
      .book-writer-lock small {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.35;
      }

      .book-writer-style-card {
        display: grid;
        grid-template-columns: minmax(0, 1.2fr) repeat(3, minmax(140px, 1fr));
        gap: 14px;
        padding: 16px;
        align-items: start;
      }

      .book-writer-style-card h3,
      .book-writer-style-card p {
        margin: 0;
      }

      .book-writer-style-card p {
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-style-card label {
        display: grid;
        gap: 8px;
      }

      .book-writer-setup-controls__intro {
        display: grid;
        gap: 6px;
      }

      .book-writer-setup-controls__intro > span {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .book-writer-custom-tone-field,
      .book-writer-style-preview,
      .book-writer-new-book__custom-tone {
        grid-column: 1 / -1;
      }

      .book-writer-style-preview {
        display: grid;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 28%, var(--border) 72%);
        border-radius: 18px;
        padding: 14px;
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--book-accent) 10%, transparent 90%),
          color-mix(in srgb, var(--surface) 92%, transparent 8%)
        );
      }

      .book-writer-style-preview > div {
        display: grid;
        gap: 4px;
      }

      .book-writer-style-preview > div > span,
      .book-writer-style-preview small {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }

      .book-writer-style-preview blockquote {
        margin: 0;
        border-left: 3px solid var(--book-accent);
        padding: 10px 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 82%, transparent 18%);
        border-radius: 12px;
        line-height: 1.55;
      }

      .book-writer-length-presets {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-content: start;
      }

      .book-writer-chip {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--card) 88%, transparent 12%);
        color: var(--text);
        font-weight: 750;
        padding: 8px 10px;
        cursor: pointer;
      }

      .book-writer-chip--active {
        border-color: color-mix(in srgb, var(--book-accent) 55%, var(--border) 45%);
        background: color-mix(in srgb, var(--book-accent) 18%, transparent 82%);
        color: var(--book-accent);
      }

      .book-writer-length-estimate {
        display: grid;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 22%, var(--border) 78%);
        border-radius: 16px;
        padding: 10px;
        background: color-mix(in srgb, var(--book-accent) 6%, transparent 94%);
      }

      .book-writer-length-estimate span {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.35;
      }

      .book-writer-rebalance-callout {
        display: grid;
        gap: 6px;
        border: 1px solid color-mix(in srgb, var(--warning) 38%, var(--border) 62%);
        border-radius: 16px;
        padding: 10px;
        background: color-mix(in srgb, var(--warning) 10%, var(--surface) 90%);
      }

      .book-writer-rebalance-callout b {
        font-size: 12px;
        font-weight: 950;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .book-writer-rebalance-callout span,
      .book-writer-rebalance-callout small {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-guided-split-head,
      .book-writer-guided-card-actions,
      .book-writer-confirm-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .book-writer-guided-focus {
        display: grid;
        grid-template-columns: minmax(190px, 240px) minmax(0, 1fr);
        gap: 14px;
      }

      .book-writer-guided-main--chapter {
        gap: 16px;
      }

      .book-writer-chapter-selector {
        display: grid;
        gap: 10px;
        position: sticky;
        top: 78px;
        z-index: 2;
        border: 1px solid color-mix(in srgb, var(--border) 65%, transparent 35%);
        border-radius: 22px;
        padding: 14px;
        background: color-mix(in srgb, var(--surface) 92%, transparent 8%);
        backdrop-filter: blur(18px);
      }

      .book-writer-chapter-selector__buttons {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 2px;
        scrollbar-width: thin;
      }

      .book-writer-chapter-selector__item {
        display: grid;
        min-width: 148px;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 16px;
        padding: 10px 12px;
        color: var(--muted);
        background: color-mix(in srgb, var(--surface) 82%, transparent 18%);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .book-writer-chapter-selector__item span {
        color: var(--book-accent-strong);
        font-size: 11px;
        font-weight: 950;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .book-writer-chapter-selector__item b {
        overflow: hidden;
        color: var(--text);
        font-size: 13px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-chapter-selector__item--active {
        border-color: var(--book-accent);
        background: color-mix(in srgb, var(--book-accent) 12%, var(--surface) 88%);
        box-shadow: 0 12px 28px rgba(0, 122, 255, 0.16);
      }

      .book-writer-chapter-selector__select {
        display: none;
      }

      .book-writer-guided-chapter-paragraphs {
        display: grid;
        gap: 14px;
      }

      .book-writer-guided-paragraph-card__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }

      .book-writer-guided-paragraph-card__head h3,
      .book-writer-guided-paragraph-card__head p {
        margin: 0;
      }

      .book-writer-guided-paragraph-card--active {
        border-color: color-mix(in srgb, var(--book-accent) 48%, var(--border) 52%);
        box-shadow: 0 18px 36px rgba(0, 122, 255, 0.12);
      }

      .book-writer-guided-chapter-paragraphs:has(.book-writer-guided-paragraph-card--focus-editor)
        .book-writer-guided-paragraph-card:not(.book-writer-guided-paragraph-card--focus-editor) {
        opacity: 0.72;
        transform: scale(0.992);
      }

      .book-writer-guided-paragraph-card--focus-editor {
        gap: 18px;
        margin-inline: clamp(-10px, -0.75vw, 0px);
        border-color: color-mix(in srgb, var(--book-accent) 58%, var(--border) 42%);
        padding: clamp(18px, 2vw, 26px);
        background:
          radial-gradient(circle at 8% 0%, rgba(0, 122, 255, 0.13), transparent 34%),
          color-mix(in srgb, var(--surface) 92%, var(--book-accent) 8%);
        box-shadow: 0 24px 60px rgba(0, 122, 255, 0.18);
      }

      .book-writer-guided-paragraph-card--focus-editor .book-writer-guided-paragraph-card__head {
        align-items: center;
      }

      .book-writer-focus-editor-note {
        display: inline-flex;
        margin-top: 6px;
        border-radius: 999px;
        padding: 5px 9px;
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
        font-size: 12px;
        font-weight: 900;
      }

      .book-writer-guided-paragraph-card:focus-within {
        gap: 16px;
        border-color: color-mix(in srgb, var(--book-accent) 52%, var(--border) 48%);
        box-shadow: 0 20px 44px rgba(0, 122, 255, 0.14);
      }

      .book-writer-guided-zone {
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-guided-zone > span {
        display: grid;
        gap: 3px;
      }

      .book-writer-guided-zone--text {
        border-color: color-mix(in srgb, var(--book-accent) 30%, var(--border) 70%);
        background: color-mix(in srgb, var(--book-accent) 6%, transparent 94%);
      }

      .book-writer-editor-field--compact {
        min-height: 44px;
      }

      textarea.book-writer-editor-field--medium {
        min-height: 128px;
      }

      textarea.book-writer-editor-field--style {
        min-height: 96px;
      }

      textarea.book-writer-editor-field--large {
        min-height: 170px;
      }

      textarea.book-writer-editor-field--hero {
        min-height: 340px;
        max-width: 100%;
        resize: vertical;
        font-size: 17px;
        line-height: 1.7;
      }

      .book-writer-guided-paragraph-card--focus-editor textarea.book-writer-plan-summary {
        min-height: 240px;
      }

      .book-writer-guided-paragraph-card--focus-editor textarea.book-writer-guided-book-text {
        min-height: min(56vh, 520px);
      }

      textarea.book-writer-editor-field--medium,
      textarea.book-writer-editor-field--style,
      textarea.book-writer-editor-field--large,
      textarea.book-writer-editor-field--hero,
      .book-writer-guided-book-text,
      .book-writer-purpose,
      .book-writer-draft,
      .book-writer-chapter textarea,
      .book-writer-paragraph textarea {
        resize: vertical;
      }

      .book-writer-chapter-description,
      .book-writer-plan-summary {
        width: 100%;
      }

      .book-writer-editor-details {
        display: grid;
        gap: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 68%, transparent 32%);
        border-radius: 18px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--surface) 78%, transparent 22%);
      }

      .book-writer-editor-details[open] {
        padding-bottom: 12px;
      }

      .book-writer-editor-details summary {
        color: var(--book-accent-strong);
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-editor-details label {
        margin-top: 10px;
      }

      .book-writer-write-plan-notes:not([open]) {
        background: color-mix(in srgb, var(--surface) 90%, transparent 10%);
      }

      .book-writer-editor-word-footer {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        color: var(--muted);
        font-size: 12px;
        font-weight: 850;
      }

      .book-writer-guided-zone--handoff {
        display: grid;
        gap: 12px;
        border-style: dashed;
        border-color: color-mix(in srgb, var(--book-accent) 34%, var(--border) 66%);
        background: color-mix(in srgb, var(--book-accent) 5%, transparent 95%);
      }

      .book-writer-guided-zone--handoff > span {
        display: grid;
        gap: 4px;
      }

      .book-writer-guided-mode-card {
        display: grid;
        gap: 6px;
        border: 1px solid color-mix(in srgb, var(--warning) 24%, var(--border) 76%);
        border-radius: 18px;
        padding: 14px;
        background: color-mix(in srgb, var(--warning) 8%, transparent 92%);
      }

      .book-writer-guided-mode-card--text {
        border-color: color-mix(in srgb, var(--book-accent) 34%, var(--border) 66%);
        background: color-mix(in srgb, var(--book-accent) 8%, transparent 92%);
      }

      .book-writer-guided-mode-card h3,
      .book-writer-guided-mode-card p {
        margin: 0;
      }

      .book-writer-guided-mode-card p:last-child {
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-write-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border: 1px solid color-mix(in srgb, var(--book-accent) 24%, var(--border) 76%);
        border-radius: 18px;
        padding: 12px;
        background: color-mix(in srgb, var(--book-accent) 6%, transparent 94%);
      }

      .book-writer-write-strip > div,
      .book-writer-instruction-warning {
        display: grid;
        gap: 4px;
      }

      .book-writer-write-strip p,
      .book-writer-write-strip b,
      .book-writer-write-strip span,
      .book-writer-instruction-warning b,
      .book-writer-instruction-warning span {
        margin: 0;
      }

      .book-writer-write-strip span,
      .book-writer-instruction-warning span {
        color: var(--muted);
        line-height: 1.4;
      }

      .book-writer-focused-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .book-writer-guided-outline {
        display: grid;
        align-content: start;
        gap: 8px;
        max-height: 620px;
        overflow: auto;
      }

      .book-writer-guided-outline-head,
      .book-writer-guided-outline-gap {
        display: grid;
        gap: 3px;
        border: 1px dashed color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 14px;
        padding: 9px 10px;
        background: color-mix(in srgb, var(--surface) 84%, transparent 16%);
      }

      .book-writer-guided-outline-head small,
      .book-writer-guided-outline-gap {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.35;
      }

      .book-writer-guided-outline-gap {
        justify-items: center;
        border-style: solid;
        font-weight: 800;
      }

      .book-writer-guided-outline-item {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 9px 10px;
        color: var(--muted);
        background: var(--surface);
        font: inherit;
        text-align: left;
      }

      .book-writer-guided-outline-number {
        display: inline-grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--book-accent) 10%, transparent 90%);
        font-weight: 800;
      }

      .book-writer-guided-outline-item--active {
        border-color: var(--book-accent);
        color: var(--text);
      }

      .book-writer-guided-outline-copy {
        display: grid;
        min-width: 0;
        gap: 2px;
      }

      .book-writer-guided-outline-copy b {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .book-writer-guided-outline-copy small {
        overflow: hidden;
        color: var(--muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-guided-outline-state {
        display: inline-grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
        color: var(--book-accent);
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-guided-outline-state--locked {
        background: color-mix(in srgb, var(--warning) 18%, transparent 82%);
        color: var(--warning);
      }

      .book-writer-guided-outline-state--empty {
        background: color-mix(in srgb, var(--danger) 12%, transparent 88%);
        color: var(--danger);
      }

      .book-writer-guided-outline-state--ai {
        background: color-mix(in srgb, var(--success) 12%, transparent 88%);
        color: var(--success);
      }

      .book-writer-guided-status {
        display: inline-flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        max-width: 720px;
        margin: 6px 0 0;
        color: var(--muted);
      }

      .book-writer-guided-chapter-context {
        margin: 2px 0 0;
        color: var(--muted);
        font-size: 13px;
      }

      .book-writer-guided-status > span {
        display: inline-grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
        color: var(--book-accent);
        font-size: 12px;
      }

      .book-writer-guided-status--locked > span {
        background: color-mix(in srgb, var(--warning) 18%, transparent 82%);
        color: var(--warning);
      }

      .book-writer-guided-status--empty > span {
        background: color-mix(in srgb, var(--danger) 12%, transparent 88%);
        color: var(--danger);
      }

      .book-writer-guided-status--ai > span {
        background: color-mix(in srgb, var(--success) 12%, transparent 88%);
        color: var(--success);
      }

      .book-writer-guided-status b {
        color: var(--text);
      }

      .book-writer-guided-status small {
        flex-basis: 100%;
        padding-left: 32px;
        color: var(--muted);
      }

      .book-writer-guided-book-text {
        min-height: 320px;
        font-size: 17px;
        line-height: 1.65;
      }

      .book-writer-mini-preview {
        display: grid;
        grid-template-columns: minmax(150px, 0.55fr) auto minmax(220px, 1.9fr);
        align-items: center;
        gap: 12px;
        margin: 8px 0;
        padding: 10px 14px;
      }

      .book-writer-mini-preview h3 {
        margin: 0;
        font-size: clamp(17px, 2vw, 22px);
        letter-spacing: -0.035em;
      }

      .book-writer-mini-preview p {
        margin: 0;
        display: -webkit-box;
        max-height: 3.1em;
        overflow: hidden;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }

      .book-writer-idea-textarea {
        min-height: 340px;
        line-height: 1.65;
        font-size: 17px;
        resize: vertical;
      }

      .book-writer-active-chapter-banner,
      .book-writer-plan-command-strip,
      .book-writer-read-head,
      .book-writer-read-controls,
      .book-writer-pen-profiles,
      .book-writer-pen-profile,
      .book-writer-read-page {
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 20px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-active-chapter-banner,
      .book-writer-plan-command-strip,
      .book-writer-read-head,
      .book-writer-read-controls {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
      }

      .book-writer-active-chapter-banner h3,
      .book-writer-plan-command-strip b,
      .book-writer-read-head h2 {
        margin: 0;
        font-size: clamp(30px, 4.2vw, 54px);
        letter-spacing: -0.06em;
      }

      .book-writer-chapter-jump {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        padding-bottom: 2px;
      }

      .book-writer-chapter-jump button {
        border: 1px solid color-mix(in srgb, var(--border) 76%, transparent 24%);
        border-radius: 999px;
        padding: 7px 10px;
        color: var(--text);
        background: var(--surface);
        white-space: nowrap;
        cursor: pointer;
      }

      .book-writer-chapter-jump button[aria-current="true"],
      .book-writer-guided-chapter--active {
        border-color: var(--book-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--book-accent) 18%, transparent 82%);
      }

      .book-writer-field-lock {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
      }

      .book-writer-field-lock input {
        width: 16px;
        height: 16px;
      }

      .book-writer-read-head {
        align-items: flex-start;
      }

      .book-writer-read-head p {
        margin: 6px 0 0;
        color: var(--muted);
      }

      .book-writer-read-actions,
      .book-writer-read-controls {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .book-writer-read-controls label {
        display: grid;
        gap: 4px;
        min-width: min(260px, 100%);
      }

      .book-writer-read-page-count {
        color: var(--muted);
        font-weight: 850;
      }

      .book-writer-read-page {
        display: grid;
        gap: 16px;
        padding: 22px clamp(18px, 4vw, 46px);
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--surface) 96%, white 4%), var(--surface)),
          var(--surface);
      }

      .book-writer-read-page header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        color: var(--muted);
        font-size: 15px;
        font-weight: 850;
      }

      .book-writer-read-page header span {
        color: var(--text);
        font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
        font-size: clamp(24px, 3.2vw, 38px);
        font-weight: 800;
        letter-spacing: -0.045em;
      }

      .book-writer-read-page__text {
        max-width: 74ch;
        margin: 0 auto;
        color: var(--text);
        font-size: 18px;
        line-height: 1.8;
      }

      .book-writer-read-page__text p {
        margin: 0 0 1.15em;
      }

      .book-writer-book-preview {
        display: grid;
        gap: 16px;
      }

      .book-writer-book-preview__bar,
      .book-writer-book-preview__nav,
      .book-writer-book-mode {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .book-writer-book-preview__bar {
        justify-content: space-between;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 22px;
        padding: 12px 14px;
        background: color-mix(in srgb, var(--surface) 82%, transparent 18%);
        backdrop-filter: blur(18px);
      }

      .book-writer-book-preview__bar h2,
      .book-writer-book-preview__bar p {
        margin: 0;
      }

      .book-writer-book-mode {
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 999px;
        padding: 4px;
        background: color-mix(in srgb, var(--surface) 78%, transparent 22%);
      }

      .book-writer-book-mode button {
        border: 0;
        border-radius: 999px;
        padding: 7px 12px;
        color: var(--muted);
        background: transparent;
        font: inherit;
        font-size: 11px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-book-mode button.active {
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        box-shadow: 0 8px 18px rgba(0, 122, 255, 0.22);
      }

      .book-writer-book-stage,
      .book-writer-ebook-shell {
        display: grid;
        grid-template-columns: minmax(190px, 260px) minmax(0, 1fr);
        gap: 18px;
        align-items: start;
      }

      .book-writer-book-sidebar,
      .book-writer-ebook-shell aside {
        position: sticky;
        top: 18px;
        display: grid;
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 70%, transparent 30%);
        border-radius: 22px;
        padding: 14px;
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
      }

      .book-writer-book-sidebar h3,
      .book-writer-ebook-shell aside h3 {
        margin: 8px 0 2px;
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-book-sidebar button,
      .book-writer-ebook-shell aside button {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        border: 0;
        border-radius: 14px;
        padding: 9px 10px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 70%, transparent 30%);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .book-writer-book-sidebar button span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .book-writer-book-page,
      .book-writer-ebook-reader {
        min-height: min(860px, 72vh);
        border: 1px solid color-mix(in srgb, var(--border) 60%, white 40%);
        border-radius: 28px;
        padding: clamp(32px, 6vw, 74px);
        color: #1f2937;
        background:
          linear-gradient(
            90deg,
            rgba(15, 23, 42, 0.04),
            transparent 7%,
            transparent 93%,
            rgba(15, 23, 42, 0.04)
          ),
          #fffaf0;
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.2);
      }

      .book-writer-book-page {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 20px;
        max-width: 780px;
        margin: 0 auto;
        aspect-ratio: 0.66;
      }

      .book-writer-book-page--title {
        place-items: center;
        text-align: center;
      }

      .book-writer-book-page h1,
      .book-writer-book-page h2,
      .book-writer-ebook-reader h1,
      .book-writer-ebook-reader h2 {
        margin: 0;
        color: #111827;
        font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
        letter-spacing: -0.045em;
      }

      .book-writer-book-page h1 {
        font-size: clamp(42px, 7vw, 82px);
        line-height: 0.95;
      }

      .book-writer-book-page h2 {
        font-size: clamp(30px, 4vw, 52px);
        line-height: 1.05;
      }

      .book-writer-book-page__body,
      .book-writer-ebook-reader {
        font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
        font-size: clamp(17px, 1.5vw, 20px);
        line-height: 1.78;
      }

      .book-writer-book-page__body p,
      .book-writer-ebook-reader p {
        margin: 0 0 1.1em;
      }

      .book-writer-book-page footer {
        color: #6b7280;
        font-size: 13px;
        text-align: center;
      }

      .book-writer-book-toc,
      .book-writer-book-index {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .book-writer-book-toc li,
      .book-writer-book-index p {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        margin: 0;
        border-bottom: 1px dotted rgba(17, 24, 39, 0.22);
        padding-bottom: 6px;
      }

      .book-writer-book-preview__nav {
        justify-content: center;
        margin-top: 14px;
      }

      .book-writer-ebook-reader {
        display: block;
        max-width: 860px;
        margin: 0 auto;
        aspect-ratio: auto;
      }

      .book-writer-ebook-reader section {
        margin-top: 34px;
      }

      .book-writer-ebook-byline {
        color: #6b7280;
        font-family: inherit;
        text-align: center;
      }

      .book-writer-pen-profiles {
        display: grid;
        gap: 12px;
        padding: 18px;
      }

      .book-writer-pen-profiles__head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
      }

      .book-writer-pen-profile-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 12px;
      }

      .book-writer-pen-profile {
        display: grid;
        gap: 12px;
        padding: 14px;
      }

      .book-writer-pen-profile__head,
      .book-writer-pen-profile__stats,
      .book-writer-pen-profile__books {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        align-items: center;
      }

      .book-writer-pen-profile textarea {
        min-height: 88px;
      }

      .book-writer-guided-readable pre {
        max-height: 620px;
      }

      .book-writer-guided-details > summary {
        cursor: pointer;
        color: var(--book-accent-strong);
        font-weight: 850;
      }

      .book-writer-confirm-backdrop {
        position: fixed;
        inset: 0;
        z-index: 100;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(8px);
      }

      .book-writer-confirm-sheet {
        display: grid;
        gap: 16px;
        width: min(560px, 100%);
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 30px;
        padding: 26px;
        background: var(--surface);
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.24);
      }

      .book-writer-confirm-sheet ul {
        display: grid;
        gap: 10px;
        margin: 0;
        padding-left: 20px;
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-hero__metrics {
        grid-column: 1 / -1;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .book-writer-celebration {
        display: grid;
        position: relative;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 14px;
        align-items: center;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--book-accent) 32%, transparent 68%);
        border-radius: 28px;
        padding: 16px 18px;
        background:
          radial-gradient(circle at 8% 24%, rgba(255, 214, 10, 0.36), transparent 28%),
          radial-gradient(circle at 72% 12%, rgba(255, 45, 85, 0.2), transparent 28%),
          linear-gradient(
            135deg,
            color-mix(in srgb, var(--book-accent) 14%, var(--surface) 86%),
            color-mix(in srgb, var(--surface) 86%, white 14%)
          );
        box-shadow: 0 18px 48px rgba(0, 122, 255, 0.16);
      }

      .book-writer-celebration h3,
      .book-writer-celebration p {
        margin: 0;
      }

      .book-writer-celebration h3 {
        font-size: clamp(20px, 2.8vw, 30px);
        letter-spacing: -0.045em;
      }

      .book-writer-celebration p:last-child {
        margin-top: 4px;
        color: var(--muted);
      }

      .book-writer-celebration__fireworks {
        display: grid;
        position: relative;
        width: 62px;
        height: 62px;
        place-items: center;
        border-radius: 22px;
        background:
          radial-gradient(circle, rgba(255, 214, 10, 0.92) 0 12%, transparent 13%),
          color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
      }

      .book-writer-celebration__fireworks span {
        position: absolute;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #ffd60a;
        animation: book-writer-firework 980ms ease-out infinite;
      }

      .book-writer-celebration__fireworks span:nth-child(2) {
        animation-delay: 90ms;
        background: #ff2d55;
      }

      .book-writer-celebration__fireworks span:nth-child(3) {
        animation-delay: 180ms;
        background: #34c759;
      }

      .book-writer-celebration__fireworks span:nth-child(4) {
        animation-delay: 270ms;
        background: #64d2ff;
      }

      .book-writer-celebration__fireworks span:nth-child(5) {
        animation-delay: 360ms;
        background: #bf5af2;
      }

      .book-writer-celebration__dismiss {
        min-height: 40px;
        border: 0;
        border-radius: 999px;
        padding: 0 15px;
        color: white;
        background: linear-gradient(135deg, var(--book-accent), var(--book-accent-strong));
        font: inherit;
        font-weight: 950;
        cursor: pointer;
      }

      @keyframes book-writer-firework {
        0% {
          opacity: 0;
          transform: translate(0, 0) scale(0.6);
        }
        18% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translate(var(--firework-x, 26px), var(--firework-y, -22px)) scale(1.4);
        }
      }

      .book-writer-celebration__fireworks span:nth-child(1) {
        --firework-x: 28px;
        --firework-y: -24px;
      }

      .book-writer-celebration__fireworks span:nth-child(2) {
        --firework-x: -26px;
        --firework-y: -18px;
      }

      .book-writer-celebration__fireworks span:nth-child(3) {
        --firework-x: 22px;
        --firework-y: 24px;
      }

      .book-writer-celebration__fireworks span:nth-child(4) {
        --firework-x: -20px;
        --firework-y: 26px;
      }

      .book-writer-celebration__fireworks span:nth-child(5) {
        --firework-x: 0;
        --firework-y: -32px;
      }

      .book-writer-trophy-room {
        display: grid;
        gap: 18px;
        overflow: hidden;
        padding: 22px;
        background:
          radial-gradient(circle at 8% 15%, rgba(255, 214, 10, 0.24), transparent 28%),
          radial-gradient(circle at 92% 0%, rgba(0, 122, 255, 0.22), transparent 32%),
          linear-gradient(
            135deg,
            color-mix(in srgb, var(--surface) 90%, white 10%),
            color-mix(in srgb, var(--surface) 72%, #0f172a 3%)
          );
      }

      .book-writer-trophy-stage {
        display: grid;
        align-items: start;
        min-height: min(440px, 72vh);
      }

      .book-writer-trophy-room--top {
        position: sticky;
        top: 12px;
        z-index: 1;
        max-height: min(420px, 70vh);
        transform-origin: top center;
        transition:
          max-height 160ms ease,
          padding 160ms ease,
          gap 160ms ease,
          opacity 160ms ease,
          transform 160ms ease,
          box-shadow 160ms ease;
        will-change: transform, padding, gap, opacity;
      }

      html.book-writer-trophy-scroll-compact .book-writer-trophy-stage {
        min-height: min(320px, 54vh);
      }

      html.book-writer-trophy-scroll-compact .book-writer-trophy-room--top {
        gap: 10px;
        max-height: 240px;
        padding: 14px 16px;
        overflow: hidden;
        transform: scale(0.985);
        box-shadow: 0 18px 46px rgba(15, 23, 42, 0.18);
      }

      html.book-writer-trophy-scroll-away .book-writer-trophy-room--top {
        opacity: 0;
        pointer-events: none;
        transform: translateY(-18px) scale(0.96);
      }

      html.book-writer-trophy-scroll-compact
        .book-writer-trophy-room--top
        .book-writer-trophy-room__head
        h3 {
        font-size: clamp(19px, 2.3vw, 26px);
      }

      html.book-writer-trophy-scroll-compact
        .book-writer-trophy-room--top
        .book-writer-trophy-room__head
        p:not(.book-writer-eyebrow) {
        display: none;
      }

      html.book-writer-trophy-scroll-compact
        .book-writer-trophy-room--top
        .book-writer-trophy-grid {
        grid-auto-columns: minmax(220px, 260px);
        grid-auto-flow: column;
        grid-template-columns: none;
        gap: 10px;
        overflow-x: auto;
        overflow-y: hidden;
        padding-bottom: 4px;
        scroll-snap-type: x proximity;
      }

      html.book-writer-trophy-scroll-compact .book-writer-trophy-room--top .book-writer-trophy-book,
      html.book-writer-trophy-scroll-compact
        .book-writer-trophy-room--top
        .book-writer-trophy-empty {
        border-radius: 22px;
        gap: 12px;
        min-height: 132px;
        padding: 12px;
        scroll-snap-align: start;
      }

      html.book-writer-trophy-scroll-compact
        .book-writer-trophy-room--top
        .book-writer-cover-shell {
        width: 76px;
      }

      .book-writer-trophy-room__head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 16px;
      }

      .book-writer-trophy-room__head h3 {
        margin: 0;
        font-size: clamp(22px, 3vw, 34px);
        letter-spacing: -0.045em;
      }

      .book-writer-trophy-room__head p,
      .book-writer-trophy-empty p,
      .book-writer-trophy-book__copy p,
      .book-writer-trophy-book__copy small {
        color: var(--muted);
      }

      .book-writer-trophy-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
        gap: 14px;
      }

      .book-writer-trophy-book,
      .book-writer-trophy-empty {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 16px;
        align-items: center;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 26px;
        padding: 16px;
        background: color-mix(in srgb, var(--surface) 88%, white 12%);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.45),
          0 18px 46px rgba(15, 23, 42, 0.1);
        transition:
          transform 110ms cubic-bezier(0.18, 1.65, 0.32, 1),
          box-shadow 160ms ease,
          border-color 160ms ease;
        transform-origin: center;
      }

      .book-writer-trophy-book__copy {
        display: grid;
        gap: 6px;
      }

      .book-writer-trophy-book__copy h4 {
        margin: 0;
        font-size: 20px;
        letter-spacing: -0.03em;
      }

      .book-writer-trophy-book .book-writer-project__restore {
        grid-column: 1 / -1;
      }

      .book-writer-trophy-empty {
        grid-template-columns: auto minmax(0, 1fr);
      }

      .book-writer-cover-shell {
        width: 92px;
        perspective: 700px;
      }

      .book-writer-cover {
        display: grid;
        position: relative;
        width: 86px;
        min-height: 132px;
        align-content: space-between;
        overflow: hidden;
        transform: rotateY(-13deg) rotateZ(-1deg);
        transform-origin: left center;
        border-radius: 10px 16px 16px 10px;
        padding: 14px 10px;
        color: white;
        background:
          linear-gradient(90deg, rgba(0, 0, 0, 0.28), transparent 18%),
          radial-gradient(circle at 70% 20%, rgba(255, 214, 10, 0.34), transparent 30%),
          linear-gradient(145deg, #111827, #005ecb 52%, #7c3aed);
        box-shadow:
          14px 16px 28px rgba(15, 23, 42, 0.2),
          inset 4px 0 0 rgba(255, 255, 255, 0.16);
      }

      .book-writer-cover::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(
          120deg,
          transparent 0 38%,
          rgba(255, 255, 255, 0.25) 48%,
          transparent 58%
        );
        mix-blend-mode: screen;
      }

      .book-writer-cover > span {
        display: inline-grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.16);
        font-weight: 950;
      }

      .book-writer-cover b {
        position: relative;
        z-index: 1;
        font-size: 13px;
        line-height: 1.05;
        letter-spacing: -0.04em;
      }

      .book-writer-cover small {
        position: relative;
        z-index: 1;
        font-size: 10px;
        opacity: 0.8;
      }

      .book-writer-cover--image {
        display: block;
        min-height: 132px;
        object-fit: cover;
        padding: 0;
      }

      .book-writer-cover--empty {
        color: var(--text);
        background:
          linear-gradient(90deg, rgba(0, 0, 0, 0.08), transparent 18%),
          color-mix(in srgb, var(--surface) 72%, var(--book-accent) 8%);
      }

      .book-writer-cover--empty span {
        color: var(--book-accent-strong);
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
      }

      .book-writer-cover-studio {
        display: grid;
        gap: 16px;
      }

      .book-writer-cover-status {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }

      .book-writer-cover-setup-list {
        display: grid;
        gap: 4px;
        margin: 4px 0 0;
        padding-left: 18px;
        color: var(--muted);
        font-size: 12px;
      }

      .book-writer-cover-studio__body {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }

      .book-writer-cover-studio__copy,
      .book-writer-cover-variants {
        display: grid;
        gap: 10px;
      }

      .book-writer-cover-variant {
        display: grid;
        grid-template-columns: 72px minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 16px;
        padding: 10px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-cover-variant--approved {
        border-color: color-mix(in srgb, var(--book-good) 48%, var(--border) 52%);
        background: color-mix(in srgb, var(--book-good) 8%, transparent 92%);
      }

      .book-writer-cover-variant__image {
        width: 64px;
        aspect-ratio: 2 / 3;
        object-fit: cover;
        border-radius: 10px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        box-shadow: 0 10px 24px rgba(2, 6, 23, 0.2);
      }

      .book-writer-upload-button {
        display: inline-flex;
        min-height: 34px;
        align-items: center;
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 999px;
        padding: 0 14px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
        font-size: 14px;
        font-weight: 900;
        cursor: pointer;
      }

      .book-writer-upload-button input {
        position: absolute;
        width: 1px;
        height: 1px;
        opacity: 0;
        pointer-events: none;
      }

      .book-writer-metric {
        display: grid;
        gap: 2px;
        text-align: center;
      }

      .book-writer-metric b {
        font-size: 24px;
        letter-spacing: -0.04em;
      }

      .book-writer-metric span {
        color: var(--muted);
        font-size: 13px;
      }

      .book-writer-journey {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 8px;
        padding: 6px;
        border: 1px solid color-mix(in srgb, var(--border) 78%, transparent 22%);
        border-radius: 999px;
        background: color-mix(in srgb, var(--surface) 86%, transparent 14%);
      }

      .book-writer-journey__step {
        display: flex;
        min-height: 48px;
        align-items: center;
        justify-content: center;
        gap: 8px;
        border: 0;
        border-radius: 999px;
        color: var(--muted);
        background: transparent;
        font: inherit;
      }

      .book-writer-journey__step span {
        display: inline-grid;
        place-items: center;
        width: 26px;
        height: 26px;
        border-radius: 999px;
        background: color-mix(in srgb, var(--border) 55%, transparent 45%);
        color: var(--text);
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-journey__step--active {
        color: white;
        background: var(--text);
      }

      .book-writer-journey__step--active span {
        background: rgba(255, 255, 255, 0.18);
        color: white;
      }

      .book-writer-journey__step--done {
        color: var(--text);
      }

      .book-writer-path {
        display: grid;
        gap: 14px;
        padding: 18px;
        background: linear-gradient(
          135deg,
          var(--book-card),
          color-mix(in srgb, var(--book-accent) 6%, var(--surface) 94%)
        );
      }

      .book-writer-path__head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
      }

      .book-writer-path__head h3 {
        margin: 0;
        font-size: 22px;
        line-height: 1.15;
        letter-spacing: -0.035em;
      }

      .book-writer-path__grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }

      .book-writer-path-card {
        display: grid;
        gap: 8px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 20px;
        padding: 14px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 90%, transparent 10%);
        text-align: left;
        font: inherit;
      }

      .book-writer-path-card--active {
        border-color: var(--book-accent);
        background: color-mix(in srgb, var(--book-accent) 12%, transparent 88%);
      }

      .book-writer-path-card span {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-path-card em {
        color: var(--book-accent-strong);
        font-style: normal;
        font-weight: 900;
      }

      .book-writer-guide,
      .book-writer-glossary {
        display: grid;
        grid-template-columns: minmax(180px, 0.28fr) minmax(0, 1fr);
        gap: 14px;
        padding: 16px 18px;
      }

      .book-writer-workflow-map {
        display: grid;
        gap: 14px;
        padding: 18px;
      }

      .book-writer-workflow-map__head {
        display: flex;
        align-items: start;
        justify-content: space-between;
        gap: 12px;
      }

      .book-writer-workflow-map__head h3 {
        margin: 0;
        font-size: 22px;
        line-height: 1.15;
        letter-spacing: -0.035em;
      }

      .book-writer-workflow-map__head p {
        margin: 6px 0 0;
        color: var(--muted);
      }

      .book-writer-workflow-map__grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
      }

      .book-writer-workflow-step {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 6px 8px;
        align-items: center;
        border: 1px solid color-mix(in srgb, var(--border) 74%, transparent 26%);
        border-radius: 18px;
        padding: 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 90%, transparent 10%);
        text-align: left;
        transition:
          transform 160ms ease,
          border-color 160ms ease,
          background 160ms ease;
      }

      .book-writer-workflow-step:hover {
        transform: translateY(-1px);
      }

      .book-writer-workflow-step--done {
        border-color: color-mix(in srgb, var(--book-good) 34%, var(--border) 66%);
        background: color-mix(in srgb, var(--book-good) 8%, transparent 92%);
      }

      .book-writer-workflow-step--current {
        border-color: color-mix(in srgb, var(--book-warn) 45%, var(--border) 55%);
        background: color-mix(in srgb, var(--book-warn) 9%, transparent 91%);
      }

      .book-writer-workflow-step > span {
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 999px;
        color: white;
        background: var(--book-accent);
        font-size: 12px;
        font-weight: 950;
      }

      .book-writer-workflow-step em,
      .book-writer-workflow-step small {
        grid-column: 1 / -1;
        color: var(--muted);
        font-style: normal;
        line-height: 1.35;
      }

      .book-writer-workflow-step small {
        font-weight: 800;
      }

      .book-writer-guide h3,
      .book-writer-glossary b {
        margin: 0;
      }

      .book-writer-guide__grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }

      .book-writer-guide__grid p {
        margin: 0;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 12px;
        color: var(--muted);
        background: color-mix(in srgb, var(--book-accent) 6%, transparent 94%);
        line-height: 1.45;
      }

      .book-writer-guide__grid b {
        color: var(--text);
      }

      .book-writer-glossary__chips {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
      }

      .book-writer-glossary-chip {
        display: grid;
        gap: 5px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-glossary-chip b {
        color: var(--text);
      }

      .book-writer-glossary-chip small {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-toolbar {
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 14px;
        padding: 18px;
      }

      .book-writer-view-title {
        max-width: 560px;
      }

      .book-writer-view-title h3,
      .book-writer-panel h3,
      .book-writer-column-head h3 {
        margin: 0;
        font-size: 22px;
        line-height: 1.15;
        letter-spacing: -0.035em;
      }

      .book-writer-view-title p,
      .book-writer-panel p {
        margin: 6px 0 0;
      }

      .book-writer-eyebrow {
        margin: 0 0 6px !important;
        color: var(--book-accent) !important;
        font-size: 12px !important;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .book-writer-actions {
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .book-writer-btn {
        display: inline-flex;
        min-height: 44px;
        align-items: center;
        gap: 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0 14px;
        color: var(--text);
        background: color-mix(in srgb, var(--surface) 90%, transparent 10%);
        font: inherit;
        font-weight: 800;
        text-decoration: none;
      }

      .book-writer-btn--primary {
        border-color: var(--book-accent);
        background: var(--book-accent);
        color: white;
      }

      .book-writer-btn--quiet {
        color: var(--muted);
      }

      .book-writer-search-wrap {
        position: relative;
        display: flex;
        align-items: center;
        min-width: 220px;
      }

      .book-writer-search-wrap span {
        position: absolute;
        left: 14px;
        display: inline-flex;
        width: 16px;
        height: 16px;
        color: var(--muted);
      }

      .book-writer-search {
        width: 100%;
        min-height: 44px;
        padding-left: 38px !important;
        border-radius: 999px !important;
      }

      .book-writer-meta {
        width: 100%;
        justify-content: space-between;
        font-size: 13px;
      }

      .book-writer-editor {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
        padding: 18px;
      }

      .book-writer-editor label,
      .book-writer-chapter label,
      .book-writer-paragraph label,
      .book-writer-lock {
        display: grid;
        gap: 7px;
        font-weight: 700;
      }

      .book-writer-lock {
        display: inline-flex;
        align-items: center;
        font-size: 13px;
      }

      .book-writer-editor--wide {
        grid-column: 1 / -1;
      }

      .book-writer-editor input,
      .book-writer-editor select,
      .book-writer-editor textarea,
      .book-writer-chapter input,
      .book-writer-chapter textarea,
      .book-writer-paragraph input,
      .book-writer-paragraph textarea,
      .book-writer-topic,
      .book-writer-search {
        width: 100%;
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 16px;
        padding: 12px 14px;
        color: var(--text);
        background: color-mix(in srgb, var(--bg) 88%, var(--surface) 12%);
        font: inherit;
      }

      .book-writer-topic {
        min-height: 140px;
        resize: vertical;
      }

      .book-writer-editor textarea {
        min-height: 120px;
      }

      .book-writer-editor input:focus,
      .book-writer-editor select:focus,
      .book-writer-editor textarea:focus,
      .book-writer-chapter input:focus,
      .book-writer-chapter textarea:focus,
      .book-writer-paragraph input:focus,
      .book-writer-paragraph textarea:focus,
      .book-writer-topic:focus,
      .book-writer-search:focus,
      .book-writer-btn:focus-visible,
      .book-writer-primary-action:focus-visible,
      .book-writer-project__select:focus-visible,
      .book-writer-project__delete:focus-visible,
      .book-writer-project__restore:focus-visible,
      .book-writer-journey__step:focus-visible,
      .book-writer-path-card:focus-visible,
      .book-writer-workflow-step:focus-visible {
        outline: 3px solid color-mix(in srgb, var(--book-accent) 28%, transparent 72%);
        outline-offset: 2px;
      }

      .book-writer-list {
        display: grid;
        gap: 14px;
      }

      .book-writer-ai-coach {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 14px;
        margin-bottom: 14px;
        padding: 18px;
        background:
          radial-gradient(circle at 8% 12%, rgba(0, 122, 255, 0.16), transparent 30%),
          color-mix(in srgb, var(--book-accent) 6%, var(--book-card) 94%);
      }

      .book-writer-ai-coach h3 {
        margin: 0;
        font-size: 22px;
        line-height: 1.12;
        letter-spacing: -0.035em;
      }

      .book-writer-ai-coach p {
        margin: 6px 0 0;
        color: var(--muted);
        line-height: 1.45;
      }

      .book-writer-ai-safety,
      .book-writer-ai-progress {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
      }

      .book-writer-ai-progress strong {
        color: var(--book-accent-strong);
        font-size: 13px;
      }

      .book-writer-generate-panel {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 14px;
        padding: 18px;
        background: color-mix(in srgb, var(--book-accent) 7%, var(--book-card) 93%);
      }

      .book-writer-generate-panel h3 {
        margin: 0;
        font-size: 22px;
        line-height: 1.15;
        letter-spacing: -0.035em;
      }

      .book-writer-generate-panel p {
        max-width: 760px;
        margin: 6px 0 0;
        color: var(--muted);
        line-height: 1.5;
      }

      .book-writer-generate-panel__actions {
        display: grid;
        justify-items: end;
        gap: 10px;
      }

      .book-writer-chapter {
        display: grid;
        gap: 12px;
        padding: 18px;
      }

      .book-writer-title-input {
        font-weight: 900;
      }

      .book-writer-paragraph-board {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 14px;
      }

      .book-writer-paragraph-column {
        display: grid;
        align-content: start;
        gap: 12px;
      }

      .book-writer-column-head {
        padding: 0 4px;
      }

      .book-writer-paragraph {
        display: grid;
        gap: 12px;
        padding: 16px;
      }

      .book-writer-paragraph-plan-layer,
      .book-writer-paragraph-text-layer {
        display: grid;
        gap: 12px;
        border: 1px solid color-mix(in srgb, var(--border) 80%, transparent 20%);
        border-radius: 20px;
        padding: 14px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-paragraph-plan-layer h4,
      .book-writer-paragraph-text-layer h4 {
        margin: 0;
        font-size: 18px;
        letter-spacing: -0.025em;
      }

      .book-writer-paragraph-text-layer {
        border-color: color-mix(in srgb, var(--book-accent) 28%, var(--border) 72%);
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--book-accent) 7%, transparent 93%),
          color-mix(in srgb, var(--surface) 90%, transparent 10%)
        );
      }

      .book-writer-purpose {
        min-height: 78px;
      }

      .book-writer-draft {
        min-height: 230px;
        line-height: 1.6;
      }

      .book-writer-draft-view,
      .book-writer-package,
      .book-writer-publish {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
        gap: 16px;
      }

      .book-writer-preview,
      .book-writer-inspector,
      .book-writer-panel,
      .book-writer-bulk-actions,
      .book-writer-empty-card {
        padding: 18px;
      }

      .book-writer-conflict {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }

      .book-writer-conflict p {
        margin: 4px 0;
      }

      .book-writer-bulk-actions {
        display: grid;
        gap: 14px;
        margin-bottom: 14px;
      }

      .book-writer-bulk-actions:not([open]) {
        box-shadow: none;
      }

      .book-writer-preview {
        min-height: 540px;
        border: 1px solid color-mix(in srgb, var(--border) 82%, transparent 18%);
        border-radius: 24px;
        background: #fbfaf7;
        color: #202124;
        box-shadow: 0 22px 60px rgba(15, 23, 42, 0.1);
      }

      .book-writer-preview pre {
        white-space: pre-wrap;
        margin: 0;
        font:
          17px/1.78 Georgia,
          serif;
      }

      .book-writer-finding,
      .book-writer-history,
      .book-writer-action-row {
        display: grid;
        gap: 4px;
        border-top: 1px solid var(--border);
        padding: 12px 0;
      }

      .book-writer-finding--pass b {
        color: var(--book-good);
      }

      .book-writer-finding--warn b {
        color: var(--book-warn);
      }

      .book-writer-finding--fail b,
      .book-writer-finding--blocked b {
        color: var(--book-danger);
      }

      .book-writer-package,
      .book-writer-publish {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .book-writer-panel--wide {
        grid-column: 1 / -1;
      }

      .book-writer-publish-card {
        background: linear-gradient(
          135deg,
          var(--book-card),
          color-mix(in srgb, var(--book-accent) 8%, var(--surface) 92%)
        );
      }

      .book-writer-fix-panel {
        display: grid;
        gap: 14px;
        border-color: color-mix(in srgb, var(--book-warn) 34%, var(--border) 66%);
        background:
          radial-gradient(circle at 100% 0%, rgba(255, 214, 10, 0.16), transparent 30%),
          color-mix(in srgb, var(--book-warn) 7%, var(--surface) 93%);
      }

      .book-writer-fix-panel ol {
        display: grid;
        gap: 8px;
        margin: 0;
        padding-left: 22px;
      }

      .book-writer-publish-steps {
        display: grid;
        gap: 8px;
        margin-top: 14px;
      }

      .book-writer-publish-step {
        display: grid;
        gap: 4px;
        border: 1px solid color-mix(in srgb, var(--border) 72%, transparent 28%);
        border-radius: 16px;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--surface) 88%, transparent 12%);
      }

      .book-writer-publish-step--done {
        border-color: color-mix(in srgb, var(--book-good) 34%, var(--border) 66%);
        background: color-mix(in srgb, var(--book-good) 8%, transparent 92%);
      }

      .book-writer-publish-step--current {
        border-color: color-mix(in srgb, var(--book-accent) 44%, var(--border) 56%);
        background: color-mix(in srgb, var(--book-accent) 9%, transparent 91%);
      }

      .book-writer-publish-step span {
        color: var(--muted);
        line-height: 1.35;
      }

      .book-writer-panel dl {
        display: grid;
        grid-template-columns: 140px minmax(0, 1fr);
        gap: 8px 12px;
      }

      .book-writer-panel dd {
        margin: 0;
        overflow-wrap: anywhere;
      }

      .book-writer-pill {
        display: inline-flex;
        width: fit-content;
        min-height: 26px;
        align-items: center;
        border-radius: 999px;
        padding: 0 9px;
        color: var(--muted);
        background: color-mix(in srgb, var(--border) 36%, transparent 64%);
        font-size: 11px;
        font-weight: 900;
      }

      .book-writer-pill--good {
        color: var(--book-good);
        background: color-mix(in srgb, var(--book-good) 14%, transparent 86%);
      }

      .book-writer-pill--warn {
        color: var(--book-warn);
        background: color-mix(in srgb, var(--book-warn) 14%, transparent 86%);
      }

      .book-writer-pill--danger {
        color: var(--book-danger);
        background: color-mix(in srgb, var(--book-danger) 14%, transparent 86%);
      }

      .book-writer-next-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding: 14px 18px;
      }

      .book-writer-next-actions span {
        display: inline-flex;
        border-radius: 999px;
        padding: 8px 12px;
        color: var(--text);
        background: color-mix(in srgb, var(--book-accent) 10%, transparent 90%);
        font-size: 13px;
        font-weight: 800;
      }

      @media (prefers-reduced-motion: reduce) {
        .book-writer-project,
        .book-writer-deleted-book,
        .book-writer-trophy-book,
        .book-writer-cover-shell,
        .book-writer-celebration__fireworks span {
          animation: none !important;
          transition: none !important;
        }

        .book-writer-project:hover,
        .book-writer-deleted-book:hover,
        .book-writer-trophy-book:hover,
        .book-writer-cover-shell:hover {
          transform: none;
        }
      }

      @media (max-width: 1100px) {
        .book-writer-dashboard,
        .book-writer-hero--empty,
        .book-writer-hero--plan,
        .book-writer-editor,
        .book-writer-draft-view,
        .book-writer-guide,
        .book-writer-glossary,
        .book-writer-path__grid,
        .book-writer-workflow-map__head,
        .book-writer-celebration,
        .book-writer-trophy-room__head,
        .book-writer-trophy-book,
        .book-writer-trophy-empty,
        .book-writer-ai-coach,
        .book-writer-health-strip,
        .book-writer-control-bar,
        .book-writer-landing-shelf,
        .book-writer-plan-write-legend,
        .book-writer-guided-workspace,
        .book-writer-guided-focus,
        .book-writer-package,
        .book-writer-publish {
          grid-template-columns: 1fr;
        }

        .book-writer-workflow-map__head {
          display: grid;
        }

        .book-writer-trophy-room__head {
          display: grid;
        }

        .book-writer-trophy-room--top {
          max-height: min(560px, 78vh);
          overflow: hidden;
          position: static;
          transform: none;
          box-shadow: none;
        }

        .book-writer-trophy-room--top,
        .book-writer-trophy-room--top .book-writer-trophy-room__head h3,
        .book-writer-trophy-room--top .book-writer-trophy-room__head p,
        .book-writer-trophy-room--top .book-writer-trophy-grid,
        .book-writer-trophy-room--top .book-writer-trophy-book,
        .book-writer-trophy-room--top .book-writer-trophy-empty,
        .book-writer-trophy-room--top .book-writer-cover-shell {
          animation: none;
        }

        html.book-writer-trophy-scroll-compact .book-writer-trophy-room--top {
          max-height: 260px;
          padding: 14px 16px;
          transform: none;
          box-shadow: none;
        }

        html.book-writer-trophy-scroll-compact
          .book-writer-trophy-room--top
          .book-writer-trophy-room__head
          p:not(.book-writer-eyebrow) {
          display: none;
        }

        .book-writer-trophy-room--top .book-writer-trophy-grid,
        html.book-writer-trophy-scroll-compact
          .book-writer-trophy-room--top
          .book-writer-trophy-grid {
          grid-auto-columns: minmax(240px, 82vw);
          grid-auto-flow: column;
          grid-template-columns: none;
          overflow-x: auto;
          overflow-y: hidden;
          padding-bottom: 4px;
          scroll-snap-type: x proximity;
        }

        .book-writer-trophy-room--top .book-writer-trophy-book,
        .book-writer-trophy-room--top .book-writer-trophy-empty {
          scroll-snap-align: start;
        }

        .book-writer-path__head,
        .book-writer-generate-panel {
          display: grid;
        }

        .book-writer-style-card {
          grid-template-columns: 1fr 1fr;
        }

        .book-writer-generate-panel__actions {
          justify-items: stretch;
        }

        .book-writer-mini-preview {
          position: static;
        }

        .book-writer-guide__grid {
          grid-template-columns: 1fr;
        }

        .book-writer-rail {
          position: static;
          min-height: auto;
        }

        .book-writer-hero__metrics {
          grid-column: auto;
        }

        .book-writer-full-draft-progress ol {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 720px) {
        .book-writer-journey {
          grid-template-columns: repeat(3, minmax(0, 1fr));
          border-radius: 24px;
        }

        .book-writer-journey__step {
          min-height: 44px;
        }

        .book-writer-hero,
        .book-writer-toolbar,
        .book-writer-editor,
        .book-writer-panel,
        .book-writer-chapter,
        .book-writer-paragraph,
        .book-writer-inspector,
        .book-writer-path,
        .book-writer-celebration,
        .book-writer-trophy-room,
        .book-writer-ai-coach,
        .book-writer-generate-panel,
        .book-writer-bulk-actions,
        .book-writer-style-card,
        .book-writer-health-strip,
        .book-writer-current-settings,
        .book-writer-control-bar,
        .book-writer-landing-shelf,
        .book-writer-plan-write-legend {
          border-radius: 20px;
          padding: 16px;
        }

        .book-writer-bulk-actions {
          align-items: stretch;
          flex-direction: column;
        }

        .book-writer-guided-header,
        .book-writer-advanced-switch,
        .book-writer-guided-split-head,
        .book-writer-guided-card-actions,
        .book-writer-confirm-actions,
        .book-writer-health-strip,
        .book-writer-current-settings,
        .book-writer-control-bar__head,
        .book-writer-landing-shelf__head,
        .book-writer-write-strip {
          display: grid;
          justify-items: stretch;
        }

        .book-writer-guided-steps {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .book-writer-path__grid {
          grid-template-columns: 1fr;
        }

        .book-writer-plain-card--three,
        .book-writer-plain-card--four {
          grid-template-columns: 1fr;
        }

        .book-writer-full-draft-progress ol {
          grid-template-columns: 1fr;
        }

        .book-writer-style-card {
          grid-template-columns: 1fr;
        }

        .book-writer-health-strip__grid {
          grid-template-columns: 1fr;
        }

        .book-writer-control-grid {
          grid-template-columns: 1fr;
        }

        .book-writer-role-grid {
          grid-template-columns: 1fr;
        }

        .book-writer-mini-preview,
        .book-writer-guided-workspace,
        .book-writer-create-focus,
        .book-writer-cover-studio__body,
        .book-writer-next-step,
        .book-writer-guided-publish-cards {
          grid-template-columns: 1fr;
        }

        .book-writer-context-panel {
          position: relative;
          top: auto;
          max-height: none;
        }

        .book-writer-chapter-selector {
          position: relative;
          top: auto;
        }

        textarea.book-writer-editor-field--large {
          min-height: 150px;
        }

        textarea.book-writer-editor-field--hero {
          min-height: 220px;
          font-size: 16px;
        }

        .book-writer-guided-paragraph-card--focus-editor {
          margin-inline: 0;
          padding: 18px;
        }

        .book-writer-guided-paragraph-card--focus-editor textarea.book-writer-plan-summary,
        .book-writer-guided-paragraph-card--focus-editor textarea.book-writer-guided-book-text {
          min-height: 260px;
        }

        .book-writer-control-grid__wide {
          grid-column: auto;
        }

        .book-writer-guided-workspace--single .book-writer-guided-main,
        .book-writer-guided-workspace--single .book-writer-guided-secondary {
          grid-column: auto;
          grid-row: auto;
        }

        .book-writer-current-settings__grid {
          grid-template-columns: 1fr;
        }

        .book-writer-actions,
        .book-writer-button-row {
          align-items: stretch;
        }

        .book-writer-btn,
        .book-writer-search-wrap,
        .book-writer-primary-action,
        .book-writer-guided-primary {
          width: 100%;
        }

        html.book-writer-trophy-scroll-compact .book-writer-trophy-room--top {
          padding: 16px;
        }
      }
    </style>
    <div
      class=${showingHome
        ? "book-writer-dashboard"
        : "book-writer-dashboard book-writer-dashboard--work"}
    >
      ${showingHome ? renderProjectRail(props) : nothing}
      <main class="book-writer-main">
        ${renderErrorCallout(props)}
        ${props.loading && !plan
          ? html`<section class="book-writer-panel">Loading...</section>`
          : nothing}
        ${renderBookCelebration(props)} ${showingHome ? renderLandingShelves(props) : nothing}
        ${props.mode === "guided"
          ? showingNewBookSetup
            ? html`${renderGuidedHeader(props, null)} ${renderGuidedCreate(props)}`
            : plan
              ? html`${renderBookControlBar(props, plan)} ${renderGuidedWorkspace(props, plan)}`
              : nothing
          : html`
              ${renderGuidedHeader(props, showingNewBookSetup ? null : plan)}
              ${renderAllControlsExit(props)} ${renderFullDraftProgress(props)}
              ${showingNewBookSetup
                ? renderCreatePanel(props)
                : plan
                  ? renderBookControlBar(props, plan)
                  : nothing}
              ${!showingNewBookSetup && plan
                ? html`
                    <section
                      class="book-writer-all-controls-stack"
                      aria-label="All Controls panels"
                    >
                      <details class="book-writer-all-controls-details">
                        <summary>Workflow map</summary>
                        ${renderWorkflowMap(props, plan)}
                      </details>
                      <details class="book-writer-all-controls-details">
                        <summary>Detailed guidance</summary>
                        ${renderGuidancePanel(props)}
                      </details>
                      <details class="book-writer-all-controls-details">
                        <summary>Dictionary</summary>
                        ${renderGlossaryStrip()}
                      </details>
                      <details class="book-writer-all-controls-details">
                        <summary>Advanced editor</summary>
                        ${renderNextActions(props)} ${renderToolbar(props, plan)}
                        ${renderActiveView(props, plan)}
                      </details>
                    </section>
                  `
                : !showingNewBookSetup
                  ? html`<section class="book-writer-empty-card">
                      No Planning Studio book selected.
                    </section>`
                  : nothing}
            `}
        ${renderAiConfirmation(props, showingNewBookSetup ? null : plan)}
        ${renderAiSuggestionSheet(props)} ${renderDestructiveConfirmation(props)}
        ${props.mode === "guided" && showingNewBookSetup && !props.loading
          ? html`
              <section class="book-writer-empty-card">
                Type a book description, confirm the simple writing controls, then click Create my
                editable book.
              </section>
            `
          : nothing}
      </main>
    </div>
  `;
}
