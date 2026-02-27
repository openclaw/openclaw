import { html, nothing } from "lit";
import type { MarketplaceSeller, MarketplaceStatusResult } from "../controllers/marketplace.ts";

export type MarketplaceProps = {
  loading: boolean;
  status: MarketplaceStatusResult | null;
  error: string | null;
  onRefresh: () => void;
};

export function renderMarketplace(props: MarketplaceProps) {
  return html`
    ${renderComingSoon()}
    ${renderMarketplaceOverview(props)}
    ${props.status?.enabled ? renderPricing(props.status) : nothing}
    ${props.status?.enabled ? renderSellers(props) : nothing}
  `;
}

function renderComingSoon() {
  return html`
    <section class="card" style="text-align: center; padding: 32px">
      <div style="font-size: 28px; font-weight: 800; margin-bottom: 8px">P2P Compute Marketplace</div>
      <div class="muted" style="font-size: 15px; max-width: 480px; margin: 0 auto 24px">
        Share idle Claude capacity and earn $AI tokens. Buyers get cheaper API access, sellers monetize
        unused compute. All settlement on-chain.
      </div>
      <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap">
        <a
          href="https://market.hanzo.bot/waitlist"
          target="_blank"
          rel="noopener"
          class="btn"
          style="
            background: var(--ok);
            color: #000;
            font-weight: 700;
            padding: 10px 24px;
            border-radius: var(--radius-md);
            text-decoration: none;
            font-size: 14px;
          "
        >
          Request Early Access
        </a>
        <a
          href="https://market.hanzo.bot"
          target="_blank"
          rel="noopener"
          class="btn"
          style="
            padding: 10px 24px;
            border-radius: var(--radius-md);
            text-decoration: none;
            font-size: 14px;
          "
        >
          Learn More
        </a>
      </div>
      <div style="margin-top: 24px; display: flex; gap: 24px; justify-content: center; flex-wrap: wrap">
        <div style="text-align: center">
          <div style="font-size: 18px; font-weight: 700">40%</div>
          <div class="muted" style="font-size: 11px">Buyer Savings</div>
        </div>
        <div style="text-align: center">
          <div style="font-size: 18px; font-weight: 700">40%</div>
          <div class="muted" style="font-size: 11px">Seller Earnings</div>
        </div>
        <div style="text-align: center">
          <div style="font-size: 18px; font-weight: 700">10%</div>
          <div class="muted" style="font-size: 11px">$AI Token Bonus</div>
        </div>
        <div style="text-align: center">
          <div style="font-size: 18px; font-weight: 700">On-Chain</div>
          <div class="muted" style="font-size: 11px">Settlement</div>
        </div>
      </div>
    </section>
  `;
}

function renderMarketplaceOverview(props: MarketplaceProps) {
  const status = props.status;
  const enabled = status?.enabled ?? false;
  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Marketplace</div>
          <div class="card-sub">P2P compute sharing — idle Claude capacity routed to buyers.</div>
        </div>
        <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
          ${props.loading ? "Loading\u2026" : "Refresh"}
        </button>
      </div>
      ${props.error ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>` : nothing}

      <div
        style="
          margin-top: 16px;
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        "
      >
        ${renderStatCard("Status", enabled ? "Active" : "Disabled", enabled ? "ok" : "warn")}
        ${renderStatCard("Available Sellers", String(status?.availableSellers ?? 0), status?.availableSellers ? "ok" : "")}
        ${renderStatCard("Total Sellers", String(status?.totalSellers ?? 0), "")}
      </div>

      ${
        !enabled
          ? html`
              <div class="callout" style="margin-top: 16px">
                Marketplace is not enabled on this gateway. Enable it in
                <code>gateway.marketplace.enabled</code> in the config.
              </div>
            `
          : nothing
      }
    </section>
  `;
}

function renderStatCard(label: string, value: string, statusClass: string) {
  return html`
    <div
      style="
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg);
      "
    >
      <div class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">
        ${label}
      </div>
      <div
        style="font-size: 22px; font-weight: 700; margin-top: 4px;"
        class="${statusClass ? `text-${statusClass}` : ""}"
      >
        ${value}
      </div>
    </div>
  `;
}

function renderPricing(status: MarketplaceStatusResult) {
  const priceFraction = status.priceFraction ?? 0.6;
  const platformFeePct = status.platformFeePct ?? 20;
  const buyerDiscount = Math.round((1 - priceFraction) * 100);
  const sellerPct = Math.round(priceFraction * 100 - platformFeePct);
  return html`
    <section class="card">
      <div class="card-title">Pricing</div>
      <div class="card-sub">Revenue split for marketplace transactions.</div>
      <div
        style="
          margin-top: 16px;
          display: grid;
          gap: 16px;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        "
      >
        ${renderStatCard("Buyer Discount", `${buyerDiscount}% off`, "")}
        ${renderStatCard("Seller Earnings", `${sellerPct}%`, "")}
        ${renderStatCard("Platform Fee", `${platformFeePct}%`, "")}
      </div>

      <div
        style="
          margin-top: 16px;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          background: var(--bg);
        "
      >
        <div style="display: flex; height: 28px; border-radius: var(--radius-sm); overflow: hidden;">
          <div
            style="
              width: ${sellerPct}%;
              background: var(--ok);
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: 600;
              color: #000;
            "
          >
            Seller ${sellerPct}%
          </div>
          <div
            style="
              width: ${platformFeePct}%;
              background: var(--info);
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: 600;
              color: #fff;
            "
          >
            Platform ${platformFeePct}%
          </div>
          <div
            style="
              width: ${buyerDiscount}%;
              background: var(--bg-hover);
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: 500;
              color: var(--text);
            "
          >
            Savings ${buyerDiscount}%
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderSellers(props: MarketplaceProps) {
  const sellers = props.status?.sellers ?? [];
  if (sellers.length === 0) {
    return html`
      <section class="card">
        <div class="card-title">Sellers</div>
        <div class="card-sub">Nodes sharing idle Claude capacity.</div>
        <div class="muted" style="margin-top: 16px">
          No sellers registered. Nodes opt in via CLI config or by calling
          <code>marketplace.opt-in</code>.
        </div>
      </section>
    `;
  }

  return html`
    <section class="card">
      <div class="card-title">Sellers</div>
      <div class="card-sub">${sellers.length} node${sellers.length !== 1 ? "s" : ""} sharing capacity.</div>
      <div
        style="
          margin-top: 16px;
          display: grid;
          gap: 12px;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        "
      >
        ${sellers.map((s) => renderSellerCard(s))}
      </div>
    </section>
  `;
}

function renderSellerCard(seller: MarketplaceSeller) {
  const statusColor =
    seller.status === "idle" ? "ok" : seller.status === "sharing" ? "info" : "warn";
  const utilization =
    seller.maxConcurrent > 0 ? Math.round((seller.activeRequests / seller.maxConcurrent) * 100) : 0;
  const successRate =
    seller.totalCompleted + seller.totalFailed > 0
      ? Math.round((seller.totalCompleted / (seller.totalCompleted + seller.totalFailed)) * 100)
      : 100;

  return html`
    <div
      style="
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg);
      "
    >
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div style="font-weight: 600; font-size: 13px;">
            ${seller.nodeId.substring(0, 12)}\u2026
          </div>
        </div>
        <span class="chip chip-${statusColor}" style="font-size: 11px; padding: 2px 8px;">
          ${seller.status}
        </span>
      </div>

      <div
        style="
          margin-top: 12px;
          display: grid;
          gap: 8px;
          grid-template-columns: 1fr 1fr;
        "
      >
        <div>
          <div class="muted" style="font-size: 10px; text-transform: uppercase;">Requests</div>
          <div style="font-size: 14px; font-weight: 600;">
            ${seller.activeRequests} / ${seller.maxConcurrent}
          </div>
        </div>
        <div>
          <div class="muted" style="font-size: 10px; text-transform: uppercase;">Utilization</div>
          <div style="font-size: 14px; font-weight: 600;">${utilization}%</div>
        </div>
        <div>
          <div class="muted" style="font-size: 10px; text-transform: uppercase;">Completed</div>
          <div style="font-size: 14px; font-weight: 600;">${seller.totalCompleted}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 10px; text-transform: uppercase;">Success Rate</div>
          <div style="font-size: 14px; font-weight: 600;">${successRate}%</div>
        </div>
      </div>

      <div style="margin-top: 10px;">
        <div class="muted" style="font-size: 10px; text-transform: uppercase; margin-bottom: 4px;">
          Trust Score
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div
            style="
              flex: 1;
              height: 6px;
              background: var(--bg-hover);
              border-radius: 3px;
              overflow: hidden;
            "
          >
            <div
              style="
                width: ${seller.performanceScore}%;
                height: 100%;
                background: ${seller.performanceScore >= 50 ? "var(--ok)" : "var(--warn)"};
                border-radius: 3px;
              "
            ></div>
          </div>
          <span style="font-size: 12px; font-weight: 600; min-width: 32px; text-align: right;">
            ${seller.performanceScore}
          </span>
        </div>
      </div>
    </div>
  `;
}
