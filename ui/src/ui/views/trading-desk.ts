import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { TradingSnapshotResult } from "../types.ts";

export type TradingDeskProps = {
  connected: boolean;
  tradingRpcAvailable: boolean;
  loading: boolean;
  snapshot: TradingSnapshotResult | null;
  error: string | null;
  onRefresh: () => void;
};

export function renderTradingDesk(props: TradingDeskProps) {
  const snapshotTime =
    typeof props.snapshot?.ts === "number"
      ? new Date(props.snapshot.ts).toLocaleTimeString()
      : t("common.na");
  const platform = props.snapshot?.platform;
  const ticket = platform?.fastOrderTicket;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; gap: 12px; align-items: flex-start;">
        <div>
          <div class="card-title">${t("tradingDesk.status.title")}</div>
          <div class="card-sub">${t("tradingDesk.status.subtitle")}</div>
        </div>
        <span class="pill ${props.connected ? "" : "danger"}">
          ${props.connected ? t("common.connected") : t("common.offline")}
        </span>
      </div>
      <div class="row" style="margin-top: 12px; gap: 8px; align-items: center;">
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? t("common.loading") : t("common.refresh")}
        </button>
        <span class="muted">${t("tradingDesk.status.lastRefresh", { time: snapshotTime })}</span>
      </div>
      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      <div class="list" style="margin-top: 14px;">
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">AI Trading Platform</div>
            <div class="list-sub">
              ${platform?.title ?? "Waiting for trading.snapshot platform state."}
            </div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="chip ${platform?.status === "ready_for_review" ? "" : "danger"}">
              ${platform?.status ?? "missing"}
            </span>
            <span class="chip">providers:${platform?.providers.length ?? 0}</span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">快速進出場 Ticket</div>
            <div class="list-sub">
              ${ticket
                ? `${ticket.provider.toUpperCase()} ${ticket.symbol} ${ticket.side} qty=${ticket.quantity} entry=${ticket.entry} exit=${ticket.exit}`
                : "No fast order ticket loaded."}
            </div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="chip ${ticket?.liveOrderAllowed ? "" : "danger"}">
              ${ticket?.liveOrderAllowed ? "live-ready" : "live-blocked"}
            </span>
            <span class="chip">blockers:${ticket?.blockerCount ?? 0}</span>
            <span class="chip">broker:${ticket?.brokerCommandEnabled ? "on" : "off"}</span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">AI 策略引擎</div>
            <div class="list-sub">
              ${platform
                ? `${platform.strategy.symbol} signals=${platform.strategy.signalsGenerated} intents=${platform.strategy.intentsReady} fill=${platform.strategy.fillStatus}/${platform.strategy.fillRecommendation}`
                : "No strategy state loaded."}
            </div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="chip">AI modules:${platform?.strategy.aiModuleCount ?? 0}</span>
            <span class="chip ${platform?.strategy.aiBrainReady ? "" : "danger"}">
              ${platform?.strategy.aiBrainReady ? "brain-ready" : "brain-missing"}
            </span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">Broker Gates</div>
            <div class="list-sub">
              ${(platform?.providers ?? [])
                .map((provider) => `${provider.label}:${provider.status}`)
                .join(" / ") || "No provider gate reports loaded."}
            </div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${(platform?.providers ?? []).map(
              (provider) => html`
                <span class="chip ${provider.ready ? "" : "danger"}">
                  ${provider.id}:${provider.blockerCount}
                </span>
              `,
            )}
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("tradingDesk.status.route")}</div>
            <div class="list-sub mono">${t("tradingDesk.status.routePath")}</div>
          </div>
          <div class="list-meta">
            <span class="chip">${t("tradingDesk.badges.wired")}</span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("tradingDesk.status.gateway")}</div>
            <div class="list-sub">${t("tradingDesk.status.gatewayHint")}</div>
          </div>
          <div class="list-meta">
            <span class="chip ${props.tradingRpcAvailable ? "" : "danger"}">
              ${props.tradingRpcAvailable
                ? t("tradingDesk.badges.contractReady")
                : t("tradingDesk.badges.contractMissing")}
            </span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("tradingDesk.status.mode")}</div>
            <div class="list-sub">${t("tradingDesk.status.modeHint")}</div>
          </div>
          <div class="list-meta">
            <span class="chip ${props.snapshot?.mode === "paper_only" ? "" : "danger"}">
              ${props.snapshot?.mode === "paper_only"
                ? t("tradingDesk.badges.paperOnly")
                : t("tradingDesk.badges.contractMissing")}
            </span>
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("tradingDesk.status.runtime")}</div>
            <div class="list-sub">${t("tradingDesk.status.runtimeHint")}</div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            <span class="chip"
              >${t("tradingDesk.status.feedsTotal", {
                count: String(props.snapshot?.runtime.totalFeeds ?? 0),
              })}</span
            >
            <span class="chip"
              >${t("tradingDesk.status.feedsConnected", {
                count: String(props.snapshot?.runtime.connectedFeeds ?? 0),
              })}</span
            >
            <span class="chip"
              >${t("tradingDesk.status.feedsRunning", {
                count: String(props.snapshot?.runtime.runningFeeds ?? 0),
              })}</span
            >
          </div>
        </div>
        <div class="list-item">
          <div class="list-main">
            <div class="list-title">${t("tradingDesk.status.safety")}</div>
            <div class="list-sub">${t("tradingDesk.status.safetyHint")}</div>
          </div>
          <div class="list-meta" style="display: flex; gap: 6px; flex-wrap: wrap;">
            ${renderGate(
              t("tradingDesk.status.liveTradingGate"),
              props.snapshot?.safety.liveTradingEnabled ?? false,
            )}
            ${renderGate(
              t("tradingDesk.status.paidProviderGate"),
              props.snapshot?.safety.paidProviderEnabled ?? false,
            )}
            ${renderGate(
              t("tradingDesk.status.writesGate"),
              props.snapshot?.safety.writesEnabled ?? false,
            )}
            ${renderGate(
              t("tradingDesk.status.highRiskGate"),
              props.snapshot?.safety.highRiskEnabled ?? false,
            )}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderGate(label: string, enabled: boolean) {
  return html`<span class="chip ${enabled ? "" : "danger"}"
    >${label}:${enabled ? t("tradingDesk.badges.enabled") : t("tradingDesk.badges.locked")}</span
  >`;
}
