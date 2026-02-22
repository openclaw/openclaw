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
  redacted: boolean;
  onNavigate: (tab: string) => void;
};

function redact(value: string, redacted: boolean) {
  return redacted ? "••••••" : value;
}

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
  redacted?: boolean;
};

function renderStatCard(card: StatCard, onNavigate: (tab: string) => void) {
  return html`
    <button class="ov-card" data-kind=${card.kind} @click=${() => onNavigate(card.tab)}>
      <span class="ov-card__label">${card.label}</span>
      <span class="ov-card__value ${card.redacted ? "redacted" : ""}">${card.value}</span>
      <span class="ov-card__hint">${card.hint}</span>
    </button>
  `;
}

export function renderOverviewCards(props: OverviewCardsProps) {
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
      value: redact(totalCost, props.redacted),
      hint: redact(`${totalTokens} tokens · ${totalMessages} msgs`, props.redacted),
      redacted: props.redacted,
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
    <section class="ov-cards">
      ${cards.map((c) => renderStatCard(c, props.onNavigate))}
    </section>

    ${
      sessions.length > 0
        ? html`
        <section class="ov-recent">
          <h3 class="ov-recent__title">${t("overview.cards.recentSessions")}</h3>
          <ul class="ov-recent__list">
            ${sessions.map(
              (s) => html`
                <li class="ov-recent__row ${props.redacted ? "redacted" : ""}">
                  <span class="ov-recent__key">${props.redacted ? redact(s.displayName || s.label || s.key, true) : blurDigits(s.displayName || s.label || s.key)}</span>
                  <span class="ov-recent__model">${s.model ?? ""}</span>
                  <span class="ov-recent__time">${s.updatedAt ? formatRelativeTimestamp(s.updatedAt) : ""}</span>
                </li>
              `,
            )}
          </ul>
        </section>
      `
        : nothing
    }
  `;
}
