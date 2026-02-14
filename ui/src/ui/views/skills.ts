import { html, nothing } from "lit";
import type { SkillMessageMap } from "../controllers/skills.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { clampText } from "../format.ts";
import { icons } from "../icons.ts";
import { renderJsonBlock } from "./json-renderer.ts";

type SkillGroup = {
  id: string;
  label: string;
  skills: SkillStatusEntry[];
};

const SKILL_SOURCE_GROUPS: Array<{ id: string; label: string; sources: string[] }> = [
  { id: "workspace", label: "Workspace Skills", sources: ["openclaw-workspace"] },
  { id: "built-in", label: "Built-in Skills", sources: ["openclaw-bundled"] },
  { id: "installed", label: "Installed Skills", sources: ["openclaw-managed"] },
  { id: "extra", label: "Extra Skills", sources: ["openclaw-extra"] },
];

let selectedSkillKey: string | null = null;

function groupSkills(skills: SkillStatusEntry[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const def of SKILL_SOURCE_GROUPS) {
    groups.set(def.id, { id: def.id, label: def.label, skills: [] });
  }
  const builtInGroup = SKILL_SOURCE_GROUPS.find((group) => group.id === "built-in");
  const other: SkillGroup = { id: "other", label: "Other Skills", skills: [] };
  for (const skill of skills) {
    const match = skill.bundled
      ? builtInGroup
      : SKILL_SOURCE_GROUPS.find((group) => group.sources.includes(skill.source));
    if (match) {
      groups.get(match.id)?.skills.push(skill);
    } else {
      other.skills.push(skill);
    }
  }
  const ordered = SKILL_SOURCE_GROUPS.map((group) => groups.get(group.id)).filter(
    (group): group is SkillGroup => Boolean(group && group.skills.length > 0),
  );
  if (other.skills.length > 0) {
    ordered.push(other);
  }
  return ordered;
}

export type SkillsProps = {
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
};

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const apiKey = props.edits[skill.skillKey] ?? "";
  const message = props.messages[skill.skillKey] ?? null;
  const canInstall = skill.install.length > 0 && skill.missing.bins.length > 0;
  const missing = [
    ...skill.missing.bins.map((b: string) => `bin:${b}`),
    ...skill.missing.env.map((e: string) => `env:${e}`),
    ...skill.missing.config.map((c: string) => `config:${c}`),
    ...skill.missing.os.map((o: string) => `os:${o}`),
  ];

  const requestUpdate = () => props.onFilterChange(props.filter);

  return html`
    <div class="log-detail" style="max-height: none;">
      <div class="log-detail-header">
        <div class="card-title" style="font-size: 13px; display: flex; align-items: center; gap: 6px;">
          <span class="icon" style="width: 14px; height: 14px;">${icons.puzzle}</span>
          ${skill.name}
        </div>
        <button class="btn btn--sm" @click=${() => { selectedSkillKey = null; requestUpdate(); }}><span class="icon" style="width:12px;height:12px;">${icons.x}</span></button>
      </div>
      <div class="log-detail-fields">
        <div class="log-detail-field">
          <div class="log-detail-label">Description</div>
          <div class="log-detail-value">${skill.description}</div>
        </div>
        <div class="log-detail-row-inline">
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Status</div>
            <div class="log-detail-value">
              <span class="log-level ${skill.eligible ? "info" : "warn"}">${skill.eligible ? "ELIGIBLE" : "BLOCKED"}</span>
            </div>
          </div>
          <div class="log-detail-field" style="flex: 1;">
            <div class="log-detail-label">Source</div>
            <div class="log-detail-value mono">${skill.source}</div>
          </div>
        </div>
        ${skill.disabled ? html`
          <div class="log-detail-field">
            <div class="log-detail-label">State</div>
            <div class="log-detail-value"><span class="log-level warn">DISABLED</span></div>
          </div>
        ` : nothing}
        ${missing.length > 0 ? html`
          <div class="log-detail-field">
            <div class="log-detail-label">Missing</div>
            <div class="chip-row">${missing.map((m: string) => html`<span class="chip chip-warn">${m}</span>`)}</div>
          </div>
        ` : nothing}
        ${skill.primaryEnv ? html`
          <div class="log-detail-field">
            <div class="log-detail-label">API Key</div>
            <div class="row" style="gap: 8px;">
              <input type="password" style="flex: 1; font-size: 12px;"
                .value=${apiKey}
                @input=${(e: Event) => props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)} />
              <button class="btn btn--sm primary" ?disabled=${busy}
                @click=${() => props.onSaveKey(skill.skillKey)}>Save</button>
            </div>
          </div>
        ` : nothing}
        <div class="row" style="gap: 8px; margin-top: 4px;">
          <button class="btn btn--sm" ?disabled=${busy}
            @click=${() => props.onToggle(skill.skillKey, skill.disabled)}>
            ${skill.disabled ? "Enable" : "Disable"}
          </button>
          ${canInstall ? html`
            <button class="btn btn--sm" ?disabled=${busy}
              @click=${() => props.onInstall(skill.skillKey, skill.name, skill.install[0].id)}>
              ${busy ? "Installing…" : skill.install[0].label}
            </button>
          ` : nothing}
        </div>
        ${message ? html`
          <div class="callout ${message.kind === "error" ? "danger" : ""}" style="margin-top: 4px; font-size: 12px;">
            ${message.message}
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];
  const filter = props.filter.trim().toLowerCase();
  const filtered = filter
    ? skills.filter((skill) =>
        [skill.name, skill.description, skill.source].join(" ").toLowerCase().includes(filter),
      )
    : skills;
  const groups = groupSkills(filtered);
  const allSkills = groups.flatMap((g) => g.skills);
  const selectedSkill = allSkills.find((s) => s.skillKey === selectedSkillKey) ?? null;
  if (!selectedSkill) selectedSkillKey = null;

  const requestUpdate = () => props.onFilterChange(props.filter);

  return html`
    <section class="card" style="padding: 0;">
      <div class="row" style="justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border);">
        <div>
          <div class="card-title">Skills</div>
          <div class="card-sub">${filtered.length} skills</div>
        </div>
        <div class="row" style="gap: 8px;">
          <input type="text" style="width: 200px; font-size: 12px;"
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Search skills" />
          <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      ${props.error ? html`<div class="callout danger" style="margin: 12px 14px;">${props.error}</div>` : nothing}

      <div class="logs-split ${selectedSkill ? "logs-split--open" : ""}">
        <div style="flex: 1; min-width: 0; overflow: hidden;">
          <div class="log-stream" style="max-height: 600px;">
            <div class="log-header" style="grid-template-columns: 20px minmax(140px, 200px) minmax(0, 1fr) 80px 70px;">
              <div class="log-header-cell"></div>
              <div class="log-header-cell">Name</div>
              <div class="log-header-cell">Description</div>
              <div class="log-header-cell">Source</div>
              <div class="log-header-cell">Status</div>
            </div>
            ${filtered.length === 0
              ? html`<div class="muted" style="padding: 12px 14px;">No skills found.</div>`
              : groups.map((group) => html`
                  <div class="debug-snapshot-row" style="background: var(--bg-elevated); cursor: default; padding: 4px 12px;">
                    <div style="font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em;">${group.label}</div>
                    <div class="mono" style="font-size: 11px; color: var(--muted);">${group.skills.length}</div>
                  </div>
                  ${group.skills.map((skill) => html`
                    <div class="log-row ${selectedSkillKey === skill.skillKey ? "selected" : ""}"
                      style="grid-template-columns: 20px minmax(140px, 200px) minmax(0, 1fr) 80px 70px;"
                      @click=${() => { selectedSkillKey = skill.skillKey; requestUpdate(); }}>
                      <div style="width: 14px; height: 14px; flex-shrink: 0; color: var(--muted); display: flex; align-items: center; justify-content: center;">${icons.puzzle}</div>
                      <div style="font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${skill.name}</div>
                      <div class="log-message mono">${clampText(skill.description, 80)}</div>
                      <div class="mono" style="font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${skill.source.replace("openclaw-", "")}</div>
                      <div><span class="log-level ${skill.eligible ? "info" : "warn"}" style="font-size: 10px;">${skill.eligible ? "OK" : "BLOCKED"}</span></div>
                    </div>
                  `)}
                `)
            }
          </div>
        </div>
        ${selectedSkill ? renderSkillDetail(selectedSkill, props) : nothing}
      </div>
    </section>
  `;
}
