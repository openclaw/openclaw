import { html, nothing } from "lit";
import "../../styles/projects.css";
import type {
  ProjectContextPreview,
  ProjectRecord,
  ProjectResourceRecord,
  ProjectsGetResult,
  ProjectsListResult,
  SessionsListResult,
} from "../types.ts";

export type ProjectsProps = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  list: ProjectsListResult | null;
  selectedId: string | null;
  detail: ProjectsGetResult | null;
  contextPreview: ProjectContextPreview | null;
  sessions: SessionsListResult | null;
  currentSessionKey: string;
  createName: string;
  createDescription: string;
  createInstructions: string;
  resourcePath: string;
  resourceName: string;
  resourceNote: string;
  searchQuery: string;
  instructionsDraft: string;
  onRefresh: () => void;
  onSelect: (projectId: string) => void;
  onCreateFieldChange: (field: "name" | "description" | "instructions", value: string) => void;
  onCreate: () => void;
  onUpdate: (
    patch: Partial<{ name: string; description: string | null; instructions: string | null }>,
  ) => void;
  onInstructionsDraftChange: (value: string) => void;
  onArchive: () => void;
  onRestore: (projectId: string) => void;
  onResourceFieldChange: (field: "path" | "name" | "note", value: string) => void;
  onSearchChange: (value: string) => void;
  onAddResourcePath: () => void;
  onAddResourceNote: () => void;
  onUploadResourceFiles: (files: File[]) => void | Promise<void>;
  onRemoveResource: (projectId: string, resourceId: string) => void;
  onReindexResource: (projectId: string, resourceId: string) => void;
  onAttachCurrentSession: (projectId: string) => void;
  onNewProjectChat: (projectId: string) => void;
  onOpenSession: (sessionKey: string) => void;
};

const PROJECT_RESOURCE_ACCEPT = [
  ".csv",
  ".css",
  ".docx",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".log",
  ".md",
  ".markdown",
  ".py",
  ".text",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
].join(",");

type ProjectHealth = {
  tone: "ready" | "attention" | "empty";
  label: string;
  detail: string;
  readyResources: number;
  attentionResources: number;
};

function fieldValue(event: Event): string {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement | null;
  return target?.value ?? "";
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) {
    return "No activity";
  }
  return new Date(ms).toLocaleString();
}

function compactDate(ms: number | null | undefined): string {
  if (!ms) {
    return "No activity";
  }
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function projectHealth(project: ProjectRecord): ProjectHealth {
  const readyResources = project.resources.filter((resource) => resource.status === "ready").length;
  const attentionResources = project.resources.filter(
    (resource) => resource.status !== "ready",
  ).length;
  const hasInstructions = Boolean(project.instructions?.trim());
  if (attentionResources > 0) {
    return {
      tone: "attention",
      label: "Needs attention",
      detail: `${plural(attentionResources, "resource")} need review`,
      readyResources,
      attentionResources,
    };
  }
  if (hasInstructions || readyResources > 0) {
    return {
      tone: "ready",
      label: "Context ready",
      detail: `${plural(readyResources, "ready resource")} plus instructions`,
      readyResources,
      attentionResources,
    };
  }
  return {
    tone: "empty",
    label: "Needs context",
    detail: "Add instructions or resources",
    readyResources,
    attentionResources,
  };
}

function formatTokenCount(tokens: number | null | undefined): string {
  if (!tokens) {
    return "0 tokens";
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`;
  }
  return `${tokens} tokens`;
}

function previewText(text: string | undefined, max = 520): string {
  const normalized = text?.replace(/\s+/g, " ").trim() ?? "";
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max).trim()}...`;
}

function projectMatches(project: ProjectRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  const haystack = [
    project.name,
    project.description ?? "",
    project.instructions ?? "",
    ...project.resources.map((resource) => `${resource.name} ${resource.textPreview ?? ""}`),
  ]
    .join("\n")
    .toLowerCase();
  return normalized.split(/\s+/).every((term) => haystack.includes(term));
}

function resourceIcon(resource: ProjectResourceRecord): string {
  if (resource.kind === "note") {
    return "Note";
  }
  const ext = resource.extension?.replace(/^\./, "").toUpperCase();
  return ext || "File";
}

function resourceStatus(resource: ProjectResourceRecord): {
  label: string;
  tone: "ready" | "attention" | "empty";
  hint: string;
} {
  if (resource.status === "ready") {
    return { label: "Ready", tone: "ready", hint: "Included in project context" };
  }
  if (resource.status === "unsupported") {
    return {
      label: "Unsupported",
      tone: "attention",
      hint: "Use Markdown, text, CSV, JSON, or DOCX",
    };
  }
  return { label: "Failed", tone: "attention", hint: resource.error ?? "Review this resource" };
}

function handleResourceFileSelect(event: Event, props: ProjectsProps) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (files.length > 0) {
    void props.onUploadResourceFiles(files);
  }
}

function renderHealthPill(health: ProjectHealth) {
  return html`<span class="project-health project-health--${health.tone}">${health.label}</span>`;
}

function renderCreateCard(props: ProjectsProps, empty = false) {
  return html`
    <section class="project-create ${empty ? "project-create--empty" : ""}">
      <div>
        <h3>${empty ? "Create your first project" : "New Project"}</h3>
        <p>
          ${empty
            ? "Start with a name and the standing instructions this project should follow."
            : "One workspace for related chats and context."}
        </p>
      </div>
      <input
        class="input"
        placeholder="Project name"
        .value=${props.createName}
        @input=${(event: Event) => props.onCreateFieldChange("name", fieldValue(event))}
      />
      <input
        class="input"
        placeholder="Purpose"
        .value=${props.createDescription}
        @input=${(event: Event) => props.onCreateFieldChange("description", fieldValue(event))}
      />
      <textarea
        class="textarea"
        placeholder="Project instructions"
        .value=${props.createInstructions}
        @input=${(event: Event) => props.onCreateFieldChange("instructions", fieldValue(event))}
      ></textarea>
      <button
        type="button"
        class="btn project-create__button"
        ?disabled=${props.saving || !props.createName.trim()}
        @click=${props.onCreate}
      >
        ${props.saving ? "Saving..." : "Create Project"}
      </button>
    </section>
  `;
}

function renderProjectList(
  activeProjects: ProjectRecord[],
  archivedProjects: ProjectRecord[],
  props: ProjectsProps,
) {
  const filtered = activeProjects.filter((project) => projectMatches(project, props.searchQuery));
  const filteredArchived = archivedProjects.filter((project) =>
    projectMatches(project, props.searchQuery),
  );
  return html`
    <aside class="projects-sidebar">
      <div class="projects-sidebar__top">
        <label class="project-search">
          <span>Find project</span>
          <input
            class="input"
            placeholder="Search projects"
            .value=${props.searchQuery}
            @input=${(event: Event) => props.onSearchChange(fieldValue(event))}
          />
        </label>
      </div>
      ${renderCreateCard(props)}
      <section class="project-list-section" aria-label="Active Projects">
        <div class="project-list-section__header">
          <span>Active Projects</span>
          <strong>${filtered.length}</strong>
        </div>
        ${filtered.length
          ? html`
              <div class="projects-list" role="listbox" aria-label="Projects">
                ${filtered.map((project) => {
                  const selected = project.id === props.selectedId;
                  const health = projectHealth(project);
                  return html`
                    <button
                      type="button"
                      class="project-list-item ${selected ? "project-list-item--selected" : ""}"
                      aria-selected=${selected}
                      @click=${() => props.onSelect(project.id)}
                    >
                      <span class="project-list-item__mark" aria-hidden="true"
                        >${project.emoji || project.name.slice(0, 2).toUpperCase()}</span
                      >
                      <span class="project-list-item__body">
                        <span class="project-list-item__title">${project.name}</span>
                        <span class="project-list-item__meta">
                          ${plural(project.resources.length, "resource")} ·
                          ${compactDate(project.updatedAt)}
                        </span>
                      </span>
                      ${renderHealthPill(health)}
                    </button>
                  `;
                })}
              </div>
            `
          : html`<div class="projects-empty projects-empty--small">
              No matching active projects.
            </div>`}
      </section>
      ${archivedProjects.length
        ? html`
            <section
              class="project-list-section project-list-section--archived"
              aria-label="Archived Projects"
            >
              <div class="project-list-section__header">
                <span>Archived Projects</span>
                <strong>${filteredArchived.length}</strong>
              </div>
              ${filteredArchived.length
                ? html`
                    <div class="projects-list projects-list--archived">
                      ${filteredArchived.map(
                        (project) => html`
                          <article class="project-list-item project-list-item--archived">
                            <span class="project-list-item__mark" aria-hidden="true"
                              >${project.emoji || project.name.slice(0, 2).toUpperCase()}</span
                            >
                            <span class="project-list-item__body">
                              <span class="project-list-item__title">${project.name}</span>
                              <span class="project-list-item__meta">
                                Archived · ${plural(project.resources.length, "resource")} ·
                                ${compactDate(project.updatedAt)}
                              </span>
                            </span>
                            <button
                              type="button"
                              class="btn btn--ghost btn--sm"
                              ?disabled=${props.saving}
                              @click=${() => props.onRestore(project.id)}
                            >
                              Restore
                            </button>
                          </article>
                        `,
                      )}
                    </div>
                  `
                : html`<div class="projects-empty projects-empty--small">
                    No matching archived projects.
                  </div>`}
            </section>
          `
        : nothing}
    </aside>
  `;
}

function renderCockpit(project: ProjectRecord, props: ProjectsProps) {
  const health = projectHealth(project);
  const sessions = props.sessions?.sessions ?? [];
  const contextTokens = props.contextPreview?.totalTokenEstimate ?? 0;
  const currentAttached = sessions.some((session) => session.key === props.currentSessionKey);
  return html`
    <section class="project-cockpit">
      <div class="project-cockpit__main">
        <div class="project-eyebrow">Project cockpit</div>
        <h2>${project.name}</h2>
        <p>${project.description || "No purpose set yet."}</p>
        <div class="project-cockpit__chips">
          ${renderHealthPill(health)}
          <span class="project-mode-pill">
            ${project.memoryMode === "project_only" ? "Project-only context" : "Shared context"}
          </span>
          ${currentAttached
            ? html`<span class="project-mode-pill">Current chat attached</span>`
            : nothing}
        </div>
      </div>
      <div class="project-cockpit__actions">
        <button
          type="button"
          class="btn project-primary-action"
          ?disabled=${props.saving}
          @click=${() => props.onNewProjectChat(project.id)}
        >
          Start Project Chat
        </button>
        <button
          type="button"
          class="btn btn--subtle"
          ?disabled=${props.saving || currentAttached}
          @click=${() => props.onAttachCurrentSession(project.id)}
        >
          ${currentAttached ? "Attached" : "Attach Current Chat"}
        </button>
      </div>
      <div class="project-cockpit__stats" aria-label="Project status">
        <div class="project-stat project-stat--${health.tone}">
          <span>Context</span>
          <strong>${health.label}</strong>
          <em>${health.detail}</em>
        </div>
        <div class="project-stat">
          <span>Resources</span>
          <strong>${project.resources.length}</strong>
          <em>${health.readyResources} ready · ${health.attentionResources} review</em>
        </div>
        <div class="project-stat">
          <span>Chats</span>
          <strong>${sessions.length}</strong>
          <em>Newest first</em>
        </div>
        <div class="project-stat">
          <span>Next context</span>
          <strong>${formatTokenCount(contextTokens)}</strong>
          <em>${props.contextPreview?.truncated ? "Preview truncated" : "Preview current"}</em>
        </div>
      </div>
    </section>
  `;
}

function renderInstructions(project: ProjectRecord, props: ProjectsProps) {
  return html`
    <section class="project-panel project-panel--instructions">
      <div class="project-panel__header">
        <div>
          <h3>Instructions</h3>
          <p>Persistent guidance for chats in this project.</p>
        </div>
        <button
          type="button"
          class="btn"
          ?disabled=${props.saving || props.instructionsDraft === (project.instructions ?? "")}
          @click=${() => props.onUpdate({ instructions: props.instructionsDraft || null })}
        >
          Save
        </button>
      </div>
      <textarea
        class="textarea project-instructions"
        .value=${props.instructionsDraft}
        @input=${(event: Event) => props.onInstructionsDraftChange(fieldValue(event))}
      ></textarea>
    </section>
  `;
}

function renderResources(project: ProjectRecord, props: ProjectsProps) {
  return html`
    <section class="project-panel project-panel--resources">
      <div class="project-panel__header">
        <div>
          <h3>Resources</h3>
          <p>${PROJECT_RESOURCE_ACCEPT.replaceAll(",", " ")}</p>
        </div>
        <label class="btn project-file-upload">
          Upload Files
          <input
            type="file"
            multiple
            accept=${PROJECT_RESOURCE_ACCEPT}
            ?disabled=${props.saving}
            @change=${(event: Event) => handleResourceFileSelect(event, props)}
          />
        </label>
      </div>
      <div class="project-resource-note">
        <input
          class="input"
          placeholder="Optional resource name"
          .value=${props.resourceName}
          @input=${(event: Event) => props.onResourceFieldChange("name", fieldValue(event))}
        />
        <textarea
          class="textarea project-note-input"
          placeholder="Quick note for this project"
          .value=${props.resourceNote}
          @input=${(event: Event) => props.onResourceFieldChange("note", fieldValue(event))}
        ></textarea>
        <button
          type="button"
          class="btn btn--subtle"
          ?disabled=${props.saving || !props.resourceNote.trim()}
          @click=${props.onAddResourceNote}
        >
          Add Note
        </button>
      </div>
      <details class="project-advanced-resource">
        <summary>Advanced: gateway-local file path</summary>
        <div class="project-resource-form">
          <input
            class="input"
            placeholder="/path/to/resource.md or .docx"
            .value=${props.resourcePath}
            @input=${(event: Event) => props.onResourceFieldChange("path", fieldValue(event))}
          />
          <button
            type="button"
            class="btn btn--subtle"
            ?disabled=${props.saving || !props.resourcePath.trim()}
            @click=${props.onAddResourcePath}
          >
            Add Path
          </button>
        </div>
      </details>
      ${project.resources.length
        ? html`<div class="project-resource-list">
            ${project.resources.map((resource) => {
              const status = resourceStatus(resource);
              return html`
                <article class="project-resource-row project-resource-row--${status.tone}">
                  <div class="project-resource-row__icon">${resourceIcon(resource)}</div>
                  <div class="project-resource-row__body">
                    <div class="project-resource-row__title">${resource.name}</div>
                    <div class="project-resource-row__meta">
                      <span class="project-resource-status project-resource-status--${status.tone}">
                        ${status.label}
                      </span>
                      ${formatTokenCount(resource.tokenEstimate)} · ${status.hint}
                    </div>
                    ${resource.textPreview
                      ? html`<p class="project-resource-row__preview">
                          ${previewText(resource.textPreview, 360)}
                        </p>`
                      : nothing}
                  </div>
                  <div class="project-resource-row__actions">
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      ?disabled=${props.saving}
                      @click=${() => props.onReindexResource(project.id, resource.id)}
                    >
                      Reindex
                    </button>
                    <button
                      type="button"
                      class="btn btn--ghost btn--sm"
                      ?disabled=${props.saving}
                      @click=${() => props.onRemoveResource(project.id, resource.id)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              `;
            })}
          </div>`
        : html`<div class="projects-empty projects-empty--small">
            Add instructions, upload a resource, or write a note.
          </div>`}
    </section>
  `;
}

function renderSessions(project: ProjectRecord, props: ProjectsProps) {
  const sessions = props.sessions?.sessions ?? [];
  return html`
    <section class="project-panel">
      <div class="project-panel__header">
        <div>
          <h3>Project Chats</h3>
          <p>${sessions.length ? "Newest first" : "No project chats yet"}</p>
        </div>
        <button
          type="button"
          class="btn"
          ?disabled=${props.saving}
          @click=${() => props.onNewProjectChat(project.id)}
        >
          Start Project Chat
        </button>
      </div>
      ${sessions.length
        ? html`<div class="project-session-list">
            ${sessions.map(
              (session) => html`
                <button
                  type="button"
                  class="project-session-row"
                  @click=${() => props.onOpenSession(session.key)}
                >
                  <span class="project-session-row__title">
                    ${session.derivedTitle || session.displayName || session.label || session.key}
                  </span>
                  <span class="project-session-row__meta">
                    Project context active · ${session.model ?? "default model"} ·
                    ${formatDate(session.updatedAt)}
                  </span>
                  ${session.lastMessagePreview
                    ? html`<span class="project-session-row__preview">
                        ${previewText(session.lastMessagePreview, 180)}
                      </span>`
                    : nothing}
                </button>
              `,
            )}
          </div>`
        : html`<div class="projects-empty projects-empty--small">
            Start a chat to use this project context.
          </div>`}
    </section>
  `;
}

function renderContextPreview(preview: ProjectContextPreview | null) {
  return html`
    <section class="project-panel project-panel--context">
      <div class="project-panel__header">
        <div>
          <h3>Context Used Next</h3>
          <p>
            ${preview
              ? `${formatTokenCount(preview.totalTokenEstimate)} · ${plural(preview.blocks.length, "block")}`
              : "No context yet"}
          </p>
        </div>
        ${preview?.truncated ? html`<span class="project-mode-pill">Truncated</span>` : nothing}
      </div>
      ${preview?.blocks.length
        ? html`<div class="project-context-blocks">
            ${preview.blocks.map(
              (block) => html`
                <article class="project-context-block">
                  <div class="project-context-block__title">${block.title}</div>
                  <p>${previewText(block.text, 620)}</p>
                </article>
              `,
            )}
          </div>`
        : html`<div class="projects-empty projects-empty--small">
            Add instructions or resources to build context.
          </div>`}
    </section>
  `;
}

function renderProjectDetail(project: ProjectRecord, props: ProjectsProps) {
  return html`
    <div class="project-detail">
      ${renderCockpit(project, props)}
      <div class="project-grid">
        <div class="project-grid__main">
          ${renderResources(project, props)} ${renderSessions(project, props)}
        </div>
        <div class="project-grid__side">
          ${renderInstructions(project, props)} ${renderContextPreview(props.contextPreview)}
          <section class="project-panel project-panel--danger">
            <div class="project-panel__header">
              <div>
                <h3>Archive</h3>
                <p>Hide this project without deleting its stored data.</p>
              </div>
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                ?disabled=${props.saving}
                @click=${props.onArchive}
              >
                Archive
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  `;
}

export function renderProjects(props: ProjectsProps) {
  const projects = props.list?.projects ?? [];
  const activeProjects = projects.filter((project) => project.archived !== true);
  const archivedProjects = projects.filter((project) => project.archived === true);
  const selected =
    props.detail?.project ?? activeProjects.find((entry) => entry.id === props.selectedId);
  const totalResources = activeProjects.reduce((sum, project) => sum + project.resources.length, 0);
  return html`
    <div class="projects-view">
      <section class="projects-toolbar">
        <div>
          <h2>Projects</h2>
          <p>Project chats with active instructions and resources.</p>
        </div>
        <div class="projects-toolbar__meta">
          <span>${plural(activeProjects.length, "active project")}</span>
          <span>${plural(archivedProjects.length, "archived project")}</span>
          <span>${plural(totalResources, "resource")}</span>
          <button
            type="button"
            class="btn btn--subtle"
            ?disabled=${props.loading}
            @click=${props.onRefresh}
          >
            ${props.loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </section>
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${activeProjects.length || archivedProjects.length
        ? html`
            <div class="projects-layout">
              ${renderProjectList(activeProjects, archivedProjects, props)}
              <main class="projects-main">
                ${selected
                  ? renderProjectDetail(selected, props)
                  : html`<div class="projects-empty projects-empty--large">
                      <strong>Select a project.</strong>
                      <span>Project status, chats, and context will appear here.</span>
                    </div>`}
              </main>
            </div>
          `
        : html`<div class="projects-first-run">${renderCreateCard(props, true)}</div>`}
    </div>
  `;
}
