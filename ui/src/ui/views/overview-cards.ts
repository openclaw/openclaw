import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTokens, formatRelativeTimestamp } from "../format.ts";
import { formatNextRun } from "../presenter.ts";
import type {
  SessionsUsageResult,
  SessionsListResult,
  SkillStatusReport,
  CronJob,
  CronStatus,
} from "../types.ts";

export type OverviewCardsProps = {
  usageResult: SessionsUsageResult | null;
  sessionsResult: SessionsListResult | null;
  skillsReport: SkillStatusReport | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  presenceCount: number;
  onNavigate: (tab: string) => void;
};

const DIGIT_RUN = /\d{3,}/g;

function blurDigits(value: string): TemplateResult {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blurred = escaped.replace(DIGIT_RUN, (m) => `<span class="blur-digits">${m}</span>`);
  return html`${unsafeHTML(blurred)}`;
}

type StatCard = {
  kind: string;
  tab: string;
  label: string;
  value: string | TemplateResult;
  hint: string | TemplateResult;
};

function renderStatCard(card: StatCard, onNavigate: (tab: string) => void) {
  return html`
    <button class="ov-card" data-kind=${card.kind} @click=${() => onNavigate(card.tab)}>
      <span class="ov-card__label">${card.label}</span>
      <span class="ov-card__value">${card.value}</span>
      <span class="ov-card__hint">${card.hint}</span>
    </button>
  `;
}

function renderSkeletonCards() {
  return html`
    <section class="ov-cards">
      ${[0, 1, 2, 3].map(
        (i) => html`
          <div class="ov-card" style="cursor:default;animation-delay:${i * 50}ms">
            <span class="skeleton skeleton-line" style="width:60px;height:10px"></span>
            <span class="skeleton skeleton-stat"></span>
            <span class="skeleton skeleton-line skeleton-line--medium" style="height:12px"></span>
          </div>
        `,
      )}
    </section>
  `;
}

export function renderOverviewCards(props: OverviewCardsProps) {
  const dataLoaded =
    props.usageResult != null || props.sessionsResult != null || props.skillsReport != null;
  if (!dataLoaded) {
    return renderSkeletonCards();
  }

  const totals = props.usageResult?.totals;
  const totalCost = formatCost(totals?.totalCost);
  const totalTokens = formatTokens(totals?.totalTokens);
  const totalMessages = totals ? String(props.usageResult?.aggregates?.messages?.total ?? 0) : "0";
  const sessionCount = props.sessionsResult?.count ?? null;

  const skills = props.skillsReport?.skills ?? [];
  const enabledSkills = skills.filter((s) => !s.disabled).length;
  const blockedSkills = skills.filter((s) => s.blockedByAllowlist).length;
  const totalSkills = skills.length;

  const cronEnabled = props.cronStatus?.enabled ?? null;
  const cronNext = props.cronStatus?.nextWakeAtMs ?? null;
  const cronJobCount = props.cronJobs.length;
  const failedCronCount = props.cronJobs.filter((j) => j.state?.lastStatus === "error").length;

  const cronValue =
    cronEnabled == null
      ? t("common.na")
      : cronEnabled
        ? `${cronJobCount} jobs`
        : t("common.disabled");

  const cronHint =
    failedCronCount > 0
      ? html`<span class="danger">${failedCronCount} failed</span>`
      : cronNext
        ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) })
        : "";

  const cards: StatCard[] = [
    {
      kind: "cost",
      tab: "usage",
      label: t("overview.cards.cost"),
      value: totalCost,
      hint: `${totalTokens} tokens · ${totalMessages} msgs`,
    },
    {
      kind: "sessions",
      tab: "sessions",
      label: t("overview.stats.sessions"),
      value: String(sessionCount ?? t("common.na")),
      hint: t("overview.stats.sessionsHint"),
    },
    {
      kind: "skills",
      tab: "skills",
      label: t("overview.cards.skills"),
      value: `${enabledSkills}/${totalSkills}`,
      hint: blockedSkills > 0 ? `${blockedSkills} blocked` : `${enabledSkills} active`,
    },
    {
      kind: "cron",
      tab: "cron",
      label: t("overview.stats.cron"),
      value: cronValue,
      hint: cronHint,
    },
  ];

  const sessions = props.sessionsResult?.sessions.slice(0, 5) ?? [];

  return html`
    <section class="ov-cards">${cards.map((c) => renderStatCard(c, props.onNavigate))}</section>

    ${sessions.length > 0
      ? html`
          <section class="ov-recent">
            <h3 class="ov-recent__title">${t("overview.cards.recentSessions")}</h3>
            <ul class="ov-recent__list">
              ${sessions.map(
                (s) => html`
                  <li class="ov-recent__row">
                    <span class="ov-recent__key"
                      >${blurDigits(s.displayName || s.label || s.key)}</span
                    >
                    <span class="ov-recent__model">${s.model ?? ""}</span>
                    <span class="ov-recent__time"
                      >${s.updatedAt ? formatRelativeTimestamp(s.updatedAt) : ""}</span
                    >
                  </li>
                `,
              )}
            </ul>
          </section>
        `
      : nothing}
  `;
}
