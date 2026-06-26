import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderSnesStudio, resetSnesStudioStateForTests } from "./snes-studio.ts";

type TestHost = NonNullable<Parameters<typeof renderSnesStudio>[0]>;

function renderStudio(host: TestHost, container: HTMLElement) {
  render(renderSnesStudio(host), container);
}

function buttonByText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function clickButton(container: HTMLElement, text: string) {
  const button = buttonByText(container, text);
  expect(button, `button containing ${text}`).not.toBeUndefined();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function typeGamePrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".snes-arcade-start textarea, .snes-guided-idea textarea",
  );
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeGuidedThingPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".snes-guided-thing-prompt textarea",
  );
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeSelectedThingPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".snes-ai-selected-panel textarea");
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeArcadeAreaPrompt(container: HTMLElement, value: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(".snes-arcade-ask-bar textarea");
  expect(textarea).not.toBeNull();
  textarea!.value = value;
  textarea!.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flushAsyncUi(container: HTMLElement, host: TestHost) {
  await Promise.resolve();
  await Promise.resolve();
  renderStudio(host, container);
}

async function waitForText(container: HTMLElement, host: TestHost, text: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    renderStudio(host, container);
    if (container.textContent?.includes(text)) {
      return;
    }
  }
  expect(container.textContent).toContain(text);
}

function createGame(container: HTMLElement, host: TestHost) {
  clickButton(container, "Make My Game");
  renderStudio(host, container);
}

function openExpertStudio(container: HTMLElement, host: TestHost) {
  const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
  expect(expert).not.toBeNull();
  expert!.open = true;
  expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
  renderStudio(host, container);
}

describe("renderSnesStudio SNES Studio", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "?__openclaw_skip_auto_agent_team=1");
    const clearStorage = (globalThis.localStorage as { clear?: unknown } | undefined)?.clear;
    if (typeof clearStorage === "function") {
      clearStorage.call(globalThis.localStorage);
    }
    resetSnesStudioStateForTests();
    document.body.replaceChildren();
  });

  it("starts with one obvious AI-first creation path", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);

    expect(container.querySelector(".snes-arcade-builder--start")).not.toBeNull();
    expect(container.querySelectorAll(".snes-arcade-start textarea")).toHaveLength(1);
    expect(container.textContent).toContain("SNES Studio");
    expect(container.textContent).toContain("What game should we make?");
    expect(container.textContent).toContain("Make My Game");
    expect(container.textContent).toContain("Local OpenClaw by default");
    expect(container.textContent).toContain("Robot mountain adventure");
    expect(container.textContent).toContain("Spooky forest coin quest");
    expect(container.textContent).toContain("Underwater rescue");
    expect(container.textContent).toContain("Play");
    expect(container.textContent).toContain("Click or drag");
    expect(container.textContent).toContain("Ask AI");
    expect(container.textContent).toContain("Expert Studio");
    expect(container.textContent).not.toContain("Toolchain Doctor");
    expect(container.textContent).not.toContain("Generic persisted runner");
    expect(container.textContent).not.toContain("Adapter receipts");
    expect(container.textContent).not.toContain("PVSnesLib");
    expect(container.textContent).not.toContain("Gateway production route not verified");
    expect(container.querySelector(".snes-mode-rail")).toBeNull();
    expect(container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio")?.open).toBe(false);

    openExpertStudio(container, host);
    expect(container.textContent).toContain("Page loaded without a Gateway client");
    expect(container.textContent).toContain("openclaw dashboard --no-open --path /snes-studio");
    expect(container.textContent).toContain("Run Live Production Check");
    expect(container.textContent).toContain("GPT 5.5-Directed Team Status");
    expect(container.textContent).toContain("Checking soon");
    expect(container.textContent).toContain("Stanski's World active target");
    expect(container.textContent).toContain("Level 1 only");
    expect(container.textContent).toContain("Level 1 definition of done");
    expect(container.textContent).toContain("Level 1 playable data");
    expect(container.textContent).toContain("Production state reconciled");
    expect(container.textContent).toContain("Level 1 browser playtest");
    expect(container.textContent).toContain("Level 1 ROM runtime");
    expect(container.textContent).toContain("Level 1 audio");
    expect(container.textContent).toContain(
      "Sound cannot be marked complete from a manifest alone",
    );
    expect(container.textContent).toContain("production-candidate-level runtime maturity");
    expect(container.textContent).toContain("2048 px scrolling Level 1");
    expect(container.textContent).toContain(
      "FXPAK export stays blocked until production-candidate-level proof is real",
    );
    expect(container.textContent).toContain("MacBook FXPAK handoff");
    expect(container.textContent).toContain("FXPAK/Games");
    expect(container.textContent).toContain("manual transfer package");
    expect(container.textContent).toContain("Level 1 visual review pack");
    expect(container.textContent).toContain("stanskis-world");
    expect(container.textContent).toContain("man-boy-snes-photo-reference");
    expect(container.textContent).toContain("Family Memory Card secret room");
    expect(container.textContent).toContain("Family Memory Card converted cameo");
    expect(container.textContent).toContain("not production-approved");
    expect(container.textContent).toContain("source image unavailable");
    expect(container.textContent).toContain("Full-game plan preserved");
    expect(container.textContent).toContain("Secret World 9");
    expect(container.textContent).toContain("Cleveland: Skyline Scramble");
    expect(container.textContent).toContain("100/100 human visual approval");
  });

  it("creates a playable side-scroller from one prompt and walks into Play & Change", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(
      container,
      'Make "Crystal Button Quest" with a robot hero, gentle enemies, gems, music, saves, three beginner levels, and Super Mario World graphics.',
    );
    createGame(container, host);

    expect(container.textContent).toContain("Crystal Button Quest");
    expect(container.textContent).toContain("Play & Change");
    expect(container.textContent).toContain("Click or drag anything on the game screen");
    expect(container.textContent).toContain("Make SNES Game File");
    expect(container.textContent).toContain("Expert Studio");
    openExpertStudio(container, host);
    expect(container.textContent).toContain("GPT 5.5 director plan ready");
    expect(container.textContent).toContain("OpenClaw Game Team filled");
    expect(container.textContent).toContain("Game quality gauntlet");
    expect(container.textContent).toContain("no GPT cost");
    expect(container.textContent).toContain("Improve Game Quality");
    expect(container.textContent).toContain("Local Proof Checklist");
    expect(container.textContent).toContain("Build Readiness");
    expect(container.textContent).toContain("ROM Runtime Proof");
    expect(container.textContent).toContain("Generic persisted runner");
    expect(container.textContent).toContain("Run Generic Milestone");
    expect(container.textContent).toContain("Local model benchmark report");
    expect(container.textContent).toContain("Load Latest Benchmark");
    expect(container.textContent).toContain("Local GLM-5.2 lane");
    expect(container.textContent).toContain("Check GLM-5.2");
    expect(container.textContent).toContain("Manual live proof steps");
    expect(container.textContent).toContain("Generated Object Audit");
    expect(container.textContent).toContain("Asset Pipeline");
    expect(container.textContent).toContain("Edit anything AI creates");
    expect(container.textContent).toContain("GPT 5.5 decision");
    expect(container.textContent).toContain("How The Team Is Working");
    expect(container.textContent).toContain("Producer Orchestrator");
    expect(container.textContent).toContain("100/100 Visual Board");
    expect(container.textContent).toContain("Prompt-to-asset workflow");
    expect(container.textContent).toContain("Production-approved art");
    expect(container.textContent).toContain("Imported/converted source art");
    expect(container.textContent).toContain("Spec-only placeholder art");
    expect(container.textContent).toContain("Source PNGs do not count");
    expect(container.textContent).toContain("Human grade");
    expect(container.textContent).toContain("source hash");
    expect(container.textContent).toContain("maturity");
    expect(container.textContent).toContain("review proof");
    expect(container.textContent).toContain("visual blocker");
    expect(container.textContent).toContain("Reject 3/100 Visuals");
    expect(container.textContent).toContain("Build Art Bible");
    expect(container.textContent).toContain("Create Source Pack");
    expect(container.textContent).toContain("Create Art Manifest");
    expect(container.textContent).toContain("Compile Art");
    expect(container.textContent).toContain("Capture Visual Proof");
    expect(container.textContent).toContain("Approve Visuals");
    expect(container.textContent).toContain("Max SNES graphics gap");
    expect(container.textContent).toContain("Stanski Level 1 visuals");
    expect(container.textContent).toContain("rejected: 3/100");
    expect(container.textContent).toContain("Pixelorama + Tiled + SuperFamiconv");
    expect(container.textContent).toContain("Current generated pixels are draft evidence");
    expect(container.textContent).toContain("Placeholder detection");
    expect(container.textContent).toContain("GPT 5.5 smart use");
    expect(container.textContent).toContain("Local OpenClaw/GLM workers");
    expect(container.textContent).toContain("Manifest memory");
    expect(container.textContent).toContain("Art Director gate");
    expect(container.textContent).toContain("Handoff receipts");
    expect(container.textContent).toContain("Review Art");
    expect(container.textContent).toContain("Ship Proof");
    expect(container.textContent).toContain("3 chapters");
    expect(container.textContent).toContain("Playable");

    clickButton(container, "Change");
    renderStudio(host, container);
    expect(container.textContent).toContain("Play & Change");
    expect(container.textContent).toContain("Things Shelf");

    clickButton(container, "Play & Change");
    renderStudio(host, container);
    expect(container.textContent).toContain("Click or drag anything on the game screen");
    expect(container.textContent).toContain("60 Hz runtime playtest");
    expect(container.textContent).toContain("ntsc 60hz");
    expect(container.textContent).toContain("Replay parity");
    expect(container.querySelector(".snes-emulator-canvas")).not.toBeNull();
    expect(container.querySelector("canvas.snes-runtime-canvas")).not.toBeNull();
    expect(container.querySelector(".snes-playtest__marker--hero")?.textContent).toContain("Hero");
    expect(container.querySelector(".snes-playtest__marker--enemy")?.textContent).toContain(
      "Enemy",
    );
    expect(container.querySelector(".snes-playtest__marker--item")?.textContent).toContain("Item");
    const askBar = container.querySelector(".snes-arcade-ask-bar");
    const playtest = container.querySelector(".snes-playtest");
    expect(askBar).not.toBeNull();
    expect(playtest).not.toBeNull();
    expect(askBar!.compareDocumentPosition(playtest!)).not.toBe(0);

    clickButton(container, "Run Right");
    renderStudio(host, container);
    expect(container.textContent).toContain("Hero moved right");
  });

  it("loads the latest real output benchmark report through Gateway on request", async () => {
    const request = vi.fn().mockResolvedValue({
      available: true,
      currentDefaultsByRole: { "snes-hardware-qa": "ollama/openclaw-control-qwen25-32b:latest" },
      downloadsAttempted: false,
      generatedAt: "2026-06-22T01:02:03.000Z",
      hostedGlmUsed: false,
      hostedProvidersUsed: false,
      modelSummaries: [
        {
          meanScore: 90,
          modelRef: "local-glm-5.2-2bit",
          role: "snes-hardware-qa",
          rounds: 3,
        },
      ],
      promotionApplied: false,
      recommendedWinnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
      rounds: 3,
      status: "partial",
      winnersByRole: { "snes-hardware-qa": "local-glm-5.2-2bit" },
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a benchmark-visible robot quest.");
    createGame(container, host);
    openExpertStudio(container, host);
    clickButton(container, "Load Latest Benchmark");
    await waitForText(container, host, "local-glm-5.2-2bit");

    expect(request).toHaveBeenCalledWith("snes.benchmark.latest", {}, { timeoutMs: 15_000 });
    expect(container.textContent).toContain("partial · 3 round(s)");
    expect(container.textContent).toContain("snes-hardware-qa: local-glm-5.2-2bit");
    const normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("hosted no");
    expect(normalized).toContain("downloads no");
  });

  it("loads local GLM-5.2 readiness through Gateway on request", async () => {
    const request = vi.fn().mockResolvedValue({
      agentProofReady: true,
      agentProofScore: 100,
      available: true,
      benchmarkRecommendsHardwareQa: true,
      blocker: null,
      hardwareQaPromoted: true,
      modelRef: "local-glm52/GLM-5.2-UD-IQ1_S-00001-of-00006.gguf",
      providerConfigured: true,
      providerId: "local-glm52",
      runtimeReady: true,
      runtimeStatus: "ready",
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a GLM-visible hardware QA robot quest.");
    createGame(container, host);
    openExpertStudio(container, host);
    clickButton(container, "Check GLM-5.2");
    await waitForText(container, host, "GLM-5.2 local lane is fully connected");

    expect(request).toHaveBeenCalledWith("snes.glm52.status", {}, { timeoutMs: 15_000 });
    const normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("provider registered");
    expect(normalized).toContain("hardware QA primary");
    expect(normalized).toContain("agent proof passed 100");
  });

  it("loads live Toolchain Doctor and runs the generic persisted production runner", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "snes.toolchain.status") {
        return {
          blockers: ["PVSnesLib is required for production SNES builds."],
          fxpakVolume: {
            detail: "No FXPAK/SD2SNES-style FAT32 volume is mounted.",
            status: "missing",
          },
          generatedAt: "2026-06-23T02:00:00.000Z",
          liveProbe: true,
          manifestPath: "/Users/openclaw/.openclaw/snes-toolchain/toolchain-manifest.json",
          receiptSummary: {
            conversion: { status: "pass" },
            emulator: { status: "pass" },
            rom: { status: "pass" },
          },
          status: "blocked",
          toolchainHome: "/Users/openclaw/.openclaw/snes-toolchain",
          tools: [
            {
              detail: "PVSnesLib was not detected.",
              id: "pvsneslib",
              installHint: "Install PVSnesLib.",
              label: "PVSnesLib",
              requiredForProduction: true,
              status: "missing",
            },
          ],
        };
      }
      if (method === "snes.production.status") {
        return {
          adapterPlan: {
            receipts: [{ adapter: "pixelorama", status: "blocked" }],
            status: "blocked",
          },
          completedCount: 0,
          currentMilestone: { id: "GEN01", name: "Project package" },
          emulatorPlan: { selectedEmulator: null, status: "blocked" },
          fxpakPlan: { destinationPath: "/Volumes/FXPAK/smoke.sfc", status: "ready" },
          gpt55Used: false,
          localGlmOnly: true,
          nextMilestone: { id: "GEN01", name: "Project package" },
          packet: { task: "Complete milestone GEN01 only.", gpt55Used: false },
          projectId: "smoke-quest",
          projectName: "Smoke Quest",
          romScaffold: {
            scaffoldRoot: ".artifacts/snes-projects/smoke-quest/rom",
            status: "blocked",
          },
          state: { currentMilestoneId: "GEN01" },
          status: "ready",
          totalCount: 6,
          workerMode: "deterministic-contract-proof",
        };
      }
      if (method === "snes.production.continue") {
        return {
          adapterPlan: {
            receipts: [{ adapter: "pixelorama", status: "blocked" }],
            status: "blocked",
          },
          completedCount: 1,
          currentMilestone: { id: "GEN02", name: "Asset registry" },
          emulatorPlan: { selectedEmulator: null, status: "blocked" },
          fxpakPlan: { destinationPath: "/Volumes/FXPAK/smoke.sfc", status: "ready" },
          gpt55Used: false,
          latestReceipt: { id: "GEN01", status: "pass", summary: "Project package passed." },
          localGlmOnly: true,
          nextMilestone: { id: "GEN02", name: "Asset registry" },
          packet: { task: "Complete milestone GEN02 only.", gpt55Used: false },
          projectId: "smoke-quest",
          projectName: "Smoke Quest",
          romScaffold: {
            scaffoldRoot: ".artifacts/snes-projects/smoke-quest/rom",
            status: "blocked",
          },
          state: { currentMilestoneId: "GEN02" },
          status: "pass",
          totalCount: 6,
          workerMode: "deterministic-contract-proof",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make Smoke Quest as a generic production runner test.");
    createGame(container, host);
    openExpertStudio(container, host);
    clickButton(container, "Check Toolchain Doctor");
    await waitForText(container, host, "Live read-only probe");
    clickButton(container, "Load Generic Production Status");
    await waitForText(container, host, "GEN01 Project package");
    clickButton(container, "Run Generic Milestone");
    await waitForText(container, host, "1/6 generic milestones complete");

    expect(request).toHaveBeenCalledWith("snes.toolchain.status", {}, { timeoutMs: 30_000 });
    expect(request).toHaveBeenCalledWith(
      "snes.production.status",
      expect.objectContaining({ projectName: "Smoke Quest As Generic Production" }),
      { timeoutMs: 30_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.production.continue",
      expect.objectContaining({
        maxMilestones: 1,
        projectName: "Smoke Quest As Generic Production",
      }),
      { timeoutMs: 120_000 },
    );
    const normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("Generic persisted runner");
    expect(normalized).toContain("Real toolchain receipts: conversion:pass");
    expect(normalized).toContain("worker deterministic-contract-proof");
    expect(normalized).toContain("routine GPT 5.5 off");
  });

  it("loads the generic SNES Mastery dashboard card through Gateway", async () => {
    const request = vi
      .fn()
      .mockImplementation(async (method: string, params?: { actionId?: string }) => {
        if (method === "snes.proof.run") {
          return {
            actionId: params?.actionId,
            blocker: null,
            blockers: [],
            generatedAt: "2026-06-26T01:03:03.000Z",
            hostedGlmUsed: false,
            localOnly: true,
            projectSpecific: false,
            removableMediaWritePerformed: false,
            status: "pass",
          };
        }
        if (method === "snes.project.createBlank") {
          return {
            packageHash: "abc123",
            packagePath: ".artifacts/snes-projects/blank-snes-platformer/project.json",
            projectId: "blank-snes-platformer",
            projectName: "Blank SNES Platformer",
            proofClaim: "project-package-created-only",
            status: "pass",
          };
        }
        if (method === "snes.mastery.status") {
          return {
            available: true,
            blocker: "One or more SNES Mastery milestones are blocked.",
            blockers: [
              {
                blockers: ["receipt status is blocked"],
                id: "G9",
                percentComplete: 0,
                title: "Kata 013: Emulator screenshot regression",
              },
            ],
            generatedAt: "2026-06-26T01:02:03.000Z",
            genericScope: { path: ".artifacts/generic-scope.json", status: "pass" },
            gpt55Used: false,
            hostedGlmUsed: false,
            kataSummary: { passed: 14, pendingOrBlocked: 1, percentComplete: 93.3, total: 15 },
            legalCorpus: { ok: true, path: ".artifacts/validation.json", status: "pass" },
            milestoneSummary: {
              blocked: 4,
              completionPercentByMilestoneCount: 76.5,
              pass: 13,
              total: 17,
            },
            nextIncomplete: {
              id: "G9",
              percentComplete: 0,
              status: "blocked",
              title: "Kata 013: Emulator screenshot regression",
            },
            projectSpecific: false,
            status: "blocked",
          };
        }
        throw new Error(`Unexpected method ${method}`);
      });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a mastery-visible robot quest.");
    createGame(container, host);
    openExpertStudio(container, host);
    clickButton(container, "Load SNES Mastery");
    await waitForText(container, host, "katas 14/15");

    expect(request).toHaveBeenCalledWith("snes.mastery.status", {}, { timeoutMs: 15_000 });
    let normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("SNES Mastery");
    expect(normalized).toContain("milestones 13/17");
    expect(normalized).toContain("generic scope pass");
    expect(normalized).toContain("Next incomplete: G9 Kata 013: Emulator screenshot regression");
    expect(normalized).toContain("Blocker: receipt status is blocked");
    expect(normalized).toContain("Run Emulator Proof");

    clickButton(container, "Run Budget Proof");
    await waitForText(container, host, "budget-enforcement · pass");
    expect(request).toHaveBeenCalledWith(
      "snes.proof.run",
      { actionId: "budget-enforcement" },
      { timeoutMs: 180_000 },
    );
    normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("browser, emulator, runtime, budget, FXPAK dry-run");

    clickButton(container, "Create Blank SNES Project");
    await waitForText(container, host, "blank-snes-platformer · pass");
    expect(request).toHaveBeenCalledWith(
      "snes.project.createBlank",
      { projectId: "blank-snes-platformer", projectName: "Blank SNES Platformer" },
      { timeoutMs: 30_000 },
    );
  });

  it("runs Visual Board actions through Gateway methods", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "snes.visual.reject") {
        return {
          artifacts: { receiptPath: ".artifacts/visual-rejection/receipt.json" },
          status: "rejected",
        };
      }
      if (method === "snes.visual.artBible") {
        return {
          artifacts: { receiptPath: ".artifacts/art-bible/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.visual.artSourcePack") {
        return {
          artifacts: { receiptPath: ".artifacts/art-source-pack/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.visual.artManifest") {
        return {
          artifacts: { receiptPath: ".artifacts/art-manifest/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.visual.compileArt") {
        return {
          artifacts: { receiptPath: ".artifacts/art-compile/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.visual.captureProof") {
        return {
          artifacts: { receiptPath: ".artifacts/visual-proof/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.visual.runtimeAssetTruth") {
        return {
          artifacts: { receiptPath: ".artifacts/runtime-asset-truth/receipt.json" },
          status: "blocked",
        };
      }
      if (method === "snes.visual.qualityAudit") {
        return {
          artifacts: { receiptPath: ".artifacts/visual-quality-audit/receipt.json" },
          status: "blocked",
        };
      }
      if (method === "snes.visual.approve") {
        return {
          artifacts: { receiptPath: ".artifacts/visual-approval/receipt.json" },
          status: "pass",
        };
      }
      if (method === "snes.production.status") {
        return {
          completedCount: 0,
          gpt55Used: false,
          localGlmOnly: true,
          projectId: "visual-quest",
          projectName: "Visual Quest",
          status: "ready",
          totalCount: 6,
          workerMode: "deterministic-contract-proof",
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make Visual Quest with production visual proof.");
    createGame(container, host);
    openExpertStudio(container, host);

    clickButton(container, "Reject 3/100 Visuals");
    await waitForText(container, host, "reject: rejected");
    clickButton(container, "Build Art Bible");
    await waitForText(container, host, "artBible: pass");
    clickButton(container, "Create Source Pack");
    await waitForText(container, host, "artSourcePack: pass");
    clickButton(container, "Create Art Manifest");
    await waitForText(container, host, "artManifest: pass");
    clickButton(container, "Compile Art");
    await waitForText(container, host, "compileArt: pass");
    clickButton(container, "Capture Visual Proof");
    await waitForText(container, host, "captureProof: pass");
    clickButton(container, "Prove Runtime Assets");
    await waitForText(container, host, "runtimeAssetTruth: blocked");
    clickButton(container, "Audit Visual Quality");
    await waitForText(container, host, "qualityAudit: blocked");

    expect(request).toHaveBeenCalledWith(
      "snes.visual.reject",
      expect.objectContaining({ humanScore: 3, projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.artBible",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.artSourcePack",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.artManifest",
      expect.objectContaining({
        assetId: "hero",
        projectId: "stanskis-world",
      }),
      { timeoutMs: 120_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.compileArt",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.captureProof",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.runtimeAssetTruth",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.visual.qualityAudit",
      expect.objectContaining({ projectId: "stanskis-world" }),
      { timeoutMs: 180_000 },
    );
  });

  it("loads and advances the Stanski durable production loop through Gateway", async () => {
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "snes.stanski.production.status") {
        return {
          completedCount: 0,
          nextMilestone: { id: "G01", name: "Production art bible" },
          rendererImpact: {
            appliedCount: 0,
            assetPackCount: 0,
            failures: [],
            status: "pass",
          },
          state: {
            currentHumanVisualGrade: 24,
            gpt55UsagePolicy: { defaultReasoning: "low", useGpt55ForRoutineMilestone: false },
            targetHumanVisualGrade: 100,
          },
          status: "ready",
          totalCount: 40,
        };
      }
      if (method === "snes.stanski.production.continue") {
        return {
          completedCount: 1,
          nextMilestone: { id: "G02", name: "Visual QA gate" },
          rendererImpact: {
            appliedCount: 1,
            assetPackCount: 0,
            failures: [],
            status: "pass",
          },
          results: [{ milestoneId: "G01", status: "pass" }],
          state: {
            currentHumanVisualGrade: 24,
            gpt55UsagePolicy: { defaultReasoning: "low", useGpt55ForRoutineMilestone: false },
            targetHumanVisualGrade: 100,
          },
          status: "pass",
          totalCount: 40,
        };
      }
      if (method === "snes.stanski.production.auto") {
        return {
          completedCount: 2,
          nextMilestone: { id: "G03", name: "Todd sprite sheet" },
          rendererImpact: {
            appliedCount: 2,
            assetPackCount: 1,
            failures: [],
            status: "pass",
          },
          results: [{ milestoneId: "G02", status: "pass" }],
          state: {
            currentHumanVisualGrade: 24,
            gpt55UsagePolicy: { defaultReasoning: "low", useGpt55ForRoutineMilestone: false },
            targetHumanVisualGrade: 100,
          },
          status: "ready",
          totalCount: 40,
        };
      }
      if (
        method === "snes.stanski.production.pause" ||
        method === "snes.stanski.production.resume" ||
        method === "snes.stanski.production.cancel" ||
        method === "snes.stanski.production.splitNext"
      ) {
        return {
          completedCount: 1,
          nextMilestone: { id: "G07a", name: "Sidewalk road tiles" },
          rendererImpact: {
            appliedCount: 1,
            assetPackCount: 1,
            failures: [],
            status: "pass",
          },
          state: {
            currentHumanVisualGrade: 24,
            gpt55UsagePolicy: { defaultReasoning: "low", useGpt55ForRoutineMilestone: false },
            targetHumanVisualGrade: 100,
          },
          status: "ready",
          totalCount: 44,
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a Stanski production loop visible quest.");
    createGame(container, host);
    openExpertStudio(container, host);

    expect(container.textContent).toContain("Stanski production loop");
    expect(container.textContent).toContain("Run One Milestone");
    expect(container.textContent).toContain("Start Bounded Auto");
    expect(container.textContent).toContain("Split Next");
    expect(container.textContent).toContain("Pause");
    expect(container.textContent).toContain("Resume");
    clickButton(container, "Load Production Status");
    await waitForText(container, host, "G01 Production art bible");
    clickButton(container, "Run One Milestone");
    await waitForText(container, host, "1/40 milestones complete");
    clickButton(container, "Start Bounded Auto");
    await waitForText(container, host, "2/40 milestones complete");

    expect(request).toHaveBeenCalledWith(
      "snes.stanski.production.status",
      {},
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.stanski.production.continue",
      { maxMilestones: 1 },
      { timeoutMs: 900_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "snes.stanski.production.auto",
      { maxMilestones: 40, maxRuntimeMinutes: 30, until: "blocked" },
      { timeoutMs: 1_860_000 },
    );
    const normalized = container.textContent?.replace(/\s+/g, " ") ?? "";
    expect(normalized).toContain("2/40 milestones complete");
    expect(normalized).toContain("Last milestone G02: pass");
    expect(normalized).toContain("routine GPT 5.5 off");
    expect(normalized).toContain("Renderer impact: pass");
  });

  it("routes Ask Live OpenClaw through the connected Gateway and shows a review", async () => {
    const request = vi.fn().mockResolvedValue({
      response: JSON.stringify({
        summary: "Live OpenClaw preview",
        rationale: ["Renamed the game from the live agent preview."],
        operations: [{ op: "replace", path: "/name", value: "Live Agent Quest" }],
      }),
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a live agent robot quest.");
    createGame(container, host);
    openExpertStudio(container, host);
    clickButton(container, "Ask Live OpenClaw");
    await flushAsyncUi(container, host);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("agent");
    expect(container.textContent).toContain("Live agent preview ready");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Live OpenClaw preview");
    expect(buttonByText(container, "Apply Change")).not.toBeUndefined();
  });

  it("routes the staged GPT 5.5/OpenClaw production check through Gateway", async () => {
    let runIndex = 0;
    let createIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        const ids = [
          "snes-game-director",
          "snes-level-designer",
          "snes-gameplay-designer",
          "snes-art-audio",
          "snes-hardware-qa",
        ];
        return { ok: true, agentId: ids[createIndex++] };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      if (method === "agent") {
        runIndex += 1;
        return { runId: `snes-live-run-${runIndex}`, status: "accepted" };
      }
      if (method === "agent.waitFinal") {
        return {
          status: "ok",
          waitStatus: "ok",
          source: "history",
          historyAttempts: 1,
          finalText: JSON.stringify({
            summary: "Live production stage patch",
            rationale: ["Verified one staged Gateway production lane."],
            operations: [{ op: "replace", path: "/name", value: "Live Production Quest" }],
          }),
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a GPT 5.5-directed OpenClaw robot quest.");
    openExpertStudio(container, host);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Live production route verified");

    const createCalls = request.mock.calls.filter(([method]) => method === "agents.create");
    expect(createCalls).toHaveLength(5);
    expect((createCalls[0]?.[1] as { name?: string })?.name).toBe("snes-game-director");
    const agentCalls = request.mock.calls.filter(([method]) => method === "agent");
    expect(agentCalls).toHaveLength(3);
    expect(request.mock.calls.filter(([method]) => method === "agent.waitFinal")).toHaveLength(3);
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    const messages = agentCalls.map(([, params]) => {
      const requestParams = params as { message?: string };
      return requestParams.message ?? "";
    });
    expect(messages[0]).toContain("GPT 5.5 Game Director planning stage.");
    expect(messages[1]).toContain("OpenClaw Game Team production stage.");
    expect(messages[2]).toContain("GPT 5.5 Quality Gate stage.");
    expect(container.textContent).toContain("Dashboard Gateway ready");
    expect(container.textContent).toContain("Automated E2E");
    expect(container.textContent).toContain("OpenClaw Game Director");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Live production stage patch");
  });

  it("falls back to unfiltered history when Codex harness replies lack target run metadata", async () => {
    let runIndex = 0;
    let createIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string, params?: unknown) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        const ids = [
          "snes-game-director",
          "snes-level-designer",
          "snes-gameplay-designer",
          "snes-art-audio",
          "snes-hardware-qa",
        ];
        return { ok: true, agentId: ids[createIndex++] };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      if (method === "agent") {
        runIndex += 1;
        return { runId: `snes-live-run-${runIndex}`, status: "accepted" };
      }
      if (method === "agent.wait") {
        return { status: "ok" };
      }
      if (method === "chat.history") {
        const historyParams = params as { targetRunId?: string };
        if (historyParams.targetRunId) {
          return { messages: [] };
        }
        return {
          result: {
            messages: [
              {
                message: {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        summary: "Codex harness patch without run metadata",
                        rationale: ["Verified unfiltered history fallback."],
                        operations: [
                          { op: "replace", path: "/name", value: "Codex Harness Quest" },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a GPT 5.5-directed OpenClaw robot quest.");
    openExpertStudio(container, host);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Live production route verified");

    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(3);
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(3);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(9);
    const historyCalls = request.mock.calls.filter(([method]) => method === "chat.history");
    expect(
      historyCalls.some(([, historyParams]) => {
        return typeof (historyParams as { auditTs?: unknown }).auditTs === "number";
      }),
    ).toBe(true);
    expect(
      historyCalls.some(([, historyParams]) => {
        return !(historyParams as { targetRunId?: string }).targetRunId;
      }),
    ).toBe(true);
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Codex harness patch without run metadata");
  });

  it("automatically checks the GPT 5.5-directed OpenClaw role team without model jobs", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    let createIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        const ids = [
          "snes-game-director",
          "snes-level-designer",
          "snes-gameplay-designer",
          "snes-art-audio",
          "snes-hardware-qa",
        ];
        return { ok: true, agentId: ids[createIndex++] };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    openExpertStudio(container, host);
    await waitForText(container, host, "Live proof pending");

    expect(request).toHaveBeenCalledTimes(7);
    const createCalls = request.mock.calls.filter(([method]) => method === "agents.create");
    expect(createCalls).toHaveLength(5);
    expect((createCalls[0]?.[1] as { name?: string })?.name).toBe("snes-game-director");
    expect(
      request.mock.calls.filter(([method]) => method === "agents.runtime.status"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(0);
    expect(container.textContent).toContain("GPT 5.5 Director");
    expect(container.textContent).toContain("OpenClaw Level Designer");
    expect(container.textContent).toContain("GPT 5.5 Quality Gate");
    expect(container.textContent).toContain("Proof pending");
    expect(container.textContent).toContain("Check Again");
  });

  it("blocks stuck live production proof instead of leaving the dashboard spinning", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    let runIndex = 0;
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return {
          agents: [
            { id: "main" },
            { id: "snes-game-director" },
            { id: "snes-level-designer" },
            { id: "snes-gameplay-designer" },
            { id: "snes-art-audio" },
            { id: "snes-hardware-qa" },
          ],
        };
      }
      if (method === "agents.runtime.status") {
        return { localModels: { available: true, installedAvailable: true } };
      }
      if (method === "agent") {
        runIndex += 1;
        return { runId: `snes-team-run-${runIndex}`, status: "accepted" };
      }
      if (method === "agent.wait") {
        return { status: "pending" };
      }
      if (method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    openExpertStudio(container, host);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Live OpenClaw unavailable");

    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "agent.wait")).toHaveLength(2);
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(6);
    expect(container.textContent).toContain("Run Live Production Check");
    expect(container.textContent).toContain(
      "Codex Architect blueprint (codex-architect) timed out during live proof",
    );
    expect(container.textContent).toContain("codex-architect");
    expect(container.textContent).toContain(
      "Not checked because an earlier live production stage failed.",
    );
  });

  it("reports OpenClaw worker setup blockers without sending live role jobs", async () => {
    window.history.replaceState(null, "", window.location.pathname || "/");
    const request = vi.fn().mockImplementation(async (method: string) => {
      if (method === "agents.list") {
        return { agents: [{ id: "main" }] };
      }
      if (method === "agents.create") {
        throw new Error("agent management disabled");
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const host = { client: { request }, connected: true, requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    openExpertStudio(container, host);
    await waitForText(container, host, "Live OpenClaw unavailable");

    expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "agents.create")).toHaveLength(5);
    expect(request.mock.calls.filter(([method]) => method === "agent")).toHaveLength(0);
    expect(container.textContent).toContain("Needs setup");
    expect(container.textContent).toContain("SNES Studio can create this worker automatically");
  });

  it("clearly blocks live production when the Gateway route is unavailable", async () => {
    const host = {
      requestUpdate: vi.fn(),
      client: { request: vi.fn() },
      connected: false,
      lastError: "401 Unauthorized",
      lastErrorCode: "UNAUTHORIZED",
    };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    openExpertStudio(container, host);
    clickButton(container, "Run Live Production Check");
    await waitForText(container, host, "Needs Dashboard login");

    expect(container.textContent).toContain("Needs Dashboard login");
    expect(container.textContent).toContain("Connection Doctor");
    expect(container.textContent).toContain("Dashboard auth missing or expired");
    expect(container.textContent).toContain("Gateway connected: no");
    expect(container.textContent).toContain("Authenticated: no");
    expect(container.textContent).toContain("Dashboard Gateway WebSocket is not connected");
    expect(container.textContent).toContain("401 Unauthorized");
    expect(container.textContent).toContain("hardware equipment is not required");
    expect(container.textContent).toContain("OPENCLAW_SNES_STUDIO_LIVE_AGENT_E2E");
  });

  it("runs local OpenClaw/Codex proof when Gateway live agent setup is unavailable", async () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a local proof robot quest.");
    createGame(container, host);
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);
    clickButton(container, "Export");
    renderStudio(host, container);

    clickButton(container, "Run Local Agent Proof");
    await waitForText(container, host, "Local agent proof passed");

    expect(container.textContent).toContain("Local agent proof passed");
    expect(container.textContent).toContain("Review Before Apply");
    expect(container.textContent).toContain("Local AI path verified");
    expect(container.textContent).toContain("Gateway live proof still needs a connected session");
    expect(buttonByText(container, "Apply Change")).not.toBeUndefined();
  });

  it("fills missing pieces after AI makes the first draft", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a sky platformer with floating platforms and coins.");
    createGame(container, host);
    clickButton(container, "Fill Gaps");
    renderStudio(host, container);

    expect(container.textContent).toContain("Story game gaps filled");
    expect(container.textContent).toContain("3 chapters");
    expect(container.textContent).toContain("3 chapters");
  });

  it("creates custom prompted things and makes them editable in playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    const initialEnemies = container.querySelectorAll(".snes-playtest__marker--enemy").length;
    const enemyPiece = [
      ...container.querySelectorAll<HTMLButtonElement>(".snes-guided-shelf__thing"),
    ].find((button) => button.textContent?.includes("Enemy"));
    expect(enemyPiece).not.toBeUndefined();
    enemyPiece!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderStudio(host, container);

    expect(container.querySelectorAll(".snes-playtest__marker--enemy").length).toBeGreaterThan(
      initialEnemies,
    );
    expect(container.textContent).toContain("Things Shelf");
  });

  it("starts and pauses a continuous live playtest loop", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    clickButton(container, "Start Test");
    renderStudio(host, container);

    expect(container.textContent).toContain("Live play started");
    expect(container.textContent).toContain("60 Hz");
    expect(container.textContent).toContain("Live play running");
    expect(container.querySelector(".snes-playtest__stage--running")).not.toBeNull();

    clickButton(container, "Pause");
    renderStudio(host, container);
    expect(container.textContent).toContain("Playtest paused");
  });

  it("selects a visible hero and applies a scoped prompt only to that thing", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    container
      .querySelector<HTMLButtonElement>(".snes-playtest__marker--hero")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderStudio(host, container);
    typeSelectedThingPrompt(container, "Make the hero jump higher and move faster.");
    clickButton(container, "Change With OpenClaw");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected thing changed");
    expect(container.textContent).toContain("GPT 5.5-Directed Team changed only Player Start");
    expect(container.textContent).toContain("Run speed");
    expect(container.textContent).toContain("Jump height");
  });

  it("changes only the selected thing visual recipe with the classic style prompt", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    typeGamePrompt(container, "Make a side-scrolling platformer with Super Mario World graphics.");
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);
    container
      .querySelector<HTMLButtonElement>(".snes-playtest__marker--enemy")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderStudio(host, container);

    expect(container.textContent).toContain("Look");
    expect(container.textContent).toContain("round colorful");
    typeSelectedThingPrompt(
      container,
      "Make this enemy rounder and colorful with a classic SNES platformer look.",
    );
    clickButton(container, "Change With OpenClaw");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected thing changed");
    expect(container.textContent).toContain("round colorful patrol enemy");
    expect(container.textContent).toContain("Look");

    clickButton(container, "Change Look With OpenClaw");
    renderStudio(host, container);
    expect(container.textContent).toContain("round colorful patrol enemy");
  });

  it("moves a game thing by direct pointer drag inside the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const hero = container.querySelector<HTMLButtonElement>(".snes-playtest__marker--hero");
    expect(hero).not.toBeNull();
    hero!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 48, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 240, clientY: 180 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 240, clientY: 180 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("Player Start moved");
    expect(container.textContent).toContain("direct drag move is now in the 60 Hz playtest");
    const selectedPanel = container.querySelector<HTMLElement>(".snes-ai-selected-panel");
    expect(selectedPanel?.textContent).toContain("Hero");
    const positionInputs = [
      ...selectedPanel!.querySelectorAll<HTMLInputElement>('input[type="number"]'),
    ];
    expect(Number(positionInputs[0]?.value)).toBeGreaterThan(120);
    expect(Number(positionInputs[1]?.value)).toBeGreaterThan(140);
  });

  it("selects a terrain chunk from a simple click in the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.querySelector(".snes-emulator-selection")).not.toBeNull();
    expect(container.textContent).toContain("Ground selected");
    expect(container.textContent).toContain("Change ground");
    expect(container.textContent).toContain("Selected 16 by 3 level squares");

    const tileClass = (index: number) =>
      container.querySelectorAll<HTMLElement>(".snes-playtest__tile")[index]?.className ?? "";
    expect(tileClass(8 * 16)).not.toContain("snes-playtest__tile--ground");
    typeArcadeAreaPrompt(container, "Move this ground up.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("ground moved");
    expect(tileClass(8 * 16)).toContain("snes-playtest__tile--ground");
    expect(tileClass(11 * 16)).not.toContain("snes-playtest__tile--ground");

    const moveHandle = container.querySelector<HTMLElement>(".snes-emulator-selection span");
    expect(moveHandle).not.toBeNull();
    moveHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 220 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("ground moved");
    expect(tileClass(8 * 16)).not.toContain("snes-playtest__tile--ground");
    expect(tileClass(11 * 16)).toContain("snes-playtest__tile--ground");

    typeArcadeAreaPrompt(container, "Make this ground shorter.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("ground resized");
    expect(tileClass(9 * 16 + 13)).toContain("snes-playtest__tile--ground");
    expect(tileClass(9 * 16 + 15)).not.toContain("snes-playtest__tile--ground");

    const resizeTerrainHandle = container.querySelector<HTMLButtonElement>(
      ".snes-emulator-selection__resize",
    );
    expect(resizeTerrainHandle).not.toBeNull();
    resizeTerrainHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 350, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 395, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 395, clientY: 245 }),
    );
    renderStudio(host, container);

    expect(container.textContent).toContain("ground resized");
    expect(tileClass(9 * 16 + 15)).toContain("snes-playtest__tile--ground");
  });

  it("lets the user select an emulator area and prompt a local change", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 80, clientY: 120 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 180 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 180, clientY: 180 }),
    );
    renderStudio(host, container);

    expect(container.querySelector(".snes-emulator-selection")).not.toBeNull();
    expect(container.textContent).toContain("Change Selected emulator area");
    expect(container.textContent).toContain("Selected 4 by 3 level squares");
    expect(container.textContent).toContain("Try asking");
    expect(container.textContent).toContain("Make this jump easier.");
    expect(container.textContent).toContain("Add a hidden key here.");
    expect(container.textContent).toContain("Fast changes");
    expect(container.textContent).toContain("Add Coins");
    expect(container.textContent).toContain("Add Key");
    expect(container.textContent).toContain("Make Easier");
    expect(container.textContent).toContain("Make Gap");
    expect(container.textContent).toContain("Remove Things");
    clickButton(container, "Add a hidden key here.");
    renderStudio(host, container);
    expect(
      container.querySelector<HTMLTextAreaElement>(".snes-arcade-ask-bar textarea")?.value,
    ).toBe("Add a hidden key here.");
    const selectedAreaMoveHandle = container.querySelector<HTMLElement>(
      ".snes-emulator-selection span",
    );
    expect(selectedAreaMoveHandle).not.toBeNull();
    selectedAreaMoveHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100, clientY: 140 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 220, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 160 }),
    );
    renderStudio(host, container);
    expect(container.textContent).toContain("Area moved");
    const resizeHandle = container.querySelector<HTMLButtonElement>(
      ".snes-emulator-selection__resize",
    );
    expect(resizeHandle).not.toBeNull();
    resizeHandle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 160 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 300, clientY: 220 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 300, clientY: 220 }),
    );
    renderStudio(host, container);
    expect(container.textContent).toContain("Area resized");
    typeArcadeAreaPrompt(container, "Add a coin trail here.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Coin Trail");
    expect(container.textContent).toContain(
      "This selected-area change is now in the 60 Hz playtest.",
    );
    const itemCountAfterAdd = container.querySelectorAll(".snes-playtest__marker--item").length;
    expect(itemCountAfterAdd).toBeGreaterThan(1);
    typeArcadeAreaPrompt(container, "Add a secret key here.");
    clickButton(container, "Preview Area Change");
    renderStudio(host, container);
    expect(container.textContent).toContain("Preview before apply");
    expect(container.textContent).toContain("Key preview");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(
      itemCountAfterAdd,
    );
    clickButton(container, "Cancel Preview");
    renderStudio(host, container);
    expect(container.textContent).not.toContain("Key preview");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(
      itemCountAfterAdd,
    );
    typeArcadeAreaPrompt(container, "Add a secret key here.");
    clickButton(container, "Preview Area Change");
    renderStudio(host, container);
    clickButton(container, "Apply Preview");
    renderStudio(host, container);
    expect(container.textContent).toContain("Key added");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBeGreaterThan(
      itemCountAfterAdd,
    );
    clickButton(container, "Remove Things");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected things removed");
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBeLessThan(
      itemCountAfterAdd,
    );
  });

  it("uses natural selected-area prompts to remove only matching things and change terrain", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    const stage = container.querySelector<HTMLElement>(".snes-emulator-canvas");
    expect(stage).not.toBeNull();
    stage!.getBoundingClientRect = () =>
      ({
        bottom: 300,
        height: 300,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 190 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, clientX: 380, clientY: 285 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 380, clientY: 285 }),
    );
    renderStudio(host, container);

    const enemyCountBefore = container.querySelectorAll(".snes-playtest__marker--enemy").length;
    const itemCountBefore = container.querySelectorAll(".snes-playtest__marker--item").length;
    typeArcadeAreaPrompt(container, "Remove enemies in this area.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Selected things removed");
    expect(container.querySelectorAll(".snes-playtest__marker--enemy").length).toBeLessThan(
      enemyCountBefore,
    );
    expect(container.querySelectorAll(".snes-playtest__marker--item").length).toBe(itemCountBefore);

    stage!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 220, clientY: 245 }),
    );
    stage!.dispatchEvent(
      new MouseEvent("pointerup", { bubbles: true, clientX: 220, clientY: 245 }),
    );
    renderStudio(host, container);

    const groundCountBefore = container.querySelectorAll(".snes-playtest__tile--ground").length;
    typeArcadeAreaPrompt(container, "Make this an empty gap.");
    clickButton(container, "Change Selected Area");
    renderStudio(host, container);

    expect(container.textContent).toContain("Gap made");
    expect(container.querySelectorAll(".snes-playtest__tile--ground").length).toBeLessThan(
      groundCountBefore,
    );
  });

  it("adds shelf pieces by click and reflects them in the playtest", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Change");
    renderStudio(host, container);
    const initialEnemies = container.querySelectorAll(".snes-playtest__marker--enemy").length;
    const enemyPiece = [
      ...container.querySelectorAll<HTMLButtonElement>(".snes-guided-shelf__thing"),
    ].find((button) => button.textContent?.includes("Enemy"));
    expect(enemyPiece).not.toBeUndefined();
    enemyPiece!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    clickButton(container, "Play & Change");
    renderStudio(host, container);

    expect(container.querySelectorAll(".snes-playtest__marker--enemy").length).toBeGreaterThan(
      initialEnemies,
    );
    expect(container.textContent).toContain("Things Shelf");
  });

  it("keeps expert SNES controls behind Advanced Studio disclosure", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    expect(container.querySelector(".snes-mode-rail")).toBeNull();
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);

    expect(container.querySelector(".snes-mode-rail")).not.toBeNull();
    expect(container.textContent).toContain("Expert Studio");
    expect(container.textContent).toContain("advanced SNES tools");
    expect(container.textContent).toContain("Project Safety");
    expect(container.textContent).toContain("Advanced AI stage");
  });

  it("shows an emulator run script plan when an emulator is selected", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    const expert = container.querySelector<HTMLDetailsElement>(".snes-ai-expert-studio");
    expect(expert).not.toBeNull();
    expert!.open = true;
    expert!.dispatchEvent(new Event("toggle", { bubbles: true }));
    renderStudio(host, container);
    clickButton(container, "Export");
    renderStudio(host, container);

    const emulatorInput = container.querySelector<HTMLInputElement>(
      ".snes-ship-proof input[placeholder='ares, bsnes, mesen, snes9x']",
    );
    expect(emulatorInput).not.toBeNull();
    emulatorInput!.value = "snes9x";
    emulatorInput!.dispatchEvent(new Event("input", { bubbles: true }));
    renderStudio(host, container);

    expect(container.textContent).toContain("Ready to run local emulator proof");
    expect(container.textContent).toContain("Download Emulator Run Script");
    expect(container.textContent).toContain("snes9x -snapshot");
  });

  it("keeps beginner export plain while preserving help for technical meaning", () => {
    const host = { requestUpdate: vi.fn() };
    const container = document.createElement("div");
    document.body.append(container);

    renderStudio(host, container);
    createGame(container, host);
    clickButton(container, "Ship");
    renderStudio(host, container);

    expect(container.textContent).toContain("Make SNES Game File");
    expect(container.querySelector(".snes-ai-export-card .snes-help-term")).not.toBeNull();
    expect(container.textContent).toContain("Ready to create a preview file");
  });
});
