import { html, nothing } from "lit";
import { normalizeToolName } from "../../../../src/agents/tool-policy-shared.js";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import type {
  SkillStatusEntry,
  SkillStatusReport,
  ToolsCatalogResult,
  ToolsEffectiveEntry,
  ToolsEffectiveResult,
} from "../types.ts";
import {
  type AgentToolEntry,
  type AgentToolSection,
  isAllowedByPolicy,
  matchesList,
  resolveAgentConfig,
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

function renderToolMetaBadges(labels: string[]) {
  if (labels.length === 0) {
    return nothing;
  }
  return html`
    <div class="agent-tool-badges">
      ${labels.map((label) => html`<span class="agent-pill">${label}</span>`)}
    </div>
  `;
}

function buildCatalogBadgeLabels(section: AgentToolSection, tool: AgentToolEntry): string[] {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  const badges: string[] = [];
  if (source === "plugin" && pluginId) {
    badges.push(`Plugin: ${pluginId}`);
  } else if (source === "core") {
    badges.push(t("agentTools.builtInBadge"));
  }
  if (tool.optional) {
    badges.push("Optional");
  }
  return badges;
}

function buildRowStatusBadges(params: {
  section: AgentToolSection;
  tool: AgentToolEntry;
  activeEntry: ToolsEffectiveEntry | null;
}) {
  const badges = buildCatalogBadgeLabels(params.section, params.tool);
  if (params.activeEntry) {
    badges.unshift(t("agentTools.liveNowBadge"));
  }
  return badges;
}

function formatToolPolicyState(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return t("agentTools.policy.disabledByOverride");
  }
  if (params.allowed && params.baseAllowed) {
    return t("agentTools.policy.enabledByProfile");
  }
  if (params.allowed) {
    return t("agentTools.policy.enabledByOverride");
  }
  return t("agentTools.policy.notIncluded");
}

function formatToolSourceLabel(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  if (source === "plugin" && pluginId) {
    return `Plugin: ${pluginId}`;
  }
  return t("agentTools.builtInBadge");
}

function formatToolAccessSummary(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return t("agentTools.access.overrideOff");
  }
  if (params.allowed && params.baseAllowed) {
    return t("agentTools.access.enabled");
  }
  if (params.allowed) {
    return t("agentTools.access.overrideOn");
  }
  return t("agentTools.access.profileOff");
}

function formatToolRuntimeSummary(params: {
  activeEntry: ToolsEffectiveEntry | null;
  runtimeSessionMatchesSelectedAgent: boolean;
}) {
  if (params.activeEntry) {
    return t("agentTools.runtime.liveNow");
  }
  if (params.runtimeSessionMatchesSelectedAgent) {
    return t("agentTools.runtime.notLive");
  }
  return t("agentTools.runtime.otherAgent");
}

function toToolAnchorId(toolId: string) {
  const safe = normalizeToolName(toolId).replace(/[^a-z0-9_-]+/g, "-");
  return `agent-tool-${safe}`;
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function flattenEffectiveTools(groups: ToolsEffectiveResult["groups"] | null | undefined) {
  return (groups ?? []).flatMap((group) => group.tools);
}

const MAX_RUNTIME_TOOL_CHIPS = 12;

function handleToolGroupToggle(event: Event) {
  const group = event.currentTarget;
  if (!(group instanceof HTMLDetailsElement) || group.open) {
    return;
  }
  for (const tool of group.querySelectorAll<HTMLDetailsElement>(".agent-tool-card[open]")) {
    tool.open = false;
  }
}

function handleRuntimeToolJump(event: Event, anchorId: string) {
  const target = document.getElementById(anchorId);
  if (!(target instanceof HTMLDetailsElement)) {
    return;
  }

  event.preventDefault();
  const parentGroup = target.closest<HTMLDetailsElement>(".agent-tools-group");
  if (parentGroup) {
    parentGroup.open = true;
  }
  target.open = true;

  const nextUrl = new URL(window.location.href);
  nextUrl.hash = anchorId;
  window.history.replaceState(null, "", nextUrl);

  requestAnimationFrame(() => {
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({
      block: "center",
      behavior: reducedMotion ? "auto" : "smooth",
    });
    target.querySelector<HTMLElement>("summary")?.focus();
  });
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
    ? t("agentTools.source.agentOverride")
    : globalTools.profile
      ? t("agentTools.source.globalDefault")
      : t("agentTools.source.default");
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
  const effectiveTools =
    params.runtimeSessionMatchesSelectedAgent && !params.toolsEffectiveError
      ? flattenEffectiveTools(params.toolsEffectiveResult?.groups)
      : [];
  const uniqueEffectiveTools = Array.from(
    new Map(effectiveTools.map((tool) => [normalizeToolName(tool.id), tool])).values(),
  );
  const visibleEffectiveTools = uniqueEffectiveTools.slice(0, MAX_RUNTIME_TOOL_CHIPS);
  const hiddenEffectiveToolCount = Math.max(
    0,
    uniqueEffectiveTools.length - visibleEffectiveTools.length,
  );
  const liveToolCount = uniqueEffectiveTools.length;
  const activeToolMap = new Map(
    effectiveTools.map((tool) => [normalizeToolName(tool.id), tool] as const),
  );
  const activeToolIds = new Set(activeToolMap.keys());

  const sortSectionTools = (tools: AgentToolEntry[]) =>
    tools.toSorted((left, right) => {
      const leftId = normalizeToolName(left.id);
      const rightId = normalizeToolName(right.id);
      const leftActive = activeToolIds.has(leftId) ? 1 : 0;
      const rightActive = activeToolIds.has(rightId) ? 1 : 0;
      if (leftActive !== rightActive) {
        return rightActive - leftActive;
      }
      const leftAllowed = resolveAllowed(left.id).allowed ? 1 : 0;
      const rightAllowed = resolveAllowed(right.id).allowed ? 1 : 0;
      if (leftAllowed !== rightAllowed) {
        return rightAllowed - leftAllowed;
      }
      return left.label.localeCompare(right.label);
    });

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
      <div class="agent-tools-header">
        <div class="agent-tools-header__intro">
          <div class="card-title">${t("agentTools.title")}</div>
          <div class="card-sub">
            ${t("agentTools.subtitle")}
            <span class="mono">${enabledCount}/${toolIds.length}</span> ${t(
              "agentTools.enabledSuffix",
            )}
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(true)}>
            ${t("agentTools.enableAll")}
          </button>
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(false)}>
            ${t("agentTools.disableAll")}
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
              ${t("agentTools.loadConfigHint")}
            </div>
          `
        : nothing}
      ${hasAgentAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.agentAllowlistHint")}
            </div>
          `
        : nothing}
      ${hasGlobalAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.globalAllowHint")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agentTools.loadingCatalog")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">${t("agentTools.catalogError")}</div>
          `
        : nothing}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">${t("agentTools.availableNow")}</div>
            <div class="card-sub">
              ${t("agentTools.availableNowSub")}
              <span class="mono">${params.runtimeSessionKey || t("agentTools.noSession")}</span>
            </div>
            ${!params.runtimeSessionMatchesSelectedAgent
              ? html`
                  <div class="callout info" style="margin-top: 12px">
                    ${t("agentTools.switchChatHint")}
                  </div>
                `
              : params.toolsEffectiveLoading &&
                  !params.toolsEffectiveResult &&
                  !params.toolsEffectiveError
                ? html`
                    <div class="callout info" style="margin-top: 12px">
                      ${t("agentTools.loadingTools")}
                    </div>
                  `
                : params.toolsEffectiveError
                  ? html`
                      <div class="callout info" style="margin-top: 12px">
                        ${t("agentTools.toolsError")}
                      </div>
                    `
                  : (params.toolsEffectiveResult?.groups?.length ?? 0) === 0
                    ? html`
                        <div class="callout info" style="margin-top: 12px">
                          ${t("agentTools.noToolsAvailable")}
                        </div>
                      `
                    : html`
                        <div class="agent-tools-runtime">
                          ${visibleEffectiveTools.map((tool) => {
                            const anchorId = toToolAnchorId(tool.id);
                            return html`
                              <a
                                class="agent-tools-runtime-chip"
                                href="#${anchorId}"
                                @click=${(event: Event) => handleRuntimeToolJump(event, anchorId)}
                              >
                                <span class="mono" translate="no">${tool.label}</span>
                                <span class="agent-tools-runtime-chip__meta"
                                  >${renderEffectiveToolBadge(tool)}</span
                                >
                              </a>
                            `;
                          })}
                          ${hiddenEffectiveToolCount > 0
                            ? html`
                                <span
                                  class="agent-tools-runtime-chip agent-tools-runtime-chip--more"
                                  title=${t("agentTools.moreLiveToolsTitle", {
                                    count: String(hiddenEffectiveToolCount),
                                  })}
                                >
                                  ${t("agentTools.moreLiveTools", {
                                    count: String(hiddenEffectiveToolCount),
                                  })}
                                </span>
                              `
                            : nothing}
                        </div>
                      `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">${t("agentTools.quickPresets")}</div>
            <div class="agent-tools-buttons">
              ${profileOptions.map(
                (option) => html`
                  <button
                    class="btn btn--sm ${profile === option.id ? "active" : ""}"
                    ?disabled=${!editable}
                    @click=${() => params.onProfileChange(params.agentId, option.id, true)}
                  >
                    ${option.label}
                  </button>
                `,
              )}
              <button
                class="btn btn--sm"
                ?disabled=${!editable}
                @click=${() => params.onProfileChange(params.agentId, null, false)}
              >
                ${t("agentTools.inherit")}
              </button>
            </div>
          </div>
        </div>

        <div class="agent-tools-facts">
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.fact.profile")}</div>
            <div class="mono">${profile}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.fact.source")}</div>
            <div>${profileSource}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.fact.enabled")}</div>
            <div class="mono">${enabledCount}/${toolIds.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.fact.live")}</div>
            <div class="mono">${liveToolCount}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${t("agentTools.fact.status")}</div>
            <div class="mono">
              ${params.configSaving
                ? t("agentTools.status.saving")
                : params.configDirty
                  ? t("agentTools.status.unsaved")
                  : t("agentTools.status.saved")}
            </div>
          </div>
        </div>
      </div>

      <div class="agent-tools-grid">
        ${toolSections.map((section) => {
          const sortedTools = sortSectionTools(section.tools);
          const enabledSectionCount = section.tools.filter(
            (tool) => resolveAllowed(tool.id).allowed,
          ).length;
          const activeSectionCount = section.tools.filter((tool) =>
            activeToolIds.has(normalizeToolName(tool.id)),
          ).length;
          const previewTools = sortedTools.slice(0, 4);
          const remainingPreviewCount = Math.max(0, sortedTools.length - previewTools.length);
          return html`
            <details class="agent-tools-group" @toggle=${handleToolGroupToggle}>
              <summary class="agent-tools-group__summary">
                <span class="agent-tools-group__summary-main">
                  <span class="agent-tools-group__title">
                    ${section.label}
                    ${section.source === "plugin" && section.pluginId
                      ? html`<span class="agent-pill">Plugin: ${section.pluginId}</span>`
                      : nothing}
                  </span>
                  <span
                    class="agent-tools-group__preview"
                    aria-label=${t("agentTools.toolPreview")}
                  >
                    ${previewTools.map(
                      (tool) =>
                        html`<span class="mono" translate="no" title=${tool.label}
                          >${tool.label}</span
                        >`,
                    )}
                    ${remainingPreviewCount > 0
                      ? html`<span>+${remainingPreviewCount} more</span>`
                      : nothing}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span
                    >${formatCountLabel(
                      section.tools.length,
                      t("agentTools.count.tool"),
                      t("agentTools.count.tool"),
                    )}</span
                  >
                  <span
                    >${formatCountLabel(
                      enabledSectionCount,
                      t("agentTools.count.enabledTool"),
                      t("agentTools.count.enabledTool"),
                    )}</span
                  >
                  ${activeSectionCount > 0
                    ? html`<span
                        >${formatCountLabel(
                          activeSectionCount,
                          t("agentTools.count.liveTool"),
                          t("agentTools.count.liveTool"),
                        )}</span
                      >`
                    : nothing}
                </span>
              </summary>
              <div class="agent-tools-list agent-tools-list--stacked">
                ${sortedTools.map((tool) => {
                  const anchorId = toToolAnchorId(tool.id);
                  const resolved = resolveAllowed(tool.id);
                  const activeEntry = activeToolMap.get(normalizeToolName(tool.id)) ?? null;
                  const defaultProfiles = tool.defaultProfiles ?? [];
                  const rowBadges = buildRowStatusBadges({
                    section,
                    tool,
                    activeEntry,
                  });
                  const accessSummary = formatToolAccessSummary(resolved);
                  const runtimeSummary = formatToolRuntimeSummary({
                    activeEntry,
                    runtimeSessionMatchesSelectedAgent: params.runtimeSessionMatchesSelectedAgent,
                  });
                  return html`
                    <details class="agent-tool-card" id=${anchorId}>
                      <summary class="agent-tool-summary">
                        <div class="agent-tool-summary__main">
                          <div class="agent-tool-summary__title-row">
                            <span class="agent-tool-title mono" translate="no">${tool.label}</span>
                          </div>
                          <div class="agent-tool-sub">${tool.description}</div>
                        </div>
                        <dl class="agent-tool-summary__facts">
                          <div class="agent-tool-summary__fact">
                            <dt class="label">${t("agentTools.detail.access")}</dt>
                            <dd>${accessSummary}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">${t("agentTools.detail.session")}</dt>
                            <dd>${runtimeSummary}</dd>
                          </div>
                        </dl>
                        <div class="agent-tool-summary__badges">
                          ${renderToolMetaBadges(rowBadges)}
                        </div>
                        <label
                          class="cfg-toggle agent-tool-toggle"
                          @click=${(event: Event) => event.stopPropagation()}
                          @keydown=${(event: KeyboardEvent) => event.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            .checked=${resolved.allowed}
                            ?disabled=${!editable}
                            aria-label=${`${resolved.allowed ? t("agentTools.detail.disable") : t("agentTools.detail.enable")} ${tool.label}`}
                            @change=${(e: Event) =>
                              updateTool(tool.id, (e.target as HTMLInputElement).checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.detail.access")}</div>
                            <div>${formatToolPolicyState(resolved)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.fact.source")}</div>
                            <div>${formatToolSourceLabel(section, tool)}</div>
                          </div>
                          ${defaultProfiles.length > 0
                            ? html`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">${t("agentTools.detail.defaultPresets")}</div>
                                  <div class="agent-tool-badges">
                                    ${defaultProfiles.map(
                                      (profileId) =>
                                        html`<span class="agent-pill">${profileId}</span>`,
                                    )}
                                  </div>
                                </div>
                              `
                            : nothing}
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${t("agentTools.detail.currentSession")}</div>
                            <div>
                              ${activeEntry
                                ? t("agentTools.detail.availableNow", {
                                    badge: renderEffectiveToolBadge(activeEntry),
                                  })
                                : params.runtimeSessionMatchesSelectedAgent
                                  ? t("agentTools.detail.notAvailable")
                                  : t("agentTools.detail.switchChat")}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${anchorId}">
                            ${t("agentTools.detail.link")}
                          </a>
                        </div>
                      </div>
                    </details>
                  `;
                })}
              </div>
            </details>
          `;
        })}
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
          <div class="card-title">${t("agents.skills.title")}</div>
          <div class="card-sub">
            ${t("agents.skills.subtitle")}
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
              ${t("agents.skills.enableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onDisableAll(params.agentId)}
            >
              ${t("agents.skills.disableAll")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable || !usingAllowlist}
              @click=${() => params.onClear(params.agentId)}
              title=${t("agents.skills.resetTitle")}
            >
              ${t("agents.skills.reset")}
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
              ${t("agents.skills.loadConfigHint")}
            </div>
          `
        : nothing}
      ${usingAllowlist
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skills.customAllowlist")}
            </div>
          `
        : html`
            <div class="callout info" style="margin-top: 12px">
              All skills are ${t("agentTools.enabledSuffix")} Disabling any skill will create a
              per-agent allowlist.
            </div>
          `}
      ${!reportReady && !params.loading
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${t("agents.skills.loadSkillsHint")}
            </div>
          `
        : nothing}
      ${params.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
        : nothing}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>${t("agents.skills.filter")}</span>
          <input
            .value=${params.filter}
            @input=${(e: Event) => params.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder=${t("agents.skills.searchPlaceholder")}
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">${t("agents.skills.shown", { count: String(filtered.length) })}</div>
      </div>

      ${filtered.length === 0
        ? html` <div class="muted" style="margin-top: 16px">${t("agents.skills.noSkills")}</div> `
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
          ? html`<div class="muted" style="margin-top: 6px;">Missing: ${missing.join(", ")}</div>`
          : nothing}
        ${reasons.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">Reason: ${reasons.join(", ")}</div>`
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
