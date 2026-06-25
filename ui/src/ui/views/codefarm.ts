// Control UI view renders the first-class Code Farm page.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  getCodefarmState,
  loadCodefarmJobs,
  loadCodefarmProject,
  loadCodefarmRepos,
  observeCodefarmJob,
  selectCodefarmRepo,
  type CodefarmProject,
  type CodefarmProjectFile,
  type CodefarmJobSummary,
  type CodefarmRepoSummary,
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
  return repo.name || repo.repo.split("/").filter(Boolean).at(-1) || repo.repo;
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
  return html`
    <section class="codefarm-project">
      <div class="codefarm-project__header">
        <div>
          <h2>${project.name}</h2>
          <p>${project.repo}</p>
        </div>
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
        <section class="codefarm-project-card">
          <h3>Project Terminal</h3>
          <div class="codefarm-detail__facts">
            <span>${project.projectTerminal?.running ? "running" : "not running"}</span>
            ${project.projectTerminal?.persistent ? html`<span>persistent</span>` : nothing}
          </div>
          ${project.projectTerminal?.session
            ? html`<div class="codefarm-attach">${project.projectTerminal.session}</div>`
            : nothing}
          ${project.projectTerminal?.attachCommand
            ? html`<div class="codefarm-attach">${project.projectTerminal.attachCommand}</div>`
            : nothing}
          ${project.projectTerminal?.note
            ? html`<p class="codefarm-note">${project.projectTerminal.note}</p>`
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
