import { html } from "lit";
import { t, type Locale } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { ORDERED_DASHBOARD_LOCALES, localeLabelKey } from "../language-options.ts";

export type LanguageViewProps = {
  currentLocale: Locale;
  onSelect: (locale: Locale) => void | Promise<void>;
};

function renderLanguageOption(props: LanguageViewProps, locale: Locale) {
  const isActive = props.currentLocale === locale;
  const isDefault = locale === "en";
  return html`
    <button
      type="button"
      class="language-option ${isActive ? "language-option--active" : ""}"
      aria-pressed=${isActive ? "true" : "false"}
      @click=${() => {
        if (isActive) {
          return;
        }
        void props.onSelect(locale);
      }}
    >
      <div class="language-option__top">
        <div class="language-option__copy">
          <div class="language-option__label">${t(`languages.${localeLabelKey(locale)}`)}</div>
          <div class="language-option__meta">${t("languagePage.previewLabel")}: ${locale}</div>
        </div>
        <div class="language-option__badges">
          ${isDefault ? html`<span class="pill">${t("languagePage.defaultBadge")}</span>` : null}
          ${
            isActive
              ? html`
                  <span class="pill language-option__selected-pill">
                    <span class="language-option__selected-icon" aria-hidden="true">${icons.check}</span>
                    ${t("languagePage.selectedBadge")}
                  </span>
                `
              : null
          }
        </div>
      </div>
      <div class="language-option__footer">
        <span class="language-option__footer-icon" aria-hidden="true">${icons.globe}</span>
        <span class="language-option__footer-text">${locale}</span>
      </div>
    </button>
  `;
}

export function renderLanguage(props: LanguageViewProps) {
  const currentLabel = t(`languages.${localeLabelKey(props.currentLocale)}`);
  return html`
    <section class="grid language-settings">
      <div class="card language-settings__hero">
        <div class="language-settings__hero-head">
          <div>
            <div class="card-title">${t("languagePage.title")}</div>
            <div class="card-sub">${t("languagePage.subtitle")}</div>
          </div>
          <span class="pill language-settings__current-pill">
            ${t("languagePage.currentLabel")}: ${currentLabel}
          </span>
        </div>
        <div class="language-settings__hero-note">${t("languagePage.localOnly")}</div>
      </div>

      <div class="card">
        <div class="card-title">${t("languagePage.availableTitle")}</div>
        <div class="card-sub">${t("languagePage.availableHint")}</div>
        <div class="language-settings__options">
          ${ORDERED_DASHBOARD_LOCALES.map((locale) => renderLanguageOption(props, locale))}
        </div>
      </div>
    </section>
  `;
}
