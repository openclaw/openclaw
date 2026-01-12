import { html, nothing } from "lit";
import type { ConfigUiHints } from "../types";
import { analyzeConfigSchema, renderConfigForm } from "./config-form";

type ConfigPatch = {
  path: Array<string | number>;
  value: unknown;
};

export type ConfigProps = {
  raw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown | null;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  formValue: Record<string, unknown> | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onReload: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
};

function cloneConfigObject<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function setPathValue(
  obj: Record<string, unknown> | unknown[],
  path: Array<string | number>,
  value: unknown,
) {
  if (path.length === 0) return;
  let current: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (typeof key === "number") {
      if (!Array.isArray(current)) return;
      if (current[key] == null) {
        current[key] =
          typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = current[key] as Record<string, unknown> | unknown[];
    } else {
      if (typeof current !== "object" || current == null) return;
      const record = current as Record<string, unknown>;
      if (record[key] == null) {
        record[key] =
          typeof nextKey === "number" ? [] : ({} as Record<string, unknown>);
      }
      current = record[key] as Record<string, unknown> | unknown[];
    }
  }
  const lastKey = path[path.length - 1];
  if (typeof lastKey === "number") {
    if (Array.isArray(current)) current[lastKey] = value;
    return;
  }
  if (typeof current === "object" && current != null) {
    (current as Record<string, unknown>)[lastKey] = value;
  }
}

function getPathValue(
  obj: unknown,
  path: Array<string | number>,
): unknown | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[key];
    } else {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
  }
  return current;
}

function buildModelPresetPatches(base: Record<string, unknown>): Array<{
  id: "minimax" | "zai" | "moonshot";
  title: string;
  description: string;
  patches: ConfigPatch[];
}> {
  const setPrimary = (modelRef: string) => ({
    path: ["agents", "defaults", "model", "primary"],
    value: modelRef,
  });
  const safeAlias = (modelRef: string, alias: string): ConfigPatch | null => {
    const existingAlias = getPathValue(base, [
      "agents",
      "defaults",
      "models",
      modelRef,
      "alias",
    ]);
    if (typeof existingAlias === "string" && existingAlias.trim().length > 0) {
      return null;
    }
    return {
      path: ["agents", "defaults", "models", modelRef, "alias"],
      value: alias,
    };
  };

  const minimaxModelsPath = ["models", "providers", "minimax", "models"] satisfies Array<
    string | number
  >;
  const moonshotModelsPath = [
    "models",
    "providers",
    "moonshot",
    "models",
  ] satisfies Array<string | number>;

  const hasNonEmptyString = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0;

  const envMinimax = getPathValue(base, ["env", "MINIMAX_API_KEY"]);
  const envZai = getPathValue(base, ["env", "ZAI_API_KEY"]);
  const envMoonshot = getPathValue(base, ["env", "MOONSHOT_API_KEY"]);

  const minimaxHasModels = Array.isArray(getPathValue(base, minimaxModelsPath));
  const moonshotHasModels = Array.isArray(getPathValue(base, moonshotModelsPath));

  const minimaxProviderBaseUrl = getPathValue(base, [
    "models",
    "providers",
    "minimax",
    "baseUrl",
  ]);
  const minimaxProviderApiKey = getPathValue(base, [
    "models",
    "providers",
    "minimax",
    "apiKey",
  ]);
  const minimaxProviderApi = getPathValue(base, [
    "models",
    "providers",
    "minimax",
    "api",
  ]);
  const moonshotProviderBaseUrl = getPathValue(base, [
    "models",
    "providers",
    "moonshot",
    "baseUrl",
  ]);
  const moonshotProviderApiKey = getPathValue(base, [
    "models",
    "providers",
    "moonshot",
    "apiKey",
  ]);
  const moonshotProviderApi = getPathValue(base, [
    "models",
    "providers",
    "moonshot",
    "api",
  ]);
  const modelsMode = getPathValue(base, ["models", "mode"]);

  const minimax: ConfigPatch[] = [];
  if (!hasNonEmptyString(envMinimax)) {
    minimax.push({ path: ["env", "MINIMAX_API_KEY"], value: "sk-..." });
  }
  if (modelsMode == null) {
    minimax.push({ path: ["models", "mode"], value: "merge" });
  }
  // Intentional: enforce the preferred MiniMax endpoint/mode.
  if (minimaxProviderBaseUrl !== "https://api.minimax.io/anthropic") {
    minimax.push({
      path: ["models", "providers", "minimax", "baseUrl"],
      value: "https://api.minimax.io/anthropic",
    });
  }
  if (!hasNonEmptyString(minimaxProviderApiKey)) {
    minimax.push({
      path: ["models", "providers", "minimax", "apiKey"],
      value: "${MINIMAX_API_KEY}",
    });
  }
  if (minimaxProviderApi !== "anthropic-messages") {
    minimax.push({
      path: ["models", "providers", "minimax", "api"],
      value: "anthropic-messages",
    });
  }
  if (!minimaxHasModels) {
    minimax.push({
      path: minimaxModelsPath as Array<string | number>,
      value: [
        {
          id: "MiniMax-M2.1",
          name: "MiniMax M2.1",
          reasoning: false,
          input: ["text"],
          cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
          contextWindow: 200000,
          maxTokens: 8192,
        },
      ],
    });
  }
  minimax.push(setPrimary("minimax/MiniMax-M2.1"));
  const minimaxAlias = safeAlias("minimax/MiniMax-M2.1", "Minimax");
  if (minimaxAlias) minimax.push(minimaxAlias);

  const zai: ConfigPatch[] = [];
  if (!hasNonEmptyString(envZai)) {
    zai.push({ path: ["env", "ZAI_API_KEY"], value: "sk-..." });
  }
  zai.push(setPrimary("zai/glm-4.7"));
  const zaiAlias = safeAlias("zai/glm-4.7", "GLM 4.7");
  if (zaiAlias) zai.push(zaiAlias);

  const moonshot: ConfigPatch[] = [];
  if (!hasNonEmptyString(envMoonshot)) {
    moonshot.push({ path: ["env", "MOONSHOT_API_KEY"], value: "sk-..." });
  }
  if (modelsMode == null) {
    moonshot.push({ path: ["models", "mode"], value: "merge" });
  }
  if (!hasNonEmptyString(moonshotProviderBaseUrl)) {
    moonshot.push({
      path: ["models", "providers", "moonshot", "baseUrl"],
      value: "https://api.moonshot.ai/v1",
    });
  }
  if (!hasNonEmptyString(moonshotProviderApiKey)) {
    moonshot.push({
      path: ["models", "providers", "moonshot", "apiKey"],
      value: "${MOONSHOT_API_KEY}",
    });
  }
  if (!hasNonEmptyString(moonshotProviderApi)) {
    moonshot.push({
      path: ["models", "providers", "moonshot", "api"],
      value: "openai-completions",
    });
  }
  if (!moonshotHasModels) {
    moonshot.push({
      path: moonshotModelsPath as Array<string | number>,
      value: [
        {
          id: "kimi-k2-0905-preview",
          name: "Kimi K2 0905 Preview",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 8192,
        },
      ],
    });
  }
  moonshot.push(setPrimary("moonshot/kimi-k2-0905-preview"));
  const moonshotAlias = safeAlias("moonshot/kimi-k2-0905-preview", "Kimi K2");
  if (moonshotAlias) moonshot.push(moonshotAlias);

  return [
    {
      id: "minimax",
      title: "MiniMax M2.1 (Anthropic)",
      description:
        "Adds provider config for MiniMax’s /anthropic endpoint and sets it as the default model.",
      patches: minimax,
    },
    {
      id: "zai",
      title: "GLM 4.7 (Z.AI)",
      description: "Adds ZAI_API_KEY placeholder + sets default model to zai/glm-4.7.",
      patches: zai,
    },
    {
      id: "moonshot",
      title: "Kimi (Moonshot)",
      description: "Adds Moonshot provider config + sets default model to kimi-k2-0905-preview.",
      patches: moonshot,
    },
  ];
}

export function renderConfig(props: ConfigProps) {
  const validity =
    props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const analysis = analyzeConfigSchema(props.schema);
  const formUnsafe = analysis.schema
    ? analysis.unsupportedPaths.length > 0
    : false;
  const canSaveForm =
    Boolean(props.formValue) && !props.loading && !formUnsafe;
  const canSave =
    props.connected &&
    !props.saving &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    (props.formMode === "raw" ? true : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;

  const applyPreset = (patches: ConfigPatch[]) => {
    const base =
      props.formValue ??
      tryParseJsonObject(props.raw) ??
      ({} as Record<string, unknown>);
    const next = cloneConfigObject(base);
    for (const patch of patches) {
      setPathValue(next, patch.path, patch.value);
    }
    props.onRawChange(`${JSON.stringify(next, null, 2).trimEnd()}\n`);
    for (const patch of patches) props.onFormPatch(patch.path, patch.value);
  };

  const presetBase =
    props.formValue ??
    tryParseJsonObject(props.raw) ??
    ({} as Record<string, unknown>);
  const modelPresets = buildModelPresetPatches(presetBase);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div class="row">
          <div class="card-title">Config</div>
          <span class="pill">${validity}</span>
        </div>
        <div class="row">
          <div class="toggle-group">
            <button
              class="btn ${props.formMode === "form" ? "primary" : ""}"
              ?disabled=${props.schemaLoading || !props.schema}
              @click=${() => props.onFormModeChange("form")}
            >
              Form
            </button>
            <button
              class="btn ${props.formMode === "raw" ? "primary" : ""}"
              @click=${() => props.onFormModeChange("raw")}
            >
              Raw
            </button>
          </div>
          <button class="btn" ?disabled=${props.loading} @click=${props.onReload}>
            ${props.loading ? "Loading…" : "Reload"}
          </button>
          <button
            class="btn primary"
            ?disabled=${!canSave}
            @click=${props.onSave}
          >
            ${props.saving ? "Saving…" : "Save"}
          </button>
          <button
            class="btn"
            ?disabled=${!canApply}
            @click=${props.onApply}
          >
            ${props.applying ? "Applying…" : "Apply & Restart"}
          </button>
          <button
            class="btn"
            ?disabled=${!canUpdate}
            @click=${props.onUpdate}
          >
            ${props.updating ? "Updating…" : "Update & Restart"}
          </button>
        </div>
      </div>

      <div class="muted" style="margin-top: 10px;">
        Writes to <span class="mono">~/.clawdbot/clawdbot.json</span>. Apply &
        Update restart the gateway and will ping the last active session when it
        comes back.
      </div>

      <div class="callout" style="margin-top: 12px;">
        <div style="font-weight: 600;">Model presets</div>
        <div class="muted" style="margin-top: 6px;">
          One-click inserts for MiniMax, GLM 4.7 (Z.AI), and Kimi (Moonshot). Keeps
          existing API keys and per-model params when present.
        </div>
        <div class="row" style="margin-top: 10px; flex-wrap: wrap;">
          ${modelPresets.map(
            (preset) => html`
              <button
                class="btn"
                ?disabled=${props.loading || props.saving || !props.connected}
                title=${preset.description}
                @click=${() => applyPreset(preset.patches)}
              >
                ${preset.title}
              </button>
            `,
          )}
        </div>
        <div class="muted" style="margin-top: 8px;">
          Tip: use <span class="mono">/model</span> to switch models without editing
          config.
        </div>
      </div>

      ${props.formMode === "form"
        ? html`<div style="margin-top: 12px;">
            ${props.schemaLoading
              ? html`<div class="muted">Loading schema…</div>`
              : renderConfigForm({
                  schema: analysis.schema,
                  uiHints: props.uiHints,
                  value: props.formValue,
                  disabled: props.loading || !props.formValue,
                  unsupportedPaths: analysis.unsupportedPaths,
                  onPatch: props.onFormPatch,
                })}
            ${formUnsafe
              ? html`<div class="callout danger" style="margin-top: 12px;">
                  Form view can’t safely edit some fields.
                  Use Raw to avoid losing config entries.
                </div>`
              : nothing}
          </div>`
        : html`<label class="field" style="margin-top: 12px;">
            <span>Raw JSON5</span>
            <textarea
              .value=${props.raw}
              @input=${(e: Event) =>
                props.onRawChange((e.target as HTMLTextAreaElement).value)}
            ></textarea>
          </label>`}

      ${props.issues.length > 0
        ? html`<div class="callout danger" style="margin-top: 12px;">
            <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
          </div>`
        : nothing}
    </section>
  `;
}
