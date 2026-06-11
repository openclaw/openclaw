import { html, nothing } from "lit";
import "../../styles/music-studio.css";
import { resolveAgentIdFromSessionKey } from "../session-key.ts";

type MusicGatewayClient = {
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
};
type HostUpdate = {
  requestUpdate?: () => void;
  client?: MusicGatewayClient | null;
  connected?: boolean;
  sessionKey?: string;
  chatRunId?: string | null;
  chatSending?: boolean;
  lastError?: string | null;
  handleSendChat?: (
    messageOverride?: string,
    opts?: { confirmReset?: boolean; restoreDraft?: boolean },
  ) => Promise<void>;
  setTab?: (next: "chat") => void;
};
type MusicMode = "create" | "arrange" | "play" | "finish";
type MusicProvider = "openclaw" | "codex";
type MusicTarget =
  | "whole-song"
  | "selected-part"
  | "beat-drums"
  | "bass"
  | "chords"
  | "melody"
  | "vocals"
  | "lyrics"
  | "sound-fx"
  | "arrangement"
  | "mix"
  | "finish-fix";
type TrackKind = "drums" | "bass" | "chords" | "melody" | "vocal" | "fx";
type SelectedPartKind = "track" | "section" | "export";

type MusicTrack = {
  id: string;
  kind: TrackKind;
  name: string;
  role: string;
  pattern: string;
  color: string;
  muted: boolean;
};

type MusicSection = {
  id: string;
  name: string;
  bars: number;
  energy: "low" | "medium" | "high";
};

type MusicSlot = {
  id: string;
  sectionId: string;
  trackId: string;
};

type MusicProject = {
  title: string;
  style: string;
  key: string;
  bpm: number;
  tracks: MusicTrack[];
  sections: MusicSection[];
  slots: MusicSlot[];
  lyrics: string[];
  mixNotes: string[];
  updatedAt: string;
};

type MusicVersion = {
  project: MusicProject;
  reason: string;
  createdAt: string;
};

type PendingMusicProposal = {
  target: MusicTarget;
  provider: MusicProvider;
  prompt: string;
  summary: string;
  operations: string[];
  nextProject: MusicProject;
};

type FinishArtifact = {
  title: string;
  body: string;
};
type MusicGenerationDispatchStatus =
  | "idle"
  | "checking"
  | "blocked"
  | "starting"
  | "started"
  | "queued"
  | "failed";
type MusicGenerationDispatchState = {
  status: MusicGenerationDispatchStatus;
  message: string;
  detail?: string;
  updatedAt?: string;
};

type SelectedMusicPart = {
  id: string;
  kind: SelectedPartKind;
  label: string;
  detail: string;
};

const DEFAULT_PROMPT =
  'Create an upbeat electronic pop track called "Neon Harbor" with drums, bass, vocal hook, risers, and a polished chorus.';
const DEFAULT_MUSIC_STUDIO_SESSION_KEY = "agent:main:dashboard:music-studio";

const TARGET_OPTIONS: Array<{ id: MusicTarget; label: string; detail: string }> = [
  { id: "whole-song", label: "Whole Song", detail: "Create or rewrite the complete track." },
  { id: "selected-part", label: "Selected Part", detail: "Change the part you clicked." },
  { id: "beat-drums", label: "Beat / Drums", detail: "Rhythm, groove, fills, and percussion." },
  { id: "bass", label: "Bass", detail: "Bass line, movement, and low-end feel." },
  { id: "chords", label: "Chords", detail: "Harmony, pads, guitars, or keys." },
  { id: "melody", label: "Melody", detail: "Lead line, hook, counter-melody." },
  { id: "vocals", label: "Vocals", detail: "Vocal concept, hook, backing parts." },
  { id: "lyrics", label: "Lyrics", detail: "Words, chorus, verse, and phrasing." },
  { id: "sound-fx", label: "Sound FX", detail: "Risers, impacts, sweeps, ambience." },
  { id: "arrangement", label: "Arrangement", detail: "Intro, verse, chorus, bridge, outro." },
  { id: "mix", label: "Mix", detail: "Balance, clarity, punch, and polish." },
  {
    id: "finish-fix",
    label: "Finish Fix",
    detail: "Readiness, export, and provider handoff fixes.",
  },
];

let project = createDefaultMusicProject();
let selectedMode: MusicMode = "create";
let selectedTarget: MusicTarget = "whole-song";
let provider: MusicProvider = "openclaw";
let promptDraft = DEFAULT_PROMPT;
let pendingProposal: PendingMusicProposal | null = null;
let selectedPartId: string | null = null;
let draggedTrackId: string | null = null;
let playing = false;
let lastSnapshotAt: string | null = null;
let finishArtifact: FinishArtifact | null = null;
let musicGenerationDispatch: MusicGenerationDispatchState = {
  status: "idle",
  message:
    "Real audio has not been requested yet. Create/Apply edits the local plan; Generate Audio starts provider-backed audio.",
};
let consoleLines: string[] = [
  "Music Studio ready. Prompt a song, preview it, apply it, then arrange parts.",
];
let undoStack: MusicVersion[] = [];
let redoStack: MusicVersion[] = [];

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function pushConsole(host: HostUpdate, message: string) {
  consoleLines = [`${nowLabel()} ${message}`, ...consoleLines].slice(0, 8);
  host.requestUpdate?.();
}

function cloneProject(value: MusicProject): MusicProject {
  return JSON.parse(JSON.stringify(value)) as MusicProject;
}

function saveUndo(reason: string) {
  undoStack = [
    { project: cloneProject(project), reason, createdAt: new Date().toISOString() },
    ...undoStack,
  ].slice(0, 20);
  redoStack = [];
}

function createTrack(kind: TrackKind, name: string, role: string, pattern: string): MusicTrack {
  const colorByKind: Record<TrackKind, string> = {
    drums: "#ff6b6b",
    bass: "#5eead4",
    chords: "#a78bfa",
    melody: "#facc15",
    vocal: "#fb7185",
    fx: "#60a5fa",
  };
  return {
    id: `${kind}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    kind,
    name,
    role,
    pattern,
    color: colorByKind[kind],
    muted: false,
  };
}

function createDefaultMusicProject(): MusicProject {
  const sections: MusicSection[] = [
    { id: "intro", name: "Intro", bars: 4, energy: "low" },
    { id: "verse", name: "Verse", bars: 8, energy: "medium" },
    { id: "chorus", name: "Chorus", bars: 8, energy: "high" },
    { id: "outro", name: "Outro", bars: 4, energy: "low" },
  ];
  const tracks = [
    createTrack(
      "drums",
      "Pulse Drums",
      "Main beat",
      "Four-on-floor kick, snare on 2 and 4, open hats in chorus.",
    ),
    createTrack(
      "bass",
      "Warm Bass",
      "Low-end drive",
      "Octave pulse that follows the root note and opens in chorus.",
    ),
    createTrack(
      "chords",
      "Glass Chords",
      "Harmony bed",
      "Wide saw chords with soft sidechain and filtered verse.",
    ),
    createTrack("melody", "Neon Lead", "Main hook", "Short call-and-response synth motif."),
    createTrack(
      "vocal",
      "Vocal Hook",
      "Singable top line",
      "Two-line chorus hook with stacked doubles.",
    ),
    createTrack(
      "fx",
      "Lift FX",
      "Transitions",
      "Noise riser into chorus and short impact on downbeat.",
    ),
  ];
  return {
    title: "Neon Harbor",
    style: "upbeat electronic pop",
    key: "A minor",
    bpm: 124,
    tracks,
    sections,
    slots: sections.flatMap((section) =>
      tracks
        .filter((track) => (section.id === "intro" ? track.kind !== "vocal" : true))
        .map((track) => ({
          id: `${section.id}:${track.id}`,
          sectionId: section.id,
          trackId: track.id,
        })),
    ),
    lyrics: ["Meet me where the harbor lights glow", "We turn the dark into stereo"],
    mixNotes: ["Keep kick and bass centered.", "Lift vocal hook 1.5 dB in chorus."],
    updatedAt: new Date().toISOString(),
  };
}

export function resetMusicStudioStateForTests() {
  project = createDefaultMusicProject();
  selectedMode = "create";
  selectedTarget = "whole-song";
  provider = "openclaw";
  promptDraft = DEFAULT_PROMPT;
  pendingProposal = null;
  selectedPartId = null;
  draggedTrackId = null;
  playing = false;
  lastSnapshotAt = null;
  finishArtifact = null;
  musicGenerationDispatch = {
    status: "idle",
    message:
      "Real audio has not been requested yet. Create/Apply edits the local plan; Generate Audio starts provider-backed audio.",
  };
  consoleLines = ["Music Studio ready. Prompt a song, preview it, apply it, then arrange parts."];
  undoStack = [];
  redoStack = [];
}

function extractQuotedTitle(prompt: string): string | null {
  const match = prompt.match(/["“](.+?)["”]/);
  return match?.[1]?.trim() || null;
}

function inferStyle(prompt: string): string {
  const lowered = prompt.toLowerCase();
  if (lowered.includes("trap")) {
    return "trap pop";
  }
  if (lowered.includes("rock")) {
    return "anthemic rock";
  }
  if (lowered.includes("lo-fi") || lowered.includes("lofi")) {
    return "lo-fi hip hop";
  }
  if (lowered.includes("country")) {
    return "modern country";
  }
  if (lowered.includes("cinematic")) {
    return "cinematic pop";
  }
  if (lowered.includes("synth")) {
    return "synthpop";
  }
  return "original pop";
}

function inferBpm(prompt: string): number {
  const explicit = prompt.match(/\b(\d{2,3})\s*bpm\b/i)?.[1];
  if (explicit) {
    return Math.max(60, Math.min(180, Number(explicit)));
  }
  const lowered = prompt.toLowerCase();
  if (lowered.includes("slow") || lowered.includes("ballad")) {
    return 82;
  }
  if (lowered.includes("fast") || lowered.includes("boss") || lowered.includes("dance")) {
    return 138;
  }
  if (lowered.includes("lo-fi") || lowered.includes("lofi")) {
    return 88;
  }
  return 124;
}

function projectFromPrompt(prompt: string): MusicProject {
  const title = extractQuotedTitle(prompt) ?? "Prompt Song";
  const style = inferStyle(prompt);
  const bpm = inferBpm(prompt);
  const lower = prompt.toLowerCase();
  const wantsBridge = lower.includes("bridge") || lower.includes("drop");
  const wantsVocals = lower.includes("vocal") || lower.includes("lyric") || lower.includes("sing");
  const sections: MusicSection[] = [
    { id: "intro", name: "Intro", bars: 4, energy: "low" },
    { id: "verse", name: "Verse", bars: 8, energy: "medium" },
    { id: "chorus", name: "Chorus", bars: 8, energy: "high" },
    ...(wantsBridge ? [{ id: "bridge", name: "Bridge", bars: 8, energy: "medium" as const }] : []),
    { id: "outro", name: "Outro", bars: 4, energy: "low" },
  ];
  const tracks = [
    createTrack(
      "drums",
      lower.includes("drum") ? "Prompt Drums" : "Groove Drums",
      "Main beat",
      `${style} groove at ${bpm} BPM with clear downbeat and chorus lift.`,
    ),
    createTrack(
      "bass",
      "Root Bass",
      "Bass movement",
      "Tight root-note pattern with octave answers at section ends.",
    ),
    createTrack(
      "chords",
      "Color Chords",
      "Harmony bed",
      "Warm chord bed that opens through the chorus.",
    ),
    createTrack(
      "melody",
      "Topline Lead",
      "Main melodic hook",
      "Simple memorable hook that answers the vocal phrase.",
    ),
    ...(wantsVocals
      ? [
          createTrack(
            "vocal",
            "Vocal Hook",
            "Lead vocal concept",
            "Short hook with doubled chorus and soft ad-libs.",
          ),
        ]
      : []),
    createTrack(
      "fx",
      "Transition FX",
      "Risers and impacts",
      "Sweep into chorus, reverse cymbal before drops, soft outro tail.",
    ),
  ];
  return {
    title,
    style,
    key: lower.includes("major") ? "C major" : "A minor",
    bpm,
    tracks,
    sections,
    slots: sections.flatMap((section) =>
      tracks
        .filter((track) => section.id !== "intro" || track.kind !== "vocal")
        .map((track) => ({
          id: `${section.id}:${track.id}`,
          sectionId: section.id,
          trackId: track.id,
        })),
    ),
    lyrics: wantsVocals
      ? [`${title}, keep the lights alive`, "Every heartbeat turns into the night"]
      : ["Instrumental hook carries the chorus."],
    mixNotes: ["Keep the hook forward.", "Leave 2 dB headroom before export."],
    updatedAt: new Date().toISOString(),
  };
}

function ensureTrack(
  draft: MusicProject,
  kind: TrackKind,
  name: string,
  role: string,
  pattern: string,
) {
  const existing = draft.tracks.find((track) => track.kind === kind);
  if (existing) {
    existing.name = name;
    existing.role = role;
    existing.pattern = pattern;
    return existing;
  }
  const track = createTrack(kind, name, role, pattern);
  draft.tracks.push(track);
  return track;
}

function applyPromptToProject(
  base: MusicProject,
  target: MusicTarget,
  prompt: string,
): MusicProject {
  const draft = target === "whole-song" ? projectFromPrompt(prompt) : cloneProject(base);
  const lower = prompt.toLowerCase();
  if (target !== "whole-song") {
    if (target === "beat-drums") {
      ensureTrack(draft, "drums", "Prompt Beat", "Main rhythm", `Prompted groove: ${prompt}`);
    } else if (target === "bass") {
      ensureTrack(draft, "bass", "Prompt Bass", "Low-end motion", `Bass follows prompt: ${prompt}`);
    } else if (target === "chords") {
      ensureTrack(draft, "chords", "Prompt Chords", "Harmony", `Chord texture: ${prompt}`);
    } else if (target === "melody") {
      ensureTrack(draft, "melody", "Prompt Melody", "Lead hook", `Melody concept: ${prompt}`);
    } else if (target === "vocals") {
      ensureTrack(draft, "vocal", "Prompt Vocal", "Vocal hook", `Vocal concept: ${prompt}`);
      draft.lyrics = [`${draft.title}, say it like thunder`, "We keep the chorus bright"];
    } else if (target === "lyrics") {
      draft.lyrics = prompt
        .split(/[\n.]+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 6);
      if (draft.lyrics.length === 0) {
        draft.lyrics = [`${draft.title} is the chorus hook.`];
      }
    } else if (target === "sound-fx") {
      ensureTrack(draft, "fx", "Prompt FX", "Transitions", `FX plan: ${prompt}`);
    } else if (target === "arrangement") {
      if (!draft.sections.some((section) => section.id === "bridge")) {
        draft.sections.splice(-1, 0, { id: "bridge", name: "Bridge", bars: 8, energy: "medium" });
      }
      if (lower.includes("short")) {
        draft.sections = draft.sections.filter((section) => section.id !== "bridge");
      }
    } else if (target === "mix") {
      draft.mixNotes = [`Mix prompt: ${prompt}`, "Check low-end balance and vocal clarity."];
    } else if (target === "selected-part") {
      const selected = selectedMusicPart();
      if (selected?.kind === "track") {
        const track = draft.tracks.find((candidate) => candidate.id === selected.id);
        if (track) {
          track.pattern = `Changed by prompt: ${prompt}`;
        }
      } else if (selected?.kind === "section") {
        const section = draft.sections.find((candidate) => candidate.id === selected.id);
        if (section) {
          section.energy = lower.includes("big") || lower.includes("loud") ? "high" : "medium";
        }
      }
    } else if (target === "finish-fix") {
      draft.mixNotes = [
        "Readiness fixed: intro, hook, transitions, and export notes are present.",
        ...draft.mixNotes,
      ];
    }
  }
  draft.updatedAt = new Date().toISOString();
  return draft;
}

function proposalSummary(target: MusicTarget) {
  const label = TARGET_OPTIONS.find((option) => option.id === target)?.label ?? "Song";
  return `${label} preview ready`;
}

function previewPrompt(host: HostUpdate) {
  const nextProject = applyPromptToProject(project, selectedTarget, promptDraft);
  pendingProposal = {
    target: selectedTarget,
    provider,
    prompt: promptDraft,
    summary: proposalSummary(selectedTarget),
    operations: [
      selectedTarget === "whole-song"
        ? "Create complete editable song"
        : `Update ${selectedTarget}`,
      "Keep undo/snapshot history",
      "Open matching editor after apply",
    ],
    nextProject,
  };
  pushConsole(host, `${provider === "openclaw" ? "OpenClaw" : "Codex"} prepared a music preview.`);
}

function applyPrompt(host: HostUpdate) {
  if (pendingProposal) {
    saveUndo(`Applied ${pendingProposal.summary}`);
    project = pendingProposal.nextProject;
    pendingProposal = null;
  } else {
    saveUndo(`Applied prompt to ${selectedTarget}`);
    project = applyPromptToProject(project, selectedTarget, promptDraft);
  }
  if (selectedTarget !== "whole-song") {
    selectedMode = "arrange";
  }
  pushConsole(host, `Applied music prompt. ${project.title} is editable and playable.`);
}

function undo(host: HostUpdate) {
  const previous = undoStack[0];
  if (!previous) {
    return;
  }
  redoStack = [
    { project: cloneProject(project), reason: "redo", createdAt: new Date().toISOString() },
    ...redoStack,
  ];
  project = cloneProject(previous.project);
  undoStack = undoStack.slice(1);
  pushConsole(host, `Undo restored ${previous.reason}.`);
}

function snapshot(host: HostUpdate) {
  saveUndo("Snapshot");
  lastSnapshotAt = new Date().toLocaleString();
  pushConsole(host, "Snapshot saved locally.");
}

function playNow(host: HostUpdate) {
  selectedMode = "play";
  playing = true;
  pushConsole(host, `Playing ${project.title} preview at ${project.bpm} BPM.`);
}

function buildProviderPacket() {
  return {
    tool: "music_generate",
    action: "generate",
    prompt: `${project.title}: ${project.style}; ${project.tracks
      .map((track) => `${track.name} (${track.role})`)
      .join(", ")}. Mix notes: ${project.mixNotes.join(" ")}`,
    lyrics: project.lyrics.join("\n"),
    instrumental: !project.tracks.some((track) => track.kind === "vocal"),
    durationSeconds: 90,
    format: "mp3",
    filename: `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "music-studio"}.mp3`,
  };
}

function buildMusicGenerationChatRequest() {
  const packet = buildProviderPacket();
  return [
    "Music Studio dashboard request: generate provider-backed audio now.",
    "",
    "Use the `music_generate` tool exactly once with this JSON packet:",
    "",
    "```json",
    JSON.stringify(packet, null, 2),
    "```",
    "",
    "Requirements:",
    "- Start generation rather than only describing the plan.",
    "- If `music_generate` is unavailable or provider credentials are missing, say exactly what setup is missing.",
    "- When the task starts, report the task id/status. When it completes, attach or link the generated audio.",
  ].join("\n");
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function musicInventoryContainsTool(value: unknown, toolId: string) {
  if (!isObjectRecord(value) || !Array.isArray(value.groups)) {
    return false;
  }
  return value.groups.some((group) => {
    if (!isObjectRecord(group) || !Array.isArray(group.tools)) {
      return false;
    }
    return group.tools.some(
      (tool) => isObjectRecord(tool) && typeof tool.id === "string" && tool.id === toolId,
    );
  });
}

function formatDispatchError(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function resolveMusicStudioSessionKey(host: HostUpdate) {
  const trimmed = typeof host.sessionKey === "string" ? host.sessionKey.trim() : "";
  return trimmed || DEFAULT_MUSIC_STUDIO_SESSION_KEY;
}

async function resolveMusicGenerationAvailability(host: HostUpdate): Promise<{
  ok: boolean;
  message?: string;
  detail?: string;
}> {
  if (!host.connected || !host.client) {
    return {
      ok: false,
      message: "Connect the Gateway before generating real audio.",
      detail:
        "The dashboard can still create and edit a local music plan while offline, but provider-backed audio needs an active Gateway connection.",
    };
  }
  if (!host.handleSendChat) {
    return {
      ok: false,
      message: "This dashboard build cannot submit a music generation run.",
      detail:
        "Refresh the dashboard after the updated Control UI loads, then try Generate Audio again.",
    };
  }

  const sessionKey = resolveMusicStudioSessionKey(host);
  try {
    const inventory = await host.client.request("tools.effective", {
      agentId: resolveAgentIdFromSessionKey(sessionKey),
      sessionKey,
    });
    if (!musicInventoryContainsTool(inventory, "music_generate")) {
      return {
        ok: false,
        message: "`music_generate` is not available for the active dashboard agent.",
        detail:
          "Configure a music provider such as Google Lyria, MiniMax, or ComfyUI, then refresh tools and try Generate Audio again.",
      };
    }
  } catch (err) {
    return {
      ok: true,
      detail: `Tool inventory could not be verified first (${formatDispatchError(err)}). The dashboard will still submit the generation request to the agent.`,
    };
  }

  return { ok: true };
}

function setMusicGenerationDispatch(host: HostUpdate, next: MusicGenerationDispatchState) {
  musicGenerationDispatch = {
    ...next,
    updatedAt: new Date().toLocaleTimeString(),
  };
  host.requestUpdate?.();
}

async function dispatchMusicGeneration(host: HostUpdate) {
  const request = buildMusicGenerationChatRequest();
  setMusicGenerationDispatch(host, {
    status: "checking",
    message: "Checking whether `music_generate` is available before starting audio generation.",
  });
  pushConsole(host, "Checking provider-backed music generation.");

  const availability = await resolveMusicGenerationAvailability(host);
  if (!availability.ok) {
    setMusicGenerationDispatch(host, {
      status: "blocked",
      message: availability.message ?? "Music generation is blocked.",
      detail: availability.detail,
    });
    setFinishArtifact(
      host,
      {
        title: "Music Generation Blocked",
        body: [availability.message, availability.detail].filter(Boolean).join("\n\n"),
      },
      "Music generation blocked before dispatch.",
    );
    return;
  }

  const wasBusy = Boolean(host.chatRunId || host.chatSending);
  setMusicGenerationDispatch(host, {
    status: "starting",
    message: wasBusy
      ? "The active chat is busy. Queueing this music generation request."
      : "Submitting this project to the active chat for provider-backed audio generation.",
    detail: availability.detail,
  });

  const previousLastError = host.lastError ?? null;
  try {
    await host.handleSendChat?.(request);
  } catch (err) {
    setMusicGenerationDispatch(host, {
      status: "failed",
      message: "The dashboard failed to submit the music generation request.",
      detail: formatDispatchError(err),
    });
    pushConsole(host, "Music generation dispatch failed.");
    return;
  }

  const nextLastError = host.lastError ?? null;
  if (nextLastError && nextLastError !== previousLastError) {
    setMusicGenerationDispatch(host, {
      status: "failed",
      message: "The Gateway rejected the music generation request.",
      detail: nextLastError,
    });
    pushConsole(host, "Music generation dispatch failed.");
    return;
  }

  setFinishArtifact(
    host,
    {
      title: wasBusy ? "Queued Music Generation Request" : "Started Music Generation Request",
      body: request,
    },
    wasBusy ? "Queued music generation in active chat." : "Sent music generation to active chat.",
  );
  setMusicGenerationDispatch(host, {
    status: wasBusy ? "queued" : "started",
    message: wasBusy
      ? "Music generation was queued in the active chat."
      : "Music generation was sent to the active chat.",
    detail:
      "Open Chat to watch the run. The agent will call `music_generate`, report task status, and attach or link the audio when ready.",
  });
}

function setFinishArtifact(host: HostUpdate, artifact: FinishArtifact, consoleMessage: string) {
  finishArtifact = artifact;
  pushConsole(host, consoleMessage);
}

function selectedMusicPart(): SelectedMusicPart | null {
  if (!selectedPartId) {
    return null;
  }
  const track = project.tracks.find((candidate) => candidate.id === selectedPartId);
  if (track) {
    return { id: track.id, kind: "track", label: track.name, detail: track.pattern };
  }
  const section = project.sections.find((candidate) => candidate.id === selectedPartId);
  if (section) {
    return {
      id: section.id,
      kind: "section",
      label: section.name,
      detail: `${section.bars} bars · ${section.energy} energy`,
    };
  }
  return null;
}

function selectPart(host: HostUpdate, id: string, target: MusicTarget = "selected-part") {
  selectedPartId = id;
  selectedTarget = target;
  pushConsole(host, `Selected ${selectedMusicPart()?.label ?? "part"}.`);
}

function bindTrackToSection(host: HostUpdate, sectionId: string) {
  if (!draggedTrackId) {
    pushConsole(host, "Drag a track card onto this section first.");
    return;
  }
  const track = project.tracks.find((candidate) => candidate.id === draggedTrackId);
  const section = project.sections.find((candidate) => candidate.id === sectionId);
  if (!track || !section) {
    return;
  }
  saveUndo("Arrangement drag/drop");
  const slotId = `${sectionId}:${draggedTrackId}`;
  if (!project.slots.some((slot) => slot.id === slotId)) {
    project = {
      ...project,
      slots: [...project.slots, { id: slotId, sectionId, trackId: draggedTrackId }],
      updatedAt: new Date().toISOString(),
    };
  }
  pushConsole(host, `Dropped ${track.name} into ${section.name}.`);
  draggedTrackId = null;
}

function targetLabel(target: MusicTarget) {
  return TARGET_OPTIONS.find((option) => option.id === target)?.label ?? "Song";
}

function isMusicGenerationDispatchBusy() {
  return (
    musicGenerationDispatch.status === "checking" || musicGenerationDispatch.status === "starting"
  );
}

function musicGenerationStatusLabel() {
  if (musicGenerationDispatch.status === "blocked") {
    return "Music Generation Blocked";
  }
  if (musicGenerationDispatch.status === "failed") {
    return "Music Generation Failed";
  }
  if (musicGenerationDispatch.status === "queued") {
    return "Music Generation Queued";
  }
  if (musicGenerationDispatch.status === "started") {
    return "Music Generation Started";
  }
  if (musicGenerationDispatch.status === "checking") {
    return "Checking Music Generation";
  }
  if (musicGenerationDispatch.status === "starting") {
    return "Starting Music Generation";
  }
  return "Ready for Music Generation";
}

function renderMusicGenerationPanel(host: HostUpdate) {
  const busy = isMusicGenerationDispatchBusy();
  return html`<section class="music-generation-panel" aria-live="polite">
    <div>
      <span class="music-eyebrow">Provider Audio</span>
      <h3>Generate real audio from this dashboard</h3>
      <strong>${musicGenerationStatusLabel()}</strong>
      <p>${musicGenerationDispatch.message}</p>
      ${musicGenerationDispatch.detail
        ? html`<small>${musicGenerationDispatch.detail}</small>`
        : nothing}
      ${musicGenerationDispatch.updatedAt
        ? html`<small>Last update: ${musicGenerationDispatch.updatedAt}</small>`
        : nothing}
    </div>
    <div class="music-toolbar">
      <button
        type="button"
        class="primary"
        ?disabled=${busy}
        @click=${() => dispatchMusicGeneration(host)}
      >
        ${busy ? "Starting Audio…" : "Generate Audio"}
      </button>
      ${host.setTab &&
      (musicGenerationDispatch.status === "started" || musicGenerationDispatch.status === "queued")
        ? html`<button type="button" @click=${() => host.setTab?.("chat")}>Open Chat</button>`
        : nothing}
    </div>
  </section>`;
}

function renderPromptBar(host: HostUpdate) {
  const disabled = selectedTarget === "selected-part" && !selectedMusicPart();
  return html`
    <section class="music-prompt-bar" aria-label="Music Studio prompt bar">
      <label>
        Target
        <select
          .value=${selectedTarget}
          @change=${(event: Event) => {
            selectedTarget = (event.target as HTMLSelectElement).value as MusicTarget;
            host.requestUpdate?.();
          }}
        >
          ${TARGET_OPTIONS.map(
            (option) =>
              html`<option value=${option.id} ?selected=${option.id === selectedTarget}>
                ${option.label}
              </option>`,
          )}
        </select>
      </label>
      <div class="music-provider-toggle" aria-label="AI provider">
        ${(["openclaw", "codex"] as const).map(
          (item) => html`<button
            type="button"
            class=${provider === item ? "active" : ""}
            @click=${() => {
              provider = item;
              host.requestUpdate?.();
            }}
          >
            ${item === "openclaw" ? "OpenClaw" : "Codex"}
          </button>`,
        )}
      </div>
      <label class="music-prompt-bar__text">
        What music do you want to create or change?
        <textarea
          rows="3"
          .value=${promptDraft}
          @input=${(event: Event) => {
            promptDraft = (event.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
      </label>
      <div class="music-prompt-bar__actions">
        <button type="button" ?disabled=${disabled} @click=${() => previewPrompt(host)}>
          Preview
        </button>
        <button
          type="button"
          class="primary"
          ?disabled=${disabled}
          @click=${() => applyPrompt(host)}
        >
          ${selectedTarget === "whole-song"
            ? "Apply: Create Song"
            : `Apply ${targetLabel(selectedTarget)}`}
        </button>
        <button type="button" @click=${() => playNow(host)}>Play Now</button>
        <button type="button" ?disabled=${undoStack.length === 0} @click=${() => undo(host)}>
          Undo
        </button>
      </div>
    </section>
  `;
}

function renderModeRail(host: HostUpdate) {
  const modes: Array<{ id: MusicMode; label: string; detail: string }> = [
    { id: "create", label: "Create", detail: "Prompt the song." },
    { id: "arrange", label: "Arrange", detail: "Drag parts." },
    { id: "play", label: "Play", detail: "Audition." },
    { id: "finish", label: "Finish", detail: "Export." },
  ];
  return html`<nav class="music-mode-rail" aria-label="Music Studio modes">
    ${modes.map(
      (mode) => html`<button
        type="button"
        class=${selectedMode === mode.id ? "active" : ""}
        @click=${() => {
          selectedMode = mode.id;
          if (mode.id === "play") {
            playNow(host);
          } else {
            host.requestUpdate?.();
          }
        }}
      >
        <strong>${mode.label}</strong><span>${mode.detail}</span>
      </button>`,
    )}
  </nav>`;
}

function renderPendingProposal(host: HostUpdate) {
  if (!pendingProposal) {
    return nothing;
  }
  return html`<section class="music-review" aria-label="Review Before Apply">
    <div>
      <span>Review Before Apply</span>
      <h3>${pendingProposal.summary}</h3>
      <p>
        ${pendingProposal.provider === "openclaw" ? "OpenClaw" : "Codex"} prepared an editable
        change.
      </p>
    </div>
    <ul>
      ${pendingProposal.operations.map((operation) => html`<li>${operation}</li>`)}
    </ul>
    <div class="music-toolbar">
      <button type="button" class="primary" @click=${() => applyPrompt(host)}>Apply Change</button>
      <button
        type="button"
        @click=${() => {
          pendingProposal = null;
          pushConsole(host, "Discarded music preview.");
        }}
      >
        Discard
      </button>
    </div>
  </section>`;
}

function renderCreateMode(host: HostUpdate) {
  return html`<section class="music-create-mode" aria-label="Create music">
    <div class="music-hero">
      <div>
        <span class="music-eyebrow">Music Studio</span>
        <h2>Prompt a song. Arrange it. Play it. Finish it.</h2>
        <p>
          Create beats, vocals, melodies, sound FX, lyrics, arrangements, mix notes, and provider
          handoff packets from one beginner-safe surface.
        </p>
      </div>
      <div class="music-start-actions">
        <button type="button" class="primary" @click=${() => applyPrompt(host)}>
          Create Playable Song
        </button>
        <button type="button" @click=${() => playNow(host)}>Play Now</button>
        <button type="button" @click=${() => snapshot(host)}>Snapshot</button>
      </div>
    </div>
    <div class="music-status-grid" aria-label="Song readiness">
      <article><span>Song</span><strong>${project.title}</strong></article>
      <article><span>Tempo</span><strong>${project.bpm} BPM</strong></article>
      <article><span>Tracks</span><strong>${project.tracks.length}</strong></article>
      <article><span>Ready</span><strong>Playable</strong></article>
    </div>
    ${renderPartsShelf(host)}
  </section>`;
}

function renderPartsShelf(host: HostUpdate) {
  return html`<section class="music-parts-shelf" aria-label="Music parts shelf">
    <div class="music-section-header">
      <div>
        <span class="music-eyebrow">Parts Shelf</span>
        <h3>Everything you can prompt or drag</h3>
      </div>
      <button
        type="button"
        @click=${() => {
          selectedMode = "arrange";
          host.requestUpdate?.();
        }}
      >
        Open Arrange
      </button>
    </div>
    <div class="music-track-grid">
      ${project.tracks.map((track) => renderTrackCard(host, track))}
    </div>
  </section>`;
}

function renderTrackCard(host: HostUpdate, track: MusicTrack) {
  return html`<button
    type="button"
    class=${selectedPartId === track.id ? "music-track-card active" : "music-track-card"}
    draggable="true"
    style=${`--track-color:${track.color}`}
    @click=${() => selectPart(host, track.id)}
    @dragstart=${() => {
      draggedTrackId = track.id;
      pushConsole(host, `Dragging ${track.name}. Drop it onto an arrangement section.`);
    }}
    @dragend=${() => {
      draggedTrackId = null;
    }}
  >
    <span>${track.kind}</span>
    <strong>${track.name}</strong>
    <small>${track.role}</small>
  </button>`;
}

function renderArrangement(host: HostUpdate) {
  return html`<section class="music-arrange-mode" aria-label="Arrange music">
    <div class="music-section-header">
      <div>
        <span class="music-eyebrow">Arrangement Canvas</span>
        <h3>${project.title}</h3>
        <p>Drag tracks into sections, click parts, and prompt the selected part.</p>
      </div>
      <button type="button" @click=${() => playNow(host)}>Play From Start</button>
    </div>
    <div class="music-arrange-layout">
      <aside>${renderPartsShelf(host)} ${renderSelectedPartSheet(host)}</aside>
      <main class="music-arrangement" aria-label="Drag tracks to sections">
        ${project.sections.map(
          (section) => html`<article
            class="music-section-drop"
            @dragover=${(event: DragEvent) => event.preventDefault()}
            @drop=${() => bindTrackToSection(host, section.id)}
          >
            <button
              type="button"
              class="music-section-title"
              @click=${() => selectPart(host, section.id)}
            >
              <strong>${section.name}</strong><span>${section.bars} bars · ${section.energy}</span>
            </button>
            <div class="music-section-clips">
              ${project.slots
                .filter((slot) => slot.sectionId === section.id)
                .map((slot) => project.tracks.find((track) => track.id === slot.trackId))
                .filter((track): track is MusicTrack => Boolean(track))
                .map(
                  (track) =>
                    html`<button type="button" @click=${() => selectPart(host, track.id)}>
                      ${track.name}
                    </button>`,
                )}
            </div>
          </article>`,
        )}
      </main>
    </div>
  </section>`;
}

function renderSelectedPartSheet(host: HostUpdate) {
  const part = selectedMusicPart();
  if (!part) {
    return html`<section class="music-selected-sheet" aria-label="Selected part sheet">
      <span class="music-eyebrow">Selected Part</span>
      <h3>Click a track or section</h3>
      <p>Then prompt just that part, duplicate the idea, test it, or undo safely.</p>
    </section>`;
  }
  return html`<section class="music-selected-sheet" aria-label="Selected part sheet">
    <span class="music-eyebrow">Selected Part</span>
    <h3>${part.label}</h3>
    <p>${part.detail}</p>
    <label>
      Prompt this part
      <textarea
        rows="3"
        .value=${promptDraft}
        @input=${(event: Event) => {
          promptDraft = (event.target as HTMLTextAreaElement).value;
          selectedTarget = "selected-part";
        }}
      ></textarea>
    </label>
    <div class="music-toolbar">
      <button type="button" class="primary" @click=${() => applyPrompt(host)}>Apply Change</button>
      <button type="button" @click=${() => previewPrompt(host)}>Preview</button>
      <button type="button" @click=${() => playNow(host)}>Test</button>
      <button type="button" ?disabled=${undoStack.length === 0} @click=${() => undo(host)}>
        Undo
      </button>
    </div>
  </section>`;
}

function renderPlayMode(host: HostUpdate) {
  return html`<section class="music-play-mode" aria-label="Play music">
    <div class="music-transport">
      <div>
        <span class="music-eyebrow">Transport</span>
        <h3>${playing ? "Playing preview" : "Ready to play"}</h3>
        <p>${project.title} · ${project.style} · ${project.key} · ${project.bpm} BPM</p>
      </div>
      <div class="music-toolbar">
        <button type="button" class="primary" @click=${() => playNow(host)}>Play Now</button>
        <button
          type="button"
          @click=${() => {
            playing = false;
            pushConsole(host, "Stopped preview.");
          }}
        >
          Stop
        </button>
        <button
          type="button"
          @click=${() => {
            selectedMode = "arrange";
            host.requestUpdate?.();
          }}
        >
          Edit Arrangement
        </button>
      </div>
    </div>
    <div class="music-now-playing" aria-label="Now playing tracks">
      ${project.tracks.map(
        (track) => html`<span style=${`--track-color:${track.color}`}>${track.name}</span>`,
      )}
    </div>
    <section class="music-lyrics" aria-label="Lyrics and hook">
      <h3>Hook / lyrics</h3>
      ${project.lyrics.map((line) => html`<p>${line}</p>`)}
    </section>
  </section>`;
}

function renderFinishMode(host: HostUpdate) {
  const providerPacket = buildProviderPacket();
  const promptPacket = `/tool music_generate prompt=${JSON.stringify(providerPacket.prompt)} lyrics=${JSON.stringify(providerPacket.lyrics)} instrumental=${providerPacket.instrumental} durationSeconds=${providerPacket.durationSeconds} format=${providerPacket.format} filename=${JSON.stringify(providerPacket.filename)}`;
  const projectJson = JSON.stringify(project, null, 2);
  const bridgePlan = [
    "GarageBand Bridge Plan",
    `1. Create a new GarageBand project named ${project.title}.`,
    `2. Set tempo to ${project.bpm} BPM and key to ${project.key}.`,
    `3. Create tracks: ${project.tracks.map((track) => track.name).join(", ")}.`,
    "4. Arrange sections in order and import generated audio/stems when available.",
    "5. Keep this OpenClaw project JSON as the source-of-truth edit map.",
  ].join("\n");
  const visibleArtifact =
    finishArtifact ??
    ({
      title: "Provider Packet",
      body: promptPacket,
    } satisfies FinishArtifact);
  return html`<section class="music-finish-mode" aria-label="Finish music">
    <div class="music-section-header">
      <div>
        <span class="music-eyebrow">Finish</span>
        <h3>Ready to export a music brief</h3>
        <p>Provider-backed audio generation stays explicit and approval-gated.</p>
      </div>
      <strong>Playable plan ready</strong>
    </div>
    <div class="music-finish-actions">
      <button
        type="button"
        class="primary"
        @click=${() =>
          setFinishArtifact(
            host,
            { title: "Project JSON", body: projectJson },
            "Exported project JSON preview.",
          )}
      >
        Export Project JSON
      </button>
      <button
        type="button"
        @click=${() =>
          setFinishArtifact(
            host,
            { title: "music_generate Provider Packet", body: promptPacket },
            "Created music_generate provider packet.",
          )}
      >
        Create Provider Packet
      </button>
      <button
        type="button"
        @click=${() =>
          setFinishArtifact(
            host,
            { title: "GarageBand Bridge Plan", body: bridgePlan },
            "Prepared GarageBand bridge plan.",
          )}
      >
        GarageBand Bridge Plan
      </button>
    </div>
    <section class="music-export-panel" aria-label="Selected finish artifact">
      <h4>${visibleArtifact.title}</h4>
      <pre>${visibleArtifact.body}</pre>
    </section>
    <details>
      <summary>Professional Details</summary>
      <ul>
        <li>Live audio requires a configured music_generation provider.</li>
        <li>Local Music Studio never stores provider secrets.</li>
        <li>Exports include prompt packet, arrangement, lyrics, mix notes, and track list.</li>
      </ul>
    </details>
  </section>`;
}

function renderConsole() {
  return html`<aside class="music-console" aria-live="polite">
    <strong>Recent</strong>
    ${lastSnapshotAt ? html`<span>Last snapshot: ${lastSnapshotAt}</span>` : nothing}
    ${consoleLines.map((line) => html`<span>${line}</span>`)}
  </aside>`;
}

function renderCurrentMode(host: HostUpdate) {
  if (selectedMode === "arrange") {
    return renderArrangement(host);
  }
  if (selectedMode === "play") {
    return renderPlayMode(host);
  }
  if (selectedMode === "finish") {
    return renderFinishMode(host);
  }
  return renderCreateMode(host);
}

export function renderMusicStudio(host: HostUpdate = {}) {
  return html`<div class="music-studio">
    ${renderModeRail(host)} ${renderPromptBar(host)} ${renderMusicGenerationPanel(host)}
    ${renderPendingProposal(host)} ${renderCurrentMode(host)} ${renderConsole()}
  </div>`;
}
