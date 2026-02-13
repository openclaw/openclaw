import { html, nothing, type TemplateResult } from "lit";
import { renderIcon } from "../icons.ts";

export type AgentHQSummaryPanelProps = {
  enabled: boolean;
  loading: boolean;
  model: string | null;
  provider: string | null;
  availableModels: Array<{ id: string; name: string; provider: string }>;
  onToggle: (enabled: boolean) => void;
  onSetModel: (model: string | null, provider: string | null) => void;
};

export function renderAgentHQSummary(props: AgentHQSummaryPanelProps): TemplateResult {
  // Group models by provider
  const modelsByProvider = new Map<string, Array<{ id: string; name: string }>>();
  for (const model of props.availableModels) {
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push({ id: model.id, name: model.name });
    modelsByProvider.set(model.provider, list);
  }

  return html`
    <div class="agenthq-filters">
      <div class="agenthq-filter-label">AI Summaries</div>
      <div class="agenthq-summary-toggle">
        <div>
          <div class="agenthq-summary-toggle-label">Enable LLM Summaries</div>
          <div class="agenthq-summary-toggle-desc">
            Use AI to summarize and explain changes
          </div>
        </div>
        <div
          class="agenthq-toggle ${props.enabled ? "active" : ""}"
          @click=${() => props.onToggle(!props.enabled)}
        >
          <div class="agenthq-toggle-knob"></div>
        </div>
      </div>

      ${
        props.enabled
          ? html`
            <div class="agenthq-summary-config">
              <select
                class="agenthq-summary-select"
                @change=${(e: Event) => {
                  const value = (e.target as HTMLSelectElement).value;
                  if (value) {
                    const [provider, modelId] = value.split("::");
                    props.onSetModel(modelId, provider);
                  } else {
                    props.onSetModel(null, null);
                  }
                }}
              >
                <option value="">Select a model...</option>
                ${Array.from(modelsByProvider.entries()).map(
                  ([provider, models]) => html`
                    <optgroup label="${provider}">
                      ${models.map((model) => {
                        const value = `${provider}::${model.id}`;
                        const isSelected = props.model === model.id && props.provider === provider;
                        return html`
                          <option value="${value}" ?selected=${isSelected}>
                            ${model.name}
                          </option>
                        `;
                      })}
                    </optgroup>
                  `,
                )}
              </select>
            </div>

            ${
              props.loading
                ? html`
                    <div class="agenthq-summary-card">
                      <div class="agenthq-loading">
                        <div class="agenthq-loading-spinner"></div>
                        <div class="agenthq-loading-text">Generating summary...</div>
                      </div>
                    </div>
                  `
                : props.model
                  ? html`
                    <div class="agenthq-summary-card">
                      <div class="agenthq-summary-card-header">
                        ${renderIcon("brain", "agenthq-summary-card-icon")}
                        <div class="agenthq-summary-card-title">Ready</div>
                      </div>
                      <div class="agenthq-summary-toggle-desc">
                        Summaries will be generated for each commit when you expand them. Click
                        "Generate Summary" in the timeline or visual view.
                      </div>
                    </div>
                  `
                  : nothing
            }
          `
          : nothing
      }
    </div>
  `;
}
