import { html, nothing, type TemplateResult } from "lit";
import type { WizardStep } from "./onboarding-wizard.ts";

export function renderSkillsConfig(
  step: WizardStep,
  availableSkills: Array<{ name: string; description?: string }>,
  currentAnswer: {
    mode?: "allowlist" | "blocklist" | "all";
    allowlist?: string[];
    blocklist?: string[];
  },
  onModeChange: (mode: "allowlist" | "blocklist" | "all") => void,
  onSkillToggle: (skillName: string, list: "allowlist" | "blocklist") => void,
): TemplateResult {
  const mode = currentAnswer.mode || "all";
  const allowlist = currentAnswer.allowlist || [];
  const blocklist = currentAnswer.blocklist || [];

  return html`
    <div class="onboarding-wizard__step">
      <h2 class="onboarding-wizard__step-title">${step.title || "Skills-Verwaltung"}</h2>
      <p class="onboarding-wizard__step-message">
        ${step.message || "Welche Skills sollen erlaubt oder blockiert sein?"}
      </p>

      <div class="onboarding-wizard__info-box">
        <strong>Sicherheit</strong>
        <p>
          Mit Allow/Block-Listen kannst du kontrollieren, welche Skills deine Agents verwenden können.
          <strong>Allowlist:</strong> Nur ausgewählte Skills sind erlaubt.<br />
          <strong>Blocklist:</strong> Alle Skills außer den blockierten sind erlaubt.<br />
          <strong>Alle:</strong> Keine Einschränkungen (Standard).
        </p>
      </div>

      <!-- Mode Selection -->
      <div class="onboarding-wizard__form-group">
        <label class="onboarding-wizard__label">Modus</label>
        <div class="onboarding-wizard__radio-group">
          <label
            class="onboarding-wizard__radio-label ${mode === "all" ? "onboarding-wizard__radio-label--selected" : ""}"
          >
            <input
              type="radio"
              name="skills-mode"
              value="all"
              .checked=${mode === "all"}
              @change=${() => onModeChange("all")}
            />
            <div class="onboarding-wizard__radio-content">
              <strong>Alle Skills erlauben</strong>
              <span class="onboarding-wizard__radio-hint">Keine Einschränkungen (Standard)</span>
            </div>
          </label>
          <label
            class="onboarding-wizard__radio-label ${mode === "allowlist" ? "onboarding-wizard__radio-label--selected" : ""}"
          >
            <input
              type="radio"
              name="skills-mode"
              value="allowlist"
              .checked=${mode === "allowlist"}
              @change=${() => onModeChange("allowlist")}
            />
            <div class="onboarding-wizard__radio-content">
              <strong>Allowlist</strong>
              <span class="onboarding-wizard__radio-hint">Nur ausgewählte Skills erlauben</span>
            </div>
          </label>
          <label
            class="onboarding-wizard__radio-label ${mode === "blocklist" ? "onboarding-wizard__radio-label--selected" : ""}"
          >
            <input
              type="radio"
              name="skills-mode"
              value="blocklist"
              .checked=${mode === "blocklist"}
              @change=${() => onModeChange("blocklist")}
            />
            <div class="onboarding-wizard__radio-content">
              <strong>Blocklist</strong>
              <span class="onboarding-wizard__radio-hint">Ausgewählte Skills blockieren</span>
            </div>
          </label>
        </div>
      </div>

      <!-- Skills List (only show if not "all") -->
      ${
        mode !== "all"
          ? html`
              <div class="onboarding-wizard__form-group">
                <label class="onboarding-wizard__label">
                  ${mode === "allowlist" ? "Erlaubte Skills" : "Blockierte Skills"}
                  <span class="onboarding-wizard__hint"
                    >(${mode === "allowlist" ? allowlist.length : blocklist.length} ausgewählt)</span
                  >
                </label>
                <div class="onboarding-wizard__skills-list">
                  ${
                    availableSkills.length === 0
                      ? html`<p class="onboarding-wizard__hint">Lade Skills...</p>`
                      : availableSkills.map(
                          (skill) => {
                            const isSelected =
                              mode === "allowlist"
                                ? allowlist.includes(skill.name)
                                : blocklist.includes(skill.name);
                            return html`
                              <label class="onboarding-wizard__checkbox-label onboarding-wizard__skill-item">
                                <input
                                  type="checkbox"
                                  .checked=${isSelected}
                                  @change=${() => onSkillToggle(skill.name, mode)}
                                />
                                <div class="onboarding-wizard__skill-content">
                                  <strong>${skill.name}</strong>
                                  ${skill.description
                                    ? html`<span class="onboarding-wizard__skill-description">${skill.description}</span>`
                                    : nothing}
                                </div>
                              </label>
                            `;
                          },
                        )
                  }
                </div>
                ${
                  mode === "allowlist" && allowlist.length === 0
                    ? html`<p class="onboarding-wizard__hint onboarding-wizard__hint--warning">
                        ⚠️ Keine Skills ausgewählt = Agent hat keine Skills verfügbar
                      </p>`
                    : nothing
                }
              </div>
            `
          : nothing
      }
    </div>
  `;
}
