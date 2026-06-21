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
  enabled: boolean | null;
  provider: string | null;
  apiKey: string | null;
  speakerVoiceId: string | null;
  model: string | null;
};

/** Resolve TTS config for a specific agent from the config form. */
function resolveAgentTts(
  configForm: Record<string, unknown> | null,
  agentId: string,
): AgentTtsConfig {
  const config = resolveAgentConfig(configForm, agentId);
  const entryTts = config.entry?.tts as Record<string, unknown> | undefined;
  const defaultsTts = config.defaults?.tts as Record<string, unknown> | undefined;
  const tts = entryTts ?? defaultsTts ?? {};
  const provider = (tts.provider as string) ?? null;
  const providers = (tts.providers as Record<string, Record<string, unknown>> | undefined) ?? {};
  const elevenlabs = providers.elevenlabs ?? {};
  return {
    enabled: (tts.enabled as boolean) ?? null,
    provider,
    apiKey: (elevenlabs.apiKey as string) ?? null,
    speakerVoiceId: (elevenlabs.speakerVoiceId as string) ?? null,
    model: (elevenlabs.model as string) ?? null,
  };
}

const ELEVENLABS_MODELS = [
  { value: "eleven_multilingual_v2", label: "Multilingual v2" },
  { value: "eleven_turbo_v2_5", label: "Turbo v2.5" },
  { value: "eleven_flash_v2_5", label: "Flash v2.5" },
  { value: "eleven_v3", label: "v3 (Alpha)" },
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
      <div class="card-title">Voice / TTS</div>
      <div class="card-sub">ElevenLabs voice configuration for this agent.</div>

      <div class="agent-model-fields" style="margin-top: 16px;">
        <label class="field">
          <span>Enable TTS</span>
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
          <span>TTS Provider</span>
          <select
            .value=${ttsProvider}
            ?disabled=${disabled}
            @change=${(e: Event) =>
              onTtsProviderChange(agent.id, (e.target as HTMLSelectElement).value || null)}
          >
            <option value="" ?selected=${!ttsProvider}>Inherit default</option>
            <option value="elevenlabs" ?selected=${ttsProvider === "elevenlabs"}>ElevenLabs</option>
            <option value="openai" ?selected=${ttsProvider === "openai"}>OpenAI</option>
            <option value="microsoft" ?selected=${ttsProvider === "microsoft"}>
              Microsoft (no key)
            </option>
          </select>
        </label>
      </div>

      ${ttsProvider === "elevenlabs" || (!ttsProvider && ttsEnabled)
        ? html`
            <div class="agent-model-fields" style="margin-top: 12px;">
              <label class="field">
                <span>ElevenLabs API Key</span>
                <input
                  type="password"
                  .value=${ttsApiKey}
                  ?disabled=${disabled}
                  placeholder="Paste ElevenLabs API key"
                  @change=${(e: Event) =>
                    onTtsApiKeyChange(agent.id, (e.target as HTMLInputElement).value)}
                />
              </label>
              <label class="field">
                <span>Voice ID</span>
                <input
                  type="text"
                  .value=${ttsVoiceId}
                  ?disabled=${disabled}
                  placeholder="e.g. EXAVITQu4vr4xnSDxMaL"
                  @change=${(e: Event) =>
                    onTtsVoiceIdChange(agent.id, (e.target as HTMLInputElement).value)}
                />
              </label>
            </div>
            <label class="field" style="margin-top: 12px; display: block;">
              <span>Model</span>
              <select
                .value=${ttsModel}
                ?disabled=${disabled}
                @change=${(e: Event) =>
                  onTtsModelChange(agent.id, (e.target as HTMLSelectElement).value)}
              >
                ${ELEVENLABS_MODELS.map(
                  (m) => html`
                    <option value=${m.value} ?selected=${ttsModel === m.value}>${m.label}</option>
                  `,
                )}
              </select>
            </label>
          `
        : nothing}
    </section>
  `;
}
