import { describe, expect, it } from "vitest";
import {
  AGENT_MASTER_PLAN,
  SHARED_SERVICE_AGENT_IDS,
  findUnmappedRoomAgents,
  isControlDirectorModelOk,
  isControlDirectorPrimaryModel,
  resolveControlDirectorThinkingPolicy,
  type RoomAgent,
} from "./agents-room.ts";

describe("agent room shared-service registry", () => {
  it("defines every shared-service role with concrete ownership metadata", () => {
    for (const agentId of SHARED_SERVICE_AGENT_IDS) {
      const metadata = AGENT_MASTER_PLAN[agentId];
      expect(metadata, agentId).toBeDefined();
      expect(metadata.roomId, agentId).toBe("core");
      expect(metadata.role.trim(), agentId).not.toBe("");
      expect(metadata.purpose.trim(), agentId).not.toBe("");
      expect(metadata.summonCriteria.trim(), agentId).not.toBe("");
      expect(metadata.owns.length, agentId).toBeGreaterThan(0);
    }
  });

  it("keeps memory and knowledge curation separate from adjacent roles", () => {
    const metadata = AGENT_MASTER_PLAN["memory-knowledge-curator"];

    expect(metadata.role).toBe("Memory and knowledge curator");
    expect(metadata.owns).toContain("knowledge provenance");
    expect(metadata.doesNotOwn).toEqual(
      expect.arrayContaining(["credential handling", "market conclusions"]),
    );
  });

  it("shows Codex as an explicit on-demand coding specialist", () => {
    const metadata = AGENT_MASTER_PLAN.codex;

    expect(metadata.displayName).toBe("Codex Coding Specialist");
    expect(metadata.activation).toBe("on-demand");
    expect(metadata.activationLabel).toBe("On-demand only");
    expect(metadata.summonCriteria).toContain("explicit Codex trigger");
    expect(metadata.doesNotOwn).toEqual(expect.arrayContaining(["silent background edits"]));
  });

  it("accepts the Qwen3.6 Control Director primary and Qwen2.5 rollback aliases", () => {
    expect(isControlDirectorModelOk("ollama/openclaw-control-qwen36-27b:latest")).toBe(true);
    expect(isControlDirectorModelOk("ollama/qwen3.6:27b-q8_0")).toBe(true);
    expect(isControlDirectorModelOk("ollama/openclaw-control-qwen25-32b:latest")).toBe(true);
    expect(isControlDirectorModelOk("ollama/qwen3.5:27b-q8_0")).toBe(false);
    expect(isControlDirectorPrimaryModel("ollama/openclaw-control-qwen36-27b:latest")).toBe(true);
    expect(isControlDirectorPrimaryModel("ollama/qwen3.6:27b-q8_0")).toBe(true);
    expect(isControlDirectorPrimaryModel("ollama/openclaw-control-qwen25-32b:latest")).toBe(
      false,
    );
  });

  it("describes the Control Director thinking-as-needed dashboard policy", () => {
    expect(
      resolveControlDirectorThinkingPolicy(
        { id: "main", name: "Control Director" } as never,
        { thinkingDefault: "off", thinkingLevel: "medium" } as never,
      ),
    ).toEqual({
      label: "Thinking as needed",
      current: "Session override: medium",
      detail: expect.stringContaining("Default off for routine turns"),
    });
    expect(
      resolveControlDirectorThinkingPolicy({ id: "builder", name: "Builder" } as never),
    ).toBeNull();
  });

  it("reports only General Workspace agents as unmapped", () => {
    const roomAgents = [
      {
        label: "Control Director",
        projectRoom: { id: "core", label: "Shared Command", subtitle: "", tone: "core" },
      },
      {
        label: "New Specialist",
        projectRoom: {
          id: "general",
          label: "General Workspace",
          subtitle: "",
          tone: "general",
        },
      },
    ] as RoomAgent[];

    expect(findUnmappedRoomAgents(roomAgents).map((entry) => entry.label)).toEqual([
      "New Specialist",
    ]);
  });
});
