/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  emptyProjectContextDraft,
  emptyProjectDocumentDraft,
  emptyProjectDocumentImportDraft,
  emptyProjectRoleDraft,
} from "../controllers/projects.ts";
import type {
  GatewaySessionRow,
  ProjectChatSummary,
  ProjectDetail,
  ProjectDocumentSummary,
  ProjectRoleSummary,
} from "../types.ts";
import { renderProjects, type ProjectsProps } from "./projects.ts";

vi.mock("../icons.ts", () => ({
  icons: {
    archive: "",
    archiveRestore: "",
    check: "",
    copy: "",
    link: "",
    messageSquare: "",
    plus: "",
    refresh: "",
    x: "",
  },
}));

function baseProject(): ProjectDetail {
  return {
    projectId: "proj-1",
    name: "OpenClaw improvements",
    description: "Project workspace UX",
    status: "active",
    defaultRoleKey: "implementation",
    sortOrder: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function baseRole(): ProjectRoleSummary {
  return {
    projectId: "proj-1",
    roleKey: "implementation",
    name: "Implementation",
    description: "Build the feature",
    instructions: "Keep changes focused.",
    status: "active",
    sortOrder: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function baseDocument(): ProjectDocumentSummary {
  return {
    projectId: "proj-1",
    documentId: "doc-1",
    title: "Architecture inventory",
    includeInContext: false,
    status: "active",
    sortOrder: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function baseChat(): ProjectChatSummary {
  return {
    projectId: "proj-1",
    sessionKey: "agent:main:main",
    title: "Implementation thread",
    role: "implementation",
    metadata: { projectDocumentIds: ["doc-1"] },
    status: "active",
    sortOrder: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
}

function baseSession(): GatewaySessionRow {
  return {
    key: "agent:main:review",
    kind: "direct",
    label: "Review chat",
    updatedAt: 3,
  };
}

function baseProps(overrides: Partial<ProjectsProps> = {}): ProjectsProps {
  const project = baseProject();
  return {
    loading: false,
    saving: false,
    error: null,
    projects: [project],
    includeArchived: false,
    selectedId: project.projectId,
    detailLoading: false,
    detail: project,
    chatsLoading: false,
    chats: [baseChat()],
    rolesLoading: false,
    roles: [baseRole()],
    documentsLoading: false,
    documents: [baseDocument()],
    sessions: [baseSession()],
    contextDraft: emptyProjectContextDraft(),
    roleDraft: emptyProjectRoleDraft(),
    documentDraft: emptyProjectDocumentDraft(),
    documentImportDraft: emptyProjectDocumentImportDraft(),
    createName: "",
    createDescription: "",
    attachSessionKey: "",
    attachTitle: "",
    attachRole: "",
    chatRoleFilter: "",
    newChatDocumentIds: [],
    onRefresh: vi.fn(),
    onToggleArchived: vi.fn(),
    onSelectProject: vi.fn(),
    onCreateDraftChange: vi.fn(),
    onCreateProject: vi.fn(),
    onNewProjectChat: vi.fn(),
    onNewProjectRoleChat: vi.fn(),
    onPatchProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onRestoreProject: vi.fn(),
    onContextDraftChange: vi.fn(),
    onSaveContext: vi.fn(),
    onRoleDraftChange: vi.fn(),
    onApplyRoleTemplate: vi.fn(),
    onCreateRole: vi.fn(),
    onPatchRole: vi.fn(),
    onArchiveRole: vi.fn(),
    onRestoreRole: vi.fn(),
    onSetDefaultRole: vi.fn(),
    onDocumentDraftChange: vi.fn(),
    onDocumentImportDraftChange: vi.fn(),
    onCreateDocument: vi.fn(),
    onImportDocuments: vi.fn(),
    onPatchDocument: vi.fn(),
    onArchiveDocument: vi.fn(),
    onRestoreDocument: vi.fn(),
    onChatRoleFilterChange: vi.fn(),
    onNewChatDocumentIdsChange: vi.fn(),
    onAttachDraftChange: vi.fn(),
    onAttachChat: vi.fn(),
    onPatchChat: vi.fn(),
    onArchiveChat: vi.fn(),
    onRestoreChat: vi.fn(),
    onDetachChat: vi.fn(),
    onOpenChat: vi.fn(),
    ...overrides,
  };
}

function renderIntoDocument(props: ProjectsProps): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderProjects(props), container);
  return container;
}

function text(container: HTMLElement): string {
  return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

afterEach(async () => {
  await i18n.setLocale("en");
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("renderProjects", () => {
  it("renders explicit save and discard controls for project and linked chat edits", () => {
    const container = renderIntoDocument(baseProps());

    expect(text(container)).toContain("Save project");
    expect(text(container)).toContain("Discard");
    expect(text(container)).toContain("Save");

    const projectForm = container.querySelector<HTMLFormElement>(".projects-project-form");
    const chatForm = container.querySelector<HTMLFormElement>(".projects-chat");
    expect(projectForm?.querySelector('button[type="submit"]')?.textContent).toContain(
      "Save project",
    );
    expect(projectForm?.querySelector('button[type="reset"]')?.textContent).toContain("Discard");
    expect(chatForm?.querySelector('button[type="submit"]')?.textContent).toContain("Save");
    expect(chatForm?.querySelector('button[type="reset"]')?.textContent).toContain("Discard");
  });

  it("uses configured project roles when attaching an existing chat", () => {
    const onAttachDraftChange = vi.fn();
    const container = renderIntoDocument(baseProps({ onAttachDraftChange }));

    const roleSelect = container.querySelector<HTMLSelectElement>(
      ".projects-attach label:nth-of-type(3) select",
    );

    expect(roleSelect).not.toBeNull();
    expect(Array.from(roleSelect?.options ?? []).map((option) => option.value)).toEqual([
      "",
      "implementation",
    ]);

    roleSelect!.value = "implementation";
    roleSelect!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onAttachDraftChange).toHaveBeenCalledWith({ role: "implementation" });
  });

  it("renders the project workspace copy in Spanish", async () => {
    await i18n.setLocale("es");

    const container = renderIntoDocument(baseProps());
    const renderedText = text(container);

    expect(renderedText).toContain("Guardar proyecto");
    expect(renderedText).toContain("Descartar");
    expect(renderedText).toContain("Vincular");
    expect(renderedText).toContain("Chats del proyecto");
    expect(renderedText).toContain("Sin rol");
  });
});
