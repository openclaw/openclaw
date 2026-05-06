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
import { viDashboardText as uiText } from "../vi-dashboard-text.ts";
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
    badges.push(uiText("Built-In", "Tích hợp sẵn"));
  }
  if (tool.optional) {
    badges.push(uiText("Optional", "Tùy chọn"));
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
    badges.unshift(uiText("Live Now", "Đang live"));
  }
  return badges;
}

function formatToolPolicyState(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return uiText("Disabled by agent override.", "Đã tắt bởi ghi đè agent.");
  }
  if (params.allowed && params.baseAllowed) {
    return uiText("Enabled by the current profile.", "Được bật bởi hồ sơ hiện tại.");
  }
  if (params.allowed) {
    return uiText("Enabled by agent override.", "Được bật bởi ghi đè agent.");
  }
  return uiText("Not included in the current profile.", "Không có trong hồ sơ hiện tại.");
}

function formatToolSourceLabel(section: AgentToolSection, tool: AgentToolEntry) {
  const source = tool.source ?? section.source;
  const pluginId = tool.pluginId ?? section.pluginId;
  if (source === "plugin" && pluginId) {
    return `Plugin: ${pluginId}`;
  }
  return uiText("Built-In", "Tích hợp sẵn");
}

function formatToolAccessSummary(params: {
  allowed: boolean;
  baseAllowed: boolean;
  denied: boolean;
}) {
  if (params.denied) {
    return uiText("Override Off", "Ghi đè tắt");
  }
  if (params.allowed && params.baseAllowed) {
    return uiText("Enabled", "Đã bật");
  }
  if (params.allowed) {
    return uiText("Override On", "Ghi đè bật");
  }
  return uiText("Profile Off", "Hồ sơ tắt");
}

function formatToolRuntimeSummary(params: {
  activeEntry: ToolsEffectiveEntry | null;
  runtimeSessionMatchesSelectedAgent: boolean;
}) {
  if (params.activeEntry) {
    return uiText("Live Now", "Đang live");
  }
  if (params.runtimeSessionMatchesSelectedAgent) {
    return uiText("Not Live", "Chưa live");
  }
  return uiText("Other Agent", "Agent khác");
}

function toToolAnchorId(toolId: string) {
  const safe = normalizeToolName(toolId).replace(/[^a-z0-9_-]+/g, "-");
  return `agent-tool-${safe}`;
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return uiText(
    `${count} ${count === 1 ? singular : plural}`,
    `${count} ${singular === "Tool" || singular.includes("Tool") ? "công cụ" : singular}`,
  );
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
    ? uiText("agent override", "ghi đè agent")
    : globalTools.profile
      ? uiText("global default", "mặc định toàn cục")
      : uiText("default", "mặc định");
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
          <div class="card-title">${uiText("Tool Access", "Quyền công cụ")}</div>
          <div class="card-sub">
            ${uiText(
              "Profile + per-tool overrides for this agent.",
              "Hồ sơ + ghi đè từng công cụ cho agent này.",
            )}
            <span class="mono">${enabledCount}/${toolIds.length}</span>
            ${uiText("enabled.", "đã bật.")}
          </div>
        </div>
        <div class="agent-tools-header__actions">
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(true)}>
            ${uiText("Enable All", "Bật tất cả")}
          </button>
          <button class="btn btn--sm" ?disabled=${!editable} @click=${() => updateAll(false)}>
            ${uiText("Disable All", "Tắt tất cả")}
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
            ${params.configSaving ? uiText("Saving…", "Đang lưu…") : uiText("Save", "Lưu")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "Load the gateway config to adjust tool profiles.",
                "Tải cấu hình gateway để chỉnh hồ sơ công cụ.",
              )}
            </div>
          `
        : nothing}
      ${hasAgentAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "This agent is using an explicit allowlist in config. Tool overrides are managed in the Config tab.",
                "Agent này đang dùng allowlist rõ ràng trong cấu hình. Ghi đè công cụ được quản lý trong tab Cấu hình.",
              )}
            </div>
          `
        : nothing}
      ${hasGlobalAllow
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "Global tools.allow is set. Agent overrides cannot enable tools that are globally blocked.",
                "Đã đặt tools.allow toàn cục. Ghi đè agent không thể bật công cụ bị chặn toàn cục.",
              )}
            </div>
          `
        : nothing}
      ${params.toolsCatalogLoading && !params.toolsCatalogResult && !params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText("Loading runtime tool catalog…", "Đang tải danh mục công cụ runtime…")}
            </div>
          `
        : nothing}
      ${params.toolsCatalogError
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "Could not load runtime tool catalog. Showing built-in fallback list instead.",
                "Không tải được danh mục công cụ runtime. Đang hiển thị danh sách fallback tích hợp.",
              )}
            </div>
          `
        : nothing}

      <div class="agent-tools-overview">
        <div class="agent-tools-overview__primary">
          <div class="agent-tools-pane">
            <div class="label">${uiText("Available Right Now", "Có sẵn ngay lúc này")}</div>
            <div class="card-sub">
              ${uiText(
                "What this agent can use in the current chat session.",
                "Những gì agent này có thể dùng trong phiên chat hiện tại.",
              )}
              <span class="mono"
                >${params.runtimeSessionKey || uiText("no session", "chưa có phiên")}</span
              >
            </div>
            ${!params.runtimeSessionMatchesSelectedAgent
              ? html`
                  <div class="callout info" style="margin-top: 12px">
                    ${uiText(
                      "Switch chat to this agent to view its live runtime tools.",
                      "Chuyển chat sang agent này để xem công cụ runtime live.",
                    )}
                  </div>
                `
              : params.toolsEffectiveLoading &&
                  !params.toolsEffectiveResult &&
                  !params.toolsEffectiveError
                ? html`
                    <div class="callout info" style="margin-top: 12px">
                      ${uiText("Loading available tools…", "Đang tải công cụ khả dụng…")}
                    </div>
                  `
                : params.toolsEffectiveError
                  ? html`
                      <div class="callout info" style="margin-top: 12px">
                        ${uiText(
                          "Could not load available tools for this session.",
                          "Không tải được công cụ khả dụng cho phiên này.",
                        )}
                      </div>
                    `
                  : (params.toolsEffectiveResult?.groups?.length ?? 0) === 0
                    ? html`
                        <div class="callout info" style="margin-top: 12px">
                          ${uiText(
                            "No tools are available for this session right now.",
                            "Hiện chưa có công cụ nào khả dụng cho phiên này.",
                          )}
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
                                  title=${uiText(
                                    `${hiddenEffectiveToolCount} more live tools are available in the groups below.`,
                                    `${hiddenEffectiveToolCount} công cụ live khác có trong các nhóm bên dưới.`,
                                  )}
                                >
                                  ${uiText(
                                    `+${hiddenEffectiveToolCount} more live tools`,
                                    `+${hiddenEffectiveToolCount} công cụ live khác`,
                                  )}
                                </span>
                              `
                            : nothing}
                        </div>
                      `}
          </div>

          <div class="agent-tools-pane">
            <div class="label">${uiText("Quick Presets", "Preset nhanh")}</div>
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
                ${uiText("Inherit", "Kế thừa")}
              </button>
            </div>
          </div>
        </div>

        <div class="agent-tools-facts">
          <div class="agent-tools-fact">
            <div class="label">${uiText("Profile", "Hồ sơ")}</div>
            <div class="mono">${profile}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${uiText("Source", "Nguồn")}</div>
            <div>${profileSource}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${uiText("Enabled", "Đã bật")}</div>
            <div class="mono">${enabledCount}/${toolIds.length}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${uiText("Live", "Live")}</div>
            <div class="mono">${liveToolCount}</div>
          </div>
          <div class="agent-tools-fact">
            <div class="label">${uiText("Status", "Trạng thái")}</div>
            <div class="mono">
              ${params.configSaving
                ? uiText("saving…", "đang lưu…")
                : params.configDirty
                  ? uiText("unsaved", "chưa lưu")
                  : uiText("saved", "đã lưu")}
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
                    aria-label=${uiText("Tool preview", "Xem trước công cụ")}
                  >
                    ${previewTools.map(
                      (tool) =>
                        html`<span class="mono" translate="no" title=${tool.label}
                          >${tool.label}</span
                        >`,
                    )}
                    ${remainingPreviewCount > 0
                      ? html`<span>
                          ${uiText(
                            `+${remainingPreviewCount} more`,
                            `+${remainingPreviewCount} nữa`,
                          )}
                        </span>`
                      : nothing}
                  </span>
                </span>
                <span class="agent-tools-group__counts">
                  <span>${formatCountLabel(section.tools.length, "Tool")}</span>
                  <span>${formatCountLabel(enabledSectionCount, "Enabled Tool")}</span>
                  ${activeSectionCount > 0
                    ? html`<span>${formatCountLabel(activeSectionCount, "Live Tool")}</span>`
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
                            <dt class="label">${uiText("Access", "Quyền")}</dt>
                            <dd>${accessSummary}</dd>
                          </div>
                          <div class="agent-tool-summary__fact">
                            <dt class="label">${uiText("Session", "Phiên")}</dt>
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
                            aria-label=${`${resolved.allowed ? uiText("Disable", "Tắt") : uiText("Enable", "Bật")} ${tool.label}`}
                            @change=${(e: Event) =>
                              updateTool(tool.id, (e.target as HTMLInputElement).checked)}
                          />
                          <span class="cfg-toggle__track"></span>
                        </label>
                      </summary>
                      <div class="agent-tool-details">
                        <div class="agent-tool-details-strip">
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${uiText("Access", "Quyền")}</div>
                            <div>${formatToolPolicyState(resolved)}</div>
                          </div>
                          <div class="agent-tool-detail agent-tool-detail--inline">
                            <div class="label">${uiText("Source", "Nguồn")}</div>
                            <div>${formatToolSourceLabel(section, tool)}</div>
                          </div>
                          ${defaultProfiles.length > 0
                            ? html`
                                <div class="agent-tool-detail agent-tool-detail--inline">
                                  <div class="label">
                                    ${uiText("Default Presets", "Preset mặc định")}
                                  </div>
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
                            <div class="label">${uiText("Current Session", "Phiên hiện tại")}</div>
                            <div>
                              ${activeEntry
                                ? uiText(
                                    `Available now via ${renderEffectiveToolBadge(activeEntry)}.`,
                                    `Đang khả dụng qua ${renderEffectiveToolBadge(activeEntry)}.`,
                                  )
                                : params.runtimeSessionMatchesSelectedAgent
                                  ? uiText(
                                      "Not available in this chat session right now.",
                                      "Hiện không khả dụng trong phiên chat này.",
                                    )
                                  : uiText(
                                      "Switch chat to this agent to inspect live availability.",
                                      "Chuyển chat sang agent này để kiểm tra khả dụng live.",
                                    )}
                            </div>
                          </div>
                          <a class="agent-tool-jump" href="#${anchorId}">
                            ${uiText("Link to This Tool", "Liên kết tới công cụ này")}
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
          <div class="card-title">${uiText("Skills", "Kỹ năng")}</div>
          <div class="card-sub">
            ${uiText(
              "Per-agent skill allowlist and workspace skills.",
              "Allowlist kỹ năng theo agent và kỹ năng workspace.",
            )}
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
              ${uiText("Enable All", "Bật tất cả")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable}
              @click=${() => params.onDisableAll(params.agentId)}
            >
              ${uiText("Disable All", "Tắt tất cả")}
            </button>
            <button
              class="btn btn--sm"
              ?disabled=${!editable || !usingAllowlist}
              @click=${() => params.onClear(params.agentId)}
              title=${uiText(
                "Remove per-agent allowlist and use all skills",
                "Xóa allowlist theo agent và dùng tất cả kỹ năng",
              )}
            >
              ${uiText("Reset", "Đặt lại")}
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
            ${params.configSaving ? uiText("Saving…", "Đang lưu…") : uiText("Save", "Lưu")}
          </button>
        </div>
      </div>

      ${!params.configForm
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "Load the gateway config to set per-agent skills.",
                "Tải cấu hình gateway để đặt kỹ năng theo agent.",
              )}
            </div>
          `
        : nothing}
      ${usingAllowlist
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "This agent uses a custom skill allowlist.",
                "Agent này dùng allowlist kỹ năng tùy chỉnh.",
              )}
            </div>
          `
        : html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "All skills are enabled. Disabling any skill will create a per-agent allowlist.",
                "Tất cả kỹ năng đang bật. Tắt bất kỳ kỹ năng nào sẽ tạo allowlist theo agent.",
              )}
            </div>
          `}
      ${!reportReady && !params.loading
        ? html`
            <div class="callout info" style="margin-top: 12px">
              ${uiText(
                "Load skills for this agent to view workspace-specific entries.",
                "Tải kỹ năng cho agent này để xem mục riêng của workspace.",
              )}
            </div>
          `
        : nothing}
      ${params.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${params.error}</div>`
        : nothing}

      <div class="filters" style="margin-top: 14px;">
        <label class="field" style="flex: 1;">
          <span>${uiText("Filter", "Bộ lọc")}</span>
          <input
            .value=${params.filter}
            @input=${(e: Event) => params.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder=${uiText("Search skills", "Tìm kiếm kỹ năng")}
            autocomplete="off"
            name="agent-skills-filter"
          />
        </label>
        <div class="muted">
          ${uiText(`${filtered.length} shown`, `${filtered.length} đang hiển thị`)}
        </div>
      </div>

      ${filtered.length === 0
        ? html`
            <div class="muted" style="margin-top: 16px">
              ${uiText("No skills found.", "Không tìm thấy kỹ năng.")}
            </div>
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
              ${uiText("Missing:", "Thiếu:")} ${missing.join(", ")}
            </div>`
          : nothing}
        ${reasons.length > 0
          ? html`<div class="muted" style="margin-top: 6px;">
              ${uiText("Reason:", "Lý do:")} ${reasons.join(", ")}
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
