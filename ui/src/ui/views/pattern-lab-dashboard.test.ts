import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { PatternLabDashboardSnapshot } from "../controllers/pattern-lab-dashboard.ts";
import {
  renderPatternLabDashboard,
  type PatternLabDashboardProps,
} from "./pattern-lab-dashboard.ts";

function file(path: string) {
  return {
    path,
    repoPath: `youtube-v1/${path}`,
    mediaPath: path,
    mediaUrl: `/__openclaw__/pattern-lab-media?path=${encodeURIComponent(path)}`,
    exists: true,
    sizeBytes: 1024,
    durationSeconds: path.endsWith(".mp4") ? 42 : null,
  };
}

function snapshot(): PatternLabDashboardSnapshot {
  return {
    generatedAt: "2026-05-11T20:00:00Z",
    videoId: "01",
    channelName: "Pattern Lab",
    status: "owner-review-required",
    publicPublish: "blocked_until_explicit_owner_approval",
    outputRoot: "youtube-v1/local-output/video-01",
    approvals: {
      image: { total: 4, approved: 4, pending: 0, complete: true },
      thumbnail: { total: 2, approved: 1, pending: 1, complete: false },
      voiceover: { total: 1, approved: 0, pending: 1, complete: false },
      proof_footage: { total: 1, approved: 1, pending: 0, complete: true },
      video: { total: 1, approved: 0, pending: 1, complete: false },
      short: { total: 3, approved: 0, pending: 3, complete: false },
    },
    blockers: ["Human review approval is missing for asset type: thumbnail."],
    readinessSteps: [
      { label: "Long-form", complete: true, detail: "Draft video is present." },
      { label: "Approvals", complete: false, detail: "2/6 asset groups approved." },
    ],
    media: {
      longForm: file("local-output/video-01/video/pattern-lab-video-01-draft.mp4"),
      voiceover: file("local-output/video-01/audio/voiceover_full_normalized.mp3"),
      shorts: [
        file("local-output/video-01/shorts/pattern-lab-video-01-short-01.mp4"),
        file("local-output/video-01/shorts/pattern-lab-video-01-short-02.mp4"),
        file("local-output/video-01/shorts/pattern-lab-video-01-short-03.mp4"),
      ],
      thumbnails: [
        file("local-output/video-01/images/thumbnail_candidate_a.png"),
        file("local-output/video-01/images/thumbnail_candidate_b.png"),
      ],
      reviewPacket: file("local-output/video-01/review/owner-review-packet.md"),
      readinessReport: file("local-output/video-01/approval/private-upload-readiness.md"),
    },
    performance: {
      path: "local-output/video-01/metrics/video-01-performance.csv",
      repoPath: "youtube-v1/local-output/video-01/metrics/video-01-performance.csv",
      rows: [],
      cards: [
        { label: "Views", value: "pending", why: "Top-of-funnel demand." },
        { label: "CTR", value: "pending", why: "Title-thumbnail promise strength." },
      ],
      decisionLabel: "pending_publish",
      nextAction: "Approve assets.",
      commentsSignalSummary: "Pending first upload.",
      requiredExports: [],
      decisionLabels: ["double_down"],
    },
    nextActions: ["Review long-form draft on phone speaker."],
  };
}

function props(overrides: Partial<PatternLabDashboardProps> = {}): PatternLabDashboardProps {
  return {
    loading: false,
    error: null,
    snapshot: snapshot(),
    lastFetchAt: 0,
    approvingAssetType: null,
    basePath: "/openclaw",
    authToken: "token",
    onRefresh: vi.fn(),
    onApproveAssetType: vi.fn(),
    ...overrides,
  };
}

describe("renderPatternLabDashboard", () => {
  it("renders Pattern Lab natively without an iframe", () => {
    const container = document.createElement("div");

    render(renderPatternLabDashboard(props()), container);

    expect(container.textContent).toContain("Pattern Lab");
    expect(container.textContent).toContain("Patterns. Criteria. Proof.");
    expect(container.textContent).toContain("Public publish: blocked");
    expect(container.querySelector("iframe")).toBeNull();

    const video = container.querySelector("video");
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(video?.getAttribute("src")).toContain("/openclaw/__openclaw__/pattern-lab-media");
    expect(video?.getAttribute("src")).toContain("token=token");
  });

  it("wires asset approval buttons", () => {
    const onApproveAssetType = vi.fn();
    const container = document.createElement("div");

    render(renderPatternLabDashboard(props({ onApproveAssetType })), container);

    const thumbnailButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Thumbnails"),
    );
    expect(thumbnailButton).toBeInstanceOf(HTMLButtonElement);
    thumbnailButton?.click();

    expect(onApproveAssetType).toHaveBeenCalledWith("thumbnail");
  });
});
