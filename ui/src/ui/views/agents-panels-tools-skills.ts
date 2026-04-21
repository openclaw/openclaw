import { html, nothing } from "lit";
import { normalizeToolName } from "../../../../src/agents/tool-policy-shared.js";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type {
  SkillStatusEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "../types.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  isAllowedByPolicy,
  localizeToolDescription,
  localizeToolGroupLabel,
  matchesList,
  resolveAgentConfig,
  localizeToolProfileLabel,
  resolveToolProfileOptions,
  resolveToolProfile,
  resolveToolSections,
} from "./agents-utils.ts";
import type { SkillGroup } from "./skills-grouping.ts";
import { groupSkills } from "./skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  renderSkillStatusChips,
} from "./skills-shared.ts";

function renderToolBadges(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const badges: string[] = [];
  if (source === "plugin" && pluginId) {
    badges.push(t("agentTools.badges.plugin", { id: pluginId }));
  } else if (source === "core") {
    badges.push(t("agentTools.badges.core"));
  }
  if (tool.optional) {
    badges.push(t("agentTools.badges.optional"));
  }
  if (badges.length === 0) {
    return nothing;
  }
  return html`
    <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;">
      ${badges.map((badge) => html`<span class="agent-pill">${badge}</span>`)}
    </div>
  `;
}

function renderEffectiveToolBadge(tool: {
  source: "core" | "plugin" | "channel";
  pluginId?: string;
  channelId?: string;
}) {
  if (tool.source === "plugin") {
    return tool.pluginId
      ? t("agentTools.connectedSource", { id: tool.pluginId })
      : t("agentTools.connected");
  }
  if (tool.source === "channel") {
    return tool.channelId
      ? t("agentTools.channelSource", { id: tool.channelId })
      : t("agentTools.channel");
  }
  return t("agentTools.builtIn");
}

function resolveProfileSourceLabel(source: "agent override" | "global default" | "default") {
  switch (source) {
    case "agent override":
      return t("agentTools.panel.profileSource.agentOverride");
    case "global default":
      return t("agentTools.panel.profileSource.globalDefault");
    case "default":
    default:
      return t("agentTools.panel.profileSource.default");
  }
}

export function renderAgentTools(params: {
  agentId: string;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  toolsCatalogLoading: boolean;
  toolsCatalogError: string | null;
  toolsCatalogResult: ToolsCatalogResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: string | null;
  toolsEffectiveResult: ToolsEffectiveResult | null;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  onProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const agentTools = config.entry?.tools ?? {};
  const globalTools = config.globalTools ?? {};
  const profile = agentTools.profile ?? globalTools.profile ?? "full";
  const profileOptions = resolveToolProfileOptions(params.toolsCatalogResult);
  const toolSections = resolveToolSections(params.toolsCatalogResult);
  const profileSource = agentTools.profile
    ? "agent override"
    : globalTools.profile
      ? "global default"
      : "default";
  const hasAgentAllow = Array.isArray(agentTools.allow) && agentTools.allow.length > 0;
  const hasGlobalAllow = Array.isArray(globalTools.allow) && globalTools.allow.length > 0;
  const editable =
    Boolean(params.configForm) &&
    !params.configLoading &&
    !params.configSaving &&
    !hasAgentAllow &&
    !(params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError);
  const alsoAllow = hasAgentAllow
    ? []
    : Array.isArray(agentTools.alsoAllow)
      ? agentTools.alsoAllow
      : [];
  const deny = hasAgentAllow ? [] : Array.isArray(agentTools.deny) ? agentTools.deny : [];
  const basePolicy = hasAgentAllow
    ? { allow: agentTools.allow ?? [], deny: agentTools.deny ?? [] }
    : (resolveToolProfile(profile) ?? undefined);
  const toolIds = toolSections.flatMap((section) => section.tools.map((tool) => tool.id));

  const resolveAllowed = (toolId: string) => {
    const baseAllowed = isAllowedByPolicy(toolId, basePolicy);
    const extraAllowed = matchesList(toolId, alsoAllow);
    const denied = matchesList(toolId, deny);
    const allowed = (baseAllowed || extraAllowed) && !denied;
    return {
      allowed,
      baseAllowed,
      denied,
    };
  };
  const enabledCount = toolIds.filter((toolId) => resolveAllowed(toolId).allowed).length;

  const updateTool = (toolId: string, nextEnabled: boolean) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const baseAllowed = resolveAllowed(toolId).baseAllowed;
    const normalized = normalizeToolName(toolId);
    if (nextEnabled) {
      nextDeny.delete(normalized);
      if (!baseAllowed) {
        nextAllow.add(normalized);
      }
    } else {
      nextAllow.delete(normalized);
      nextDeny.add(normalized);
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  const updateAll = (nextEnabled: boolean) => {
    const nextAllow = new Set(
      alsoAllow.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    const nextDeny = new Set(
      deny.map((entry) => normalizeToolName(entry)).filter((entry) => entry.length > 0),
    );
    for (const toolId of toolIds) {
      const baseAllowed = resolveAllowed(toolId).baseAllowed;
      const normalized = normalizeToolName(toolId);
      if (nextEnabled) {
        nextDeny.delete(normalized);
        if (!baseAllowed) {
          nextAllow.add(normalized);
        }
      } else {
        nextAllow.delete(normalized);
        nextDeny.add(normalized);
      }
    }
    params.onOverridesChange(params.agentId, [...nextAllow], [...nextDeny]);
  };

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">${t("agentTools.panel.title")}</div>
          <div class="card-sub">
            ${t("agentTools.panel.subtitle", {
              enabled: String(enabledCount),
              total: String(toolIds.length),
            })}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(true)}>
            ${t("agentTools.panel.enableAll")}
          </button>
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(false)}>
            ${t("agentTools.panel.disableAll")}
          </button>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.panel.loadConfigHint")}
            </div>
          `
        : nothing}
      ${hasAgentAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.panel.explicitAllowlistHint")}
            </div>
          `
        : nothing}
      ${hasGlobalAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.panel.globalAllowHint")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.panel.catalogLoading")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.panel.catalogFallbackHint")}
            </div>
          `
        : nothing}

      <div class="agent-tools-meta" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">${t("agentTools.panel.profile")}</div>
          <div class="mono">${localizeToolProfileLabel(profile, profile)}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agentTools.panel.source")}</div>
          <div>${resolveProfileSourceLabel(profileSource)}</div>
        </div>
        ${params.configDirty
          ? html`
              <div class="agent-kv">
                <div class="label">${t("agentTools.panel.status")}</div>
                <div class="mono">${t("agentTools.panel.unsaved")}</div>
              </div>
            `
          : nothing}
      </div>

      <div style="margin-top: 18px;">
        <div class="label">${t("agentTools.panel.availableNowTitle")}</div>
        <div class="card-sub">
          ${t("agentTools.panel.availableNowSubtitle")}
          <span class="mono">${params.runtimeSessionKey || t("agentTools.panel.noSession")}</span>
        </div>
        ${!params.runtimeSessionMatchesSelectedAgent
          ? html`
              <div class="callout info" style="margin-top: 12px">
                ${t("agentTools.panel.switchChatHint")}
              </div>
            `
          : params.toolsEffectiveLoading &&
              !params.toolsEffectiveResult &&
              !params.toolsEffectiveError
            ? html`
                <div class="callout info" style="margin-top: 12px">
                  ${t("agentTools.panel.effectiveLoading")}
                </div>
              `
            : params.toolsEffectiveError
              ? html`
                  <div class="callout info" style="margin-top: 12px">
                    ${t("agentTools.panel.effectiveError")}
                  </div>
                `
              : (params.toolsEffectiveResult?.groups?.length ?? 0) === 0
                ? html`
                    <div class="callout info" style="margin-top: 12px">
                      ${t("agentTools.panel.effectiveEmpty")}
                    </div>
                  `
                : html`
                    <div class="agent-tools-grid" style="margin-top: 16px;">
                      ${params.toolsEffectiveResult?.groups.map(
                        (group) => html`
                          <div class="agent-tools-section">
                            <div class="agent-tools-header">
                              ${localizeToolGroupLabel(group.id, group.label)}
                            </div>
                            <div class="agent-tools-list">
                              ${group.tools.map((tool) => {
                                return html`
                                  <div class="agent-tool-row">
                                    <div>
                                      <div class="agent-tool-title">${tool.label}</div>
                                      <div class="agent-tool-sub">
                                        ${localizeToolDescription(tool.id, tool.description)}
                                      </div>
                                      <div
                                        style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px;"
                                      >
                                        <span class="agent-pill"
                                          >${renderEffectiveToolBadge(tool)}</span
                                        >
                                      </div>
                                    </div>
                                  </div>
                                `;
                              })}
                            </div>
                          </div>
                        `,
                      )}
                    </div>
                  `}
      </div>

      <div class="agent-tools-presets" style="margin-top: 16px;">
        <div class="label">${t("agentTools.panel.quickPresets")}</div>
        <div class="agent-tools-buttons">
          ${profileOptions.map(
            (option) => html`
              <button
                class="btn btn--sm ${profile === option.id ? "active" : ""}"
                ?disabled=${!editable}
                @click=${() => params.onProfileChange(params.agentId, option.id, true)}
              >
                ${localizeToolProfileLabel(option.id, option.label)}
              </button>
            `,
          )}
          <button
            class="btn btn--sm"
            ?disabled=${!editable}
            @click=${() => params.onProfileChange(params.agentId, null, false)}
          >
            ${t("agentTools.panel.inherit")}
          </button>
        </div>
      </div>

      <div class="agent-tools-grid" style="margin-top: 20px;">
        ${toolSections.map(
          (section) => html`
            <div class="agent-tools-section">
              <div class="agent-tools-header">
                ${section.label}
                ${section.source === "plugin" && section.pluginId
                  ? html`<span class="agent-pill" style="margin-left: 8px;"
                      >${t("agentTools.badges.plugin", { id: section.pluginId })}</span
                    >`
                  : nothing}
              </div>
              <div class="agent-tools-list">
                ${section.tools.map((tool) => {
                  const { allowed } = resolveAllowed(tool.id);
                  return html`
                    <div class="agent-tool-row">
                      <div>
                        <div class="agent-tool-title mono">${tool.label}</div>
                        <div class="agent-tool-sub">${tool.description}</div>
                        ${renderToolBadges(section, tool)}
                      </div>
                      <label class="cfg-toggle">
                        <input
                          type="checkbox"
                          .checked=${allowed}
                          ?disabled=${!editable}
                          @change=${(e: Event) =>
                            updateTool(tool.id, (e.target as HTMLInputElement).checked)}
                        />
                        <span class="cfg-toggle__track"></span>
                      </label>
                    </div>
                  `;
                })}
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

export function renderAgentSkills(params: {
  agentId: string;
  report: SkillStatusReport | null;
  loading: boolean;
  error: string | null;
  activeAgentId: string | null;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  filter: string;
  onFilterChange: (next: string) => void;
  onRefresh: () => void;
  onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onClear: (agentId: string) => void;
  onDisableAll: (agentId: string) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
}) {
  const editable = Boolean(params.configForm) && !params.configLoading && !params.configSaving;
  const config = resolveAgentConfig(params.configForm, params.agentId);
  const allowlist = Array.isArray(config.entry?.skills) ? config.entry?.skills : undefined;
  const allowSet = new Set((allowlist ?? []).map((name) => name.trim()).filter(Boolean));
  const usingAllowlist = allowlist !== undefined;
  const reportReady = Boolean(params.report && params.activeAgentId === params.agentId);
  const rawSkills = reportReady ? (params.report?.skills ?? []) : [];
  const filter = normalizeLowercaseStringOrEmpty(params.filter);
  const filtered = filter
    ? rawSkills.filter((skill) =>
        normalizeLowercaseStringOrEmpty(
          [skill.name, skill.description, skill.source].join(" "),
        ).includes(filter),
      )
    : rawSkills;
  const groups = groupSkills(filtered);
  const enabledCount = usingAllowlist
    ? rawSkills.filter((skill) => allowSet.has(skill.name)).length
    : rawSkills.length;
  const totalCount = rawSkills.length;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; flex-wrap: wrap;">
        <div style="min-width: 0;">
          <div class="card-title">${t("skillsPage.title")}</div>
          <div class="card-sub">
            ${t("skillsPage.agent.subtitle")}
            ${totalCount > 0
              ? html`<span class="mono">${enabledCount}/${totalCount}</span>`
              : nothing}
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap;">
          <div
            class="row"
            style="gap: 4px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 2px;"
          >
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onClear(params.agentId)}
            >
              ${t("skillsPage.agent.enableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onDisableAll(params.agentId)}
            >
              ${t("skillsPage.agent.disableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable || !usingAllowlist}
              @click=${() => params.onClear(params.agentId)}
              title=${t("skillsPage.agent.resetTitle")}
            >
              ${t("skillsPage.agent.reset")}
            </button>
          </div>
          <button
            class="btn btn--sm"
            ?disabled=${params.configLoading}
            @click=${params.onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button class="btn btn--sm" ?disabled=${params.loading} @click=${params.onRefresh}>
            ${params.loading ? t("common.loading") : t("common.refresh")}
          </button>
          <button
            class="btn btn--sm primary"
            ?disabled=${params.configSaving || !params.configDirty}
            @click=${params.onConfigSave}
          >
            ${params.configSaving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("skillsPage.agent.loadConfigHint")}
            </div>
          `
        : nothing}
      ${usingAllowlist
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("skillsPage.agent.customAllowlistHint")}
            </div>
          `
        : html`
            <div class="callout info" style="margin-top: 12px">
              ${t("skillsPage.agent.allEnabledHint")}
            </div>
          `}
      ${!reportReady && !params.loading
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("skillsPage.agent.loadSkillsHint")}
            </div>
          `
        : nothing}
      ${params.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
        : nothing}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>${t("skillsPage.agent.filterLabel")}</span>
          <input
            .value=${params.filter}
            @input=${(e: Event) => params.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder=${t("skillsPage.agent.searchPlaceholder")}
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${t("skillsPage.shownCount", { count: String(filtered.length) })}</div>
      </div>

      ${filtered.length === 0
        ? html`
            <div class="muted" style="margin-top: 16px">${t("skillsPage.empty.noSkills")}</div>
          `
        : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) =>
                renderAgentSkillGroup(group, {
                  agentId: params.agentId,
                  allowSet,
                  usingAllowlist,
                  editable,
                  onToggle: params.onToggle,
                }),
              )}
            </div>
          `}
    </section>
  `;
}

function renderAgentSkillGroup(
  group: SkillGroup,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const collapsedByDefault = group.id === "workspace" || group.id === "built-in";
  return html`
    <details class="agent-skills-group" ?open=${!collapsedByDefault}>
      <summary class="agent-skills-header">
        <span>${group.label}</span>
        <span class="muted">${group.skills.length}</span>
      </summary>
      <div class="list skills-grid">
        ${group.skills.map((skill) =>
          renderAgentSkillRow(skill, {
            agentId: params.agentId,
            allowSet: params.allowSet,
            usingAllowlist: params.usingAllowlist,
            editable: params.editable,
            onToggle: params.onToggle,
          }),
        )}
      </div>
    </details>
  `;
}

function renderAgentSkillRow(
  skill: SkillStatusEntry,
  params: {
    agentId: string;
    allowSet: Set<string>;
    usingAllowlist: boolean;
    editable: boolean;
    onToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  },
) {
  const enabled = params.usingAllowlist ? params.allowSet.has(skill.name) : true;
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  return html`
    <div class="list-item agent-skill-row">
      <div class="list-main">
        <div class="list-title">${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}</div>
        <div class="list-sub">${skill.description}</div>
        ${renderSkillStatusChips({ skill })}
        ${missing.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">
              ${t("skillsPage.agent.missing", { items: missing.join(", ") })}
            </div>`
          : nothing}
        ${reasons.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">
              ${t("skillsPage.detail.reason", { reasons: reasons.join(", ") })}
            </div>`
          : nothing}
      </div>
      <div class="list-meta">
        <label class="cfg-toggle">
          <input
            type="checkbox"
            .checked=${enabled}
            ?disabled=${!params.editable}
            @change=${(e: Event) =>
              params.onToggle(params.agentId, skill.name, (e.target as HTMLInputElement).checked)}
          />
          <span class="cfg-toggle__track"></span>
        </label>
      </div>
    </div>
  `;
}
