import { html, nothing, type TemplateResult } from "lit";
import { LitElement } from "lit";
import { state } from "lit/decorators.js";
import { customElement } from "lit/decorators.js";
import { icons } from "../icons.ts";
import { renderSkillsConfig } from "./onboarding-wizard-skills.ts";
import "../../styles/onboarding-wizard.css";

export type WizardStep = {
  id: string;
  type:
    | "welcome"
    | "api-key"
    | "workspace-path"
    | "gateway-config"
    | "channel-cards"
    | "agent-mode-select"
    | "agent-single-form"
    | "agent-team-count"
    | "agent-swarm-config"
    | "agent-grid"
    | "agent-config-advanced"
    | "skills-config"
    | "summary";
  title?: string;
  message?: string;
  options?: Array<{ value: unknown; label: string; hint?: string }>;
  initialValue?: unknown;
  placeholder?: string;
  sensitive?: boolean;
  icon?: string;
  logo?: string;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
    required?: boolean;
  };
  items?: Array<{ id: string; label: string; icon?: string }>;
  summary?: Array<{ label: string; value: string }>;
};

export type OnboardingWizardProps = {
  step: WizardStep | null;
  stepIndex: number;
  totalSteps: number;
  loading: boolean;
  error: string | null;
  gateway?: any; // GatewayBrowserClient
  onNext: (answer: unknown) => void;
  onBack: () => void;
  onCancel: () => void;
};

@customElement("onboarding-wizard")
export class OnboardingWizard extends LitElement {
  @state() private currentAnswer: unknown = null;
  @state() private validationError: string | null = null;
  @state() private showApiKey = false;
  @state() private apiKeyValidating = false;
  @state() private apiKeyValid: boolean | null = null;
  private apiKeyValidationTimer: number | null = null;
  @state() private availableSkills: Array<{ name: string; description?: string }> = [];
  @state() private skillsLoading = false;

  render() {
    const props = this.props;
    if (!props || !props.step) {
      return nothing;
    }

    const { step, stepIndex, totalSteps, loading, error, onNext, onBack } = props;

    return html`
      <div class="onboarding-wizard">
        <div class="onboarding-wizard__overlay"></div>
        <div class="onboarding-wizard__container">
          <!-- Progress Bar -->
          <div class="onboarding-wizard__progress">
            ${Array.from({ length: totalSteps }, (_, i) => {
              const isActive = i === stepIndex;
              const isCompleted = i < stepIndex;
              return html`
                <div
                  class="onboarding-wizard__progress-dot ${isActive ? "onboarding-wizard__progress-dot--active" : ""} ${isCompleted ? "onboarding-wizard__progress-dot--completed" : ""}"
                ></div>
              `;
            })}
          </div>

          <!-- Step Content -->
          <div class="onboarding-wizard__content">
            ${this.renderStep(step)}
          </div>

          <!-- Error Message -->
          ${error ? html`<div class="onboarding-wizard__error">${error}</div>` : nothing}

          <!-- Navigation -->
          <div class="onboarding-wizard__navigation">
            ${
              stepIndex > 0
                ? html`
                  <button
                    class="onboarding-wizard__button onboarding-wizard__button--secondary"
                    @click=${onBack}
                    ?disabled=${loading}
                  >
                    Zurück
                  </button>
                `
                : html`
                    <div></div>
                  `
            }
            <div class="onboarding-wizard__navigation-spacer"></div>
            <button
              class="onboarding-wizard__button onboarding-wizard__button--primary"
              @click=${() => {
                if (this.validateStep(step)) {
                  onNext(this.currentAnswer);
                }
              }}
              ?disabled=${loading || !this.isStepValid(step)}
            >
              ${loading ? "Lädt..." : stepIndex === totalSteps - 1 ? "Fertig" : "Weiter"}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderStep(step: WizardStep): TemplateResult | Promise<TemplateResult> {
    switch (step.type) {
      case "welcome":
        return this.renderWelcome(step);
      case "api-key":
        return this.renderApiKey(step);
      case "workspace-path":
        return this.renderWorkspacePath(step);
      case "gateway-config":
        return this.renderGatewayConfig(step);
      case "channel-cards":
        return this.renderChannelCards(step);
      case "agent-mode-select":
        return this.renderAgentModeSelect(step);
      case "agent-single-form":
        return this.renderAgentSingleForm(step);
      case "agent-team-count":
        return this.renderAgentTeamCount(step);
      case "agent-swarm-config":
        return this.renderAgentSwarmConfig(step);
      case "agent-grid":
        return this.renderAgentGrid(step);
      case "skills-config":
        return this.renderSkillsConfig(step);
      case "summary":
        return this.renderSummary(step);
      default:
        return html`
          <div>Unknown step type</div>
        `;
    }
  }

  private renderWelcome(step: WizardStep): TemplateResult {
    return html`
      <div class="onboarding-wizard__step onboarding-wizard__step--welcome">
        ${
          step.logo
            ? step.logo.endsWith(".mp4")
              ? html`<video src="${step.logo}" autoplay loop muted playsinline class="onboarding-wizard__logo onboarding-wizard__logo--video" />`
              : html`<img src="${step.logo}" alt="Activi Logo" class="onboarding-wizard__logo" />`
            : html`
                <div class="onboarding-wizard__logo-placeholder">A</div>
              `
        }
        <h1 class="onboarding-wizard__title">${step.title || "Willkommen bei Activi"}</h1>
        <p class="onboarding-wizard__subtitle">${step.message || "Dein AI-Agent Command Center"}</p>
      </div>
    `;
  }

  private renderApiKey(step: WizardStep): TemplateResult {
    const provider =
      (this.currentAnswer as { provider?: string; apiKey?: string })?.provider ||
      step.initialValue ||
      "anthropic";
    const apiKey = (this.currentAnswer as { provider?: string; apiKey?: string })?.apiKey || "";
    const showKey = !step.sensitive || this.showApiKey;

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "AI Model / API Key"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Provider</label>
          <select
            class="onboarding-wizard__select"
            .value=${provider}
            @change=${(e: Event) => {
              const target = e.target as HTMLSelectElement;
              this.currentAnswer = { ...(this.currentAnswer as object), provider: target.value };
              this.requestUpdate();
            }}
          >
            ${step.options?.map((opt) => html`<option value="${opt.value}">${opt.label}</option>`)}
          </select>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">API Key</label>
          <div class="onboarding-wizard__input-wrapper">
            <input
              type=${showKey ? "text" : "password"}
              class="onboarding-wizard__input"
              placeholder=${step.placeholder || "sk-..."}
              .value=${apiKey}
              @input=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                const newApiKey = target.value;
                this.currentAnswer = { ...(this.currentAnswer as object), apiKey: newApiKey };
                
                // Debounce API key validation (500ms)
                if (this.apiKeyValidationTimer !== null) {
                  clearTimeout(this.apiKeyValidationTimer);
                }
                
                // Reset validation state
                this.apiKeyValid = null;
                this.apiKeyValidating = false;
                
                // Basic format validation immediately
                this.validateStep(step);
                
                // Debounced validation for longer keys
                if (newApiKey.length >= 10) {
                  this.apiKeyValidating = true;
                  this.apiKeyValidationTimer = window.setTimeout(async () => {
                    // Format validation (basic check)
                    const isValidFormat = /^sk-[a-zA-Z0-9_-]+$/.test(newApiKey) || 
                                         /^sk-ant-[a-zA-Z0-9_-]+$/.test(newApiKey);
                    this.apiKeyValid = isValidFormat;
                    this.apiKeyValidating = false;
                    this.requestUpdate();
                  }, 500);
                }
                
                this.requestUpdate();
              }}
            />
            ${
              step.sensitive
                ? html`
                  <button
                    class="onboarding-wizard__toggle"
                    @click=${() => {
                      this.showApiKey = !this.showApiKey;
                      this.requestUpdate();
                    }}
                  >
                    ${showKey ? "Verbergen" : "Anzeigen"}
                  </button>
                `
                : nothing
            }
          </div>
          ${
            this.apiKeyValidating
              ? html`<p class="onboarding-wizard__hint onboarding-wizard__hint--validating">Prüfe API-Key...</p>`
              : this.apiKeyValid === true
                ? html`<p class="onboarding-wizard__hint onboarding-wizard__hint--valid">✓ Gültiges Format</p>`
                : this.apiKeyValid === false && apiKey.length >= 10
                  ? html`<p class="onboarding-wizard__hint onboarding-wizard__hint--invalid">⚠ Ungültiges Format</p>`
                  : html`<p class="onboarding-wizard__hint">Dein Key bleibt lokal, wird nie übertragen</p>`
          }
        </div>
      </div>
    `;
  }

  private renderWorkspacePath(step: WizardStep): TemplateResult {
    const value = (this.currentAnswer as string) || step.initialValue || "~/.activi/workspace";

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Workspace"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Workspace-Verzeichnis</label>
          <div class="onboarding-wizard__input-wrapper">
            <input
              type="text"
              class="onboarding-wizard__input"
              placeholder=${step.placeholder || "~/.activi/workspace"}
              .value=${value}
              @input=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                this.currentAnswer = target.value;
                this.validateStep(step);
                this.requestUpdate();
              }}
            />
            <button class="onboarding-wizard__button onboarding-wizard__button--secondary">
              Durchsuchen
            </button>
          </div>
          <p class="onboarding-wizard__hint">
            Hier speichert Activi Sessions, Configs und Agent-Daten
          </p>
        </div>
      </div>
    `;
  }

  private renderGatewayConfig(step: WizardStep): TemplateResult {
    const config = (this.currentAnswer as {
      port?: number;
      bind?: string;
      authMode?: string;
      password?: string;
      remoteAccess?: boolean;
    }) || {
      port: 18789,
      bind: step.initialValue || "loopback",
      authMode: "token",
      remoteAccess: false,
    };

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Gateway Konfiguration"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Port</label>
          <input
            type="number"
            class="onboarding-wizard__input"
            .value=${String(config.port || 18789)}
            @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              this.currentAnswer = { ...config, port: parseInt(target.value, 10) };
              this.requestUpdate();
            }}
          />
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Bind-Modus</label>
          <select
            class="onboarding-wizard__select"
            .value=${config.bind || "loopback"}
            @change=${(e: Event) => {
              const target = e.target as HTMLSelectElement;
              this.currentAnswer = { ...config, bind: target.value };
              this.requestUpdate();
            }}
          >
            ${step.options?.map((opt) => html`<option value="${opt.value}">${opt.label}</option>`)}
          </select>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Authentifizierung</label>
          <select
            class="onboarding-wizard__select"
            .value=${config.authMode || "token"}
            @change=${(e: Event) => {
              const target = e.target as HTMLSelectElement;
              this.currentAnswer = { ...config, authMode: target.value };
              this.requestUpdate();
            }}
          >
            <option value="token">Token (auto-generiert)</option>
            <option value="password">Passwort</option>
          </select>
        </div>

        ${
          config.authMode === "password"
            ? html`
              <div class="onboarding-wizard__form-group">
                <label class="onboarding-wizard__label">Passwort</label>
                <input
                  type="password"
                  class="onboarding-wizard__input"
                  .value=${config.password || ""}
                  @input=${(e: Event) => {
                    const target = e.target as HTMLInputElement;
                    this.currentAnswer = { ...config, password: target.value };
                    this.requestUpdate();
                  }}
                />
              </div>
            `
            : nothing
        }

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__checkbox-label">
            <input
              type="checkbox"
              .checked=${config.remoteAccess || false}
              @change=${(e: Event) => {
                const target = e.target as HTMLInputElement;
                this.currentAnswer = { ...config, remoteAccess: target.checked };
                this.requestUpdate();
              }}
            />
            Remote-Zugriff erlauben
          </label>
        </div>
      </div>
    `;
  }

  private renderChannelCards(step: WizardStep): TemplateResult {
    const selected = (this.currentAnswer as Array<{ id: string; connected: boolean }>) || [];

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Channels verbinden"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__channel-grid">
          ${step.items?.map((item) => {
            const isConnected = selected.some((s) => s.id === item.id && s.connected);
            return html`
              <div class="onboarding-wizard__channel-card ${isConnected ? "onboarding-wizard__channel-card--connected" : ""}">
                <div class="onboarding-wizard__channel-icon">${icons.messageSquare}</div>
                <h3 class="onboarding-wizard__channel-name">${item.label}</h3>
                <button
                  class="onboarding-wizard__button onboarding-wizard__button--secondary"
                  @click=${() => {
                    const next = [...selected];
                    const idx = next.findIndex((s) => s.id === item.id);
                    if (idx >= 0) {
                      next[idx] = { ...next[idx], connected: !next[idx].connected };
                    } else {
                      next.push({ id: item.id, connected: true });
                    }
                    this.currentAnswer = next;
                    this.requestUpdate();
                  }}
                >
                  ${isConnected ? "Getrennt" : "Verbinden"}
                </button>
                ${
                  isConnected
                    ? html`
                        <span class="onboarding-wizard__channel-badge">Verbunden</span>
                      `
                    : nothing
                }
              </div>
            `;
          })}
        </div>

        <a href="#" class="onboarding-wizard__link">Später einrichten</a>
      </div>
    `;
  }

  private renderAgentModeSelect(step: WizardStep): TemplateResult {
    const selected = (this.currentAnswer as string) || step.initialValue || "single";

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Team / Agents"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__radio-group">
          ${step.options?.map((opt) => {
            const isSelected = selected === opt.value;
            return html`
              <label class="onboarding-wizard__radio-label ${isSelected ? "onboarding-wizard__radio-label--selected" : ""}">
                <input
                  type="radio"
                  name="agent-mode"
                  value=${opt.value}
                  .checked=${isSelected}
                  @change=${() => {
                    this.currentAnswer = opt.value;
                    this.requestUpdate();
                  }}
                />
                <div class="onboarding-wizard__radio-content">
                  <strong>${opt.label}</strong>
                  ${opt.hint ? html`<span class="onboarding-wizard__radio-hint">${opt.hint}</span>` : nothing}
                </div>
              </label>
            `;
          })}
        </div>
      </div>
    `;
  }

  private renderAgentSingleForm(step: WizardStep): TemplateResult {
    const agentData = (this.currentAnswer as { name?: string }) || {
      name: step.initialValue || "main",
    };

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Einzel-Agent konfigurieren"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Agent-Name</label>
          <input
            type="text"
            class="onboarding-wizard__input"
            placeholder=${step.placeholder || "main"}
            .value=${agentData.name || ""}
            @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              this.currentAnswer = { ...agentData, name: target.value };
              this.validateStep(step);
              this.requestUpdate();
            }}
          />
        </div>
      </div>
    `;
  }

  private renderAgentTeamCount(step: WizardStep): TemplateResult {
    const count = (this.currentAnswer as string) || step.initialValue || "3";

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Team-Modus"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__info-box">
          <strong>Master-Admin</strong>
          <p>Du bist der Master-Admin und hast dauerhaft Kontrolle über das Team via Web UI.</p>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Anzahl Agents</label>
          <input
            type="number"
            class="onboarding-wizard__input"
            placeholder=${step.placeholder || "3"}
            .value=${count}
            min=${step.validation?.min || 2}
            max=${step.validation?.max || 20}
            @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              this.currentAnswer = target.value;
              this.validateStep(step);
              this.requestUpdate();
            }}
          />
          <p class="onboarding-wizard__hint">
            Zwischen ${step.validation?.min || 2} und ${step.validation?.max || 20} Agents
          </p>
        </div>
      </div>
    `;
  }

  private renderAgentSwarmConfig(step: WizardStep): TemplateResult {
    const swarmConfig = (this.currentAnswer as {
      count?: number;
      strategy?: "parallel" | "sequential";
    }) || { count: 10, strategy: "parallel" };
    const count = String(swarmConfig.count || 10);
    const strategy = swarmConfig.strategy || "parallel";

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Schwarm-Modus"}</h2>
        <p class="onboarding-wizard__step-message">
          ${step.message || "Konfiguriere deinen Agenten-Schwarm"}
        </p>

        <div class="onboarding-wizard__info-box">
          <strong>Schwarm-Modus</strong>
          <p>
            Viele Agents arbeiten zusammen an Aufgaben. Sie können parallel oder sequentiell arbeiten.
            Ideal für komplexe Aufgaben, die aufgeteilt werden können.
          </p>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Anzahl Agents</label>
          <input
            type="number"
            class="onboarding-wizard__input"
            placeholder="10"
            .value=${count}
            min="5"
            max="100"
            @input=${(e: Event) => {
              const target = e.target as HTMLInputElement;
              this.currentAnswer = {
                ...swarmConfig,
                count: parseInt(target.value, 10) || 10,
              };
              this.validateStep(step);
              this.requestUpdate();
            }}
          />
          <p class="onboarding-wizard__hint">Zwischen 5 und 100 Agents (empfohlen: 10-20)</p>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">Koordinations-Strategie</label>
          <div class="onboarding-wizard__radio-group">
            <label
              class="onboarding-wizard__radio-label ${strategy === "parallel" ? "onboarding-wizard__radio-label--selected" : ""}"
            >
              <input
                type="radio"
                name="swarm-strategy"
                value="parallel"
                .checked=${strategy === "parallel"}
                @change=${() => {
                  this.currentAnswer = { ...swarmConfig, strategy: "parallel" };
                  this.requestUpdate();
                }}
              />
              <div class="onboarding-wizard__radio-content">
                <strong>Parallel</strong>
                <span class="onboarding-wizard__radio-hint">Alle Agents arbeiten gleichzeitig (schneller)</span>
              </div>
            </label>
            <label
              class="onboarding-wizard__radio-label ${strategy === "sequential" ? "onboarding-wizard__radio-label--selected" : ""}"
            >
              <input
                type="radio"
                name="swarm-strategy"
                value="sequential"
                .checked=${strategy === "sequential"}
                @change=${() => {
                  this.currentAnswer = { ...swarmConfig, strategy: "sequential" };
                  this.requestUpdate();
                }}
              />
              <div class="onboarding-wizard__radio-content">
                <strong>Sequentiell</strong>
                <span class="onboarding-wizard__radio-hint">Agents arbeiten nacheinander (kosteneffizienter)</span>
              </div>
            </label>
          </div>
        </div>
      </div>
    `;
  }

  private renderAgentGrid(step: WizardStep): TemplateResult {
    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Agents erstellt"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || ""}</p>

        <div class="onboarding-wizard__agent-grid">
          ${step.items?.map(
            (item) => html`
              <div class="onboarding-wizard__agent-card">
                <div class="onboarding-wizard__agent-avatar">${item.label.charAt(0)}</div>
                <h3 class="onboarding-wizard__agent-name">${item.label}</h3>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  private renderAgentConfigAdvanced(step: WizardStep): TemplateResult {
    const config = (this.currentAnswer as {
      rules?: string;
      commands?: string;
      systemPrompt?: string;
    }) || {};

    return html`
      <div class="onboarding-wizard__step">
        <h2 class="onboarding-wizard__step-title">${step.title || "Agent-Konfiguration"}</h2>
        <p class="onboarding-wizard__step-message">
          ${step.message || "Konfiguriere Rules, Commands und System-Prompt für deine Agents (optional)"}
        </p>

        <div class="onboarding-wizard__info-box">
          <strong>Hinweis</strong>
          <p>
            Diese Konfiguration wird auf <strong>alle erstellten Agents</strong> angewendet. Du kannst sie später
            individuell anpassen.
          </p>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">
            Rules (AGENTS.md)
            <span class="onboarding-wizard__hint">Verhaltensregeln und Richtlinien für Agents</span>
          </label>
          <textarea
            class="onboarding-wizard__textarea"
            placeholder="Beispiel:&#10;- Sei immer höflich und professionell&#10;- Verwende keine persönlichen Daten ohne Erlaubnis&#10;- Dokumentiere alle wichtigen Entscheidungen"
            rows="6"
            .value=${config.rules || ""}
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              this.currentAnswer = { ...config, rules: target.value };
              this.requestUpdate();
            }}
          ></textarea>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">
            Commands (TOOLS.md)
            <span class="onboarding-wizard__hint">Verfügbare Befehle und Tools für Agents</span>
          </label>
          <textarea
            class="onboarding-wizard__textarea"
            placeholder="Beispiel:&#10;/search - Suche im Internet&#10;/code - Analysiere Code&#10;/write - Schreibe Dateien"
            rows="6"
            .value=${config.commands || ""}
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              this.currentAnswer = { ...config, commands: target.value };
              this.requestUpdate();
            }}
          ></textarea>
        </div>

        <div class="onboarding-wizard__form-group">
          <label class="onboarding-wizard__label">
            System-Prompt (SOUL.md)
            <span class="onboarding-wizard__hint">Grundlegende Persönlichkeit und Verhalten des Agents</span>
          </label>
          <textarea
            class="onboarding-wizard__textarea"
            placeholder="Beispiel:&#10;Du bist ein hilfreicher AI-Assistent.&#10;Dein Ziel ist es, dem Nutzer bei seinen Aufgaben zu helfen.&#10;Sei präzise, aber freundlich."
            rows="6"
            .value=${config.systemPrompt || ""}
            @input=${(e: Event) => {
              const target = e.target as HTMLTextAreaElement;
              this.currentAnswer = { ...config, systemPrompt: target.value };
              this.requestUpdate();
            }}
          ></textarea>
        </div>

        <p class="onboarding-wizard__hint">
          <strong>Tipp:</strong> Diese Felder sind optional. Du kannst sie leer lassen und später konfigurieren.
        </p>
      </div>
    `;
  }

  private renderSkillsConfig(step: WizardStep): TemplateResult {
    // Load skills on first render
    if (this.availableSkills.length === 0 && !this.skillsLoading) {
      void this.loadAvailableSkills();
    }

    const skillsAnswer = (this.currentAnswer as {
      mode?: "allowlist" | "blocklist" | "all";
      allowlist?: string[];
      blocklist?: string[];
    }) || { mode: "all" };

    return renderSkillsConfig(
      step,
      this.availableSkills,
      skillsAnswer,
      (mode) => {
        this.currentAnswer = { ...skillsAnswer, mode };
        this.requestUpdate();
      },
      (skillName, list) => {
        const current = skillsAnswer[list] || [];
        const updated = current.includes(skillName)
          ? current.filter((s) => s !== skillName)
          : [...current, skillName];
        this.currentAnswer = { ...skillsAnswer, [list]: updated };
        this.requestUpdate();
      },
    );
  }

  private async loadAvailableSkills(): Promise<void> {
    this.skillsLoading = true;
    this.requestUpdate();
    try {
      const props = this.props;
      const gateway = (props as any)?.gateway;
      if (gateway) {
        const result = await gateway.request("skills.status", {});
        if (result?.skills) {
          this.availableSkills = result.skills.map((s: any) => ({
            name: s.name || s.skillKey,
            description: s.description,
          }));
        }
      } else {
        // Fallback: empty list if no gateway available
        this.availableSkills = [];
      }
    } catch (err) {
      console.error("Failed to load skills:", err);
      this.availableSkills = [];
    } finally {
      this.skillsLoading = false;
      this.requestUpdate();
    }
  }

  private renderSummary(step: WizardStep): TemplateResult {
    return html`
      <div class="onboarding-wizard__step onboarding-wizard__step--summary">
        <h2 class="onboarding-wizard__step-title">${step.title || "Fertig"}</h2>
        <p class="onboarding-wizard__step-message">${step.message || "Activi ist bereit."}</p>

        ${
          step.summary && step.summary.length > 0
            ? html`
              <div class="onboarding-wizard__summary">
                ${step.summary.map(
                  (item) => html`
                    <div class="onboarding-wizard__summary-item">
                      <span class="onboarding-wizard__summary-label">${item.label}:</span>
                      <span class="onboarding-wizard__summary-value">${item.value}</span>
                    </div>
                  `,
                )}
              </div>
            `
            : nothing
        }

        <div class="onboarding-wizard__summary-actions">
          <button class="onboarding-wizard__button onboarding-wizard__button--primary">
            Dashboard öffnen
          </button>
          <button class="onboarding-wizard__button onboarding-wizard__button--secondary">
            Terminal nutzen
          </button>
        </div>
      </div>
    `;
  }

  private validateStep(step: WizardStep): boolean {
    this.validationError = null;

    if (step.validation?.required) {
      if (
        !this.currentAnswer ||
        (typeof this.currentAnswer === "string" && !this.currentAnswer.trim())
      ) {
        this.validationError = "Dieses Feld ist erforderlich";
        return false;
      }
    }

    if (step.validation?.min !== undefined && typeof this.currentAnswer === "number") {
      if (this.currentAnswer < step.validation.min) {
        this.validationError = `Mindestwert: ${step.validation.min}`;
        return false;
      }
    }

    if (step.validation?.max !== undefined && typeof this.currentAnswer === "number") {
      if (this.currentAnswer > step.validation.max) {
        this.validationError = `Maximalwert: ${step.validation.max}`;
        return false;
      }
    }

    return true;
  }

  private isStepValid(step: WizardStep): boolean {
    if (!step.validation?.required) {
      return true;
    }
    return this.validateStep(step);
  }

  private props: OnboardingWizardProps | null = null;

  setProps(props: OnboardingWizardProps) {
    this.props = props;
    this.currentAnswer = props.step?.initialValue || null;
    this.requestUpdate();
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has("props") && this.props) {
      this.currentAnswer = this.props.step?.initialValue || null;
    }
  }
}
