// Control UI view renders the first-class Code Farm page.
import { html, nothing } from "lit";
import {
  archiveCodefarmProject,
  configureCodefarmProject,
  getCodefarmState,
  loadCodefarmJobs,
  loadCodefarmProject,
  loadCodefarmRepos,
  observeCodefarmJob,
  selectCodefarmRepo,
  sendCodefarmProjectTerminalInput,
  setCodefarmProjectRuntime,
  type CodefarmProject,
  type CodefarmProjectForm,
  type CodefarmProjectFile,
  type CodefarmJobSummary,
  type CodefarmRepoSummary,
  type CodefarmRuntime,
} from "../controllers/codefarm.ts";
import { formatRelativeTimestamp } from "../format.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import { icons } from "../icons.ts";

export type CodefarmRenderProps = {
  host: object;
  client: GatewayBrowserClient | null;
  connected: boolean;
  onRequestUpdate?: () => void;
};

function statusClass(status: string): string {
  if (status === "running" || status === "preparing") {
    return "is-running";
  }
  if (status === "ready_for_review") {
    return "is-review";
  }
  if (status === "failed" || status === "blocked" || status === "needs_recovery") {
    return "is-blocked";
  }
  return "is-idle";
}

function formatCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function latestLabel(value: string | undefined): string {
  if (!value) {
    return "No timestamp";
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? formatRelativeTimestamp(timestamp) : "No timestamp";
}

function repoTitle(repo: CodefarmRepoSummary): string {
  return repo.name || repo.repo.split("/").findLast(Boolean) || repo.repo;
}

function renderRepoButton(props: CodefarmRenderProps, repo: CodefarmRepoSummary) {
  const state = getCodefarmState(props.host);
  const active = state.selectedRepo === repo.repo;
  return html`
    <button
      type="button"
      class="codefarm-repo ${active ? "is-active" : ""}"
      @click=${() =>
        void selectCodefarmRepo({
          host: props.host,
          client: props.client,
          repo: repo.repo,
          requestUpdate: props.onRequestUpdate,
        })}
    >
      <span class="codefarm-repo__top">
        <span class="codefarm-repo__name">${repoTitle(repo)}</span>
        <span class="codefarm-repo__count">${repo.totalJobs}</span>
      </span>
      <span class="codefarm-repo__path">${repo.repo}</span>
      <span class="codefarm-repo__meta">
        <span>${formatCount(repo.activeJobs, "active")}</span>
        <span>${formatCount(repo.reviewJobs, "review")}</span>
        <span>${formatCount(repo.blockedJobs, "blocked")}</span>
        ${repo.archived ? html`<span>archived</span>` : nothing}
      </span>
      <span class="codefarm-repo__time">${latestLabel(repo.latestUpdatedAt)}</span>
    </button>
  `;
}

function renderJobButton(props: CodefarmRenderProps, job: CodefarmJobSummary) {
  const state = getCodefarmState(props.host);
  const repo = state.selectedRepo ?? state.repoInput;
  const selected = state.selectedJobId === job.id;
  return html`
    <li>
      <button
        type="button"
        class="codefarm-job ${selected ? "is-active" : ""}"
        @click=${() => {
          state.selectedJobId = job.id;
          props.onRequestUpdate?.();
        }}
      >
        <span class="codefarm-job__top">
          <span class="codefarm-job__id">${job.id}</span>
          <span class="codefarm-status ${statusClass(job.status)}">${job.status}</span>
        </span>
        ${job.taskIntent
          ? html`<span class="codefarm-job__intent">${job.taskIntent}</span>`
          : nothing}
        <span class="codefarm-job__meta">
          ${job.runtime ? html`<span>${job.runtime}</span>` : nothing}
          ${job.branch ? html`<span>${job.branch}</span>` : nothing}
          ${job.nextAction ? html`<span>${job.nextAction}</span>` : nothing}
        </span>
      </button>
      <button
        type="button"
        class="btn btn--sm codefarm-job__observe"
        ?disabled=${!repo || state.observing || !props.connected}
        @click=${() =>
          repo
            ? void observeCodefarmJob({
                host: props.host,
                client: props.client,
                repo,
                jobId: job.id,
                requestUpdate: props.onRequestUpdate,
              })
            : undefined}
      >
        ${state.observing && selected ? "Loading..." : "Observe"}
      </button>
    </li>
  `;
}

function setCodefarmSection(props: CodefarmRenderProps, section: "projects" | "jobs") {
  const state = getCodefarmState(props.host);
  state.activeSection = section;
  props.onRequestUpdate?.();
}

function renderTabs(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  return html`
    <div class="codefarm-tabs" role="tablist" aria-label="Code Farm sections">
      <button
        type="button"
        class="codefarm-tab ${state.activeSection === "projects" ? "is-active" : ""}"
        role="tab"
        aria-selected=${state.activeSection === "projects" ? "true" : "false"}
        @click=${() => setCodefarmSection(props, "projects")}
      >
        Projects
      </button>
      <button
        type="button"
        class="codefarm-tab ${state.activeSection === "jobs" ? "is-active" : ""}"
        role="tab"
        aria-selected=${state.activeSection === "jobs" ? "true" : "false"}
        @click=${() => setCodefarmSection(props, "jobs")}
      >
        Jobs
      </button>
    </div>
  `;
}

function renderRepoList(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  return html`
    <aside class="codefarm-sidebar" aria-label="Code Farm projects">
      <div class="codefarm-pane-title">Projects</div>
      ${state.loading && !state.repos.length
        ? html`<p class="muted">Loading projects...</p>`
        : state.repos.length
          ? html`<div class="codefarm-repos">
              ${state.repos.map((repo) => renderRepoButton(props, repo))}
            </div>`
          : html`<p class="muted">No Code Farm projects found.</p>`}
      <div class="codefarm-manual">
        <input
          class="input codefarm-manual__input"
          placeholder="Repo path"
          .value=${state.repoInput}
          @input=${(event: Event) => {
            state.repoInput = (event.currentTarget as HTMLInputElement).value;
          }}
        />
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${state.jobsLoading || !state.repoInput.trim() || !props.connected}
          @click=${() => {
            const repo = state.repoInput.trim();
            if (!repo) {
              return;
            }
            void Promise.all([
              loadCodefarmJobs({
                host: props.host,
                client: props.client,
                repo,
                requestUpdate: props.onRequestUpdate,
              }),
              loadCodefarmProject({
                host: props.host,
                client: props.client,
                repo,
                requestUpdate: props.onRequestUpdate,
              }),
            ]);
          }}
        >
          Load
        </button>
      </div>
    </aside>
  `;
}

function renderProjectFile(file: CodefarmProjectFile) {
  return html`
    <article class="codefarm-project-file">
      <div class="codefarm-project-file__header">
        <span>${file.path}</span>
        ${file.truncated ? html`<span>truncated</span>` : nothing}
      </div>
      <pre>${file.content || "No content."}</pre>
    </article>
  `;
}

function renderStatusCounts(project: CodefarmProject) {
  const statuses = Object.entries(project.jobs.statuses);
  if (!statuses.length) {
    return html`<span>No job history yet</span>`;
  }
  return statuses.map(([status, count]) => html`<span>${status}: ${count}</span>`);
}

function renderProjectJobs(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  if (!state.jobs.length) {
    return html`<p class="muted">No jobs loaded for this project.</p>`;
  }
  return html`
    <ol class="codefarm-project-jobs">
      ${state.jobs.slice(0, 8).map(
        (job) => html`
          <li>
            <span class="codefarm-project-jobs__id">${job.id}</span>
            <span class="codefarm-status ${statusClass(job.status)}">${job.status}</span>
            ${job.taskIntent ? html`<span>${job.taskIntent}</span>` : nothing}
          </li>
        `,
      )}
    </ol>
  `;
}

function setProjectFormValue(
  host: object,
  key: keyof CodefarmProjectForm,
  event: Event,
  requestUpdate?: () => void,
) {
  const state = getCodefarmState(host);
  state.projectForm = {
    ...state.projectForm,
    [key]: (event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value,
  };
  requestUpdate?.();
}

function renderProjectForm(props: CodefarmRenderProps, project: CodefarmProject) {
  const state = getCodefarmState(props.host);
  const form = state.projectForm;
  return html`
    <section class="codefarm-project-card codefarm-project-card--wide">
      <h3>Project Form</h3>
      <div class="codefarm-project-form">
        <label>
          <span>Project name</span>
          <input
            class="input codefarm-project-form__name"
            .value=${form.projectName}
            @input=${(event: Event) =>
              setProjectFormValue(props.host, "projectName", event, props.onRequestUpdate)}
          />
        </label>
        <label class="codefarm-project-form__wide">
          <span>Mission</span>
          <textarea
            class="input codefarm-project-form__mission"
            rows="3"
            .value=${form.mission}
            @input=${(event: Event) =>
              setProjectFormValue(props.host, "mission", event, props.onRequestUpdate)}
          ></textarea>
        </label>
        <label>
          <span>Milestone</span>
          <input
            class="input codefarm-project-form__milestone"
            .value=${form.currentMilestone}
            @input=${(event: Event) =>
              setProjectFormValue(props.host, "currentMilestone", event, props.onRequestUpdate)}
          />
        </label>
        <label>
          <span>Slice</span>
          <input
            class="input codefarm-project-form__slice"
            .value=${form.currentSlice}
            @input=${(event: Event) =>
              setProjectFormValue(props.host, "currentSlice", event, props.onRequestUpdate)}
          />
        </label>
      </div>
      ${state.projectFormError
        ? html`<p class="codefarm-error">${state.projectFormError}</p>`
        : nothing}
      <div class="codefarm-project-form__actions">
        <button
          type="button"
          class="btn btn--sm codefarm-project-form__save"
          ?disabled=${state.projectFormSaving || !props.connected}
          @click=${() =>
            void configureCodefarmProject({
              host: props.host,
              client: props.client,
              repo: project.repo,
              form: state.projectForm,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          ${state.projectFormSaving ? "Saving" : "Save Project"}
        </button>
      </div>
    </section>
  `;
}

function renderProjectRuntime(props: CodefarmRenderProps, project: CodefarmProject) {
  const state = getCodefarmState(props.host);
  const runtime = project.runtime ?? {
    selected: "codex-cli" as CodefarmRuntime,
    options: [
      { id: "codex-cli" as CodefarmRuntime, label: "Codex CLI" },
      { id: "claude-code" as CodefarmRuntime, label: "Claude Code" },
    ],
  };
  return html`
    <section class="codefarm-project-card">
      <h3>Runtime</h3>
      <label class="codefarm-runtime-field">
        <span>Worker runtime</span>
        <select
          class="input codefarm-runtime-select"
          .value=${runtime.selected}
          ?disabled=${state.runtimeSaving || !props.connected}
          @change=${(event: Event) =>
            void setCodefarmProjectRuntime({
              host: props.host,
              client: props.client,
              repo: project.repo,
              runtime: (event.currentTarget as HTMLSelectElement).value as CodefarmRuntime,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          ${runtime.options.map(
            (option) => html`<option value=${option.id}>${option.label}</option>`,
          )}
        </select>
      </label>
      <div class="codefarm-detail__facts">
        <span>${runtime.selected}</span>
        <span>${state.runtimeSaving ? "saving" : "selected"}</span>
      </div>
      ${state.runtimeError ? html`<p class="codefarm-error">${state.runtimeError}</p>` : nothing}
    </section>
  `;
}

function renderProjectForeman(project: CodefarmProject) {
  const profile = project.profile;
  return html`
    <section class="codefarm-project-card">
      <h3>${profile?.name ?? "Project Foreman"}</h3>
      <div class="codefarm-detail__facts">
        <span>${profile?.status ?? "missing"}</span>
        ${(profile?.contract ?? ["GSD-first", "CodeFarm execution", "Persistent tmux"]).map(
          (item) => html`<span>${item}</span>`,
        )}
      </div>
      ${profile?.workspace
        ? html`<div class="codefarm-attach">${profile.workspace}</div>`
        : nothing}
      ${profile?.agentDir ? html`<div class="codefarm-attach">${profile.agentDir}</div>` : nothing}
    </section>
  `;
}

function setTerminalInputValue(host: object, event: Event, requestUpdate?: () => void) {
  const state = getCodefarmState(host);
  state.terminalInput = (event.currentTarget as HTMLInputElement).value;
  requestUpdate?.();
}

function submitProjectTerminalInput(
  props: CodefarmRenderProps,
  project: CodefarmProject,
  event?: Event,
) {
  event?.preventDefault();
  const state = getCodefarmState(props.host);
  const input = state.terminalInput;
  if (!input.trim() || state.terminalSending) {
    return;
  }
  void sendCodefarmProjectTerminalInput({
    host: props.host,
    client: props.client,
    repo: project.repo,
    input,
    enter: true,
    requestUpdate: props.onRequestUpdate,
  });
}

function terminalInputDisabledReason(
  props: CodefarmRenderProps,
  projectTerminal: CodefarmProject["projectTerminal"],
): string | null {
  if (!props.connected) {
    return "Gateway disconnected.";
  }
  if (!projectTerminal?.running) {
    return "Project tmux session is not running.";
  }
  return null;
}

function renderProjectDetail(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  const project = state.project;
  if (state.projectLoading && !project) {
    return html`
      <section class="codefarm-project">
        <div class="codefarm-detail__empty">Loading project...</div>
      </section>
    `;
  }
  if (!project) {
    return html`
      <section class="codefarm-project">
        <div class="codefarm-detail__empty">Select a project.</div>
      </section>
    `;
  }
  const projectTerminal = project.projectTerminal;
  const projectTerminalText = projectTerminal?.terminal?.lines.length
    ? projectTerminal.terminal.lines.join("\n")
    : projectTerminal?.running
      ? "Project terminal is running, but no output has been captured yet."
      : "No project terminal output captured yet.";
  const terminalDisabledReason = terminalInputDisabledReason(props, projectTerminal);
  return html`
    <section class="codefarm-project">
      <div class="codefarm-project__header">
        <div>
          <h2>${project.name}</h2>
          <p>${project.repo}</p>
        </div>
        <button
          type="button"
          class="btn btn--sm codefarm-project-archive"
          ?disabled=${state.projectLoading || !props.connected}
          @click=${() =>
            void archiveCodefarmProject({
              host: props.host,
              client: props.client,
              repo: project.repo,
              archived: !project.archived,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          ${project.archived ? "Unarchive" : "Archive"}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${state.projectLoading || !props.connected}
          @click=${() =>
            void loadCodefarmProject({
              host: props.host,
              client: props.client,
              repo: project.repo,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          ${state.projectLoading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      ${state.projectError
        ? html`<div class="callout danger">${state.projectError}</div>`
        : nothing}
      <div class="codefarm-project-grid">
        ${renderProjectForm(props, project)} ${renderProjectRuntime(props, project)}
        ${renderProjectForeman(project)}
        <section class="codefarm-project-card">
          <h3>Project Terminal</h3>
          <div class="codefarm-detail__facts">
            <span>${project.projectTerminal?.running ? "running" : "not running"}</span>
            ${project.projectTerminal?.persistent ? html`<span>persistent</span>` : nothing}
            ${projectTerminal?.terminal?.source
              ? html`<span>Source: ${projectTerminal.terminal.source}</span>`
              : nothing}
            ${projectTerminal?.pane ? html`<span>Pane: ${projectTerminal.pane}</span>` : nothing}
            ${projectTerminal?.command
              ? html`<span>Command: ${projectTerminal.command}</span>`
              : nothing}
            ${projectTerminal?.terminal?.truncated ? html`<span>truncated</span>` : nothing}
          </div>
          ${project.projectTerminal?.session
            ? html`<div class="codefarm-attach">${project.projectTerminal.session}</div>`
            : nothing}
          ${projectTerminal?.cwd
            ? html`<div class="codefarm-attach">${projectTerminal.cwd}</div>`
            : nothing}
          ${project.projectTerminal?.attachCommand
            ? html`<div class="codefarm-attach">${project.projectTerminal.attachCommand}</div>`
            : nothing}
          ${project.projectTerminal?.note
            ? html`<p class="codefarm-note">${project.projectTerminal.note}</p>`
            : nothing}
          <form
            class="codefarm-terminal-controls"
            @submit=${(event: Event) => submitProjectTerminalInput(props, project, event)}
          >
            <input
              class="input codefarm-terminal-input"
              placeholder="Type a command for the project tmux session"
              .value=${state.terminalInput}
              ?disabled=${state.terminalSending || Boolean(terminalDisabledReason)}
              autocomplete="off"
              spellcheck="false"
              @input=${(event: Event) =>
                setTerminalInputValue(props.host, event, props.onRequestUpdate)}
            />
            <button
              type="submit"
              class="btn btn--sm codefarm-terminal-send"
              ?disabled=${state.terminalSending ||
              Boolean(terminalDisabledReason) ||
              !state.terminalInput.trim()}
              @click=${(event: Event) => submitProjectTerminalInput(props, project, event)}
            >
              ${state.terminalSending ? "Sending" : "Send"}
            </button>
          </form>
          ${terminalDisabledReason
            ? html`<p class="codefarm-terminal-hint">${terminalDisabledReason}</p>`
            : nothing}
          <pre class="codefarm-terminal">${projectTerminalText}</pre>
          ${state.terminalError
            ? html`<p class="codefarm-error">${state.terminalError}</p>`
            : nothing}
        </section>

        <section class="codefarm-project-card">
          <h3>GSD State</h3>
          <div class="codefarm-detail__facts">
            <span>${project.gsd.available ? "available" : "not initialized"}</span>
            ${project.gsd.files.map((file) => html`<span>${file.path}</span>`)}
          </div>
          ${project.gsd.files.length
            ? html`<div class="codefarm-project-files">
                ${project.gsd.files.map((file) => renderProjectFile(file))}
              </div>`
            : html`<p class="muted">No GSD files found.</p>`}
        </section>

        <section class="codefarm-project-card">
          <h3>Jobs</h3>
          ${renderProjectJobs(props)}
        </section>

        <section class="codefarm-project-card">
          <h3>Project Context</h3>
          ${project.contextFiles.length
            ? html`<div class="codefarm-project-files">
                ${project.contextFiles.map((file) => renderProjectFile(file))}
              </div>`
            : html`<p class="muted">No project context files found.</p>`}
        </section>

        <section class="codefarm-project-card">
          <h3>Evolution</h3>
          <div class="codefarm-detail__facts">
            <span>${formatCount(project.jobs.totalJobs, "job")}</span>
            <span>${formatCount(project.jobs.activeJobs, "active")}</span>
            ${typeof project.jobs.reviewJobs === "number"
              ? html`<span>${formatCount(project.jobs.reviewJobs, "review")}</span>`
              : nothing}
            ${typeof project.jobs.blockedJobs === "number"
              ? html`<span>${formatCount(project.jobs.blockedJobs, "blocked")}</span>`
              : nothing}
          </div>
          <div class="codefarm-detail__facts codefarm-project-statuses">
            ${renderStatusCounts(project)}
          </div>
          ${project.jobs.latestUpdatedAt
            ? html`<p class="muted">Latest ${latestLabel(project.jobs.latestUpdatedAt)}</p>`
            : nothing}
        </section>
      </div>
    </section>
  `;
}

function renderTerminal(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  const observation = state.observation;
  if (!observation) {
    return html`
      <section class="codefarm-detail">
        <div class="codefarm-detail__empty">No job selected.</div>
      </section>
    `;
  }
  const terminalText = observation.terminal.lines.length
    ? observation.terminal.lines.join("\n")
    : "No terminal output captured yet.";
  return html`
    <section class="codefarm-detail">
      <div class="codefarm-detail__header">
        <div>
          <h2>${observation.jobId}</h2>
          <p>${observation.repo ?? state.selectedRepo ?? ""}</p>
        </div>
        <span class="codefarm-status ${statusClass(observation.status ?? "unknown")}"
          >${observation.status ?? "unknown"}</span
        >
      </div>
      <div class="codefarm-detail__facts">
        <span>Source: ${observation.terminal.source}</span>
        ${observation.runtime ? html`<span>Runtime: ${observation.runtime}</span>` : nothing}
        ${observation.branch ? html`<span>Branch: ${observation.branch}</span>` : nothing}
        ${observation.tmux?.pane ? html`<span>Pane: ${observation.tmux.pane}</span>` : nothing}
      </div>
      ${observation.tmux?.attachCommand
        ? html`<div class="codefarm-attach">${observation.tmux.attachCommand}</div>`
        : nothing}
      ${observation.tmux?.note
        ? html`<p class="codefarm-note">${observation.tmux.note}</p>`
        : nothing}
      ${state.observeError ? html`<p class="codefarm-error">${state.observeError}</p>` : nothing}
      <pre class="codefarm-terminal">${terminalText}</pre>
      ${observation.changes?.touchedFiles.length
        ? html`
            <div class="codefarm-files">
              <h3>Touched files</h3>
              <ul>
                ${observation.changes.touchedFiles.map((file) => html`<li>${file}</li>`)}
              </ul>
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderProjectsSection(props: CodefarmRenderProps) {
  return html`
    <div class="codefarm-project-layout">
      ${renderRepoList(props)} ${renderProjectDetail(props)}
    </div>
  `;
}

function renderJobsSection(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  const selectedRepo = state.selectedRepo ?? state.repoInput;
  return html`
    <div class="codefarm-layout">
      ${renderRepoList(props)}

      <section class="codefarm-jobs" aria-label="Code Farm jobs">
        <div class="codefarm-pane-title">
          <span>Jobs</span>
          ${selectedRepo
            ? html`<span class="codefarm-pane-title__path">${selectedRepo}</span>`
            : nothing}
        </div>
        ${state.jobsError ? html`<div class="callout danger">${state.jobsError}</div>` : nothing}
        ${state.jobsLoading
          ? html`<p class="muted">Loading jobs...</p>`
          : state.jobs.length
            ? html`<ol class="codefarm-job-list">
                ${state.jobs.map((job) => renderJobButton(props, job))}
              </ol>`
            : html`<p class="muted">Select a project to load jobs.</p>`}
      </section>

      ${renderTerminal(props)}
    </div>
  `;
}

export function renderCodefarm(props: CodefarmRenderProps) {
  const state = getCodefarmState(props.host);
  const totalJobs = state.repos.reduce((sum, repo) => sum + repo.totalJobs, 0);
  const activeJobs = state.repos.reduce((sum, repo) => sum + repo.activeJobs, 0);
  return html`
    <section class="codefarm">
      <div class="codefarm-toolbar">
        <div class="codefarm-toolbar__stats">
          <span>${formatCount(state.repos.length, "repo")}</span>
          <span>${formatCount(totalJobs, "job")}</span>
          <span>${formatCount(activeJobs, "active")}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${state.loading || !props.connected}
          @click=${() => {
            state.showArchived = !state.showArchived;
            void loadCodefarmRepos({
              host: props.host,
              client: props.client,
              requestUpdate: props.onRequestUpdate,
            });
          }}
        >
          ${state.showArchived ? "Hide archived" : "Show archived"}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${state.loading || !props.connected}
          @click=${() =>
            void loadCodefarmRepos({
              host: props.host,
              client: props.client,
              requestUpdate: props.onRequestUpdate,
            })}
        >
          <span aria-hidden="true">${icons.refresh}</span>
          ${state.loading ? "Refreshing" : "Refresh"}
        </button>
      </div>
      ${renderTabs(props)}
      ${state.error ? html`<div class="callout danger">${state.error}</div>` : nothing}
      ${state.activeSection === "projects"
        ? renderProjectsSection(props)
        : renderJobsSection(props)}
    </section>
  `;
}
