import { html, nothing } from "lit";
import { BUILTIN_LOCALES, canonicalizeLocale, isBuiltinLocale, t } from "../../i18n/index.ts";
import { resolveLanguageLabel, searchLanguageCatalog } from "../../i18n/language-catalog.ts";
import type { AppViewState } from "../app-view-state.ts";

function isGenerating(state: AppViewState, locale: string) {
  return state.controlUiI18nJobs.some(
    (job) => job.locale === locale && (job.status === "queued" || job.status === "running"),
  );
}

export function renderI18nLanguageModal(state: AppViewState) {
  const generatedMap = new Map(
    (state.controlUiI18nCatalog?.generatedLocales ?? []).map((entry) => [entry.locale, entry]),
  );
  const generatedOnlyLocales = [...generatedMap.keys()].filter(
    (locale) => !isBuiltinLocale(locale),
  );
  const searchResults = searchLanguageCatalog(state.controlUiI18nModalSearch);
  const visibleLocales = Array.from(
    new Set([
      ...BUILTIN_LOCALES,
      ...searchResults.map((entry) => entry.locale),
      ...generatedOnlyLocales,
    ]),
  )
    .filter((locale) => {
      const query = state.controlUiI18nModalSearch.trim().toLowerCase();
      if (!query) {
        return true;
      }
      const label = resolveLanguageLabel(locale).toLowerCase();
      return locale.toLowerCase().includes(query) || label.includes(query);
    })
    .toSorted((a, b) => {
      const aBuiltin = isBuiltinLocale(a) ? 0 : 1;
      const bBuiltin = isBuiltinLocale(b) ? 0 : 1;
      if (aBuiltin !== bBuiltin) {
        return aBuiltin - bBuiltin;
      }
      return resolveLanguageLabel(a).localeCompare(resolveLanguageLabel(b));
    });

  const customCanonical = canonicalizeLocale(state.controlUiI18nModalCustomLocale);
  const customIsGenerated = customCanonical ? generatedMap.has(customCanonical) : false;
  const customGenerating = customCanonical ? isGenerating(state, customCanonical) : false;

  return html`
    ${
      state.controlUiI18nModalOpen
        ? html`
            <div
              class="exec-approval-overlay"
              role="dialog"
              aria-modal="true"
              aria-label=${t("controlUiI18n.modal.addLanguage")}
            >
              <div class="exec-approval-card i18n-language-modal">
                <div class="exec-approval-header">
                  <div>
                    <div class="exec-approval-title">${t("controlUiI18n.modal.addLanguage")}</div>
                    <div class="exec-approval-sub">
                      ${t("controlUiI18n.modal.subtitle")}
                    </div>
                  </div>
                </div>

                <div class="i18n-language-modal__search">
                  <input
                    placeholder=${t("controlUiI18n.modal.searchPlaceholder")}
                    .value=${state.controlUiI18nModalSearch}
                    @input=${(e: Event) =>
                      state.handleControlUiI18nSearchChange((e.target as HTMLInputElement).value)}
                  />
                </div>

                <div class="i18n-language-modal__custom">
                  <label class="field">
                    <span>${t("controlUiI18n.modal.customLocaleLabel")}</span>
                    <input
                      .value=${state.controlUiI18nModalCustomLocale}
                      placeholder=${t("controlUiI18n.modal.customLocalePlaceholder")}
                      @input=${(e: Event) =>
                        state.handleControlUiI18nCustomLocaleChange(
                          (e.target as HTMLInputElement).value,
                        )}
                    />
                  </label>
                  <div class="row" style="margin-top: 8px;">
                    <button
                      class="btn btn--sm"
                      ?disabled=${!customCanonical || customGenerating}
                      @click=${() =>
                        customCanonical &&
                        state.handleControlUiI18nRequestGenerate(customCanonical, {
                          force: customIsGenerated,
                        })}
                    >
                      ${
                        customGenerating
                          ? t("common.generating")
                          : customIsGenerated
                            ? t("common.regenerate")
                            : t("common.generate")
                      }
                    </button>
                    <span class="muted">
                      ${
                        customCanonical
                          ? t("controlUiI18n.modal.canonical", { locale: customCanonical })
                          : t("controlUiI18n.modal.invalidCustomLocale")
                      }
                    </span>
                  </div>
                </div>

                <div class="i18n-language-modal__list" role="list">
                  ${visibleLocales.map((locale) => {
                    const generated = generatedMap.get(locale);
                    const generating = isGenerating(state, locale);
                    const isBuiltin = isBuiltinLocale(locale);
                    return html`
                      <div class="i18n-language-row" role="listitem">
                        <div class="i18n-language-row__meta">
                          <div class="i18n-language-row__title">${resolveLanguageLabel(locale)}</div>
                          <div class="i18n-language-row__sub mono">${locale}</div>
                        </div>
                        <div class="i18n-language-row__badges">
                          ${
                            isBuiltin
                              ? html`
                                  <span class="i18n-badge">${t("controlUiI18n.badges.bundled")}</span>
                                `
                              : nothing
                          }
                          ${
                            generated
                              ? html`
                                  <span class="i18n-badge">${t("controlUiI18n.badges.generated")}</span>
                                `
                              : nothing
                          }
                          ${
                            generating
                              ? html`
                                  <span class="i18n-badge i18n-badge--info">${t("controlUiI18n.badges.generating")}</span>
                                `
                              : nothing
                          }
                          ${
                            generated?.stale
                              ? html`
                                  <span class="i18n-badge i18n-badge--warn">${t("controlUiI18n.badges.stale")}</span>
                                `
                              : nothing
                          }
                        </div>
                        <div class="i18n-language-row__actions">
                          ${
                            isBuiltin
                              ? nothing
                              : html`
                                <button
                                  class="btn btn--sm"
                                  ?disabled=${generating}
                                  @click=${() =>
                                    state.handleControlUiI18nRequestGenerate(locale, {
                                      force: Boolean(generated),
                                    })}
                                >
                                  ${
                                    generating
                                      ? t("common.generating")
                                      : generated
                                        ? t("common.regenerate")
                                        : t("common.generate")
                                  }
                                </button>
                              `
                          }
                        </div>
                      </div>
                    `;
                  })}
                </div>

                <div class="exec-approval-actions">
                  <button class="btn primary" @click=${() => state.handleControlUiI18nCloseModal()}>
                    ${t("common.close")}
                  </button>
                </div>
              </div>
            </div>
          `
        : nothing
    }

    ${
      state.controlUiI18nConfirmRequest
        ? html`
            <div
              class="exec-approval-overlay"
              role="dialog"
              aria-modal="true"
              aria-label=${t("controlUiI18n.modal.generateTranslation")}
            >
              <div class="exec-approval-card">
                <div class="exec-approval-header">
                  <div>
                    <div class="exec-approval-title">
                      ${
                        state.controlUiI18nConfirmRequest.force
                          ? t("controlUiI18n.modal.regenerateTranslation")
                          : t("controlUiI18n.modal.generateTranslation")
                      }
                    </div>
                    <div class="exec-approval-sub">
                      ${resolveLanguageLabel(state.controlUiI18nConfirmRequest.locale)}
                      <span class="mono">(${state.controlUiI18nConfirmRequest.locale})</span>
                    </div>
                  </div>
                </div>
                <div class="callout info" style="margin-top: 12px;">
                  ${t("controlUiI18n.modal.providerNotice")}
                </div>
                <div class="exec-approval-actions">
                  <button class="btn primary" @click=${() => void state.handleControlUiI18nConfirmGenerate()}>
                    ${state.controlUiI18nConfirmRequest.force ? t("common.regenerate") : t("common.generate")}
                  </button>
                  <button class="btn" @click=${() => state.handleControlUiI18nCancelConfirm()}>
                    ${t("common.cancel")}
                  </button>
                </div>
              </div>
            </div>
          `
        : nothing
    }
  `;
}
