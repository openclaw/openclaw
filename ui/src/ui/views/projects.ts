// Control UI view renders project workspace management.
import { html, nothing } from "lit";
import {
  projectDocumentIdsFromMetadata,
  projectMetadataWithDocumentIds,
  toggleProjectDocumentId,
} from "../controllers/projects.ts";
import type {
  ProjectContextDraft,
  ProjectDocumentDraft,
  ProjectDocumentImportDraft,
  ProjectRoleDraft,
} from "../controllers/projects.ts";
import { formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
import { projectUiText as p } from "../project-i18n.ts";
import type {
  GatewaySessionRow,
  ProjectChatSummary,
  ProjectDetail,
  ProjectDocumentSummary,
  ProjectRoleSummary,
  ProjectSummary,
} from "../types.ts";

export type ProjectsProps = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  projects: ProjectSummary[];
  includeArchived: boolean;
  selectedId: string | null;
  detailLoading: boolean;
  detail: ProjectDetail | null;
  chatsLoading: boolean;
  chats: ProjectChatSummary[];
  rolesLoading: boolean;
  roles: ProjectRoleSummary[];
  documentsLoading: boolean;
  documents: ProjectDocumentSummary[];
  sessions: GatewaySessionRow[];
  contextDraft: ProjectContextDraft;
  roleDraft: ProjectRoleDraft;
  documentDraft: ProjectDocumentDraft;
  documentImportDraft: ProjectDocumentImportDraft;
  createName: string;
  createDescription: string;
  attachSessionKey: string;
  attachTitle: string;
  attachRole: string;
  chatRoleFilter: string;
  newChatDocumentIds: string[];
  onRefresh: () => void;
  onToggleArchived: (includeArchived: boolean) => void;
  onSelectProject: (projectId: string) => void;
  onCreateDraftChange: (patch: { name?: string; description?: string }) => void;
  onCreateProject: () => void;
  onNewProjectChat: () => void;
  onNewProjectRoleChat: (role: string, title: string) => void;
  onPatchProject: (patch: {
    name?: string;
    description?: string | null;
    defaultRoleKey?: string | null;
  }) => void;
  onArchiveProject: () => void;
  onRestoreProject: () => void;
  onContextDraftChange: (patch: Partial<ProjectContextDraft>) => void;
  onSaveContext: () => void;
  onRoleDraftChange: (patch: Partial<ProjectRoleDraft>) => void;
  onApplyRoleTemplate: (template: ProjectRoleDraft) => void;
  onCreateRole: () => void;
  onPatchRole: (
    roleKey: string,
    patch: {
      name?: string;
      description?: string | null;
      instructions?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) => void;
  onArchiveRole: (roleKey: string) => void;
  onRestoreRole: (roleKey: string) => void;
  onSetDefaultRole: (roleKey: string | null) => void;
  onDocumentDraftChange: (patch: Partial<ProjectDocumentDraft>) => void;
  onDocumentImportDraftChange: (patch: Partial<ProjectDocumentImportDraft>) => void;
  onCreateDocument: () => void;
  onImportDocuments: () => void;
  onPatchDocument: (
    documentId: string,
    patch: {
      title?: string;
      uri?: string | null;
      kind?: string | null;
      notes?: string | null;
      includeInContext?: boolean;
    },
  ) => void;
  onArchiveDocument: (documentId: string) => void;
  onRestoreDocument: (documentId: string) => void;
  onChatRoleFilterChange: (roleKey: string) => void;
  onNewChatDocumentIdsChange: (documentIds: string[]) => void;
  onAttachDraftChange: (patch: { sessionKey?: string; title?: string; role?: string }) => void;
  onAttachChat: () => void;
  onPatchChat: (
    sessionKey: string,
    patch: {
      title?: string | null;
      role?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ) => void;
  onArchiveChat: (sessionKey: string) => void;
  onRestoreChat: (sessionKey: string) => void;
  onDetachChat: (sessionKey: string) => void;
  onOpenChat: (sessionKey: string) => void;
};

const PROJECT_ROLE_TEMPLATES: ProjectRoleDraft[] = [
  {
    name: "Documentation",
    description: "Turn project work into clear durable docs.",
    instructions:
      "Prioriza documentacion accionable, decisiones, pasos reproducibles y enlaces utiles. Mantiene el texto breve y facil de mantener.",
  },
  {
    name: "QA Automation",
    description: "Design verification and regression coverage.",
    instructions:
      "Prioriza pruebas automatizadas, casos borde, regresiones probables y criterios de aceptacion verificables.",
  },
  {
    name: "Product",
    description: "Scope, UX, priorities, and tradeoffs.",
    instructions:
      "Prioriza valor de usuario, alcance, orden de implementacion, riesgos de producto y decisiones que desbloqueen ejecucion.",
  },
  {
    name: "Operations",
    description: "Runbooks, reliability, and release readiness.",
    instructions:
      "Prioriza operacion diaria, monitoreo, despliegue, rollback, seguridad practica y procedimientos repetibles.",
  },
];

function formatProjectUpdatedAt(project: ProjectSummary): string {
  return formatRelativeTimestamp(project.updatedAtMs);
}

function activeProjectChats(chats: ProjectChatSummary[]): ProjectChatSummary[] {
  return chats.filter((chat) => chat.status === "active");
}

function selectableProjectDocuments(props: ProjectsProps): ProjectDocumentSummary[] {
  return props.documents.filter(
    (document) => document.status === "active" && !document.includeInContext,
  );
}

function formatDocumentBytes(value: number | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderProjectDocumentDiagnostic(document: ProjectDocumentSummary) {
  const diagnostic = document.summaryDiagnostic;
  if (!diagnostic) {
    return nothing;
  }
  const meta = [
    diagnostic.extension,
    formatDocumentBytes(diagnostic.sizeBytes),
    diagnostic.cache !== "not_applicable" ? `cache: ${diagnostic.cache}` : undefined,
  ].filter(Boolean);
  return html`
    <div class="projects-document-diagnostic projects-document-diagnostic--${diagnostic.status}">
      <div class="projects-document-diagnostic__top">
        <span>${diagnostic.label}</span>
        ${diagnostic.injectsSummary
          ? html`<span class="projects-document-diagnostic__injects">context summary</span>`
          : nothing}
      </div>
      <p>${diagnostic.reason}</p>
      ${meta.length > 0
        ? html`<div class="projects-document-diagnostic__meta">${meta.join(" · ")}</div>`
        : nothing}
    </div>
  `;
}

function roleLabel(roles: ProjectRoleSummary[], roleKey: string | undefined): string {
  if (!roleKey) {
    return p("noRole");
  }
  return roles.find((role) => role.roleKey === roleKey)?.name ?? roleKey;
}

function sessionLabel(row: GatewaySessionRow): string {
  return row.label || row.displayName || row.key;
}

function projectStatusLabel(project: ProjectSummary): string {
  return project.status === "archived" ? p("archived") : p("active");
}

function renderProjectList(props: ProjectsProps) {
  if (props.loading && props.projects.length === 0) {
    return html`<div class="projects-empty">${p("loadingProjects")}</div>`;
  }
  if (props.projects.length === 0) {
    return html`<div class="projects-empty">${p("noProjectsYet")}</div>`;
  }
  return html`
    <div class="projects-list" role="listbox" aria-label=${p("projects")}>
      ${props.projects.map((project) => {
        const selected = project.projectId === props.selectedId;
        return html`
          <button
            class="projects-list__item ${selected ? "projects-list__item--selected" : ""}"
            type="button"
            role="option"
            aria-selected=${selected}
            @click=${() => props.onSelectProject(project.projectId)}
          >
            <span class="projects-list__main">
              <span class="projects-list__title">${project.name}</span>
              <span class="projects-list__meta">
                ${projectStatusLabel(project)}
                ${project.description
                  ? html`<span aria-hidden="true">·</span>${project.description}`
                  : nothing}
              </span>
            </span>
            <span class="projects-list__time">${formatProjectUpdatedAt(project)}</span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderCreateProject(props: ProjectsProps) {
  return html`
    <form
      class="projects-create"
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onCreateProject();
      }}
    >
      <label>
        <span>${p("name")}</span>
        <input
          type="text"
          .value=${props.createName}
          placeholder=${p("newProject")}
          ?disabled=${props.saving}
          @input=${(event: Event) =>
            props.onCreateDraftChange({ name: (event.target as HTMLInputElement).value })}
        />
      </label>
      <label>
        <span>${p("description")}</span>
        <input
          type="text"
          .value=${props.createDescription}
          placeholder="Optional"
          ?disabled=${props.saving}
          @input=${(event: Event) =>
            props.onCreateDraftChange({ description: (event.target as HTMLInputElement).value })}
        />
      </label>
      <button class="btn btn--primary btn--sm" type="submit" ?disabled=${props.saving}>
        ${icons.plus}<span>${p("create")}</span>
      </button>
    </form>
  `;
}

function renderProjectDetails(props: ProjectsProps) {
  const detail = props.detail;
  if (props.detailLoading && !detail) {
    return html`<section class="projects-panel">
      <div class="projects-empty">${p("loadingProject")}</div>
    </section>`;
  }
  if (!detail) {
    return html`
      <section class="projects-panel">
        <div class="projects-empty">${p("selectProject")}</div>
      </section>
    `;
  }
  const activeChats = activeProjectChats(props.chats);
  const archived = detail.status === "archived";
  return html`
    <section class="projects-panel">
      <form
        class="projects-project-form"
        @submit=${(event: Event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget as HTMLFormElement);
          const name = String(data.get("name") ?? "").trim();
          if (!name) {
            return;
          }
          props.onPatchProject({
            name,
            description: String(data.get("description") ?? "").trim() || null,
          });
        }}
      >
        <header class="projects-panel__header">
          <div class="projects-panel__title">
            <input
              class="projects-title-input"
              aria-label=${p("name")}
              name="name"
              .value=${detail.name}
              .defaultValue=${detail.name}
              ?disabled=${props.saving || detail.status === "archived"}
            />
            <span class="projects-status projects-status--${detail.status}">
              ${projectStatusLabel(detail)}
            </span>
          </div>
          <div class="projects-panel__actions">
            <button
              class="btn btn--primary btn--sm"
              type="submit"
              ?disabled=${props.saving || archived}
            >
              ${icons.check}<span>${p("saveProject")}</span>
            </button>
            <button class="btn btn--sm" type="reset" ?disabled=${props.saving || archived}>
              ${icons.x}<span>${p("discard")}</span>
            </button>
            <button class="btn btn--sm" type="button" @click=${props.onRefresh}>
              ${icons.refresh}<span>${p("refresh")}</span>
            </button>
            ${archived
              ? html`
                  <button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${props.saving}
                    @click=${props.onRestoreProject}
                  >
                    ${icons.archiveRestore}<span>${p("restore")}</span>
                  </button>
                `
              : html`
                  <button
                    class="btn btn--sm btn--danger"
                    type="button"
                    ?disabled=${props.saving}
                    @click=${props.onArchiveProject}
                  >
                    ${icons.archive}<span>${p("archive")}</span>
                  </button>
                `}
          </div>
        </header>

        <label class="projects-field">
          <span>${p("description")}</span>
          <textarea
            rows="2"
            name="description"
            .value=${detail.description ?? ""}
            .defaultValue=${detail.description ?? ""}
            ?disabled=${props.saving || detail.status === "archived"}
          ></textarea>
        </label>
      </form>

      <div class="projects-stats" aria-label=${p("projects")}>
        <span><strong>${activeChats.length}</strong> active chats</span>
        <span><strong>${props.chats.length}</strong> linked chats</span>
        <span>Updated ${formatProjectUpdatedAt(detail)}</span>
      </div>

      ${renderProjectContext(props)} ${renderProjectDocuments(props)} ${renderProjectRoles(props)}
      ${renderProjectChats(props)}
    </section>
  `;
}

function renderProjectContext(props: ProjectsProps) {
  const archived = props.detail?.status === "archived";
  return html`
    <section class="projects-section">
      <div class="projects-section__header">
        <div>
          <h3>${p("sharedContext")}</h3>
          <p>${p("sharedContextHelp")}</p>
        </div>
        <button
          class="btn btn--primary btn--sm"
          type="button"
          ?disabled=${props.saving || archived}
          @click=${props.onSaveContext}
        >
          ${icons.check}<span>${p("saveContext")}</span>
        </button>
      </div>
      <div class="projects-context-grid">
        <label class="projects-field">
          <span>${p("summary")}</span>
          <textarea
            rows="4"
            .value=${props.contextDraft.summary}
            ?disabled=${archived}
            @input=${(event: Event) =>
              props.onContextDraftChange({ summary: (event.target as HTMLTextAreaElement).value })}
          ></textarea>
        </label>
        <label class="projects-field">
          <span>${p("instructions")}</span>
          <textarea
            rows="4"
            .value=${props.contextDraft.instructions}
            ?disabled=${archived}
            @input=${(event: Event) =>
              props.onContextDraftChange({
                instructions: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        <label class="projects-field">
          <span>${p("decisions")}</span>
          <textarea
            rows="5"
            placeholder="One decision per line"
            .value=${props.contextDraft.decisions}
            ?disabled=${archived}
            @input=${(event: Event) =>
              props.onContextDraftChange({
                decisions: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        <label class="projects-field">
          <span>${p("documents")}</span>
          <textarea
            rows="5"
            placeholder="One path, URL, or note per line"
            .value=${props.contextDraft.documents}
            ?disabled=${archived}
            @input=${(event: Event) =>
              props.onContextDraftChange({
                documents: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
      </div>
    </section>
  `;
}

function renderProjectDocuments(props: ProjectsProps) {
  const archived = props.detail?.status === "archived";
  return html`
    <section class="projects-section">
      <div class="projects-section__header">
        <div>
          <h3>${p("projectDocuments")}</h3>
          <p>${p("projectDocumentsHelp")}</p>
        </div>
      </div>
      <form
        class="projects-document-create"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onCreateDocument();
        }}
      >
        <label>
          <span>${p("title")}</span>
          <input
            type="text"
            .value=${props.documentDraft.title}
            placeholder="Spec, runbook, decision log..."
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentDraftChange({ title: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label>
          <span>${p("uriOrPath")}</span>
          <input
            type="text"
            .value=${props.documentDraft.uri}
            placeholder="/path/to/file.md or https://..."
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentDraftChange({ uri: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label>
          <span>${p("kind")}</span>
          <input
            type="text"
            .value=${props.documentDraft.kind}
            placeholder="spec, obsidian, repo, url"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentDraftChange({ kind: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label class="projects-document-create__include">
          <input
            type="checkbox"
            .checked=${props.documentDraft.includeInContext}
            ?disabled=${props.saving || archived}
            @change=${(event: Event) =>
              props.onDocumentDraftChange({
                includeInContext: (event.target as HTMLInputElement).checked,
              })}
          />
          <span>${p("context")}</span>
        </label>
        <label class="projects-document-create__notes">
          <span>${p("notes")}</span>
          <textarea
            rows="3"
            .value=${props.documentDraft.notes}
            placeholder="Why this document matters, what to read first, constraints..."
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentDraftChange({ notes: (event.target as HTMLTextAreaElement).value })}
          ></textarea>
        </label>
        <button
          class="btn btn--primary btn--sm"
          type="submit"
          ?disabled=${props.saving || archived || !props.documentDraft.title.trim()}
        >
          ${icons.plus}<span>${p("addDocument")}</span>
        </button>
      </form>
      <form
        class="projects-document-import"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onImportDocuments();
        }}
      >
        <label class="projects-document-import__text">
          <span>${p("bulkImport")}</span>
          <textarea
            rows="5"
            .value=${props.documentImportDraft.text}
            placeholder="Paste one path, URL, Markdown link, Obsidian [[note]], or title | path per line"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentImportDraftChange({
                text: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        <label class="projects-document-import__roots">
          <span>${p("foldersToScan")}</span>
          <textarea
            rows="5"
            .value=${props.documentImportDraft.roots}
            placeholder="/home/me/Documentos/Obsidian/10-Proyectos/MyProject"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentImportDraftChange({
                roots: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        <label>
          <span>${p("defaultKind")}</span>
          <input
            type="text"
            .value=${props.documentImportDraft.kind}
            placeholder="obsidian, spec, repo"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentImportDraftChange({
                kind: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label>
          <span>${p("defaultNotes")}</span>
          <input
            type="text"
            .value=${props.documentImportDraft.notes}
            placeholder="Imported from project folder"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onDocumentImportDraftChange({
                notes: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="projects-document-import__check">
          <input
            type="checkbox"
            .checked=${props.documentImportDraft.recursive}
            ?disabled=${props.saving || archived}
            @change=${(event: Event) =>
              props.onDocumentImportDraftChange({
                recursive: (event.target as HTMLInputElement).checked,
              })}
          />
          <span>${p("scanSubfolders")}</span>
        </label>
        <label class="projects-document-import__check">
          <input
            type="checkbox"
            .checked=${props.documentImportDraft.includeInContext}
            ?disabled=${props.saving || archived}
            @change=${(event: Event) =>
              props.onDocumentImportDraftChange({
                includeInContext: (event.target as HTMLInputElement).checked,
              })}
          />
          <span>${p("includeImportedDocs")}</span>
        </label>
        <button
          class="btn btn--secondary btn--sm"
          type="submit"
          ?disabled=${props.saving ||
          archived ||
          (!props.documentImportDraft.text.trim() && !props.documentImportDraft.roots.trim())}
        >
          ${icons.plus}<span>${p("importDocuments")}</span>
        </button>
      </form>
      ${props.documentsLoading
        ? html`<div class="projects-empty">${p("loadingDocuments")}</div>`
        : props.documents.length === 0
          ? html`<div class="projects-empty">${p("noDocuments")}</div>`
          : html`
              <div class="projects-document-grid" aria-label=${p("projectDocuments")}>
                ${props.documents.map((document) => renderProjectDocument(props, document))}
              </div>
            `}
    </section>
  `;
}

function renderProjectDocument(props: ProjectsProps, document: ProjectDocumentSummary) {
  const archived = document.status === "archived";
  const projectArchived = props.detail?.status === "archived";
  return html`
    <article class="projects-document-card ${archived ? "projects-document-card--archived" : ""}">
      <div class="projects-document-card__top">
        <label class="projects-document-card__field">
          <span>${p("title")}</span>
          <input
            type="text"
            .value=${document.title}
            ?disabled=${props.saving || archived || projectArchived}
            @change=${(event: Event) => {
              const title = (event.target as HTMLInputElement).value.trim();
              if (title && title !== document.title) {
                props.onPatchDocument(document.documentId, { title });
              }
            }}
          />
        </label>
        <label class="projects-document-card__include">
          <input
            type="checkbox"
            .checked=${document.includeInContext}
            ?disabled=${props.saving || archived || projectArchived}
            @change=${(event: Event) =>
              props.onPatchDocument(document.documentId, {
                includeInContext: (event.target as HTMLInputElement).checked,
              })}
          />
          <span>${p("context")}</span>
        </label>
      </div>
      <div class="projects-document-card__grid">
        <label class="projects-document-card__field">
          <span>${p("uriOrPath")}</span>
          <input
            type="text"
            .value=${document.uri ?? ""}
            ?disabled=${props.saving || archived || projectArchived}
            @change=${(event: Event) =>
              props.onPatchDocument(document.documentId, {
                uri: (event.target as HTMLInputElement).value.trim() || null,
              })}
          />
        </label>
        <label class="projects-document-card__field">
          <span>${p("kind")}</span>
          <input
            type="text"
            .value=${document.kind ?? ""}
            ?disabled=${props.saving || archived || projectArchived}
            @change=${(event: Event) =>
              props.onPatchDocument(document.documentId, {
                kind: (event.target as HTMLInputElement).value.trim() || null,
              })}
          />
        </label>
      </div>
      <label class="projects-document-card__field">
        <span>${p("notes")}</span>
        <textarea
          rows="3"
          .value=${document.notes ?? ""}
          ?disabled=${props.saving || archived || projectArchived}
          @change=${(event: Event) =>
            props.onPatchDocument(document.documentId, {
              notes: (event.target as HTMLTextAreaElement).value.trim() || null,
            })}
        ></textarea>
      </label>
      ${renderProjectDocumentDiagnostic(document)}
      <div class="projects-document-card__actions">
        <span class="projects-status projects-status--${document.status}">
          ${document.status === "archived" ? p("archived") : p("active")}
        </span>
        ${archived
          ? html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onRestoreDocument(document.documentId)}
              >
                ${icons.archiveRestore}<span>${p("restore")}</span>
              </button>
            `
          : html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onArchiveDocument(document.documentId)}
              >
                ${icons.archive}<span>${p("archive")}</span>
              </button>
            `}
      </div>
    </article>
  `;
}

function renderProjectRoles(props: ProjectsProps) {
  const archived = props.detail?.status === "archived";
  return html`
    <section class="projects-section">
      <div class="projects-section__header">
        <div>
          <h3>${p("projectRoles")}</h3>
          <p>${p("projectRolesHelp")}</p>
        </div>
      </div>
      <div class="projects-role-templates" aria-label=${p("projectRoles")}>
        ${PROJECT_ROLE_TEMPLATES.map(
          (template) => html`
            <button
              class="btn btn--sm"
              type="button"
              ?disabled=${props.saving || archived}
              @click=${() => props.onApplyRoleTemplate(template)}
            >
              ${icons.copy}<span>${template.name}</span>
            </button>
          `,
        )}
      </div>
      <form
        class="projects-role-create"
        @submit=${(event: Event) => {
          event.preventDefault();
          props.onCreateRole();
        }}
      >
        <label>
          <span>${p("name")}</span>
          <input
            type="text"
            .value=${props.roleDraft.name}
            placeholder="Design, QA, PM..."
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onRoleDraftChange({ name: (event.target as HTMLInputElement).value })}
          />
        </label>
        <label>
          <span>${p("description")}</span>
          <input
            type="text"
            .value=${props.roleDraft.description}
            placeholder="What this role is for"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onRoleDraftChange({
                description: (event.target as HTMLInputElement).value,
              })}
          />
        </label>
        <label class="projects-role-create__instructions">
          <span>${p("instructions")}</span>
          <textarea
            rows="3"
            .value=${props.roleDraft.instructions}
            placeholder="One compact operating brief for this role"
            ?disabled=${props.saving || archived}
            @input=${(event: Event) =>
              props.onRoleDraftChange({
                instructions: (event.target as HTMLTextAreaElement).value,
              })}
          ></textarea>
        </label>
        <button
          class="btn btn--primary btn--sm"
          type="submit"
          ?disabled=${props.saving || archived || !props.roleDraft.name.trim()}
        >
          ${icons.plus}<span>${p("addRole")}</span>
        </button>
      </form>
      ${props.rolesLoading
        ? html`<div class="projects-empty">${p("loadingRoles")}</div>`
        : props.roles.length === 0
          ? html`<div class="projects-empty">${p("noRoles")}</div>`
          : html`
              <div class="projects-role-grid" aria-label=${p("projectRoles")}>
                ${props.roles.map((role) => renderProjectRole(props, role))}
              </div>
            `}
    </section>
  `;
}

function renderProjectRole(props: ProjectsProps, role: ProjectRoleSummary) {
  const archived = role.status === "archived";
  const projectArchived = props.detail?.status === "archived";
  const isDefault = props.detail?.defaultRoleKey === role.roleKey;
  return html`
    <article class="projects-role-card ${archived ? "projects-role-card--archived" : ""}">
      <label class="projects-role-card__field">
        <span>${p("name")}</span>
        <input
          type="text"
          .value=${role.name}
          ?disabled=${props.saving || archived || projectArchived}
          @change=${(event: Event) => {
            const name = (event.target as HTMLInputElement).value.trim();
            if (name && name !== role.name) {
              props.onPatchRole(role.roleKey, { name });
            }
          }}
        />
      </label>
      <label class="projects-role-card__field">
        <span>${p("description")}</span>
        <input
          type="text"
          .value=${role.description ?? ""}
          ?disabled=${props.saving || archived || projectArchived}
          @change=${(event: Event) =>
            props.onPatchRole(role.roleKey, {
              description: (event.target as HTMLInputElement).value.trim() || null,
            })}
        />
      </label>
      <label class="projects-role-card__field projects-role-card__field--wide">
        <span>${p("instructions")}</span>
        <textarea
          rows="4"
          .value=${role.instructions ?? ""}
          ?disabled=${props.saving || archived || projectArchived}
          @change=${(event: Event) =>
            props.onPatchRole(role.roleKey, {
              instructions: (event.target as HTMLTextAreaElement).value.trim() || null,
            })}
        ></textarea>
      </label>
      ${renderRoleDocumentSelector(props, role, archived || projectArchived)}
      <div class="projects-role-card__actions">
        <button
          class="btn btn--sm ${isDefault ? "active" : ""}"
          type="button"
          ?disabled=${props.saving || archived || projectArchived}
          @click=${() => props.onSetDefaultRole(isDefault ? null : role.roleKey)}
        >
          ${icons.check}<span>${isDefault ? p("projectDefault") : p("makeDefault")}</span>
        </button>
        <button
          class="btn btn--primary btn--sm"
          type="button"
          ?disabled=${props.saving || archived || projectArchived}
          @click=${() => props.onNewProjectRoleChat(role.roleKey, role.name)}
        >
          ${icons.plus}<span>${p("newChat")}</span>
        </button>
        ${archived
          ? html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onRestoreRole(role.roleKey)}
              >
                ${icons.archiveRestore}<span>${p("restore")}</span>
              </button>
            `
          : html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onArchiveRole(role.roleKey)}
              >
                ${icons.archive}<span>${p("archive")}</span>
              </button>
            `}
      </div>
    </article>
  `;
}

function renderRoleDocumentSelector(
  props: ProjectsProps,
  role: ProjectRoleSummary,
  disabled: boolean,
) {
  const documents = selectableProjectDocuments(props);
  if (documents.length === 0) {
    return nothing;
  }
  const selectedDocumentIds = projectDocumentIdsFromMetadata(role.metadata);
  return html`
    <div class="projects-role-card__documents">
      <span>${p("extraRoleDocuments")}</span>
      <div class="projects-document-choice-list">
        ${documents.map(
          (document) => html`
            <label>
              <input
                type="checkbox"
                .checked=${selectedDocumentIds.includes(document.documentId)}
                ?disabled=${props.saving || disabled}
                @change=${(event: Event) => {
                  const nextDocumentIds = toggleProjectDocumentId(
                    selectedDocumentIds,
                    document.documentId,
                    (event.target as HTMLInputElement).checked,
                  );
                  props.onPatchRole(role.roleKey, {
                    metadata: projectMetadataWithDocumentIds(role.metadata, nextDocumentIds),
                  });
                }}
              />
              <span>${document.title}</span>
            </label>
          `,
        )}
      </div>
    </div>
  `;
}

function renderProjectChats(props: ProjectsProps) {
  const filteredChats = props.chatRoleFilter
    ? props.chats.filter((chat) =>
        props.chatRoleFilter === "__none" ? !chat.role : chat.role === props.chatRoleFilter,
      )
    : props.chats;
  return html`
    <section class="projects-section">
      <div class="projects-section__header">
        <div>
          <h3>${p("projectChats")}</h3>
          <p>${p("projectChatsHelp")}</p>
        </div>
        <div class="projects-section__actions">
          <label class="projects-chat-filter">
            <span>${p("role")}</span>
            <select
              .value=${props.chatRoleFilter}
              @change=${(event: Event) =>
                props.onChatRoleFilterChange((event.target as HTMLSelectElement).value)}
            >
              <option value="">${p("allRoles")}</option>
              <option value="__none">${p("noRole")}</option>
              ${props.roles
                .filter((role) => role.status === "active")
                .map((role) => html`<option value=${role.roleKey}>${role.name}</option>`)}
            </select>
          </label>
          ${renderNewChatDocumentPicker(props)}
          <button
            class="btn btn--primary btn--sm"
            type="button"
            ?disabled=${props.saving || props.detail?.status === "archived"}
            @click=${props.onNewProjectChat}
          >
            ${icons.plus}<span>${p("newChat")}</span>
          </button>
        </div>
      </div>
      ${renderAttachChat(props)}
      ${props.chatsLoading
        ? html`<div class="projects-empty">${p("loadingChats")}</div>`
        : filteredChats.length === 0
          ? html`<div class="projects-empty">
              ${props.chats.length === 0 ? p("noChats") : p("noMatchingChats")}
            </div>`
          : html`
              <div class="projects-chat-list">
                ${filteredChats.map((chat) => renderProjectChat(props, chat))}
              </div>
            `}
    </section>
  `;
}

function renderNewChatDocumentPicker(props: ProjectsProps) {
  const documents = selectableProjectDocuments(props);
  if (documents.length === 0) {
    return nothing;
  }
  return html`
    <label class="projects-chat-filter projects-chat-filter--documents">
      <span>${p("newChatDocs")}</span>
      <select
        multiple
        .value=${props.newChatDocumentIds[0] ?? ""}
        ?disabled=${props.saving || props.detail?.status === "archived"}
        @change=${(event: Event) =>
          props.onNewChatDocumentIdsChange(
            Array.from((event.target as HTMLSelectElement).selectedOptions).map(
              (option) => option.value,
            ),
          )}
      >
        ${documents.map(
          (document) => html`
            <option
              value=${document.documentId}
              ?selected=${props.newChatDocumentIds.includes(document.documentId)}
            >
              ${document.title}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

function renderAttachChat(props: ProjectsProps) {
  const activeSessionKeys = new Set(props.chats.map((chat) => chat.sessionKey));
  const availableSessions = props.sessions.filter((session) => !activeSessionKeys.has(session.key));
  const archived = props.detail?.status === "archived";
  return html`
    <form
      class="projects-attach"
      @submit=${(event: Event) => {
        event.preventDefault();
        props.onAttachChat();
      }}
    >
      <label>
        <span>${p("session")}</span>
        <select
          .value=${props.attachSessionKey}
          ?disabled=${props.saving || archived}
          @change=${(event: Event) =>
            props.onAttachDraftChange({ sessionKey: (event.target as HTMLSelectElement).value })}
        >
          <option value="">${p("noSession")}</option>
          ${availableSessions.map(
            (session) => html`<option value=${session.key}>${sessionLabel(session)}</option>`,
          )}
        </select>
      </label>
      <label>
        <span>${p("title")}</span>
        <input
          type="text"
          .value=${props.attachTitle}
          placeholder="Optional"
          ?disabled=${props.saving || archived}
          @input=${(event: Event) =>
            props.onAttachDraftChange({ title: (event.target as HTMLInputElement).value })}
        />
      </label>
      <label>
        <span>${p("role")}</span>
        <select
          .value=${props.attachRole}
          ?disabled=${props.saving || archived}
          @change=${(event: Event) =>
            props.onAttachDraftChange({ role: (event.target as HTMLSelectElement).value })}
        >
          <option value="">${p("noRole")}</option>
          ${props.roles
            .filter((role) => role.status === "active")
            .map((role) => html`<option value=${role.roleKey}>${role.name}</option>`)}
        </select>
      </label>
      <button
        class="btn btn--sm"
        type="submit"
        ?disabled=${props.saving || archived || !props.attachSessionKey}
      >
        ${icons.link}<span>${p("attach")}</span>
      </button>
    </form>
  `;
}

function renderProjectChat(props: ProjectsProps, chat: ProjectChatSummary) {
  const archived = chat.status === "archived";
  const projectArchived = props.detail?.status === "archived";
  const documents = selectableProjectDocuments(props);
  const selectedDocumentIds = projectDocumentIdsFromMetadata(chat.metadata);
  return html`
    <form
      class="projects-chat ${archived ? "projects-chat--archived" : ""}"
      @submit=${(event: Event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const data = new FormData(form);
        props.onPatchChat(chat.sessionKey, {
          title: String(data.get("title") ?? "").trim() || null,
          role: String(data.get("role") ?? "").trim() || null,
          metadata: projectMetadataWithDocumentIds(
            chat.metadata,
            data.getAll("documentId").map((value) => String(value)),
          ),
        });
      }}
    >
      <div class="projects-chat__main">
        <span class="projects-chat__title">${chat.title || chat.sessionKey}</span>
        <span class="projects-chat__meta">
          <span class="projects-chat__status">${archived ? p("archived") : p("active")}</span>
          <span aria-hidden="true">·</span> ${roleLabel(props.roles, chat.role)}
          <span aria-hidden="true">·</span> ${chat.sessionKey}
        </span>
        ${archived
          ? nothing
          : html`
              <div class="projects-chat__edit">
                <label>
                  <span>${p("title")}</span>
                  <input
                    name="title"
                    type="text"
                    .value=${chat.title ?? ""}
                    .defaultValue=${chat.title ?? ""}
                    placeholder=${p("sessionTitle")}
                    ?disabled=${props.saving || projectArchived}
                  />
                </label>
                <label>
                  <span>${p("role")}</span>
                  <select
                    name="role"
                    .value=${chat.role ?? ""}
                    ?disabled=${props.saving || projectArchived}
                  >
                    <option value="">${p("noRole")}</option>
                    ${props.roles
                      .filter((role) => role.status === "active")
                      .map(
                        (role) => html`
                          <option value=${role.roleKey} ?selected=${chat.role === role.roleKey}>
                            ${role.name}
                          </option>
                        `,
                      )}
                  </select>
                </label>
                ${documents.length > 0
                  ? html`
                      <div class="projects-chat__documents">
                        <span>${p("extraDocs")}</span>
                        <div class="projects-document-choice-list">
                          ${documents.map(
                            (document) => html`
                              <label>
                                <input
                                  name="documentId"
                                  type="checkbox"
                                  value=${document.documentId}
                                  .checked=${selectedDocumentIds.includes(document.documentId)}
                                  .defaultChecked=${selectedDocumentIds.includes(
                                    document.documentId,
                                  )}
                                  ?disabled=${props.saving || projectArchived}
                                />
                                <span>${document.title}</span>
                              </label>
                            `,
                          )}
                        </div>
                      </div>
                    `
                  : nothing}
              </div>
            `}
      </div>
      <div class="projects-chat__actions">
        ${archived
          ? nothing
          : html`
              <button
                class="btn btn--primary btn--sm"
                type="submit"
                ?disabled=${props.saving || projectArchived}
              >
                ${icons.check}<span>${p("save")}</span>
              </button>
              <button class="btn btn--sm" type="reset" ?disabled=${props.saving || projectArchived}>
                ${icons.x}<span>${p("discard")}</span>
              </button>
            `}
        <button class="btn btn--sm" type="button" @click=${() => props.onOpenChat(chat.sessionKey)}>
          ${icons.messageSquare}<span>${p("open")}</span>
        </button>
        ${archived
          ? html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onRestoreChat(chat.sessionKey)}
              >
                ${icons.archiveRestore}<span>${p("restore")}</span>
              </button>
            `
          : html`
              <button
                class="btn btn--sm"
                type="button"
                ?disabled=${props.saving || projectArchived}
                @click=${() => props.onArchiveChat(chat.sessionKey)}
              >
                ${icons.archive}<span>${p("archive")}</span>
              </button>
            `}
        <button
          class="btn btn--sm btn--danger"
          type="button"
          ?disabled=${props.saving || projectArchived}
          @click=${() => props.onDetachChat(chat.sessionKey)}
        >
          ${icons.x}<span>${p("remove")}</span>
        </button>
      </div>
    </form>
  `;
}

export function renderProjects(props: ProjectsProps) {
  return html`
    <section class="projects-view" aria-label=${p("projects")}>
      <aside class="projects-sidebar">
        <header class="projects-sidebar__header">
          <div>
            <h2>${p("projects")}</h2>
            <p>${p("projectsHelp")}</p>
          </div>
          <button
            class="btn btn--icon btn--sm"
            type="button"
            title=${p("refresh")}
            @click=${props.onRefresh}
          >
            ${icons.refresh}
          </button>
        </header>
        <label class="projects-archived-toggle">
          <input
            type="checkbox"
            .checked=${props.includeArchived}
            @change=${(event: Event) =>
              props.onToggleArchived((event.target as HTMLInputElement).checked)}
          />
          <span>${p("showArchived")}</span>
        </label>
        ${props.error
          ? html`<div class="projects-error" role="alert">${props.error}</div>`
          : nothing}
        ${renderCreateProject(props)} ${renderProjectList(props)}
      </aside>
      ${renderProjectDetails(props)}
    </section>
  `;
}
