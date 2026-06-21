// Control UI view renders agents panels overview screen content.
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
} from "../types.ts";
import {
  buildModelOptions,
  normalizeModelValue,
  parseFallbackList,
  resolveAgentConfig,
  resolveAgentRuntimeLabel,
  resolveModelFallbacks,
  resolveModelLabel,
  resolveModelPrimary,
} from "./agents-utils.ts";
import type { AgentsPanel } from "./agents.types.ts";

/** Per-agent TTS config resolved from the config form. */
export type AgentTtsConfig = {
  /** Effective TTS auto mode: "always" | "off" | "session" | null (unset). */
  auto: string | null;
  /** True when auto mode resolves to TTS on (always or session). */
  enabled: boolean | null;
  provider: string | null;
  apiKey: string | null;
  apiKeyIsSecretRef: boolean;
  speakerVoiceId: string | null;
  model: string | null;
};

/** Check if a value looks like a structured SecretRef object. */
function isSecretRefObject(value: unknown): value is { source: string; id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.source === "string" && typeof candidate.id === "string";
}

/** Keys that must not be deep-merged (prototype pollution guards). */
const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Recursively merge defined values from override into base, mirroring the
 * runtime `deepMergeDefined` contract from `src/tts/tts-config.ts`.
 *
 * Objects are merged key-by-key; primitives and arrays are replaced.
 * `undefined` values in the override are skipped.
 */
function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return override === undefined ? base : override;
  }
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) continue;
    result[key] = key in result ? deepMergeDefined(result[key], value) : value;
  }
  return result;
}

/** Resolve TTS config for a specific agent from the config form.
 *
 * Runtime TTS resolution starts from `messages.tts` as the base layer and
 * deep-merges per-agent overrides on top (see `resolveEffectiveTtsConfig` in
 * `src/tts/tts-config.ts`). This resolver mirrors that contract — including
 * recursive deep-merge of nested `providers` objects — so the UI reflects the
 * effective runtime state rather than only the agent-scoped block.
 *
 * Auto mode (`auto: "always" | "off" | "session"`) takes precedence over the
 * deprecated `enabled` boolean, matching runtime precedence in
 * `shouldAttemptTtsPayload`.
 */
function resolveAgentTts(
  configForm: Record<string, unknown> | null,
  agentId: string,
): AgentTtsConfig {
  const config = resolveAgentConfig(configForm, agentId);
  const baseTts = (configForm?.messages as Record<string, unknown> | undefined)?.tts as
    | Record<string, unknown>
    | undefined;
  const entryTts = config.entry?.tts as Record<string, unknown> | undefined;
  const defaultsTts = config.defaults?.tts as Record<string, unknown> | undefined;

  // Deep-merge layers: base (messages.tts) → defaults → entry (agent-specific)
  let mergedTts: Record<string, unknown> = deepMergeDefined(baseTts ?? {}, {}) as Record<
    string,
    unknown
  >;
  for (const layer of [defaultsTts, entryTts]) {
    if (!layer) continue;
    mergedTts = deepMergeDefined(mergedTts, layer) as Record<string, unknown>;
  }

  const provider = (mergedTts.provider as string) ?? null;
  const providers =
    (mergedTts.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const elevenlabs = providers.elevenlabs ?? {};
  const rawApiKey = elevenlabs.apiKey;

  // Auto mode takes precedence over deprecated `enabled` boolean (runtime contract).
  const auto = (mergedTts.auto as string) ?? null;
  const enabledBool = (mergedTts.enabled as boolean) ?? null;
  const effectiveEnabled = auto ? auto !== "off" : enabledBool;

  return {
    auto,
    enabled: effectiveEnabled,
    provider,
    apiKey: typeof rawApiKey === "string" ? rawApiKey : null,
    apiKeyIsSecretRef: isSecretRefObject(rawApiKey),
    speakerVoiceId: (elevenlabs.speakerVoiceId as string) ?? null,
    model: (elevenlabs.modelId as string) ?? (elevenlabs.model as string) ?? null,
  };
}

const ELEVENLABS_MODELS = [
  { value: "eleven_multilingual_v2", labelKey: "agents.voice.models.multilingualV2" },
  { value: "eleven_turbo_v2_5", labelKey: "agents.voice.models.turboV25" },
  { value: "eleven_flash_v2_5", labelKey: "agents.voice.models.flashV25" },
  { value: "eleven_v3", labelKey: "agents.voice.models.v3Alpha" },
];

export function renderAgentOverview(params: {
  agent: AgentsListResult["agents"][number];
  basePath: string;
  defaultId: string | null;
  configForm: Record<string, unknown> | null;
  agentFilesList: AgentsFilesListResult | null;
  agentIdentity: AgentIdentityResult | null;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  modelCatalog: ModelCatalogEntry[];
  onConfigReload: () => void;
  onConfigSave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onTtsProviderChange: (agentId: string, provider: string | null) => void;
  onTtsApiKeyChange: (agentId: string, apiKey: string) => void;
  onTtsVoiceIdChange: (agentId: string, voiceId: string) => void;
  onTtsModelChange: (agentId: string, model: string) => void;
  onTtsToggle: (agentId: string, enabled: boolean) => void;
}) {
  const {
    agent,
    configForm,
    agentFilesList,
    configLoading,
    configSaving,
    configDirty,
    onConfigReload,
    onConfigSave,
    onModelChange,
    onModelFallbacksChange,
    onSelectPanel,
    onTtsProviderChange,
    onTtsApiKeyChange,
    onTtsVoiceIdChange,
    onTtsModelChange,
    onTtsToggle,
  } = params;
  const isDefault = Boolean(params.defaultId && agent.id === params.defaultId);
  const config = resolveAgentConfig(configForm, agent.id);
  const agentModel = agent.model;
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    config.defaults?.workspace ||
    agent.workspace ||
    "default";
  const model = config.entry?.model
    ? resolveModelLabel(config.entry?.model)
    : config.defaults?.model
      ? resolveModelLabel(config.defaults?.model)
      : resolveModelLabel(agentModel);
  const runtime = resolveAgentRuntimeLabel(agent.agentRuntime);
  const defaultModel = resolveModelLabel(config.defaults?.model ?? agentModel);
  const entryPrimary = resolveModelPrimary(config.entry?.model);
  const defaultPrimary =
    resolveModelPrimary(config.defaults?.model) ||
    (defaultModel !== "-" ? normalizeModelValue(defaultModel) : null) ||
    (configForm ? null : resolveModelPrimary(agentModel));
  const effectivePrimary = entryPrimary ?? defaultPrimary ?? null;
  const selectedPrimary = isDefault ? effectivePrimary : entryPrimary;
  const modelFallbacks =
    resolveModelFallbacks(config.entry?.model) ??
    resolveModelFallbacks(config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agentModel));
  const fallbackChips = modelFallbacks ?? [];
  const skillFilter = Array.isArray(config.entry?.skills) ? config.entry?.skills : null;
  const skillCount = skillFilter?.length ?? null;
  const disabled = !configForm || configLoading || configSaving;
  const thinkingDefault = agent.thinkingDefault ?? "-";
  const ttsConfig = resolveAgentTts(configForm, agent.id);
  const ttsEnabled = ttsConfig.enabled ?? false;
  const ttsProvider = ttsConfig.provider ?? "";
  const ttsApiKey = ttsConfig.apiKey ?? "";
  const ttsApiKeyIsSecretRef = ttsConfig.apiKeyIsSecretRef;
  const ttsVoiceId = ttsConfig.speakerVoiceId ?? "";
  const ttsModel = ttsConfig.model ?? "eleven_multilingual_v2";

  const removeChip = (index: number) => {
    const next = fallbackChips.filter((_, i) => i !== index);
    onModelFallbacksChange(agent.id, next);
  };

  const handleChipKeydown = (e: KeyboardEvent) => {
    const input = e.target as HTMLInputElement;
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const parsed = parseFallbackList(input.value);
      if (parsed.length > 0) {
        onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
        input.value = "";
      }
    }
  };

  return html`
    <section class="card">
      <div class="card-title">Overview</div>
      <div class="card-sub">Workspace paths and identity metadata.</div>

      <div class="agents-overview-grid" style="margin-top: 16px;">
        <div class="agent-kv">
          <div class="label">Workspace</div>
          <div>
            <button
              type="button"
              class="workspace-link mono"
              @click=${() => onSelectPanel("files")}
              title="Open Files tab"
            >
              ${workspace}
            </button>
          </div>
        </div>
        <div class="agent-kv">
          <div class="label">Primary Model</div>
          <div class="mono">${model}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Runtime</div>
          <div class="mono">${runtime}</div>
        </div>
        <div class="agent-kv">
          <div class="label">${t("agents.context.thinkingDefault")}</div>
          <div class="mono">${thinkingDefault}</div>
        </div>
        <div class="agent-kv">
          <div class="label">Skills Filter</div>
          <div>${skillFilter ? `${skillCount} selected` : "all skills"}</div>
        </div>
      </div>

      ${configDirty
        ? html`
            <div class="callout warn" style="margin-top: 16px">
              You have unsaved config changes.
            </div>
          `
        : nothing}

      <div class="agent-model-select" style="margin-top: 20px;">
        <div class="label">Model Selection</div>
        <div class="agent-model-fields">
          <label class="field">
            <span>Primary model${isDefault ? " (default)" : ""}</span>
            <select
              .value=${selectedPrimary ?? ""}
              ?disabled=${disabled}
              @change=${(e: Event) =>
                onModelChange(agent.id, (e.target as HTMLSelectElement).value || null)}
            >
              ${isDefault
                ? html` <option value="" ?selected=${!selectedPrimary}>Not set</option> `
                : html`
                    <option value="" ?selected=${!selectedPrimary}>
                      ${defaultPrimary ? `Inherit default (${defaultPrimary})` : "Inherit default"}
                    </option>
                  `}
              ${buildModelOptions(
                configForm,
                effectivePrimary ?? undefined,
                params.modelCatalog,
                selectedPrimary,
              )}
            </select>
          </label>
          <div class="field">
            <span>Fallbacks</span>
            <div
              class="agent-chip-input"
              @click=${(e: Event) => {
                const container = e.currentTarget as HTMLElement;
                const input = container.querySelector("input");
                if (input) {
                  input.focus();
                }
              }}
            >
              ${fallbackChips.map(
                (chip, i) => html`
                  <span class="chip">
                    ${chip}
                    <button
                      type="button"
                      class="chip-remove"
                      ?disabled=${disabled}
                      @click=${() => removeChip(i)}
                    >
                      &times;
                    </button>
                  </span>
                `,
              )}
              <input
                ?disabled=${disabled}
                placeholder=${fallbackChips.length === 0 ? "provider/model" : ""}
                @keydown=${handleChipKeydown}
                @blur=${(e: Event) => {
                  const input = e.target as HTMLInputElement;
                  const parsed = parseFallbackList(input.value);
                  if (parsed.length > 0) {
                    onModelFallbacksChange(agent.id, [...fallbackChips, ...parsed]);
                    input.value = "";
                  }
                }}
              />
            </div>
          </div>
        </div>
        <div class="agent-model-actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${configLoading}
            @click=${onConfigReload}
          >
            ${t("common.reloadConfig")}
          </button>
          <button
            type="button"
            class="btn btn--sm primary"
            ?disabled=${configSaving || !configDirty}
            @click=${onConfigSave}
          >
            ${configSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>

    <section class="card" style="margin-top: 16px;">
      <div class="card-title">${t("agents.voice.title")}</div>
      <div class="card-sub">${t("agents.voice.subtitle")}</div>

      <div class="agent-model-fields" style="margin-top: 16px;">
        <label class="field">
          <span>${t("agents.voice.enableTts")}</span>
          <label class="toggle-switch">
            <input
              type="checkbox"
              .checked=${ttsEnabled}
              ?disabled=${disabled}
              @change=${(e: Event) => onTtsToggle(agent.id, (e.target as HTMLInputElement).checked)}
            />
            <span class="toggle-slider"></span>
          </label>
        </label>

        <label class="field">
          <span>${t("agents.voice.provider")}</span>
          <select
            .value=${ttsProvider}
            ?disabled=${disabled}
            @change=${(e: Event) =>
              onTtsProviderChange(agent.id, (e.target as HTMLSelectElement).value || null)}
          >
            <option value="" ?selected=${!ttsProvider}>${t("agents.voice.providerInherit")}</option>
            <option value="elevenlabs" ?selected=${ttsProvider === "elevenlabs"}>
              ${t("agents.voice.providers.elevenlabs")}
            </option>
            <option value="openai" ?selected=${ttsProvider === "openai"}>
              ${t("agents.voice.providers.openai")}
            </option>
            <option value="microsoft" ?selected=${ttsProvider === "microsoft"}>
              ${t("agents.voice.providers.microsoft")}
            </option>
          </select>
        </label>
      </div>

      ${ttsProvider === "elevenlabs" || (!ttsProvider && ttsEnabled)
        ? html`
            <div class="agent-model-fields" style="margin-top: 12px;">
              <label class="field">
                <span>${t("agents.voice.apiKey")}</span>
                ${ttsApiKeyIsSecretRef
                  ? html`
                      <input
                        type="text"
                        value="•••••••• (SecretRef)"
                        disabled
                        title=${t("agents.voice.apiKeySecretRefReadOnly")}
                      />
                      <small
                        style="display: block; margin-top: 4px; color: var(--text-muted, #888); font-size: 0.8em;"
                        >${t("agents.voice.apiKeySecretRefHint")}</small
                      >
                    `
                  : html`
                      <input
                        type="password"
                        .value=${ttsApiKey}
                        ?disabled=${disabled}
                        placeholder="${t("agents.voice.apiKeyPlaceholder")}"
                        @change=${(e: Event) =>
                          onTtsApiKeyChange(agent.id, (e.target as HTMLInputElement).value)}
                      />
                    `}
              </label>
              <label class="field">
                <span>${t("agents.voice.voiceId")}</span>
                <input
                  type="text"
                  .value=${ttsVoiceId}
                  ?disabled=${disabled}
                  placeholder="${t("agents.voice.voiceIdPlaceholder")}"
                  @change=${(e: Event) =>
                    onTtsVoiceIdChange(agent.id, (e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
            <label class="field" style="margin-top: 12px; display: block;">
              <span>${t("agents.voice.model")}</span>
              <select
                .value=${ttsModel}
                ?disabled=${disabled}
                @change=${(e: Event) =>
                  onTtsModelChange(agent.id, (e.target as HTMLSelectElement).value)}
              >
                ${ELEVENLABS_MODELS.map(
                  (m) => html`
                    <option value=${m.value} ?selected=${ttsModel === m.value}>
                      ${t(m.labelKey)}
                    </option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
    </section>
  `;
}
