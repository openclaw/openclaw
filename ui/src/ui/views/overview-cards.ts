import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTokens, formatRelativeTimestamp } from "../format.ts";
import { icons } from "../icons.ts";
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

  return html`
    <section class="ov-cards">
      <div class="card ov-stat-card clickable" data-kind="cost" @click=${() => props.onNavigate("usage")}>
        <div class="ov-stat-card__inner">
          <div class="ov-stat-card__icon">${icons.barChart}</div>
          <div class="ov-stat-card__body">
            <div class="stat-label">${t("overview.cards.cost")}</div>
            <div class="stat-value ${props.redacted ? "redacted" : ""}">${redact(totalCost, props.redacted)}</div>
            <div class="muted">${redact(`${totalTokens} tokens · ${totalMessages} msgs`, props.redacted)}</div>
          </div>
        </div>
      </div>
      <div class="card ov-stat-card clickable" data-kind="sessions" @click=${() => props.onNavigate("sessions")}>
        <div class="ov-stat-card__inner">
          <div class="ov-stat-card__icon">${icons.fileText}</div>
          <div class="ov-stat-card__body">
            <div class="stat-label">${t("overview.stats.sessions")}</div>
            <div class="stat-value">${sessionCount ?? t("common.na")}</div>
            <div class="muted">${t("overview.stats.sessionsHint")}</div>
          </div>
        </div>
      </div>
      <div class="card ov-stat-card clickable" data-kind="skills" @click=${() => props.onNavigate("skills")}>
        <div class="ov-stat-card__inner">
          <div class="ov-stat-card__icon">${icons.zap}</div>
          <div class="ov-stat-card__body">
            <div class="stat-label">${t("overview.cards.skills")}</div>
            <div class="stat-value">${enabledSkills}/${totalSkills}</div>
            <div class="muted">${blockedSkills > 0 ? `${blockedSkills} blocked` : `${enabledSkills} active`}</div>
          </div>
        </div>
      </div>
      <div class="card ov-stat-card clickable" data-kind="cron" @click=${() => props.onNavigate("cron")}>
        <div class="ov-stat-card__inner">
          <div class="ov-stat-card__icon">${icons.scrollText}</div>
          <div class="ov-stat-card__body">
            <div class="stat-label">${t("overview.stats.cron")}</div>
            <div class="stat-value">
              ${cronEnabled == null ? t("common.na") : cronEnabled ? `${cronJobCount} jobs` : t("common.disabled")}
            </div>
            <div class="muted">
              ${
                failedCronCount > 0
                  ? html`<span class="danger">${failedCronCount} failed</span>`
                  : nothing
              }
              ${cronNext ? t("overview.stats.cronNext", { time: formatNextRun(cronNext) }) : ""}
            </div>
          </div>
        </div>
      </div>
    </section>

    ${
      props.sessionsResult && props.sessionsResult.sessions.length > 0
        ? html`
        <section class="card ov-recent-sessions">
          <div class="card-title">${t("overview.cards.recentSessions")}</div>
          <div class="ov-session-list">
            ${props.sessionsResult.sessions.slice(0, 5).map(
              (s) => html`
                <div class="ov-session-row ${props.redacted ? "redacted" : ""}">
                  <span class="ov-session-key">${props.redacted ? redact(s.displayName || s.label || s.key, true) : blurDigits(s.displayName || s.label || s.key)}</span>
                  <span class="muted">${s.model ?? ""}</span>
                  <span class="muted">${s.updatedAt ? formatRelativeTimestamp(s.updatedAt) : ""}</span>
                </div>
              `,
            )}
          </div>
        </section>
      `
        : nothing
    }
  `;
}
