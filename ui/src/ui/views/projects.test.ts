import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderProjects, type ProjectsProps } from "./projects.ts";

function createProps(overrides: Partial<ProjectsProps> = {}): ProjectsProps {
  const project = {
    id: "research-desk",
    name: "Research Desk",
    description: "Market research workspace",
    instructions: "Use primary sources.",
    memoryMode: "project_only" as const,
    createdAt: 1,
    updatedAt: 2,
    resources: [
      {
        id: "resource-1",
        projectId: "research-desk",
        name: "Master Plan.md",
        kind: "file" as const,
        sourceType: "local_file" as const,
        extension: ".md",
        sha256: "abc",
        status: "ready" as const,
        textPreview: "A concise master plan.",
        tokenEstimate: 20,
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: "resource-2",
        projectId: "research-desk",
        name: "Archive.pdf",
        kind: "file" as const,
        sourceType: "uploaded_file" as const,
        extension: ".pdf",
        sha256: "def",
        status: "unsupported" as const,
        error: "unsupported resource type: .pdf",
        tokenEstimate: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
  return {
    loading: false,
    saving: false,
    error: null,
    list: { ok: true, ts: 2, count: 1, projects: [project] },
    selectedId: project.id,
    detail: { ok: true, project },
    contextPreview: {
      project,
      blocks: [
        {
          kind: "instructions" as const,
          title: "Project instructions",
          text: "Use primary sources.",
          tokenEstimate: 5,
        },
      ],
      resourcesIncluded: [],
      totalTokenEstimate: 5,
      truncated: false,
    },
    sessions: {
      ts: 2,
      path: "/tmp/sessions.json",
      count: 1,
      totalCount: 1,
      hasMore: false,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "agent:main:dashboard:one",
          kind: "direct",
          updatedAt: 2,
          projectId: project.id,
          derivedTitle: "Summarize launch plan",
          model: "qwen25-32b",
        },
      ],
    },
    currentSessionKey: "agent:main:main",
    createName: "",
    createDescription: "",
    createInstructions: "",
    resourcePath: "",
    resourceName: "",
    resourceNote: "",
    searchQuery: "",
    instructionsDraft: "Use primary sources.",
    onRefresh: vi.fn(),
    onSelect: vi.fn(),
    onCreateFieldChange: vi.fn(),
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onInstructionsDraftChange: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onResourceFieldChange: vi.fn(),
    onSearchChange: vi.fn(),
    onAddResourcePath: vi.fn(),
    onAddResourceNote: vi.fn(),
    onUploadResourceFiles: vi.fn(),
    onRemoveResource: vi.fn(),
    onReindexResource: vi.fn(),
    onAttachCurrentSession: vi.fn(),
    onNewProjectChat: vi.fn(),
    onOpenSession: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  render("", document.body);
});

describe("renderProjects", () => {
  it("renders project resources, chats, and context preview", () => {
    const container = document.createElement("div");
    render(renderProjects(createProps()), container);

    const text = container.textContent ?? "";
    expect(text).toContain("Research Desk");
    expect(text).toContain("Needs attention");
    expect(text).toContain("Master Plan.md");
    expect(text).toContain("Unsupported");
    expect(text).toContain("Summarize launch plan");
    expect(text).toContain("Context Used Next");
    expect(text).toContain("5 tokens");
  });

  it("starts a new project chat from one button", () => {
    const onNewProjectChat = vi.fn();
    const container = document.createElement("div");
    render(renderProjects(createProps({ onNewProjectChat })), container);

    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Start Project Chat",
    );
    expect(button).toBeTruthy();
    button?.click();

    expect(onNewProjectChat).toHaveBeenCalledWith("research-desk");
  });

  it("filters projects and exposes upload and reindex actions", () => {
    const onSearchChange = vi.fn();
    const onUploadResourceFiles = vi.fn();
    const onReindexResource = vi.fn();
    const container = document.createElement("div");
    render(
      renderProjects(createProps({ onSearchChange, onUploadResourceFiles, onReindexResource })),
      container,
    );

    const search = container.querySelector<HTMLInputElement>(".project-search input");
    search!.value = "launch";
    search!.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onSearchChange).toHaveBeenCalledWith("launch");

    const upload = container.querySelector<HTMLInputElement>(".project-file-upload input");
    const file = new File(["hello"], "hello.md", { type: "text/markdown" });
    Object.defineProperty(upload, "files", { value: [file], configurable: true });
    upload!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onUploadResourceFiles).toHaveBeenCalledWith([file]);

    const reindex = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Reindex",
    );
    reindex?.click();
    expect(onReindexResource).toHaveBeenCalledWith("research-desk", "resource-1");
  });

  it("shows archived projects as restorable without selecting them as active detail", () => {
    const onRestore = vi.fn();
    const archived = {
      id: "archived-project",
      name: "Archived Project",
      memoryMode: "project_only" as const,
      archived: true,
      createdAt: 1,
      updatedAt: 3,
      resources: [],
    };
    const container = document.createElement("div");
    render(
      renderProjects(
        createProps({
          onRestore,
          list: {
            ok: true,
            ts: 3,
            count: 2,
            projects: [archived, createProps().detail!.project],
          },
        }),
      ),
      container,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("1 active project");
    expect(text).toContain("1 archived project");
    expect(text).toContain("Archived Project");

    const restore = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Restore",
    );
    restore?.click();
    expect(onRestore).toHaveBeenCalledWith("archived-project");
  });
});
