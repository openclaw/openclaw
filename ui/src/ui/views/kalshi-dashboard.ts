import { html, nothing, svg } from "lit";
import "../../styles/kalshi-dashboard.css";
import type { KalshiDashboardSnapshot } from "../controllers/kalshi-dashboard.ts";

/* oxlint-disable typescript/no-base-to-string oxc/no-map-spread typescript/no-unnecessary-type-conversion */

export type KalshiDashboardProps = {
  loading: boolean;
  error: string | null;
  snapshot: KalshiDashboardSnapshot | null;
  lastFetchAt: number | null;
  timezone: string;
  timeframe: string;
  pnlTimeframe: string;
  strategySort: KalshiStrategySort;
  showDeepAudit: boolean;
  auditTablePages?: Record<string, number>;
  auditTableQueries?: Record<string, string>;
  onTimezoneChange: (timezone: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onPnlTimeframeChange: (timeframe: string) => void;
  onStrategySortChange: (sort: KalshiStrategySort) => void;
  onToggleDeepAudit: () => void;
  onAuditTablePageChange: (table: string, page: number) => void;
  onAuditTableQueryChange: (table: string, query: string) => void;
  onRefresh: () => void;
};

const CONTINENTAL_US_TIMEZONES = [
  { value: "America/New_York", label: "Eastern", sample: "ET" },
  { value: "America/Chicago", label: "Central", sample: "CT" },
  { value: "America/Denver", label: "Mountain", sample: "MT" },
  { value: "America/Phoenix", label: "Arizona", sample: "MST" },
  { value: "America/Los_Angeles", label: "Pacific", sample: "PT" },
] as const;

const TREND_TIMEFRAMES = [
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "6h", label: "6 hours", ms: 6 * 60 * 60 * 1000 },
  { value: "12h", label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "48h", label: "48 hours", ms: 48 * 60 * 60 * 1000 },
  { value: "7d", label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "1 month", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "1y", label: "1 year", ms: 365 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All", ms: null },
] as const;

const PNL_TIMEFRAMES = [
  { value: "all", label: "All time", ms: null },
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "6h", label: "6 hours", ms: 6 * 60 * 60 * 1000 },
  { value: "12h", label: "12 hours", ms: 12 * 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "48h", label: "48 hours", ms: 48 * 60 * 60 * 1000 },
  { value: "7d", label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "1 month", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

const AUDIT_TABLE_ROW_LIMIT = 50;
type AuditTableId = "pending" | "overdue" | "recent" | "resolved";

type AuditWindow = {
  page: number;
  pageCount: number;
  start: number;
  end: number;
};

type AuditPageMeta = NonNullable<KalshiDashboardSnapshot["audit_pages"]>[string];
type MarkovMicrostructureMarket = NonNullable<
  NonNullable<KalshiDashboardSnapshot["markov_microstructure"]>["markets"]
>[number];

export type KalshiStrategySort = "problem_first" | "pnl" | "accuracy" | "volume" | "name";

const STRATEGY_SORT_OPTIONS: Array<{ value: KalshiStrategySort; label: string }> = [
  { value: "problem_first", label: "Problem-first" },
  { value: "pnl", label: "Worst P&L first" },
  { value: "accuracy", label: "Best accuracy first" },
  { value: "volume", label: "Most volume first" },
  { value: "name", label: "Name" },
];

const COMMON_KALSHI_CATEGORIES = [
  { category: "weather", label: "Weather" },
  { category: "sports", label: "Sports" },
  { category: "economics", label: "Economics" },
  { category: "politics", label: "Politics" },
  { category: "crypto", label: "Crypto" },
  { category: "entertainment", label: "Entertainment" },
  { category: "unknown", label: "Unknown / Other" },
] as const;

const METRIC_DEFINITIONS: Record<string, string> = {
  "Paper Decisions":
    "Every paper-only Kalshi decision OpenClaw logged, including no-trade, rejected, exploration, and forward-paper decisions.",
  "Accepted Paper Trades":
    "Paper trade decisions that passed the strategy and risk rules. These are still simulated, but they are the decisions that can produce paper P&L evidence.",
  "Resolved Outcomes":
    "Paper decisions whose markets have settled, so OpenClaw can compare the paper prediction with what actually happened.",
  "Brier Score":
    "A calibration score for yes/no predictions. Lower is better; it becomes available only after resolved outcomes exist.",
  "Paper P&L":
    "Realized simulated profit or loss from scored accepted paper trades in the selected timeframe. Open positions are not counted as profit yet.",
  "Total Profit":
    "Gross simulated winnings from resolved accepted paper trades in the selected timeframe, before subtracting losing trades.",
  "Total Loss":
    "Gross simulated losses from resolved accepted paper trades in the selected timeframe. Shown as a positive dollar amount so it is easy to compare against total profit.",
  Accuracy:
    "The percentage of resolved directional paper trades where OpenClaw picked the winning side. It appears after outcomes resolve.",
  "Category Accuracy":
    "Accuracy split by Kalshi market domain, such as weather, sports, economics, politics, crypto, entertainment, or unknown/other. Each category only uses resolved paper trades from the selected timeframe.",
  "Scored Trades":
    "Accepted paper trades with resolved outcomes, which are the trades that can teach accuracy, calibration, and simulated P&L.",
  "Exploration Trades":
    "Small, bounded paper-only trades used to learn faster. They are useful for discovery but do not count as live-readiness proof by themselves.",
  "Forward Paper Trades":
    "Stricter out-of-sample paper trades used to test whether an explored strategy keeps working.",
  "Unresolved Exposure":
    "The simulated dollars currently tied up in accepted paper trades that have not resolved yet.",
  "No-Live Validator":
    "A safety scan that checks the Kalshi implementation for live-trading or write-capable behavior.",
  "Scheduled Runs": "Completed automated paper-learning cycles.",
  "Weather Runs": "Completed automated weather-learning cycles.",
  "Weather Parsed":
    "Weather market candidates successfully parsed in the latest weather-learning cycle.",
  "Weather Trade Ready":
    "Weather market candidates that had enough clean data to become paper-trade candidates.",
  "Weather City Coverage":
    "Trade-ready weather cities found in the current Kalshi snapshot compared with registered OpenClaw watchlist cities.",
  "Weather Expansion":
    "The ranked plan for adding more weather cities and weather regimes so OpenClaw gets more diverse, scoreable paper evidence.",
  "Paper Volume Accelerator":
    "A paper-only recommendation layer that increases useful practice volume while keeping live trading blocked.",
  "Weather Model Audit":
    "A paper-only audit that explains why scored weather trades won or lost, then recommends whether to tighten, pause, or continue each weather bucket.",
  "Audit Scope":
    "Whether this weather audit is based on the current paper epoch or older preserved history.",
  "Weather Source Health":
    "Whether the external weather evidence snapshot is fresh enough to trust for paper analysis.",
  "Stochastic Process Lift":
    "A paper-only routing lift sourced from Markov/ microstructure diagnostics confidence and risk pressure.",
  "Walk-Forward Stability Lift":
    "An out-of-sample guard that rewards stable walk-forward candidate behavior and withdraws pressure when stability drops.",
  "Sports Execution Reliability":
    "Execution-quality score for sports routing. Low values require continued sports hold until slippage, spread, and execution quality improve.",
  "Scored Weather": "Current-epoch accepted weather paper trades that have source-backed outcomes.",
  "Top Failure Mode":
    "The most common plain-language reason weather paper trades need repair, tightening, or more evidence.",
  "Strategy Discovery":
    "A paper-only shadow layer that scores hypothetical YES, NO, and no-trade choices for observed markets so OpenClaw can find patterns without adding accepted paper exposure.",
  "Inverse Standard Strategy Audit":
    "A paper-only audit comparing the preserved Standard Strategy baseline with the opposite-side Inverse Standard Strategy.",
  "Strategy Comparison":
    "A paper-only comparison of every named strategy lane using the best available resolved accepted-paper and audit evidence.",
  "Supreme Trading Strategy":
    "The centralized paper-only meta-strategy that weights market, ML, Markov, governor, risk, and no-trade signals without enabling live trading.",
  "STS Confidence":
    "A weighted paper-only confidence score across accuracy, profitability, learning speed, adaptability, robustness, and statistical validity.",
  Calibration:
    "The STS model reliability score derived from expected calibration error (lower ECE = stronger calibration).",
  "STS Regime":
    "The current market/data regime STS infers from telemetry, outcome resolution, source freshness, and microstructure warnings.",
  "Are We Learning?":
    "A quick health answer based on recent scored paper trades and dashboard data freshness. It is strongest when recent accepted paper trades are resolving and being scored.",
  "Learning Speed":
    "Fresh source-backed outcomes scored by the rapid weather/crypto learner. Shadow outcomes speed up learning, but they are excluded from live-readiness proof.",
  "Accepted Proof Age":
    "How old the newest scored accepted-paper proof is. This can be stale even while zero-exposure shadow learning is fresh.",
  "Profit Direction":
    "Whether realized paper P&L is positive or negative in the selected P&L window. It only counts resolved accepted paper trades, not pending simulated exposure.",
  "Current Bottleneck":
    "The single biggest issue currently slowing accuracy, profit, or learning speed. If this says P&L is negative, the paper trades that have final results are losing simulated money in the current test period.",
  "Next Best Move":
    "The highest-priority paper-only action OpenClaw should take next to improve learning quality or speed. It never authorizes live trading.",
  "P&L":
    "Profit and loss. On this dashboard it means simulated paper profit or loss, not real money.",
  "P&L Delta":
    "The difference between this strategy's simulated paper profit/loss and the Standard Strategy baseline. Positive is better than Standard Strategy; negative is worse.",
  "Current Test Period":
    "The active paper-trading period being judged right now. Older paper data is preserved as history, but this period is what OpenClaw is learning from today.",
  "Resolved Paper Trades":
    "Paper trades where the real market result is known, so OpenClaw can score whether the simulated bet was right or wrong.",
  "Clean Evidence":
    "Evidence OpenClaw trusts enough to learn from because the market, result timing, price, and outcome data are clear enough to score.",
  Baseline:
    "A comparison point, such as the old Standard Strategy, the Kalshi market price, doing nothing, or a random YES/NO choice.",
  "Standard Strategy Accuracy":
    "The preserved baseline accuracy of the Standard Strategy on resolved directional paper trades.",
  "Inverse Standard Accuracy":
    "The accuracy the Inverse Standard Strategy would have had by picking the opposite side on the same resolved directional paper trades.",
  "Inverse Standard P&L Delta":
    "How much better or worse the Inverse Standard Strategy performed than the Standard Strategy on the same resolved trades.",
  "Inverse Standard Tracking":
    "Shows whether OpenClaw is actively measuring the Inverse Standard Strategy. This is paper-only and never enables live trading by itself.",
  "Weather Arbitrage Strategy":
    "A separate paper-only lane for weather markets where OpenClaw looks for price differences between related Kalshi weather contracts after fees, spread, and timing risk.",
  PolyClaw:
    "A paper-only comparison lane for the PolyClaw skill. It becomes meaningful after PolyClaw logs candidates and those candidates resolve.",
  "polymarket-kalshi-divergence":
    "A paper-only comparison lane for markets where Polymarket and Kalshi appear to price the same or related outcomes differently. It is compared only after logged candidates resolve.",
  "Crypto Evidence":
    "A paper-only crypto lane that looks for active Kalshi Bitcoin or Ethereum markets, attaches external spot-price evidence, and only creates simulated trades when the data is parseable and the edge beats estimated costs.",
  "Crypto Markets Seen":
    "Active Kalshi markets found by crypto-related searches that mention Bitcoin, Ethereum, BTC, ETH, or crypto.",
  "Parseable Crypto Markets":
    "Crypto markets where OpenClaw could identify the asset, threshold, direction, and expected result time.",
  "Crypto Paper Candidates":
    "Paper-only crypto candidates created from external spot-price evidence. These never authorize live trading.",
  "Crypto Spot Sources":
    "External spot-price feeds available to the crypto evidence lane for paper-only fair-value estimates.",
  "Crypto Readiness":
    "Whether the crypto evidence lane knows when to re-check Kalshi crypto markets that are not yet trade-ready.",
  "Weather/Crypto ML":
    "The paper-only selective learner that keeps weather and crypto shadow-only until reality contracts, shadow proof, P&L, and market-baseline gates pass.",
  "Probability Diagnostics":
    "A research-only Markov and market-microstructure panel. It can flag low-data buckets, longshot bias, and maker/taker traps, but it cannot authorize live or accepted paper trades by itself.",
  "Markov Proxy":
    "A terminal price-path proxy from historical price-bucket transitions. It is not a standalone resolution probability.",
  "Becker Calibration":
    "A conservative prior from Jonathan Becker's Kalshi microstructure study, used here as risk shrinkage rather than trading proof.",
  "Maker/Taker Edge":
    "Edge after spread, Kalshi fees, and empirical maker/taker assumptions. Maker-first warnings prevent crossing the spread when the model edge is thin.",
  "Reality Contract":
    "A forensic decision-to-outcome integrity check. Weather and crypto records that fail it are quarantined and cannot train the learner.",
  "Abstention Rate":
    "The share of weather/crypto ML segments intentionally kept shadow-only because they have not met the promotion ladder.",
  "Executable Quality":
    "The share of inverse-audit trades where spread data was available to estimate the opposite ask conservatively. Low quality means the inverse result is useful as a warning, not proof.",
  "Hidden Opportunities":
    "Autonomous paper-only findings where OpenClaw noticed a possible strategy improvement, bug, or bad bucket without waiting for a human to spot it.",
  "Strategy Governor":
    "The paper-only router that decides whether each candidate gets forward-paper budget, exploration budget, inverse testing, shadow-only treatment, or a pause.",
  "Governor Accepted":
    "Paper candidates the governor allowed to stay accepted or become bounded inverse forward-paper tests.",
  "Governor Blocked":
    "Paper candidates the governor kept shadow-only or paused because data quality, segment health, or baseline proof was not strong enough.",
  "Inverse Forward Tests":
    "Tiny paper-only probes where the governor tests the Inverse Standard Strategy for a specific segment.",
  "Autonomous Paper Experiments":
    "Tiny bounded forward-paper tests created only when an opportunity beats the active paper strategy, market-implied baseline, no-trade baseline, and random-side baseline.",
  "Bug vs Edge Diagnostics":
    "The count of opportunity findings that look more like data, parsing, timing, or scoring problems than a real trading edge.",
  "Low Quality Blocks":
    "Opportunities that were detected but blocked because executable price quality, spread/depth evidence, settlement clarity, or baseline proof was not strong enough.",
  "Opportunity Repairs":
    "Plain-language repair tasks OpenClaw must finish before a hidden opportunity can safely change paper strategy behavior.",
  "Promotion Ladder":
    "The safe paper-only path from a raw finding to a watched signal, a repair task, a paper test, or a paused losing lane. It never enables live trading.",
  "Shadow Forward Watch":
    "A promising pattern OpenClaw watches closely without changing strategy or adding simulated exposure until proof quality improves.",
  "Shadow Scored":
    "Shadow choices matched to resolved outcomes. These are useful for discovery, but they did not become accepted paper trades.",
  "Shadow P&L":
    "Hypothetical discovery profit or loss from shadow choices. It is not accepted paper P&L and does not count as live-readiness proof.",
  "Discovery Candidates":
    "Shadow patterns with enough positive evidence to deserve review for bounded paper exploration.",
  "Evidence Yield":
    "The percentage of logged paper decisions that became accepted simulated trades. Higher means OpenClaw is generating more learnable bets from each cycle.",
  "Outcome Backlog":
    "Accepted paper trades waiting for market resolution. A backlog is useful, but too much unresolved evidence slows learning.",
  "Recommended Cycle Settings":
    "The safe paper-learning settings OpenClaw recommends for the next scheduled cycle based on current evidence yield.",
  "Rapid Learning Plan":
    "The paper-only plan for increasing useful scored evidence quickly. It identifies the current bottleneck, next-cycle settings, evidence targets, and safety rules.",
  Observations: "Read-only Kalshi market and orderbook snapshots collected for paper analysis.",
  "Strategy Scorecard":
    "A scored paper-trading health report by strategy segment, including P&L, accuracy, Brier score, and promotion status.",
  "Trend Chart":
    "A live dashboard chart of scored paper trades over time. X is scored trades; Y shows accuracy and cumulative paper P&L.",
  "Active Paused Segments":
    "Active current-epoch paper strategy segments blocked from new accepted paper trades because scored evidence was poor. The Standard Strategy shadow/control bucket is counted separately.",
  "Standard Strategy Shadowed":
    "Standard Strategy categories kept as a shadow/control baseline after the Inverse Standard Strategy reset. This is not a pause on the active Inverse Standard Strategy.",
  "Forward Candidates":
    "Paper strategy segments that have enough positive evidence to deserve stricter forward-paper testing.",
  "Strategy Learning Map":
    "Shows which market domains are learning separately, which lessons can transfer safely, and where transfer is blocked to avoid applying weather lessons to sports or other mismatched markets.",
  "Strategy Lessons":
    "Plain-English lessons OpenClaw learned from resolved paper trades, including what changed next and which metric should improve.",
  "Negative Transfer Warnings":
    "Warnings that a lesson could become harmful if applied outside the domain or scope where it was learned.",
  "Domain Performance":
    "Paper results grouped by market domain such as weather, sports, economics, crypto, politics, entertainment, or unknown.",
  "Data Freshness":
    "Whether the dashboard's paper-learning and weather-learning inputs were refreshed recently enough to trust at a glance.",
};

const TERM_DEFINITIONS: Record<string, string> = {
  Accepted:
    "Paper decisions that passed the active paper strategy checks. These are simulated only.",
  Explore:
    "Small, bounded paper-only trades used to learn faster. They help discover patterns but do not prove live-readiness by themselves.",
  Forward:
    "Stricter out-of-sample paper trades used to test whether a strategy keeps working after exploration.",
  "No Trade":
    "Cases where OpenClaw intentionally skipped a paper trade because the setup did not meet the rules.",
  Rejected:
    "Paper candidates that failed hard checks such as missing data, weak edge, unclear settlement, or risk limits.",
  Observed: "Read-only Kalshi market and orderbook snapshots collected for analysis.",
  Candidates: "Markets that reached the paper-decision stage after discovery and basic parsing.",
  "Fair Values":
    "Candidates with an independent estimated probability source available for comparison against Kalshi prices.",
  Resolved:
    "Paper trades whose markets have settled, so OpenClaw can score accuracy, calibration, and simulated P&L.",
  "Current test period":
    "The active paper-trading period being judged right now. It is the same idea as an epoch, but written in plain English.",
  PnL: "Profit and loss. On this dashboard it means simulated paper profit or loss, not real money.",
  "Clean evidence":
    "Evidence OpenClaw trusts enough to learn from because the market, result timing, price, and outcome data are clear enough to score.",
  Baseline:
    "A comparison point, such as the old Standard Strategy, the Kalshi market price, doing nothing, or a random YES/NO choice.",
};

function standardizeStrategyTerminology(text: string): string {
  return text
    .replace(/\bCurrent vs Inverse Strategy\b/gi, "Standard Strategy vs Inverse Standard Strategy")
    .replace(
      /\bStandard vs Inverse Standard Strategy\b/gi,
      "Standard Strategy vs Inverse Standard Strategy",
    )
    .replace(/\bcurrent paper strategy\b/gi, "active paper strategy")
    .replace(/\bcurrent strategy\b/gi, "active paper strategy")
    .replace(/\bcurrent-side\b/gi, "Standard Strategy side")
    .replace(/\bcurrent side\b/gi, "Standard Strategy side")
    .replace(/\bold paper baseline\b/gi, "Standard Strategy baseline")
    .replace(/\bold baseline\b/gi, "Standard Strategy baseline")
    .replace(/\bold strategy\b/gi, "Standard Strategy")
    .replace(/\bold side\b/gi, "Standard Strategy side")
    .replace(/\boriginal strategy\b/gi, "Standard Strategy")
    .replace(/\boriginal side\b/gi, "Standard Strategy side")
    .replace(/\boriginal accuracy\b/gi, "Standard Strategy accuracy")
    .replace(/\boriginal P&L\b/gi, "Standard Strategy P&L")
    .replace(/\boriginal win rate\b/gi, "Standard Strategy win rate")
    .replace(/\binverse-first\b/gi, "Inverse Standard Strategy")
    .replace(/\binverse first\b/gi, "Inverse Standard Strategy")
    .replace(/\binverse strategy\b/gi, "Inverse Standard Strategy")
    .replace(/\binverse-side\b/gi, "Inverse Standard Strategy side")
    .replace(/\binverse side\b/gi, "Inverse Standard Strategy side")
    .replace(/\binverse trades\b/gi, "Inverse Standard Strategy trades")
    .replace(/\binverse segments\b/gi, "Inverse Standard Strategy segments")
    .replace(/\binverse tests\b/gi, "Inverse Standard Strategy tests")
    .replace(/\binverse paper decisions\b/gi, "Inverse Standard Strategy paper decisions")
    .replace(/\bpoly_claw\b/gi, "PolyClaw")
    .replace(/\bpolyclaw\b/gi, "PolyClaw")
    .replace(/\bpolymarket_kalshi_divergence\b/gi, "polymarket-kalshi-divergence")
    .replace(/\bweather arbitrage strategy\b/gi, "Weather Arbitrage Strategy")
    .replace(/\blow_resolution_rate\b/gi, "Too few paper trades have final results")
    .replace(
      /\bnegative_current_epoch_pnl\b/gi,
      "Paper trades are losing money in this test period",
    )
    .replace(
      /\bconvert_pending_paper_trades_to_scored_evidence\b/gi,
      "Turn pending paper trades into graded results",
    )
    .replace(
      /\bincrease_scoreable_paper_candidates\b/gi,
      "Increase useful paper-practice candidates",
    );
}

function fmt(value: unknown): string {
  if (value == null) {
    return "n/a";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return "n/a";
    }
    return Number.isInteger(value) ? String(value) : value.toPrecision(4);
  }
  if (typeof value === "string") {
    return standardizeStrategyTerminology(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function pct(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function pctPoint(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} pp`;
}

function weatherCryptoBoostToPercent(value: unknown, decimals = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 1 ? "+" : ""}${((value - 1) * 100).toFixed(decimals)}%`;
}

function money(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function clampRoutePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function routeMixBars(mix: Array<{ key: string; label: string; pct: number; value: number }>) {
  if (!mix.length) {
    return html`<p class="muted">No route split data in the latest epoch.</p>`;
  }
  const total = mix.reduce((sum, item) => sum + item.pct, 0);
  return html`
    <div class="kalshi-route-mix" aria-label="Route mix bars">
      <div class="kalshi-route-mix__stack" role="img" aria-label="Route mix percentages">
        ${mix.map(
          (entry) => html`
            <span
              class="kalshi-route-mix__segment kalshi-route-mix__segment--${entry.key.toLowerCase()}"
              style=${`--segment-width:${total > 0 ? (entry.pct / total) * 100 : 0}%`}
              title=${`${entry.label}: ${(entry.pct * 100).toFixed(1)}% (${entry.value})`}
            ></span>
          `,
        )}
      </div>
      <ul class="kalshi-route-mix__legend">
        ${mix.map(
          (entry) => html`
            <li>
              <span
                class="kalshi-route-mix__swatch kalshi-route-mix__swatch--${entry.key.toLowerCase()}"
              ></span>
              ${entry.label}: ${(entry.pct * 100).toFixed(1)}%
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

function formatRouteMixSummary(
  mix: Array<{ key: string; label: string; pct: number; value: number }>,
) {
  if (!mix.length) {
    return "No route split data available.";
  }
  return mix.map((entry) => `${entry.label}: ${(entry.pct * 100).toFixed(1)}%`).join(" · ");
}

function routeMixPercentages(raw: Record<string, unknown> | undefined): Array<{
  key: string;
  label: string;
  pct: number;
  value: number;
}> {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const canonicalOrder = [
    "SHADOW_ONLY",
    "ACCEPT_EXPLORATION",
    "ACCEPT_PAPER",
    "FORWARD_PAPER",
  ] as const;
  const entries = canonicalOrder
    .map((key) => ({
      key,
      value: typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] : 0,
    }))
    .filter((entry) => entry.value > 0)
    .map((entry) => ({
      ...entry,
      label: entry.key.toLowerCase().replaceAll("_", " "),
      pct: 0,
    }));
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0) {
    return [];
  }
  return entries.map((entry) => ({
    ...entry,
    pct: clampRoutePercent(total <= 1.5 ? entry.value : entry.value / total),
  }));
}

function markovTone(value: unknown): "ok" | "warn" | "danger" {
  const number = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (number == null) {
    return "warn";
  }
  if (number >= 7) {
    return "ok";
  }
  if (number >= 4) {
    return "warn";
  }
  return "danger";
}

function markovRoutingTone(value: unknown): "ok" | "warn" | "danger" {
  const routing = String(value ?? "").toUpperCase();
  if (routing === "TINY_PAPER_REVIEW_ONLY") {
    return "warn";
  }
  if (routing === "OBSERVE_ONLY") {
    return "ok";
  }
  return "danger";
}

function markovMarketLabel(market: MarkovMicrostructureMarket | undefined): string {
  if (!market) {
    return "No market selected";
  }
  return (
    market.market_ticker ??
    (typeof market.title === "string" && market.title ? market.title : "Unnamed market")
  );
}

function markovBestMakerEdge(market: MarkovMicrostructureMarket | undefined): number | null {
  if (!market?.execution) {
    return null;
  }
  const candidates = [
    market.execution.yes_maker_edge_pct,
    market.execution.no_maker_edge_pct,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : null;
}

function markovWorstTakerEdge(market: MarkovMicrostructureMarket | undefined): number | null {
  if (!market?.execution) {
    return null;
  }
  const candidates = [
    market.execution.yes_taker_edge_pct,
    market.execution.no_taker_edge_pct,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return candidates.length ? Math.min(...candidates) : null;
}

function markovHeatmap(market: MarkovMicrostructureMarket | undefined) {
  const heatmap = market?.transition_heatmap;
  const matrix = heatmap?.matrix ?? [];
  if (!matrix.length) {
    return html`<div class="kalshi-markov-heatmap kalshi-markov-heatmap--empty">
      No transition matrix yet.
    </div>`;
  }
  const currentBucket = heatmap?.current_bucket ?? market?.current_bucket ?? -1;
  return html`<div
    class="kalshi-markov-heatmap"
    role="img"
    aria-label=${`Transition heatmap for ${markovMarketLabel(market)}`}
  >
    ${matrix.slice(0, 10).map((row, rowIndex) =>
      row.slice(0, 10).map((value, columnIndex) => {
        const intensity = Math.max(0.06, Math.min(1, value));
        const lowSample = (heatmap?.row_counts?.[rowIndex] ?? 0) < 30;
        return html`<span
          class="kalshi-markov-heatmap__cell ${rowIndex === currentBucket
            ? "kalshi-markov-heatmap__cell--current"
            : ""} ${lowSample ? "kalshi-markov-heatmap__cell--low-sample" : ""}"
          style=${`--intensity:${intensity}`}
          title=${`Bucket ${rowIndex} → ${columnIndex}: ${(value * 100).toFixed(1)}%; samples ${heatmap?.row_counts?.[rowIndex] ?? 0}`}
        ></span>`;
      }),
    )}
  </div>`;
}

function auditRowText(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(auditRowText).join(" ");
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map(auditRowText)
      .join(" ");
  }
  return "";
}

function filterAuditRows<T>(rows: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return rows;
  }
  return rows.filter((row) => auditRowText(row).includes(normalized));
}

function auditWindow(totalRows: number, requestedPage: unknown): AuditWindow {
  const pageCount = Math.max(1, Math.ceil(totalRows / AUDIT_TABLE_ROW_LIMIT));
  const rawPage =
    typeof requestedPage === "number" && Number.isFinite(requestedPage)
      ? Math.trunc(requestedPage)
      : 1;
  const page = Math.min(Math.max(rawPage, 1), pageCount);
  const start = (page - 1) * AUDIT_TABLE_ROW_LIMIT;
  return {
    page,
    pageCount,
    start,
    end: Math.min(start + AUDIT_TABLE_ROW_LIMIT, totalRows),
  };
}

function auditWindowFromMeta(meta: AuditPageMeta | undefined, fallback: AuditWindow): AuditWindow {
  if (!meta?.server_sliced) {
    return fallback;
  }
  const page = typeof meta.page === "number" && Number.isFinite(meta.page) ? meta.page : 1;
  const pageCount =
    typeof meta.page_count === "number" && Number.isFinite(meta.page_count) ? meta.page_count : 1;
  const pageSize =
    typeof meta.page_size === "number" && Number.isFinite(meta.page_size)
      ? meta.page_size
      : AUDIT_TABLE_ROW_LIMIT;
  const shownRows =
    typeof meta.shown_rows === "number" && Number.isFinite(meta.shown_rows) ? meta.shown_rows : 0;
  const start = shownRows > 0 ? (Math.max(1, page) - 1) * pageSize : 0;
  return {
    end: start + shownRows,
    page: Math.max(1, page),
    pageCount: Math.max(1, pageCount),
    start,
  };
}

function auditNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function csvCell(value: unknown): string {
  const text = fmt(value).replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

function auditCsvHref(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) {
    return "data:text/csv;charset=utf-8,";
  }
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [
    columns.map(csvCell).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}

function auditControls<T extends Record<string, unknown>>(
  props: KalshiDashboardProps,
  table: AuditTableId,
  label: string,
  allRows: T[],
  filteredRows: T[],
  window: AuditWindow,
  query: string,
  visibleRows: T[],
  meta?: AuditPageMeta,
) {
  const filteredCount = auditNumber(meta?.filtered_rows, filteredRows.length);
  const totalCount = auditNumber(meta?.total_rows, allRows.length);
  const startLabel = filteredCount && visibleRows.length ? window.start + 1 : 0;
  const endLabel = visibleRows.length ? window.end : 0;
  return html`<div class="kalshi-audit-controls" aria-label=${`${label} controls`}>
    <label>
      Search ${label}
      <input
        type="search"
        .value=${query}
        placeholder="Ticker, city, side, outcome..."
        @input=${(event: Event) =>
          props.onAuditTableQueryChange(table, (event.currentTarget as HTMLInputElement).value)}
      />
    </label>
    <span class="muted">
      Showing ${fmt(startLabel)}-${fmt(endLabel)} of ${fmt(filteredCount)} matching rows
      (${fmt(totalCount)} total). ${meta?.server_sliced ? "Server-paged for speed." : ""}
    </span>
    <div class="kalshi-audit-controls__actions">
      <button
        type="button"
        class="btn btn--secondary"
        ?disabled=${window.page <= 1}
        @click=${() => props.onAuditTablePageChange(table, window.page - 1)}
      >
        Previous
      </button>
      <span class="muted">Page ${fmt(window.page)} / ${fmt(window.pageCount)}</span>
      <button
        type="button"
        class="btn btn--secondary"
        ?disabled=${window.page >= window.pageCount}
        @click=${() => props.onAuditTablePageChange(table, window.page + 1)}
      >
        Next
      </button>
      <a
        class="btn btn--secondary"
        href=${auditCsvHref(visibleRows)}
        download=${`kalshi-${table}-visible-rows.csv`}
      >
        Export visible CSV
      </a>
    </div>
  </div>`;
}

function signedMoney(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

type StrategyHealthSegment = NonNullable<
  NonNullable<KalshiDashboardSnapshot["strategy_scorecard"]>["segments"]
>[number];

function plainStrategyToken(value: unknown): string {
  const text = (value == null ? "unknown" : fmt(value)).trim();
  const replacements: Record<string, string> = {
    buy_yes: "buy YES",
    buy_no: "buy NO",
    unknown_side: "unknown side",
    unknown_horizon: "unknown timing",
    no_depth: "no visible depth",
    very_deep: "very deep liquidity",
    weather_model: "weather model",
    weather_model_fast_evidence: "Standard Strategy weather model",
    inverse_first_paper: "Inverse Standard Strategy",
    inverse_forward_test: "Inverse Standard Strategy forward test",
    weather_arbitrage_strategy: "Weather Arbitrage Strategy",
    polyclaw: "PolyClaw",
    polymarket_kalshi_divergence: "polymarket-kalshi-divergence",
    old_baseline_shadow_control: "Standard Strategy baseline kept for comparison",
    active_inverse_first_paper_learning: "Active Inverse Standard Strategy paper learning",
    tracked_weather_arbitrage_lane: "Tracked weather arbitrage lane",
    tracked_polyclaw_skill_lane: "PolyClaw skill lane",
    tracked_cross_market_divergence_skill_lane: "Polymarket/Kalshi divergence skill lane",
    waiting_for_current_epoch_outcomes: "Waiting for results in this test period",
    negative_current_epoch_pnl: "Paper trades are losing money in this test period",
    collect_more_forward_paper_proof: "Need more proof from stricter paper tests",
    waiting_for_clean_scored_evidence: "Waiting for reliable scored results",
    low_resolution_rate: "Too few paper trades have final results",
    negative_clean_net_pnl: "Reliable scored paper trades are losing money",
    waiting_for_weather_arbitrage_scanner: "waiting for weather arbitrage scanner",
    waiting_for_polyclaw_skill_data: "waiting for PolyClaw skill data",
    waiting_for_polymarket_kalshi_divergence_skill_data:
      "waiting for polymarket-kalshi-divergence skill data",
    tracking_no_candidates_yet: "tracking; no clean candidates yet",
    tracking_shadow_only: "tracking in shadow-only mode",
    market_implied_baseline: "market baseline",
    manual_input: "manual input",
    high_probability_harvesting_simulation: "high-probability harvesting",
    market_making_simulation: "market-making simulation",
  };
  return replacements[text] ?? text.replaceAll("_", " ");
}

function strategySegmentParts(segment: StrategyHealthSegment): {
  domain: string;
  place: string;
  marketType: string;
  strategy: string;
  source: string;
  side: string;
  horizon: string;
  liquidity: string;
} {
  const raw = segment.segment ?? "";
  const parts = raw.split("|");
  if (parts.length >= 9 && parts[0] === "leaf") {
    return {
      domain: parts[1] ?? "unknown",
      place: "",
      marketType: parts[3] ?? parts[2] ?? "unknown",
      strategy: parts[4] ?? "unknown",
      source: parts[5] ?? "unknown",
      side: parts[6] ?? "unknown_side",
      horizon: parts[7] ?? "unknown_horizon",
      liquidity: parts[8] ?? "unknown",
    };
  }
  if (parts.length >= 4) {
    return {
      domain: parts[0] ?? "unknown",
      place: parts[1] ?? "",
      marketType: parts[2] ?? "unknown",
      strategy: segment.strategy_lane ?? "unknown",
      source: parts[3] ?? "unknown",
      side: "unknown_side",
      horizon: "unknown_horizon",
      liquidity: "unknown",
    };
  }
  return {
    domain: segment.domain ?? "unknown",
    place: "",
    marketType: segment.subdomain ?? "unknown",
    strategy: segment.strategy_lane ?? "unknown",
    source: "unknown",
    side: "unknown_side",
    horizon: "unknown_horizon",
    liquidity: "unknown",
  };
}

function strategyBucketSummary(segment: StrategyHealthSegment): string {
  const parts = strategySegmentParts(segment);
  const domain = plainStrategyToken(parts.domain);
  const marketType = plainStrategyToken(parts.marketType);
  const place = parts.place && parts.place.toLowerCase() !== "unknown" ? ` in ${parts.place}` : "";
  const base = domain === "unknown" ? "Unknown market bucket" : `${domain} ${marketType}${place}`;
  return `${base}: ${plainStrategyToken(parts.side)}, ${plainStrategyToken(parts.liquidity)}`;
}

function hideStrategyHealthRow(segment: StrategyHealthSegment): boolean {
  const scored = segment.scored;
  return typeof scored !== "number" || scored <= 0;
}

function cents(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value)}c`;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function timeZoneAbbreviation(timestamp: string, timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(new Date(timestamp))
      .find((item) => item.type === "timeZoneName");
    return part?.value ?? timezone;
  } catch {
    return timezone;
  }
}

function formatTradeTime(timestamp: unknown, timezone: string): string {
  if (typeof timestamp !== "string" || !timestamp) {
    return "n/a";
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return timestamp;
  }
  try {
    const formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
    return `${formatted} ${timeZoneAbbreviation(timestamp, timezone)}`;
  } catch {
    return timestamp;
  }
}

function relativeResolutionTime(timestamp: unknown, generatedAt: unknown): string {
  const targetMs = parseTimeMs(timestamp);
  const baseMs = parseTimeMs(generatedAt) ?? Date.now();
  if (targetMs == null) {
    return "timing unknown";
  }
  const deltaMs = targetMs - baseMs;
  const absMs = Math.abs(deltaMs);
  const minutes = Math.round(absMs / 60000);
  if (minutes < 1) {
    return deltaMs >= 0 ? "due now" : "past expected time";
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const pieces = [];
  if (days) {
    pieces.push(`${days}d`);
  }
  if (hours) {
    pieces.push(`${hours}h`);
  }
  if (!days && mins) {
    pieces.push(`${mins}m`);
  }
  const text = pieces.join(" ") || `${minutes}m`;
  return deltaMs >= 0 ? `in ${text}` : `${text} past expected time`;
}

function formatAgeMs(ageMs: unknown): string {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) {
    return "unknown age";
  }
  if (ageMs < 60_000) {
    return `${Math.max(0, Math.round(ageMs / 1000))}s old`;
  }
  if (ageMs < 3_600_000) {
    return `${Math.round(ageMs / 60_000)}m old`;
  }
  return `${(ageMs / 3_600_000).toFixed(1)}h old`;
}

function formatAgeMinutes(ageMinutes: unknown): string {
  if (typeof ageMinutes !== "number" || !Number.isFinite(ageMinutes)) {
    return "unknown age";
  }
  if (ageMinutes < 1) {
    return `${Math.max(0, Math.round(ageMinutes * 60))}s old`;
  }
  if (ageMinutes < 60) {
    return `${ageMinutes.toFixed(1)}m old`;
  }
  return `${(ageMinutes / 60).toFixed(1)}h old`;
}

function formatResultKnownTime(
  timestamp: unknown,
  sourceLabel: unknown,
  note: unknown,
  timezone: string,
  generatedAt: unknown,
) {
  const label = typeof sourceLabel === "string" && sourceLabel ? sourceLabel : "Unknown";
  const noteText =
    typeof note === "string" && note ? note : "No result-known timing note available.";
  if (typeof timestamp !== "string" || !timestamp) {
    return html`<span class="kalshi-resolution-time" title=${noteText}>
      <b>Unknown</b>
      <span>${label}</span>
    </span>`;
  }
  return html`<span
    class="kalshi-resolution-time"
    title=${`${formatTradeTime(timestamp, timezone)}. ${label}. ${noteText}`}
  >
    <b>${formatTradeTime(timestamp, timezone)}</b>
    <span>${relativeResolutionTime(timestamp, generatedAt)} · ${label}</span>
  </span>`;
}

function formatChartTimeParts(
  timestamp: unknown,
  timezone: string,
): { date: string; time: string; full: string } {
  if (typeof timestamp !== "string" || !timestamp) {
    return { date: "n/a", time: "n/a", full: "n/a" };
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return { date: timestamp, time: "n/a", full: timestamp };
  }
  try {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "2-digit",
      year: "numeric",
    }).format(date);
    const clock = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
    const zone = timeZoneAbbreviation(timestamp, timezone);
    return { date: day, time: `${clock} ${zone}`, full: `${day}, ${clock} ${zone}` };
  } catch {
    return { date: timestamp, time: "n/a", full: timestamp };
  }
}

function timezoneDisplayName(timezone: string): string {
  const known = CONTINENTAL_US_TIMEZONES.find((option) => option.value === timezone);
  return known ? `${known.label} (${known.sample})` : timezone;
}

function timeframeMs(value: string): number | null {
  return TREND_TIMEFRAMES.find((option) => option.value === value)?.ms ?? null;
}

function pnlTimeframeMs(value: string): number | null {
  return PNL_TIMEFRAMES.find((option) => option.value === value)?.ms ?? null;
}

function filterTrendPoints(
  points: TrendPoint[],
  timeframe: string,
  anchorTimestamp?: string,
): TrendPoint[] {
  const sorted = sortedTrendPoints(points);
  const spanMs = timeframeMs(timeframe);
  if (spanMs == null || !sorted.length) {
    return sorted;
  }
  const anchorMs = parseTimeMs(anchorTimestamp) ?? Date.now();
  const timestamped = sorted
    .map((point) => ({ point, ms: parseTimeMs(point.scored_at_utc ?? point.timestamp_utc) }))
    .filter((entry): entry is { point: TrendPoint; ms: number } => entry.ms != null);
  if (!timestamped.length) {
    return sorted;
  }
  const cutoff = anchorMs - spanMs;
  return timestamped
    .filter((entry) => entry.ms >= cutoff && entry.ms <= anchorMs)
    .map((entry) => entry.point);
}

function sortedTrendPoints(points: TrendPoint[]): TrendPoint[] {
  return points.toSorted((a, b) => {
    const aMs = parseTimeMs(a.scored_at_utc ?? a.timestamp_utc) ?? a.index ?? 0;
    const bMs = parseTimeMs(b.scored_at_utc ?? b.timestamp_utc) ?? b.index ?? 0;
    return aMs - bMs;
  });
}

function selectedPnl(
  points: TrendPoint[],
  timeframe: string,
  allTimeFallback: unknown,
): { value: number | null; label: string; scored: number } {
  const label = PNL_TIMEFRAMES.find((option) => option.value === timeframe)?.label ?? timeframe;
  const allTimeValue =
    typeof allTimeFallback === "number" && Number.isFinite(allTimeFallback)
      ? allTimeFallback
      : null;
  const scored = sortedTrendPoints(points).filter(
    (point) =>
      typeof point.cumulative_pnl_usd === "number" && Number.isFinite(point.cumulative_pnl_usd),
  );
  const spanMs = pnlTimeframeMs(timeframe);
  if (timeframe === "all" || spanMs == null) {
    const latest = scored[scored.length - 1]?.cumulative_pnl_usd;
    return {
      value: typeof latest === "number" && Number.isFinite(latest) ? latest : allTimeValue,
      label,
      scored: scored.length,
    };
  }
  const timestamped = scored
    .map((point) => ({ point, ms: parseTimeMs(point.scored_at_utc ?? point.timestamp_utc) }))
    .filter((entry): entry is { point: TrendPoint; ms: number } => entry.ms != null);
  if (!timestamped.length) {
    return { value: null, label, scored: 0 };
  }
  const latest = timestamped[timestamped.length - 1];
  const cutoff = latest.ms - spanMs;
  const inWindow = timestamped.filter((entry) => entry.ms >= cutoff);
  if (!inWindow.length) {
    return { value: 0, label, scored: 0 };
  }
  const baseline = timestamped.toReversed().find((entry) => entry.ms < cutoff)
    ?.point.cumulative_pnl_usd;
  const latestPnl = latest.point.cumulative_pnl_usd;
  if (typeof latestPnl !== "number" || !Number.isFinite(latestPnl)) {
    return { value: null, label, scored: inWindow.length };
  }
  return {
    value:
      typeof baseline === "number" && Number.isFinite(baseline) ? latestPnl - baseline : latestPnl,
    label,
    scored: inWindow.length,
  };
}

type TimeframePerformance = NonNullable<
  NonNullable<
    NonNullable<KalshiDashboardSnapshot["self_improvement"]>["metrics"]
  >["paper_performance_by_timeframe"]
>[string];

type CategoryAccuracyRow = NonNullable<TimeframePerformance["category_accuracy"]>[number];

type TimeframeActivity = NonNullable<
  NonNullable<
    NonNullable<KalshiDashboardSnapshot["self_improvement"]>["metrics"]
  >["paper_activity_by_timeframe"]
>[string];

function selectedPerformance(
  metrics: NonNullable<KalshiDashboardSnapshot["self_improvement"]>["metrics"],
  timeframe: string,
  pnlSelection: { value: number | null; label: string; scored: number },
): TimeframePerformance {
  const performance = metrics?.paper_performance_by_timeframe?.[timeframe];
  if (performance) {
    return performance;
  }
  return {
    label: pnlSelection.label,
    scored_decisions: pnlSelection.scored,
    wins: metrics?.accuracy_wins,
    losses:
      typeof metrics?.accuracy_sample_size === "number" && typeof metrics.accuracy_wins === "number"
        ? metrics.accuracy_sample_size - metrics.accuracy_wins
        : undefined,
    accuracy: metrics?.accuracy,
    net_pnl_usd: pnlSelection.value,
    total_profit_usd:
      typeof pnlSelection.value === "number" ? Math.max(0, pnlSelection.value) : null,
    total_loss_usd:
      typeof pnlSelection.value === "number" ? Math.max(0, -pnlSelection.value) : null,
    category_accuracy: [],
  };
}

function selectedActivity(
  metrics: NonNullable<KalshiDashboardSnapshot["self_improvement"]>["metrics"],
  timeframe: string,
): TimeframeActivity | null {
  return metrics?.paper_activity_by_timeframe?.[timeframe] ?? null;
}

function performanceNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type StrategyComparisonRow = NonNullable<
  NonNullable<KalshiDashboardSnapshot["strategy_comparison"]>["rows"]
>[number];

type CountdownMilestone = NonNullable<
  NonNullable<KalshiDashboardSnapshot["milestone_countdown"]>["milestones"]
>[number];

type CountdownCriterion = NonNullable<CountdownMilestone["criteria"]>[number];

function strategyDisplayName(row: Partial<StrategyComparisonRow>): string {
  return row.display_name ?? plainStrategyToken(row.strategy_id);
}

function strategyRowNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strategyVolume(row: Partial<StrategyComparisonRow>): number {
  return (
    strategyRowNumber(row.decisions) ??
    (strategyRowNumber(row.accepted) ?? 0) + (strategyRowNumber(row.shadow_decisions) ?? 0)
  );
}

function strategyShadowCount(row: Partial<StrategyComparisonRow>): number {
  const explicitShadow = strategyRowNumber(row.shadow_decisions);
  if (explicitShadow != null) {
    return explicitShadow;
  }
  return Math.max(0, strategyVolume(row) - (strategyRowNumber(row.accepted) ?? 0));
}

function strategyAveragePnl(row: Partial<StrategyComparisonRow>): number | null {
  const explicitAverage = strategyRowNumber(row.average_pnl_per_scored_trade_usd);
  if (explicitAverage != null) {
    return explicitAverage;
  }
  const pnl = strategyRowNumber(row.paper_pnl_usd);
  const scored = strategyRowNumber(row.scored);
  if (pnl == null || scored == null || scored <= 0) {
    return null;
  }
  return pnl / scored;
}

function strategyDomainsLabel(row: Partial<StrategyComparisonRow>): string {
  const domains = row.domains;
  if (!domains || typeof domains !== "object" || Array.isArray(domains)) {
    return "n/a";
  }
  const entries = Object.entries(domains)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3);
  if (!entries.length) {
    return "n/a";
  }
  return entries.map(([domain, count]) => `${plainStrategyToken(domain)} ${fmt(count)}`).join(", ");
}

function strategyProblemScore(row: StrategyComparisonRow): number {
  const status = `${row.tracking_status ?? ""} ${row.next_step ?? ""}`.toLowerCase();
  const pnl = strategyRowNumber(row.paper_pnl_usd);
  const scored = strategyRowNumber(row.scored) ?? 0;
  const unresolved = strategyRowNumber(row.unresolved) ?? 0;
  let score = 0;
  if (pnl != null && pnl < 0 && scored > 0) {
    score += 8;
  }
  if (/\b(block|halt|pause|losing|danger|reject)\w*\b/.test(status)) {
    score += 6;
  }
  if (/\b(wait|shadow|pending|not enough|proof)\w*\b/.test(status)) {
    score += 3;
  }
  if (scored <= 0) {
    score += 2;
  }
  if (unresolved > 0) {
    score += 1;
  }
  return score;
}

function strategyRowTone(row: StrategyComparisonRow): "ok" | "warn" | "danger" {
  const pnl = strategyRowNumber(row.paper_pnl_usd);
  const scored = strategyRowNumber(row.scored) ?? 0;
  if (pnl != null && pnl < 0 && scored > 0) {
    return "danger";
  }
  if (strategyProblemScore(row) >= 3) {
    return "warn";
  }
  return "ok";
}

function countdownScore(value: unknown): string {
  const numeric = strategyRowNumber(value);
  if (numeric == null) {
    return "0";
  }
  const clamped = Math.max(0, Math.min(10, numeric));
  return Number.isInteger(clamped) ? String(clamped) : clamped.toFixed(1).replace(/\.0$/, "");
}

function countdownCriterionLabel(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "Score";
  return raw.split(/\s+/).slice(0, 2).join(" ");
}

function countdownEtaLabel(milestone: CountdownMilestone): string {
  const status = (milestone.status ?? "").toLowerCase();
  if (status === "blocked") {
    return "Blocked";
  }
  if (status === "complete") {
    return "Complete";
  }
  if (typeof milestone.eta_label === "string" && milestone.eta_label.trim()) {
    return milestone.eta_label.trim();
  }
  const seconds = strategyRowNumber(milestone.eta_seconds);
  if (seconds == null) {
    return "Waiting";
  }
  if (seconds <= 0) {
    return "Complete";
  }
  const totalMinutes = Math.max(0, Math.ceil(seconds / 60));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

function countdownMilestoneTone(milestone: CountdownMilestone): "ok" | "warn" | "danger" {
  const status = (milestone.status ?? "").toLowerCase();
  if (status === "complete") {
    return "ok";
  }
  if (
    status === "blocked" ||
    status === "waiting" ||
    countdownEtaLabel(milestone).toLowerCase() === "waiting"
  ) {
    return "danger";
  }
  return "warn";
}

function countdownMilestoneMeaning(milestone: CountdownMilestone): string {
  const id = (milestone.milestone_id ?? milestone.label ?? "").toLowerCase();
  if (id.includes("proof")) {
    return "Enough baseline-beating accepted paper results?";
  }
  if (id.includes("profit")) {
    return "Is accepted paper profitable?";
  }
  if (id.includes("weather")) {
    return "Is weather data/model coverage ready?";
  }
  if (id.includes("crypto")) {
    return "Is crypto settlement-basis evidence ready?";
  }
  if (id.includes("review")) {
    return "Ready for human review only?";
  }
  return milestone.plain_english ?? "Proof gate status.";
}

function countdownCriteria(milestone: CountdownMilestone): CountdownCriterion[] {
  return Array.isArray(milestone.criteria) ? milestone.criteria.slice(0, 4) : [];
}

function sortStrategyRows(
  rows: StrategyComparisonRow[],
  sort: KalshiStrategySort,
): StrategyComparisonRow[] {
  return rows.toSorted((left, right) => {
    if (sort === "name") {
      return strategyDisplayName(left).localeCompare(strategyDisplayName(right));
    }
    if (sort === "volume") {
      return (
        strategyVolume(right) - strategyVolume(left) ||
        strategyDisplayName(left).localeCompare(strategyDisplayName(right))
      );
    }
    if (sort === "accuracy") {
      const leftAccuracy = strategyRowNumber(left.accuracy);
      const rightAccuracy = strategyRowNumber(right.accuracy);
      if (leftAccuracy == null && rightAccuracy != null) {
        return 1;
      }
      if (leftAccuracy != null && rightAccuracy == null) {
        return -1;
      }
      if (leftAccuracy != null && rightAccuracy != null && leftAccuracy !== rightAccuracy) {
        return rightAccuracy - leftAccuracy;
      }
      return (
        strategyVolume(right) - strategyVolume(left) ||
        strategyDisplayName(left).localeCompare(strategyDisplayName(right))
      );
    }
    if (sort === "pnl") {
      const leftPnl = strategyRowNumber(left.paper_pnl_usd);
      const rightPnl = strategyRowNumber(right.paper_pnl_usd);
      if (leftPnl == null && rightPnl != null) {
        return 1;
      }
      if (leftPnl != null && rightPnl == null) {
        return -1;
      }
      if (leftPnl != null && rightPnl != null && leftPnl !== rightPnl) {
        return leftPnl - rightPnl;
      }
      return (
        strategyVolume(right) - strategyVolume(left) ||
        strategyDisplayName(left).localeCompare(strategyDisplayName(right))
      );
    }
    return (
      strategyProblemScore(right) - strategyProblemScore(left) ||
      strategyVolume(right) - strategyVolume(left) ||
      strategyDisplayName(left).localeCompare(strategyDisplayName(right))
    );
  });
}

function strategyPnlDelta(
  row: StrategyComparisonRow,
  standardPnl: number | null,
  standardScored: number | null,
): { amount: number | null; label: string } {
  const explicitActualDelta = performanceNumber(row.pnl_delta_vs_standard_usd);
  const explicitLabel =
    typeof row.pnl_delta_vs_standard_label === "string" && row.pnl_delta_vs_standard_label.trim()
      ? row.pnl_delta_vs_standard_label
      : null;
  if (explicitActualDelta != null) {
    return { amount: explicitActualDelta, label: explicitLabel ?? "actual vs Standard" };
  }

  const rowPnl = performanceNumber(row.paper_pnl_usd);
  const rowScored = performanceNumber(row.scored);
  if (row.strategy_id === "standard_strategy" && rowPnl != null && (rowScored ?? 0) > 0) {
    return { amount: 0, label: "baseline" };
  }

  if (rowPnl != null && standardPnl != null && (rowScored ?? 0) > 0 && (standardScored ?? 0) > 0) {
    return { amount: rowPnl - standardPnl, label: "actual vs Standard" };
  }

  const auditDelta = performanceNumber(row.audit_delta_vs_standard_pnl_usd);
  if (auditDelta != null) {
    return { amount: auditDelta, label: "audit vs Standard" };
  }

  return { amount: null, label: explicitLabel ?? "waiting for scored proof" };
}

function performanceScored(performance: TimeframePerformance, fallback: number): number {
  return typeof performance.scored_decisions === "number" &&
    Number.isFinite(performance.scored_decisions)
    ? performance.scored_decisions
    : fallback;
}

function categoryAccuracyByName(rows: CategoryAccuracyRow[]): Map<string, CategoryAccuracyRow> {
  return new Map(
    rows
      .map((row): [string, CategoryAccuracyRow] | null => {
        const category = typeof row.category === "string" ? row.category.toLowerCase() : null;
        return category ? [category, row] : null;
      })
      .filter((entry): entry is [string, CategoryAccuracyRow] => entry != null),
  );
}

function categoryAccuracyNote(
  row: CategoryAccuracyRow | undefined,
  label: string,
  timeframeLabel: string,
): string {
  if (!row) {
    return `${timeframeLabel}: no resolved ${label.toLowerCase()} paper trades.`;
  }
  return `${fmt(row.wins)} wins / ${fmt(row.scored)} scored ${label.toLowerCase()} trades. ${money(row.net_pnl_usd)} net.`;
}

function categoryAccuracyTone(row: CategoryAccuracyRow | undefined): "ok" | "warn" | "danger" {
  if (row?.accuracy == null) {
    return "warn";
  }
  return row.accuracy >= 0.5 ? "ok" : "danger";
}

function shortText(value: unknown, maxLength = 88): string {
  const text = typeof value === "string" ? value : fmt(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function plainOpportunityToken(value: unknown): string {
  const text = (value == null ? "unknown" : fmt(value)).trim();
  const replacements: Record<string, string> = {
    ablation_detector: "Losing bucket check",
    inverse_detector: "Opposite-side check",
    regret_detector: "Missed-trade check",
    shadow_detector: "Shadow pattern check",
    baseline_detector: "Baseline comparison",
    data_quality_detector: "Data-quality check",
    ACCEPT_FORWARD_PAPER: "Accept forward-paper",
    ACCEPT_EXPLORATION: "Accept exploration",
    SHADOW_ONLY: "Shadow-only",
    PAUSE_SEGMENT: "Pause segment",
    INVERSE_FORWARD_TEST: "Inverse forward-paper test",
    REJECT_DATA_QUALITY: "Reject data-quality",
    likely_edge: "Likely paper lesson",
    possible_bug: "Possible data problem",
    low_quality_data: "Promising, but proof is weak",
    needs_more_evidence: "Needs more evidence",
    paused: "Paused losing paper lane",
    learning_loss_warning: "Learning, but losing on paper",
    bug_review_required: "Repair data first",
    shadow_forward_watch: "Watch closely, no strategy change",
    in_forward_paper: "Testing in stricter paper",
    promoted_paper_only: "Paper-only promotion",
    rejected_low_quality: "Rejected: weak proof",
    paper_pause_active: "Paper pause active",
    quality_repair_ready: "Repair needed before use",
    clean_forward_paper_candidate: "Ready for paper test",
    executable_quality_met: "prove executable prices",
    data_quality_clear: "clear data-quality issues",
    minimum_sample_met: "collect enough clean examples",
    beats_current_strategy: "beat active paper strategy",
    beats_market_implied_baseline: "beat Kalshi market baseline",
    beats_no_trade_baseline: "beat doing nothing",
    beats_random_side_baseline: "beat random YES/NO choice",
    low_executable_quality: "opposite-side price proof is weak",
    synthetic_inverse_pricing: "inverse result used synthetic pricing",
    unknown_or_missing_result_timing: "result-known time is missing",
    settlement_parse_gap: "settlement rules need cleaner parsing",
    high_confidence_weather_miss: "weather model was confident and wrong",
    increase_scoreable_paper_candidates: "Increase useful paper-practice candidates",
    convert_pending_paper_trades_to_scored_evidence:
      "Turn pending paper trades into graded results",
    repair_result_timing: "add expected result-known time",
    repair_settlement_parser: "clean up settlement parsing",
    audit_weather_direction_and_station: "audit weather direction and station",
    prove_executable_opposite_side: "prove opposite-side executable price",
    collect_more_clean_scored_samples: "collect more clean scored examples",
    add_market_baseline_brier: "add market baseline comparison",
    rerun_opportunity_engine: "rerun opportunity scoring",
  };
  if (replacements[text]) {
    return replacements[text];
  }
  return text
    .replace(/^leaf\|/, "")
    .replaceAll("|", " / ")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function plainLearningText(value: unknown): string {
  return standardizeStrategyTerminology(fmt(value))
    .replace(
      /\bbaseline-beating current-epoch segments\b/gi,
      "segments that beat the comparison baselines in this test period",
    )
    .replace(/\bcurrent epoch\b/gi, "current test period")
    .replace(/\bcurrent-epoch\b/gi, "current test period")
    .replace(/\bclean resolved paper trades\b/gi, "paper trades with reliable final results")
    .replace(/\bclean resolved paper evidence\b/gi, "reliable scored paper evidence")
    .replace(/\bclean scored evidence\b/gi, "reliable scored evidence")
    .replace(/\bclean net P&L\b/gi, "simulated net profit/loss")
    .replace(/\bnet P&L\b/gi, "net profit/loss")
    .replace(/\bP&L\b/g, "profit/loss")
    .replace(/\bbaseline-beating\b/gi, "better than the comparison baselines")
    .replace(/\bforward-paper\b/gi, "stricter paper")
    .replace(/\bforward paper\b/gi, "stricter paper")
    .replace(/\bsource-backed outcomes\b/gi, "results backed by a trusted source")
    .replace(/\bscore\b/gi, "grade")
    .replace(/\bscored\b/gi, "graded")
    .replace(/\s+/g, " ")
    .trim();
}

function plainBottleneckLabel(value: unknown): string {
  return plainStrategyToken(value);
}

function termHelp(label: string) {
  return definitionHelp(label, TERM_DEFINITIONS[label]);
}

function plainFailureMode(item: unknown): { label: string; explanation: string; count?: number } {
  if (item && typeof item === "object") {
    const record = item as {
      label?: unknown;
      explanation?: unknown;
      count?: unknown;
      mode?: unknown;
    };
    const label =
      typeof record.label === "string" ? record.label : plainOpportunityToken(record.mode);
    const explanation =
      typeof record.explanation === "string"
        ? record.explanation
        : "OpenClaw recorded this weather audit issue and will keep it paper-only until the evidence is cleaner.";
    const count = typeof record.count === "number" ? record.count : undefined;
    return { label, explanation, count };
  }
  return {
    label: plainOpportunityToken(item),
    explanation:
      "OpenClaw recorded this weather audit issue and will keep it paper-only until the evidence is cleaner.",
  };
}

function weatherFailureModeSummary(item: {
  failure_mode_summary?: Array<unknown>;
  failure_modes?: Record<string, number>;
}) {
  const details =
    item.failure_mode_summary && item.failure_mode_summary.length
      ? item.failure_mode_summary.map(plainFailureMode)
      : Object.entries(item.failure_modes ?? {}).map(([mode, count]) =>
          plainFailureMode({ mode, count }),
        );
  return details.length
    ? html`<ul class="kalshi-compact-list">
        ${details
          .slice(0, 3)
          .map(
            (detail) => html`<li>
              <b>${detail.label}</b>${detail.count == null ? "" : ` (${fmt(detail.count)})`}:
              ${detail.explanation}
            </li>`,
          )}
      </ul>`
    : html`No current failure pattern.`;
}

function opportunityTone(status: unknown, diagnosis: unknown): "ok" | "warn" | "danger" {
  const statusText = status == null ? "" : fmt(status);
  const diagnosisText = diagnosis == null ? "" : fmt(diagnosis);
  if (
    statusText.includes("bug") ||
    statusText.includes("rejected") ||
    diagnosisText.includes("possible_bug")
  ) {
    return "danger";
  }
  if (
    statusText.includes("paused") ||
    statusText.includes("in_forward") ||
    statusText.includes("promoted")
  ) {
    return "ok";
  }
  return "warn";
}

function opportunityPlainSummary(item: {
  detector?: string;
  diagnosis?: string;
  status?: string;
  promotion_status?: string;
  evidence?: string;
  next_paper_action?: string;
  next_proof_needed?: string;
  promotion_blockers?: string[];
}) {
  const status = item.status ?? "";
  const detector = plainOpportunityToken(item.detector);
  const diagnosis = plainOpportunityToken(item.diagnosis);
  const promotion = plainOpportunityToken(item.promotion_status ?? item.status);
  const blockers = (item.promotion_blockers ?? []).slice(0, 3).map(plainOpportunityToken);
  const action =
    item.next_paper_action ??
    item.next_proof_needed ??
    (blockers.length ? `Needs ${blockers.join(", ")}.` : "Keep watching and rerun scoring.");
  const headline = status.includes("paused")
    ? "OpenClaw found a losing paper lane and paused it."
    : status.includes("shadow_forward_watch")
      ? "OpenClaw found a possible improvement, but is only watching it for now."
      : status.includes("bug")
        ? "OpenClaw found a signal that may be a data issue, not a real edge."
        : status.includes("in_forward")
          ? "OpenClaw is testing this idea in stricter paper mode."
          : "OpenClaw found a paper-only improvement candidate.";
  return { detector, diagnosis, promotion, blockers, action, headline };
}

function pnlTone(value: unknown, scoredCount: number): "ok" | "warn" | "danger" {
  if (scoredCount <= 0 || typeof value !== "number" || !Number.isFinite(value)) {
    return "warn";
  }
  return value >= 0 ? "ok" : "danger";
}

function metricHelp(title: string) {
  const definition = METRIC_DEFINITIONS[title];
  return definitionHelp(title, definition);
}

function definitionHelp(label: string, definition: string | undefined) {
  return definition
    ? html`<details class="kalshi-help" title=${definition}>
        <summary aria-label=${`${label} definition`}>?</summary>
        <span class="kalshi-help__popover" role="tooltip">${definition}</span>
      </details>`
    : nothing;
}

function metricCard(
  title: string,
  value: string,
  note: string,
  tone: "ok" | "warn" | "danger" | "" = "",
) {
  const definition = METRIC_DEFINITIONS[title];
  return html`
    <section class="kalshi-card ${tone ? `kalshi-card--${tone}` : ""}">
      <div
        class="kalshi-card__title"
        title=${definition ?? nothing}
        aria-label=${definition ? `${title}: ${definition}` : nothing}
      >
        ${title}${metricHelp(title)}
      </div>
      <div class="kalshi-card__value">${value}</div>
      <div class="kalshi-card__note">${note}</div>
    </section>
  `;
}

function humanStatusCard(
  title: string,
  value: string,
  note: string,
  tone: "ok" | "warn" | "danger" | "" = "",
) {
  return html`
    <section class="kalshi-today-card ${tone ? `kalshi-today-card--${tone}` : ""}">
      <span class="kalshi-today-card__label">${title}</span>
      <strong class="kalshi-today-card__value">${value}</strong>
      <p class="kalshi-today-card__note">${note}</p>
    </section>
  `;
}

function learningLaneCard(params: {
  detail: string;
  label: string;
  metric: string;
  note: string;
  tone: "ok" | "warn" | "danger";
}) {
  return html`
    <article class="kalshi-lane-card kalshi-lane-card--${params.tone}">
      <div>
        <span class="kalshi-lane-card__detail">${params.detail}</span>
        <h4>${params.label}</h4>
      </div>
      <strong class="kalshi-lane-card__metric">${params.metric}</strong>
      <p class="kalshi-lane-card__note">${params.note}</p>
    </article>
  `;
}

function bar(label: string, value: number, total: number, tone: "ok" | "warn" | "danger") {
  const width = total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((value / total) * 100)));
  const definition = TERM_DEFINITIONS[label];
  return html`
    <div class="kalshi-bar-row">
      <span
        class="kalshi-bar-label"
        title=${definition ?? nothing}
        aria-label=${definition ? `${label}: ${definition}` : nothing}
      >
        ${label}${definitionHelp(label, definition)}
      </span>
      <div class="kalshi-bar">
        <i class="kalshi-bar__fill kalshi-bar__fill--${tone}" style=${`width:${width}%`}></i>
      </div>
      <b>${value}</b>
    </div>
  `;
}

function listItems(items: string[] | undefined) {
  if (!items?.length) {
    return html`<li>None</li>`;
  }
  return items.map((item) => html`<li>${item}</li>`);
}

type TrendPoint = NonNullable<
  NonNullable<NonNullable<KalshiDashboardSnapshot["strategy_scorecard"]>["trend"]>["points"]
>[number];

function linePoints(
  points: TrendPoint[],
  key: "accuracy" | "cumulative_pnl_usd",
  {
    width,
    height,
    top,
    right,
    bottom,
    left,
    min,
    max,
  }: {
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
    min: number;
    max: number;
  },
): string {
  if (!points.length) {
    return "";
  }
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const span = max === min ? 1 : max - min;
  const denominator = Math.max(1, points.length - 1);
  return points
    .map((point, index) => {
      const value = point[key];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
      }
      const x = left + (index / denominator) * plotWidth;
      const y = top + plotHeight - ((value - min) / span) * plotHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function pointPosition(
  points: TrendPoint[],
  index: number,
  value: unknown,
  {
    width,
    height,
    top,
    right,
    bottom,
    left,
    min,
    max,
  }: {
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
    min: number;
    max: number;
  },
): { x: number; y: number } | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const span = max === min ? 1 : max - min;
  const denominator = Math.max(1, points.length - 1);
  return {
    x: left + (index / denominator) * plotWidth,
    y: top + plotHeight - ((value - min) / span) * plotHeight,
  };
}

function volumeBuckets(
  points: TrendPoint[],
  plot: { width: number; left: number; right: number; bottomY: number },
) {
  if (!points.length) {
    return [];
  }
  const bucketCount = Math.min(14, Math.max(1, points.length));
  const counts = Array.from({ length: bucketCount }, () => 0);
  points.forEach((_point, index) => {
    const bucket = Math.min(bucketCount - 1, Math.floor((index / points.length) * bucketCount));
    counts[bucket] += 1;
  });
  const maxCount = Math.max(1, ...counts);
  const plotWidth = plot.width - plot.left - plot.right;
  const bucketWidth = plotWidth / bucketCount;
  return counts.map((count, index) => {
    const height = (count / maxCount) * 42;
    return {
      count,
      x: plot.left + index * bucketWidth + 1.5,
      y: plot.bottomY - height,
      width: Math.max(2, bucketWidth - 3),
      height,
    };
  });
}

function projectedAccuracy(points: TrendPoint[]): number | null {
  if (points.length < 8) {
    return null;
  }
  const recent = points.slice(-12);
  const first = recent[0]?.accuracy;
  const last = recent[recent.length - 1]?.accuracy;
  if (
    typeof first !== "number" ||
    !Number.isFinite(first) ||
    typeof last !== "number" ||
    !Number.isFinite(last)
  ) {
    return null;
  }
  return Math.min(1, Math.max(0, last + (last - first) * 0.5));
}

function trendChart(
  points: TrendPoint[],
  timeframe: string,
  timezone: string,
  anchorTimestamp?: string,
  activity?: TimeframeActivity | null,
) {
  if (!points.length) {
    return html`<p class="muted">
      No scored paper trades yet, so the trend chart is unavailable.
    </p>`;
  }
  const timeframeLabel =
    TREND_TIMEFRAMES.find((option) => option.value === timeframe)?.label ?? timeframe;
  const width = 720;
  const height = 330;
  const top = 24;
  const right = 54;
  const bottom = 62;
  const left = 54;
  const projectionWidth = 84;
  const actualRight = right + projectionWidth;
  const displayPoints = filterTrendPoints(points, timeframe, anchorTimestamp);
  if (!displayPoints.length) {
    const anchorTime = formatChartTimeParts(anchorTimestamp, timezone);
    const accepted = activity?.accepted ?? 0;
    const scoredAccepted = activity?.scored_accepted ?? 0;
    const outcomesRecorded = activity?.outcomes_recorded ?? 0;
    const emptyReason =
      accepted > 0 && scoredAccepted === 0
        ? "Paper trades were accepted in this window, but none of those accepted trades have resolved and scored yet. This is a learning-speed bottleneck, not a dashboard refresh failure."
        : outcomesRecorded > 0 && scoredAccepted === 0
          ? "Outcomes were recorded in this window, but they did not belong to accepted directional paper trades that can update accuracy and P&L."
          : "No accepted paper trades resolved inside this window, so the accuracy and P&L trend cannot move yet.";
    return html`<div class="kalshi-trend-chart kalshi-trend-chart--empty">
      <div class="kalshi-chart-summary">
        <span><b>Timeframe:</b> ${timeframeLabel}</span>
        <span><b>Current time:</b> ${anchorTime.full}</span>
        <span><b>Paper decisions:</b> ${fmt(activity?.decisions ?? 0)}</span>
        <span><b>Accepted paper trades:</b> ${fmt(accepted)}</span>
        <span><b>Scored accepted trades:</b> ${fmt(scoredAccepted)}</span>
      </div>
      <p class="muted">${emptyReason} Choose a longer timeframe to review older scored evidence.</p>
    </div>`;
  }
  const pnlValues = displayPoints
    .map((point) => point.cumulative_pnl_usd)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  let pnlMin = Math.min(0, ...pnlValues);
  let pnlMax = Math.max(0, ...pnlValues);
  if (pnlMin === pnlMax) {
    pnlMin -= 1;
    pnlMax += 1;
  }
  const accuracyPoints = linePoints(displayPoints, "accuracy", {
    width,
    height,
    top,
    right: actualRight,
    bottom,
    left,
    min: 0,
    max: 1,
  });
  const pnlPoints = linePoints(displayPoints, "cumulative_pnl_usd", {
    width,
    height,
    top,
    right: actualRight,
    bottom,
    left,
    min: pnlMin,
    max: pnlMax,
  });
  const midY = top + (height - top - bottom) / 2;
  const latest = displayPoints[displayPoints.length - 1];
  const latestAccuracy = latest?.accuracy;
  const latestPnl = latest?.cumulative_pnl_usd;
  const projection = projectedAccuracy(displayPoints);
  const plotWidth = width - left - actualRight;
  const fullPlotRight = width - right;
  const plotHeight = height - top - bottom;
  const lastX = left + plotWidth;
  const latestAccuracyY =
    typeof latestAccuracy === "number" && Number.isFinite(latestAccuracy)
      ? top + plotHeight - latestAccuracy * plotHeight
      : null;
  const projectionY =
    typeof projection === "number" && Number.isFinite(projection)
      ? top + plotHeight - projection * plotHeight
      : null;
  const latestAccuracyText = pct(latestAccuracy);
  const latestPnlText = signedMoney(latestPnl);
  const bars = volumeBuckets(displayPoints, {
    width,
    left,
    right: actualRight,
    bottomY: height - bottom,
  });
  const denominator = Math.max(1, displayPoints.length - 1);
  const hoverBandWidth = Math.max(18, plotWidth / Math.max(1, displayPoints.length));
  const hoverColumns = displayPoints
    .map((point, index) => {
      const accuracyPosition = pointPosition(displayPoints, index, point.accuracy, {
        width,
        height,
        top,
        right: actualRight,
        bottom,
        left,
        min: 0,
        max: 1,
      });
      const pnlPosition = pointPosition(displayPoints, index, point.cumulative_pnl_usd, {
        width,
        height,
        top,
        right: actualRight,
        bottom,
        left,
        min: pnlMin,
        max: pnlMax,
      });
      const x = left + (index / denominator) * plotWidth;
      const tooltipWidth = 205;
      const tooltipHeight = 90;
      const tooltipX = x + tooltipWidth + 12 > fullPlotRight ? x - tooltipWidth - 10 : x + 10;
      const time = formatChartTimeParts(point.scored_at_utc ?? point.timestamp_utc, timezone);
      return {
        point,
        time,
        x,
        bandX: Math.max(left, Math.min(lastX - hoverBandWidth, x - hoverBandWidth / 2)),
        bandWidth: hoverBandWidth,
        tooltipX,
        tooltipY: top + 10,
        tooltipWidth,
        tooltipHeight,
        accuracyPosition,
        pnlPosition,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        point: TrendPoint;
        time: { date: string; time: string; full: string };
        x: number;
        bandX: number;
        bandWidth: number;
        tooltipX: number;
        tooltipY: number;
        tooltipWidth: number;
        tooltipHeight: number;
        accuracyPosition: { x: number; y: number } | null;
        pnlPosition: { x: number; y: number } | null;
      } => entry.accuracyPosition != null || entry.pnlPosition != null,
    );
  const startTime = formatChartTimeParts(
    displayPoints[0]?.scored_at_utc ?? displayPoints[0]?.timestamp_utc,
    timezone,
  );
  const currentBoundaryTime = formatChartTimeParts(
    latest?.scored_at_utc ?? latest?.timestamp_utc,
    timezone,
  );
  return html`
    <div
      class="kalshi-trend-chart"
      role="img"
      aria-label="Kalshi paper trading trend chart. X axis is scored trades over time. Left Y axis is accuracy from 0% to 100%. Right Y axis is cumulative paper profit/loss."
    >
      <div class="kalshi-chart-summary">
        <span><b>Accuracy trend:</b> ${latestAccuracyText}</span>
        <span><b>Projected next accuracy:</b> ${pct(projection)}</span>
        <span><b>Cumulative paper profit/loss:</b> ${latestPnlText}</span>
        <span><b>Learning volume:</b> ${fmt(displayPoints.length)} scored trades</span>
        <span><b>Time zone:</b> ${timezoneDisplayName(timezone)}</span>
      </div>
      <div class="kalshi-chart-guide">
        <span><b>Left of blue dotted line:</b> actual scored paper results.</span>
        <span><b>Right of blue dotted line:</b> simple projected accuracy, not proof.</span>
        <span
          ><b>Bars:</b> scored paper trades in each slice. Hover the graph for exact values.</span
        >
      </div>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
        <line
          x1=${left}
          y1=${top}
          x2=${left}
          y2=${height - bottom}
          class="kalshi-chart-axis"
        ></line>
        <line
          x1=${left}
          y1=${height - bottom}
          x2=${width - right}
          y2=${height - bottom}
          class="kalshi-chart-axis"
        ></line>
        <line
          x1=${left}
          y1=${midY}
          x2=${width - right}
          y2=${midY}
          class="kalshi-chart-grid kalshi-chart-grid--reference"
        ></line>
        <line x1=${left} y1=${top} x2=${width - right} y2=${top} class="kalshi-chart-grid"></line>
        <rect
          x=${lastX}
          y=${top}
          width=${fullPlotRight - lastX}
          height=${height - top - bottom}
          class="kalshi-chart-projection-zone"
        >
          <title>Projection zone: values to the right are paper-only estimates.</title>
        </rect>
        ${bars.map(
          (bar) => svg`<rect
            x=${bar.x}
            y=${bar.y}
            width=${bar.width}
            height=${bar.height}
            rx="2"
            class="kalshi-chart-volume-bar"
          >
            <title>${bar.count} scored paper trades in this time slice</title>
          </rect>`,
        )}
        <polyline
          points=${accuracyPoints}
          class="kalshi-chart-line kalshi-chart-line--accuracy"
        ></polyline>
        <polyline points=${pnlPoints} class="kalshi-chart-line kalshi-chart-line--pnl"></polyline>
        ${hoverColumns.map(
          (entry) => svg`<g class="kalshi-chart-hover-column" tabindex="0">
            <rect
              x=${entry.bandX}
              y=${top}
              width=${entry.bandWidth}
              height=${height - top - bottom}
              class="kalshi-chart-hover-zone"
            ></rect>
            <line
              x1=${entry.x}
              y1=${top}
              x2=${entry.x}
              y2=${height - bottom}
              class="kalshi-chart-hover-line"
            ></line>
            <g class="kalshi-chart-tooltip">
              <rect
                x=${entry.tooltipX}
                y=${entry.tooltipY}
                width=${entry.tooltipWidth}
                height=${entry.tooltipHeight}
                rx="8"
                class="kalshi-chart-tooltip-box"
              ></rect>
              <text
                x=${entry.tooltipX + 10}
                y=${entry.tooltipY + 18}
                class="kalshi-chart-tooltip-title"
              >
                Trade ${fmt(entry.point.index)}
              </text>
              <text
                x=${entry.tooltipX + 10}
                y=${entry.tooltipY + 35}
                class="kalshi-chart-tooltip-text"
              >
                Accuracy ${pct(entry.point.accuracy)}
              </text>
              <text
                x=${entry.tooltipX + 10}
                y=${entry.tooltipY + 52}
                class="kalshi-chart-tooltip-text"
              >
                Paper profit/loss ${signedMoney(entry.point.cumulative_pnl_usd)}
              </text>
              <text
                x=${entry.tooltipX + 10}
                y=${entry.tooltipY + 67}
                class="kalshi-chart-tooltip-muted"
              >
                ${entry.time.date}
              </text>
              <text
                x=${entry.tooltipX + 10}
                y=${entry.tooltipY + 82}
                class="kalshi-chart-tooltip-muted"
              >
                ${entry.time.time}
              </text>
            </g>
          </g>`,
        )}
        ${latestAccuracyY != null && projectionY != null
          ? svg`
              <line
                x1=${lastX}
                y1=${latestAccuracyY}
                x2=${fullPlotRight}
                y2=${projectionY}
                class="kalshi-chart-line kalshi-chart-line--projection"
              >
                <title>
                  Projected next accuracy ${pct(projection)}. This is a paper-only trend
                  extrapolation, not a guaranteed forecast.
                </title>
              </line>
            `
          : nothing}
        <line x1=${lastX} y1=${top} x2=${lastX} y2=${height - bottom} class="kalshi-chart-now">
          <title>Current time boundary: actual scored results are left of this line.</title>
        </line>
        <text
          x=${lastX - 4}
          y=${height - bottom - 8}
          text-anchor="end"
          class="kalshi-chart-label kalshi-chart-label--now"
        >
          current time
        </text>
        <text
          x=${lastX - 4}
          y=${height - bottom + 14}
          text-anchor="end"
          class="kalshi-chart-label kalshi-chart-label--now"
        >
          ${currentBoundaryTime.time}
        </text>
        <text x=${left} y=${height - 26} class="kalshi-chart-label">${startTime.date}</text>
        <text x=${left} y=${height - 12} class="kalshi-chart-label">${startTime.time}</text>
        <text x=${width - right} y=${height - 26} text-anchor="end" class="kalshi-chart-label">
          projected
        </text>
        <text x="16" y=${top + 4} class="kalshi-chart-label">100%</text>
        <text x="16" y=${midY + 4} class="kalshi-chart-label">50%</text>
        <text x="16" y=${height - bottom} class="kalshi-chart-label">0%</text>
        <text
          x="18"
          y=${top + 68}
          class="kalshi-chart-axis-title"
          transform=${`rotate(-90 18 ${top + 68})`}
        >
          Accuracy
        </text>
        <text x=${width / 2} y=${height - 4} text-anchor="middle" class="kalshi-chart-axis-title">
          Scored paper trades by selected timezone
        </text>
        <text x=${width - 8} y=${top + 4} text-anchor="end" class="kalshi-chart-label">
          ${signedMoney(pnlMax)}
        </text>
        <text x=${width - 8} y=${height - bottom} text-anchor="end" class="kalshi-chart-label">
          ${signedMoney(pnlMin)}
        </text>
        <text
          x=${width - right - 6}
          y=${top + 20}
          text-anchor="end"
          class="kalshi-chart-line-label"
        >
          Accuracy ${latestAccuracyText}
        </text>
        <text
          x=${width - right - 6}
          y=${top + 38}
          text-anchor="end"
          class="kalshi-chart-line-label kalshi-chart-line-label--pnl"
        >
          Paper profit/loss ${latestPnlText}
        </text>
        ${projection != null
          ? svg`<text
              x=${width - 18}
              y=${Math.max(top + 56, projectionY ?? top + 56)}
              text-anchor="end"
              class="kalshi-chart-line-label kalshi-chart-line-label--projection"
            >
              projected ${pct(projection)}
            </text>`
          : nothing}
      </svg>
      <div class="kalshi-chart-legend">
        <span><i class="kalshi-legend kalshi-legend--accuracy"></i> Accuracy trend</span>
        <span><i class="kalshi-legend kalshi-legend--projection"></i> Projected accuracy</span>
        <span><i class="kalshi-legend kalshi-legend--pnl"></i> Cumulative paper profit/loss</span>
        <span><i class="kalshi-legend kalshi-legend--now"></i> Current time boundary</span>
        <span><i class="kalshi-legend kalshi-legend--volume"></i> Learning volume bars</span>
        <span>Timeframe: ${timeframeLabel}</span>
        <span>Hover or focus inside the graph for exact values</span>
        <span>X axis: scored paper trades over time</span>
        <span>Y axis: accuracy left, profit/loss right</span>
      </div>
    </div>
  `;
}

export function renderKalshiDashboard(props: KalshiDashboardProps) {
  const snapshot = props.snapshot;
  const paper = snapshot?.paper ?? {};
  const accelerator = snapshot?.accelerator ?? {};
  const decisionQuality = accelerator.decision_quality ?? {};
  const distance = accelerator.distance_to_live_readiness ?? {};
  const metrics = snapshot?.self_improvement?.metrics ?? {};
  const scorecard = snapshot?.strategy_scorecard ?? {};
  const volume = snapshot?.paper_volume_accelerator ?? {};
  const volumeMetrics = volume.metrics ?? {};
  const paperTradeAccelerator = snapshot?.paper_trade_accelerator ?? {};
  const paperTradeRouteMix = (paperTradeAccelerator.route_mix ?? {}) as {
    overall?: Record<string, number>;
    weather_crypto?: Record<string, number>;
  };
  const paperTradeRouteMixOverall = paperTradeRouteMix.overall ?? {};
  const paperTradeRouteMixWeatherCrypto = paperTradeRouteMix.weather_crypto ?? {};
  const paperTradeRouteMixOverallTotal = routeMixPercentages(
    paperTradeAccelerator.route_mix_total?.overall ?? paperTradeRouteMixOverall,
  );
  const paperTradeRouteMixWeatherCryptoTotal = routeMixPercentages(
    paperTradeAccelerator.route_mix_total?.weather_crypto ?? paperTradeRouteMixWeatherCrypto,
  );
  const paperTradeRouteMixOverallSummary = formatRouteMixSummary(paperTradeRouteMixOverallTotal);
  const paperTradeRouteMixWeatherCryptoSummary = formatRouteMixSummary(
    paperTradeRouteMixWeatherCryptoTotal,
  );
  const volumeSettings = volume.recommended_cycle_settings ?? {};
  const volumeAllocation = volume.recommended_allocation ?? {};
  const profitFirewall = accelerator.profit_firewall ?? {};
  const weatherAudit = snapshot?.weather_model_audit ?? {};
  const weatherAuditAction = weatherAudit.primary_action ?? {};
  const weatherAuditBuckets = weatherAudit.bucket_summaries?.slice(0, 6) ?? [];
  const weatherTopFailure =
    weatherAudit.top_failure_mode ??
    Object.entries(weatherAudit.failure_modes ?? {})
      .toSorted(([, left], [, right]) => right - left)
      .map(([mode, count]) => ({ mode, count }))[0] ??
    null;
  const shadowDiscovery = snapshot?.shadow_discovery ?? {};
  const shadowMetrics = shadowDiscovery.metrics ?? {};
  const shadowActions = shadowDiscovery.by_action?.slice(0, 6) ?? [];
  const shadowSegments = shadowDiscovery.best_segments?.slice(0, 5) ?? [];
  const shadowReviewCandidates = shadowDiscovery.exploration_review_candidates ?? [];
  const inverseAudit = snapshot?.inverse_strategy_audit ?? {};
  const inverseMetrics = inverseAudit.metrics ?? {};
  const inverseSegments = inverseMetrics.best_segments?.slice(0, 6) ?? [];
  const inverseForwardCandidates = inverseMetrics.contrarian_forward_paper_candidates ?? [];
  const inverseRecommendations = inverseAudit.recommendations?.slice(0, 4) ?? [];
  const milestoneCountdown = snapshot?.milestone_countdown ?? {};
  const countdownMilestones = milestoneCountdown.milestones ?? [];
  const countdownHealth = milestoneCountdown.countdown_health ?? snapshot?.countdown_health ?? {};
  const countdownLearningMomentum =
    typeof countdownHealth.learning_momentum === "object" &&
    countdownHealth.learning_momentum !== null &&
    !Array.isArray(countdownHealth.learning_momentum)
      ? (countdownHealth.learning_momentum as Record<string, unknown>)
      : {};
  const countdownFreshness =
    typeof countdownHealth.freshness === "object" &&
    countdownHealth.freshness !== null &&
    !Array.isArray(countdownHealth.freshness)
      ? (countdownHealth.freshness as Record<string, unknown>)
      : {};
  const countdownRateWindows =
    typeof countdownHealth.accepted_forward_rate_windows === "object" &&
    countdownHealth.accepted_forward_rate_windows !== null &&
    !Array.isArray(countdownHealth.accepted_forward_rate_windows)
      ? (countdownHealth.accepted_forward_rate_windows as Record<string, unknown>)
      : (milestoneCountdown.rate_windows ?? {});
  const countdownWindowRows = Array.isArray(countdownRateWindows.windows)
    ? (countdownRateWindows.windows as Array<Record<string, unknown>>)
    : [];
  const countdownProofBlockers = Array.isArray(countdownHealth.proof_blockers)
    ? (countdownHealth.proof_blockers as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  const countdownCandidateQuality =
    typeof countdownHealth.accepted_forward_candidate_quality === "object" &&
    countdownHealth.accepted_forward_candidate_quality !== null &&
    !Array.isArray(countdownHealth.accepted_forward_candidate_quality)
      ? (countdownHealth.accepted_forward_candidate_quality as Record<string, unknown>)
      : {};
  const countdownCandidateBlockers =
    typeof countdownCandidateQuality.blocker_counts === "object" &&
    countdownCandidateQuality.blocker_counts !== null &&
    !Array.isArray(countdownCandidateQuality.blocker_counts)
      ? Object.entries(countdownCandidateQuality.blocker_counts as Record<string, unknown>).slice(
          0,
          6,
        )
      : [];
  const countdownCandidateActions = Array.isArray(countdownCandidateQuality.next_actions)
    ? (countdownCandidateQuality.next_actions as unknown[]).slice(0, 3)
    : [];
  const strategyComparison = snapshot?.strategy_comparison ?? {};
  const strategyComparisonRows = strategyComparison.rows ?? [];
  const sortedStrategyComparisonRows = sortStrategyRows(strategyComparisonRows, props.strategySort);
  const strategyActual = strategyComparison.actual_summary;
  const strategyAudit = strategyComparison.audit_summary;
  const standardStrategyRow =
    strategyComparisonRows.find((row) => row.strategy_id === "standard_strategy") ?? {};
  const inverseStandardRow =
    strategyComparisonRows.find((row) => row.strategy_id === "inverse_standard_strategy") ?? {};
  const actualStandardAccuracy =
    performanceNumber(strategyActual?.standard_accuracy) ??
    performanceNumber(standardStrategyRow.accuracy);
  const actualInverseAccuracy =
    performanceNumber(strategyActual?.inverse_standard_accuracy) ??
    performanceNumber(inverseStandardRow.accuracy);
  const actualStandardPnl =
    performanceNumber(strategyActual?.standard_pnl_usd) ??
    performanceNumber(standardStrategyRow.paper_pnl_usd);
  const actualInversePnl =
    performanceNumber(strategyActual?.inverse_standard_pnl_usd) ??
    performanceNumber(inverseStandardRow.paper_pnl_usd);
  const actualPnlDelta =
    performanceNumber(strategyActual?.pnl_delta_inverse_minus_standard_usd) ??
    (actualStandardPnl == null || actualInversePnl == null
      ? null
      : actualInversePnl - actualStandardPnl);
  const actualStandardScored =
    strategyActual?.standard_scored ?? standardStrategyRow.scored ?? standardStrategyRow.accepted;
  const actualInverseScored =
    strategyActual?.inverse_standard_scored ??
    inverseStandardRow.scored ??
    inverseStandardRow.accepted;
  const auditStandardAccuracy =
    performanceNumber(strategyAudit?.standard_accuracy) ??
    performanceNumber(inverseMetrics.original_accuracy);
  const auditInverseAccuracy =
    performanceNumber(strategyAudit?.inverse_standard_accuracy) ??
    performanceNumber(inverseMetrics.inverse_accuracy);
  const auditPnlDelta =
    performanceNumber(strategyAudit?.pnl_delta_inverse_minus_standard_usd) ??
    performanceNumber(inverseMetrics.pnl_delta_inverse_minus_original_usd);
  const auditScored = strategyAudit?.scored ?? inverseMetrics.total_directional_scored;
  const auditExecutableQuality =
    performanceNumber(strategyAudit?.executable_quality_fraction) ??
    performanceNumber(inverseMetrics.executable_quality_fraction);
  const actualStandardScoredForDelta =
    performanceNumber(actualStandardScored) ?? performanceNumber(standardStrategyRow.scored);
  const strategyTotals = strategyComparisonRows.reduce<{
    accepted: number;
    pnl: number;
    scored: number;
    shadow: number;
  }>(
    (totals, row) => ({
      accepted: totals.accepted + (strategyRowNumber(row.accepted) ?? 0),
      scored: totals.scored + (strategyRowNumber(row.scored) ?? 0),
      shadow: totals.shadow + strategyShadowCount(row),
      pnl: totals.pnl + (strategyRowNumber(row.paper_pnl_usd) ?? 0),
    }),
    { accepted: 0, scored: 0, shadow: 0, pnl: 0 },
  );
  const cryptoEvidence = snapshot?.crypto_evidence ?? {};
  const weatherCryptoMl = snapshot?.weather_crypto_ml ?? {};
  const mlDomains = weatherCryptoMl.domains ?? {};
  const weatherMl = mlDomains.weather ?? {};
  const cryptoMl = mlDomains.crypto ?? {};
  const mlReality = weatherCryptoMl.reality_contract ?? {};
  const mlGovernance = weatherCryptoMl.model_governance ?? {};
  const mlModel = weatherCryptoMl.ml_model ?? {};
  const mlMarkovUplift = mlModel.markov_microstructure_uplift ?? {};
  const mlMarkovCoverage = weatherCryptoMl.markov_feature_coverage ?? {};
  const mlPromotionGap = weatherCryptoMl.promotion_gap ?? {};
  const mlMarkovOverlay = weatherCryptoMl.markov_microstructure_ml_overlay ?? {};
  const mlCalibrationRepair = mlPromotionGap.calibration_repair ?? {};
  const mlCalibrationRepairBehavior = mlCalibrationRepair.candidate_behavior ?? {};
  const mlCalibrationRepairSegments = mlCalibrationRepair.segments?.slice(0, 3) ?? [];
  const mlPromotionGapSegments = mlPromotionGap.segments?.slice(0, 3) ?? [];
  const mlPromotionBlockers = Object.entries(mlPromotionGap.blocker_counts ?? {}).toSorted(
    ([leftKey, leftValue], [rightKey, rightValue]) =>
      (rightValue ?? 0) - (leftValue ?? 0) || leftKey.localeCompare(rightKey),
  );
  const mlQualifiedSegments = weatherCryptoMl.shadow_qualified_segments?.slice(0, 3) ?? [];
  const mlTopSegments = weatherCryptoMl.segments?.slice(0, 5) ?? [];
  const markovMicrostructure = snapshot?.markov_microstructure ?? {};
  const markovSummary = markovMicrostructure.summary ?? {};
  const markovMarkets = markovMicrostructure.markets?.slice(0, 5) ?? [];
  const supremeTradingStrategy = snapshot?.supreme_trading_strategy ?? {};
  const stsTradingDashboard = snapshot?.sts_trading_dashboard ?? {};
  const stsTradingSummary =
    typeof stsTradingDashboard.summary === "object" &&
    stsTradingDashboard.summary !== null &&
    !Array.isArray(stsTradingDashboard.summary)
      ? (stsTradingDashboard.summary as Record<string, unknown>)
      : {};
  const stsDirectedPaper =
    typeof stsTradingDashboard.directed_paper === "object" &&
    stsTradingDashboard.directed_paper !== null &&
    !Array.isArray(stsTradingDashboard.directed_paper)
      ? (stsTradingDashboard.directed_paper as Record<string, unknown>)
      : {};
  const stsDataContractRepair =
    typeof stsTradingDashboard.data_contract_repair === "object" &&
    stsTradingDashboard.data_contract_repair !== null &&
    !Array.isArray(stsTradingDashboard.data_contract_repair)
      ? (stsTradingDashboard.data_contract_repair as Record<string, unknown>)
      : {};
  const stsForwardWeatherEvidence =
    typeof stsTradingDashboard.forward_weather_evidence === "object" &&
    stsTradingDashboard.forward_weather_evidence !== null &&
    !Array.isArray(stsTradingDashboard.forward_weather_evidence)
      ? (stsTradingDashboard.forward_weather_evidence as Record<string, unknown>)
      : {};
  const stsSegmentPolicy =
    typeof stsTradingDashboard.segment_policy === "object" &&
    stsTradingDashboard.segment_policy !== null &&
    !Array.isArray(stsTradingDashboard.segment_policy)
      ? (stsTradingDashboard.segment_policy as Record<string, unknown>)
      : {};
  const stsShadowLearning =
    typeof stsTradingDashboard.shadow_learning === "object" &&
    stsTradingDashboard.shadow_learning !== null &&
    !Array.isArray(stsTradingDashboard.shadow_learning)
      ? (stsTradingDashboard.shadow_learning as Record<string, unknown>)
      : {};
  const stsProofPromotion =
    typeof stsTradingDashboard.proof_promotion === "object" &&
    stsTradingDashboard.proof_promotion !== null &&
    !Array.isArray(stsTradingDashboard.proof_promotion)
      ? (stsTradingDashboard.proof_promotion as Record<string, unknown>)
      : {};
  const stsProofPromotionBlockers = Array.isArray(stsProofPromotion.top_blockers)
    ? (stsProofPromotion.top_blockers as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  const stsProofPromotionDomainBlockers = Array.isArray(
    stsProofPromotion.eligible_domain_top_blockers,
  )
    ? (stsProofPromotion.eligible_domain_top_blockers as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  const stsProofPromotionGovernorReasons = Array.isArray(
    stsProofPromotion.eligible_domain_governor_reason_counts,
  )
    ? (
        stsProofPromotion.eligible_domain_governor_reason_counts as Array<Record<string, unknown>>
      ).slice(0, 3)
    : [];
  const stsProofPromotionCandidates = Array.isArray(stsProofPromotion.promotion_candidates)
    ? (stsProofPromotion.promotion_candidates as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  const stsTradingDomains = Array.isArray(stsTradingDashboard.domains)
    ? (stsTradingDashboard.domains as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  const stsReadinessGates = Array.isArray(stsTradingDashboard.readiness_gates)
    ? (stsTradingDashboard.readiness_gates as Array<Record<string, unknown>>)
    : [];
  const stsRecentDecisions = Array.isArray(stsTradingDashboard.recent_decisions)
    ? (stsTradingDashboard.recent_decisions as Array<Record<string, unknown>>).slice(0, 6)
    : [];
  const stsCanAcceptPaper = stsTradingSummary.can_accept_sts_paper === true;
  const stsDirectedResolved = performanceNumber(stsDirectedPaper.resolved_trades) ?? 0;
  const stsDirectedPending = performanceNumber(stsDirectedPaper.pending_trades) ?? 0;
  const stsReadinessEta = snapshot?.sts_readiness_eta ?? {};
  const stsAgentAudit = snapshot?.sts_agent_audit ?? {};
  const stsCryptoFreshCycle = snapshot?.sts_crypto_fresh_cycle ?? {};
  const stsCryptoFreshCapture =
    typeof stsCryptoFreshCycle.crypto_capture === "object" &&
    stsCryptoFreshCycle.crypto_capture !== null &&
    !Array.isArray(stsCryptoFreshCycle.crypto_capture)
      ? (stsCryptoFreshCycle.crypto_capture as Record<string, unknown>)
      : {};
  const stsCryptoFreshPromotion =
    typeof stsCryptoFreshCycle.fresh_sts_promotion === "object" &&
    stsCryptoFreshCycle.fresh_sts_promotion !== null &&
    !Array.isArray(stsCryptoFreshCycle.fresh_sts_promotion)
      ? (stsCryptoFreshCycle.fresh_sts_promotion as Record<string, unknown>)
      : {};
  const stsCryptoFreshWindowDiagnostics = snapshot?.sts_crypto_fresh_window_diagnostics ?? {};
  const stsCryptoFreshWindowCandidates = Array.isArray(
    stsCryptoFreshWindowDiagnostics.top_fresh_candidates,
  )
    ? (
        stsCryptoFreshWindowDiagnostics.top_fresh_candidates as Array<Record<string, unknown>>
      ).slice(0, 4)
    : [];
  const stsCryptoBaselineCalibration = snapshot?.sts_crypto_baseline_calibration ?? {};
  const stsCryptoCalibrationBuckets = Array.isArray(
    stsCryptoBaselineCalibration.calibration_buckets,
  )
    ? (stsCryptoBaselineCalibration.calibration_buckets as Array<Record<string, unknown>>).slice(
        0,
        5,
      )
    : [];
  const stsCryptoProbabilityRecalibrator = snapshot?.sts_crypto_probability_recalibrator ?? {};
  const stsCryptoRecalibrationBuckets = Array.isArray(
    stsCryptoProbabilityRecalibrator.bucket_recalibration,
  )
    ? (
        stsCryptoProbabilityRecalibrator.bucket_recalibration as Array<Record<string, unknown>>
      ).slice(-5)
    : [];
  const stsCryptoSegmentEdge = snapshot?.sts_crypto_segment_edge ?? {};
  const stsCryptoTopSegments = Array.isArray(stsCryptoSegmentEdge.top_segments)
    ? (stsCryptoSegmentEdge.top_segments as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const stsCryptoExecutionRealism = snapshot?.sts_crypto_execution_realism ?? {};
  const stsCryptoExecutionSegments = Array.isArray(stsCryptoExecutionRealism.top_segments)
    ? (stsCryptoExecutionRealism.top_segments as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const stsCryptoExecutionSelector = snapshot?.sts_crypto_execution_selector ?? {};
  const stsCryptoExecutionExperiments = Array.isArray(
    stsCryptoExecutionSelector.active_shadow_experiments,
  )
    ? (
        stsCryptoExecutionSelector.active_shadow_experiments as Array<Record<string, unknown>>
      ).slice(0, 5)
    : [];
  const stsCryptoPausedExecutionExperiments = Array.isArray(
    stsCryptoExecutionSelector.paused_shadow_experiments,
  )
    ? (
        stsCryptoExecutionSelector.paused_shadow_experiments as Array<Record<string, unknown>>
      ).slice(0, 3)
    : [];
  const stsCryptoExecutionSelectorOutcomes = snapshot?.sts_crypto_execution_selector_outcomes ?? {};
  const stsCryptoExecutionOutcomeRows = Array.isArray(
    stsCryptoExecutionSelectorOutcomes.experiments,
  )
    ? (stsCryptoExecutionSelectorOutcomes.experiments as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const stsCryptoRegimeSelector = snapshot?.sts_crypto_regime_selector ?? {};
  const stsCryptoRegimeExperiments = Array.isArray(
    stsCryptoRegimeSelector.active_shadow_experiments,
  )
    ? (stsCryptoRegimeSelector.active_shadow_experiments as Array<Record<string, unknown>>).slice(
        0,
        5,
      )
    : [];
  const stsCryptoRegimePenalties = Array.isArray(stsCryptoRegimeSelector.forward_regime_penalties)
    ? (stsCryptoRegimeSelector.forward_regime_penalties as Array<Record<string, unknown>>).slice(
        0,
        4,
      )
    : [];
  const stsCryptoRegimeSelectorOutcomes = snapshot?.sts_crypto_regime_selector_outcomes ?? {};
  const stsCryptoRegimeOutcomeRows = Array.isArray(
    stsCryptoRegimeSelectorOutcomes.forward_recorded_experiments,
  )
    ? (
        stsCryptoRegimeSelectorOutcomes.forward_recorded_experiments as Array<
          Record<string, unknown>
        >
      ).slice(0, 4)
    : Array.isArray(stsCryptoRegimeSelectorOutcomes.retrospective_experiments)
      ? (
          stsCryptoRegimeSelectorOutcomes.retrospective_experiments as Array<
            Record<string, unknown>
          >
        ).slice(0, 4)
      : Array.isArray(stsCryptoRegimeSelectorOutcomes.experiments)
        ? (stsCryptoRegimeSelectorOutcomes.experiments as Array<Record<string, unknown>>).slice(
            0,
            4,
          )
        : [];
  const stsCryptoRegimeOutcomeMode =
    Array.isArray(stsCryptoRegimeSelectorOutcomes.forward_recorded_experiments) &&
    (stsCryptoRegimeSelectorOutcomes.forward_recorded_experiments as Array<Record<string, unknown>>)
      .length
      ? "forward-recorded"
      : "retrospective replay";
  const stsCryptoCoverageCohortRows = Array.isArray(
    stsCryptoRegimeSelectorOutcomes.coverage_probe_failure_cohort_blocks,
  )
    ? (
        stsCryptoRegimeSelectorOutcomes.coverage_probe_failure_cohort_blocks as Array<
          Record<string, unknown>
        >
      ).slice(0, 4)
    : [];
  const stsCryptoInverseRepairProofGate =
    typeof stsCryptoRegimeSelectorOutcomes.inverse_repair_shadow_proof_gate === "object" &&
    stsCryptoRegimeSelectorOutcomes.inverse_repair_shadow_proof_gate !== null &&
    !Array.isArray(stsCryptoRegimeSelectorOutcomes.inverse_repair_shadow_proof_gate)
      ? (stsCryptoRegimeSelectorOutcomes.inverse_repair_shadow_proof_gate as Record<
          string,
          unknown
        >)
      : {};
  const stsCryptoInverseRepairProofBlockers = Array.isArray(
    stsCryptoInverseRepairProofGate.blockers,
  )
    ? (stsCryptoInverseRepairProofGate.blockers as unknown[]).slice(0, 4)
    : [];
  const stsCryptoRegimeInverseRepair = snapshot?.sts_crypto_regime_inverse_repair ?? {};
  const stsCryptoRegimeRepairRows = Array.isArray(stsCryptoRegimeInverseRepair.repairs)
    ? (stsCryptoRegimeInverseRepair.repairs as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const stsAgentAuditRows = Array.isArray(stsAgentAudit.agents)
    ? (stsAgentAudit.agents as Array<Record<string, unknown>>).slice(0, 8)
    : [];
  const stsDomainOptimizer = snapshot?.sts_domain_optimizer ?? {};
  const stsDomainLearningOptimizer = snapshot?.sts_domain_learning_optimizer ?? {};
  const stsDomainOptimizerBest =
    typeof stsDomainLearningOptimizer.best_domain_to_improve_next === "object" &&
    stsDomainLearningOptimizer.best_domain_to_improve_next !== null &&
    !Array.isArray(stsDomainLearningOptimizer.best_domain_to_improve_next)
      ? (stsDomainLearningOptimizer.best_domain_to_improve_next as Record<string, unknown>)
      : {};
  const stsDomainOptimizerLanes = Array.isArray(stsDomainLearningOptimizer.domain_lanes)
    ? (stsDomainLearningOptimizer.domain_lanes as Array<Record<string, unknown>>)
    : [];
  const stsDomainLearningPolicy =
    (stsDomainLearningOptimizer.domain_separation_policy as Record<string, unknown> | undefined) ??
    (stsDomainOptimizer.domain_learning_policy as Record<string, unknown> | undefined) ??
    {};
  const stsDomainLearningActionRows = stsDomainOptimizerLanes.slice(0, 8);
  const stsWeatherSelectorRepair = snapshot?.sts_weather_selector_repair ?? {};
  const stsWeatherSelectorBlockers = Array.isArray(stsWeatherSelectorRepair.top_blockers)
    ? (stsWeatherSelectorRepair.top_blockers as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  const stsCryptoEvidenceRepair = snapshot?.sts_crypto_evidence_repair ?? {};
  const stsCryptoEvidenceBlockers = Array.isArray(stsCryptoEvidenceRepair.top_blockers)
    ? (stsCryptoEvidenceRepair.top_blockers as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  const stsUnlockQueue = snapshot?.sts_unlock_queue ?? {};
  const stsTopUnlockAction =
    typeof stsUnlockQueue.top_unlock_action === "object" &&
    stsUnlockQueue.top_unlock_action !== null &&
    !Array.isArray(stsUnlockQueue.top_unlock_action)
      ? (stsUnlockQueue.top_unlock_action as Record<string, unknown>)
      : {};
  const stsUnlockActions = Array.isArray(stsUnlockQueue.unlock_actions)
    ? (stsUnlockQueue.unlock_actions as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const stsPaperTradingEta =
    typeof stsReadinessEta.paper_trading_eta === "object" &&
    stsReadinessEta.paper_trading_eta !== null &&
    !Array.isArray(stsReadinessEta.paper_trading_eta)
      ? (stsReadinessEta.paper_trading_eta as Record<string, unknown>)
      : {};
  const stsLiveReviewEta =
    typeof stsReadinessEta.live_review_eta === "object" &&
    stsReadinessEta.live_review_eta !== null &&
    !Array.isArray(stsReadinessEta.live_review_eta)
      ? (stsReadinessEta.live_review_eta as Record<string, unknown>)
      : {};
  const stsDomainPaperEta =
    typeof stsReadinessEta.domain_paper_trading_eta === "object" &&
    stsReadinessEta.domain_paper_trading_eta !== null &&
    !Array.isArray(stsReadinessEta.domain_paper_trading_eta)
      ? (stsReadinessEta.domain_paper_trading_eta as Record<string, Record<string, unknown>>)
      : {};
  const stsWeatherPaperEta = stsDomainPaperEta.weather ?? {};
  const stsCryptoPaperEta = stsDomainPaperEta.crypto ?? {};
  const stsDomainPaperEtaRows = Object.entries(stsDomainPaperEta)
    .map(([domain, eta]) => ({ domain, eta }))
    .toSorted((left, right) => left.domain.localeCompare(right.domain));
  const stsPaperEtaBasis =
    typeof stsPaperTradingEta.real_data_basis === "object" &&
    stsPaperTradingEta.real_data_basis !== null &&
    !Array.isArray(stsPaperTradingEta.real_data_basis)
      ? (stsPaperTradingEta.real_data_basis as Record<string, unknown>)
      : {};
  const stsLiveEtaBasis =
    typeof stsLiveReviewEta.real_data_basis === "object" &&
    stsLiveReviewEta.real_data_basis !== null &&
    !Array.isArray(stsLiveReviewEta.real_data_basis)
      ? (stsLiveReviewEta.real_data_basis as Record<string, unknown>)
      : {};
  const stsLiveEtaBlockers = Array.isArray(stsLiveReviewEta.blockers)
    ? (stsLiveReviewEta.blockers as unknown[]).slice(0, 5)
    : [];
  const stsPaperGovernorReasons = Array.isArray(
    stsPaperEtaBasis.eligible_domain_governor_reason_counts,
  )
    ? (
        stsPaperEtaBasis.eligible_domain_governor_reason_counts as Array<Record<string, unknown>>
      ).slice(0, 3)
    : [];
  const stsPaperEtaBlockers =
    Array.isArray(stsPaperEtaBasis.eligible_domain_top_blockers) &&
    stsPaperEtaBasis.eligible_domain_top_blockers.length
      ? (stsPaperEtaBasis.eligible_domain_top_blockers as Array<Record<string, unknown>>).slice(
          0,
          5,
        )
      : Array.isArray(stsPaperEtaBasis.top_blockers)
        ? (stsPaperEtaBasis.top_blockers as Array<Record<string, unknown>>).slice(0, 5)
        : [];
  const stsReadinessRoadmap = snapshot?.sts_readiness_roadmap ?? {};
  const rawStsRoadmapPaper =
    typeof stsReadinessRoadmap.paper_trading === "object" &&
    stsReadinessRoadmap.paper_trading !== null &&
    !Array.isArray(stsReadinessRoadmap.paper_trading)
      ? (stsReadinessRoadmap.paper_trading as Record<string, unknown>)
      : {};
  const rawStsRoadmapLive =
    typeof stsReadinessRoadmap.live_trading === "object" &&
    stsReadinessRoadmap.live_trading !== null &&
    !Array.isArray(stsReadinessRoadmap.live_trading)
      ? (stsReadinessRoadmap.live_trading as Record<string, unknown>)
      : {};
  const stsRoadmapPaper = Object.keys(rawStsRoadmapPaper).length
    ? rawStsRoadmapPaper
    : {
        readiness_score: stsCanAcceptPaper ? 80 : 30,
        stage_label: String(stsTradingSummary.status_label ?? "Shadow-only learning"),
        can_sts_direct_paper: stsCanAcceptPaper,
        top_blocker: stsTradingSummary.top_blocker ?? "sts_readiness_roadmap_missing",
        plain_english:
          stsTradingSummary.plain_english ??
          "STS readiness roadmap is refreshing; showing stable STS trading-dashboard fallback.",
      };
  const stsRoadmapLive = Object.keys(rawStsRoadmapLive).length
    ? rawStsRoadmapLive
    : {
        readiness_score: 10,
        stage_label: "Not live-ready",
        can_trade_live: false,
        manual_review_required: true,
        plain_english: "Live trading remains off and requires human review after paper proof.",
      };
  const stsRoadmapDelta =
    typeof stsReadinessRoadmap.progress_delta === "object" &&
    stsReadinessRoadmap.progress_delta !== null &&
    !Array.isArray(stsReadinessRoadmap.progress_delta)
      ? (stsReadinessRoadmap.progress_delta as Record<string, unknown>)
      : {};
  const stsRoadmapStages = Array.isArray(stsReadinessRoadmap.stages)
    ? (stsReadinessRoadmap.stages as Array<Record<string, unknown>>)
    : [
        { label: "Data ready", state: "complete" },
        { label: "Shadow learning", state: "current" },
        { label: "Baseline challenger", state: "blocked" },
        { label: "Tiny paper", state: "future" },
        { label: "Human review", state: "future" },
      ];
  const stsRoadmapGates = Array.isArray(stsReadinessRoadmap.gates)
    ? (stsReadinessRoadmap.gates as Array<Record<string, unknown>>)
    : stsReadinessGates.map(
        (gate): Record<string, unknown> => ({
          ...gate,
          score: gate.status === "passed" ? 10 : 0,
          blocker: gate.blocker ?? gate.gate_id,
          why_it_matters: gate.plain_english,
          unlocks_when: gate.blocker ? `Resolve ${String(gate.blocker)}` : "Gate remains passed.",
        }),
      );
  const stsRoadmapNextActions = Array.isArray(stsReadinessRoadmap.next_actions)
    ? (stsReadinessRoadmap.next_actions as unknown[]).slice(0, 4)
    : [
        stsTradingSummary.next_action ??
          "Generate baseline-beating accepted-forward-paper proof for STS.",
      ];
  const stsPaperScore = Math.max(
    0,
    Math.min(100, performanceNumber(stsRoadmapPaper.readiness_score) ?? 0),
  );
  const stsLiveScore = Math.max(
    0,
    Math.min(100, performanceNumber(stsRoadmapLive.readiness_score) ?? 0),
  );
  const stsRegime = supremeTradingStrategy.current_regime ?? {};
  const stsObjectives = supremeTradingStrategy.objective_scores ?? {};
  const stsWeights = supremeTradingStrategy.strategy_weights?.slice(0, 8) ?? [];
  const stsChampionWeight = performanceNumber(
    stsWeights.find((row) => row.strategy_id === "weather_crypto_ml_champion")?.weight,
  );
  const stsSportsGuardrail = performanceNumber(
    stsWeights.find((row) => row.strategy_id === "sports_control_guardrail")?.weight,
  );
  const stsRationales = supremeTradingStrategy.top_rationales?.slice(0, 4) ?? [];
  const stsRisk = supremeTradingStrategy.risk ?? {};
  const stsLearning = supremeTradingStrategy.learning ?? {};
  const stsLearningAcceleration =
    typeof stsLearning.domain_learning_acceleration === "object" &&
    stsLearning.domain_learning_acceleration !== null &&
    !Array.isArray(stsLearning.domain_learning_acceleration)
      ? (stsLearning.domain_learning_acceleration as Record<string, unknown>)
      : {};
  const stsLearningAccelerationEnabled = stsLearningAcceleration.enabled === true;
  const stsCryptoExecutionRealismFromLearning =
    typeof stsLearningAcceleration.crypto_execution_realism === "object" &&
    stsLearningAcceleration.crypto_execution_realism !== null &&
    !Array.isArray(stsLearningAcceleration.crypto_execution_realism)
      ? (stsLearningAcceleration.crypto_execution_realism as Record<string, unknown>)
      : stsCryptoExecutionRealism;
  const stsCryptoExecutionRealismMultiplierFromLearning = performanceNumber(
    stsCryptoExecutionRealismFromLearning.execution_realism_multiplier,
  );
  const stsCryptoExecutionPressureFromLearning = plainStrategyToken(
    stsCryptoExecutionRealismFromLearning.execution_pressure ?? "",
  );
  const stsCryptoExecutionExecutableRatio = performanceNumber(
    stsCryptoExecutionRealismFromLearning.executable_ratio,
  );
  const stsCryptoExecutionLiquidityRatio = performanceNumber(
    stsCryptoExecutionRealismFromLearning.liquidity_gap_ratio,
  );
  const stsWeatherCryptoBoost = performanceNumber(stsLearningAcceleration.weather_crypto_boost);
  const stsWeatherCryptoRawBoost = performanceNumber(
    stsLearningAcceleration.weather_crypto_raw_boost,
  );
  const stsWeatherCryptoCalibrationFactor = performanceNumber(
    stsLearningAcceleration.weather_crypto_calibration_factor,
  );
  const stsWeatherCryptoReallocation = performanceNumber(
    stsLearningAcceleration.weather_crypto_reallocation_multiplier,
  );
  const stsWeatherCryptoReallocationReason = plainStrategyToken(
    stsLearningAcceleration.weather_crypto_reallocation_reason ??
      "No weather/crypto reallocation is currently required.",
  );
  const stsWeatherCryptoStochasticMultiplier = performanceNumber(
    stsLearningAcceleration.weather_crypto_stochastic_process_multiplier,
  );
  const stsWeatherCryptoStochasticReason = plainStrategyToken(
    stsLearningAcceleration.weather_crypto_stochastic_process_reason ??
      "Stochastic process diagnostics are not yet available for routing feedback.",
  );
  const stsWeatherCryptoWalkForwardMultiplier = performanceNumber(
    stsLearningAcceleration.weather_crypto_walk_forward_stability_multiplier,
  );
  const stsWeatherCryptoWalkForwardReason = plainStrategyToken(
    stsLearningAcceleration.weather_crypto_walk_forward_stability_reason ??
      "Walk-forward stability signal is not yet available.",
  );
  const stsLearningVelocityMultiplier = performanceNumber(
    stsLearningAcceleration.learning_velocity_multiplier,
  );
  const stsExecutionReliability = performanceNumber(
    stsLearningAcceleration.execution_reliability_score,
  );
  const stsSportsReason = plainStrategyToken(stsLearningAcceleration.sports_reason ?? "");
  const stsSportsBlockReason = plainStrategyToken(
    stsLearningAcceleration.weather_crypto_sports_block_reason ??
      stsLearningAcceleration.weather_crypto_reallocation_guard_reason ??
      stsSportsReason ??
      "No sports hold reason recorded.",
  );
  const stsSportsBlocked = Boolean(stsLearningAcceleration.sports_blocked);
  const stsSportsRouteHold = performanceNumber(stsLearningAcceleration.sports_control_weight);
  const stsSportsStatus =
    stsSportsBlocked ||
    (stsSportsRouteHold != null &&
      Number.isFinite(stsSportsRouteHold) &&
      stsSportsRouteHold <= 0.01)
      ? "Halted"
      : "Unblocked";
  const stsWeatherCryptoBoostMetric =
    stsWeatherCryptoBoost == null || !Number.isFinite(stsWeatherCryptoBoost)
      ? "n/a"
      : `${stsWeatherCryptoBoost.toFixed(2)}x`;
  const stsWeatherCryptoRouteHold =
    stsSportsStatus === "Halted" ? "route hold active" : "route pressure available";
  const stsStochasticDecayFactor = performanceNumber(
    stsLearningAcceleration.weather_crypto_decay_factor,
  );
  const stsWeatherDecayFactor = performanceNumber(
    stsLearningAcceleration.weather_crypto_decay_factor_weather,
  );
  const stsCryptoDecayFactor = performanceNumber(
    stsLearningAcceleration.weather_crypto_decay_factor_crypto,
  );
  const stsWeatherRecentEdge = performanceNumber(
    stsLearningAcceleration.weather_crypto_recent_edge_weather,
  );
  const stsCryptoRecentEdge = performanceNumber(
    stsLearningAcceleration.weather_crypto_recent_edge_crypto,
  );
  const stsCryptoExecutionRealismMultiplier = performanceNumber(
    stsLearningAcceleration.crypto_execution_realism_multiplier,
  );
  const stsLearningCryptoExecutionRealism =
    typeof stsLearningAcceleration.crypto_execution_realism === "object" &&
    stsLearningAcceleration.crypto_execution_realism !== null &&
    !Array.isArray(stsLearningAcceleration.crypto_execution_realism)
      ? (stsLearningAcceleration.crypto_execution_realism as Record<string, unknown>)
      : {};
  const stsCryptoExecutionPressure = plainStrategyToken(
    stsLearningCryptoExecutionRealism.execution_pressure ?? "",
  );
  const stsCryptoExecutionReason =
    typeof stsLearningCryptoExecutionRealism.reason === "string"
      ? stsLearningCryptoExecutionRealism.reason
      : "";
  const stsCalibrationReason =
    typeof stsLearningAcceleration.weather_crypto_calibration_reason === "string"
      ? String(stsLearningAcceleration.weather_crypto_calibration_reason)
      : "";
  const stsStochasticRecentEdge = performanceNumber(
    stsLearningAcceleration.weather_crypto_recent_edge,
  );
  const stsStochasticProcessPolicy =
    typeof stsLearningAcceleration.stochastic_process_policy === "object" &&
    stsLearningAcceleration.stochastic_process_policy !== null &&
    !Array.isArray(stsLearningAcceleration.stochastic_process_policy)
      ? (stsLearningAcceleration.stochastic_process_policy as Record<string, unknown>)
      : {};
  const stsStochasticProcessDownsides = Array.isArray(stsStochasticProcessPolicy.downsides)
    ? stsStochasticProcessPolicy.downsides
    : [];
  const stsWeatherRegimeDecay =
    stsLearningAcceleration.weather_crypto_regime_decay_weather &&
    typeof stsLearningAcceleration.weather_crypto_regime_decay_weather === "object"
      ? (stsLearningAcceleration.weather_crypto_regime_decay_weather as Record<string, unknown>)
      : {};
  const stsCryptoRegimeDecay =
    stsLearningAcceleration.weather_crypto_regime_decay_crypto &&
    typeof stsLearningAcceleration.weather_crypto_regime_decay_crypto === "object"
      ? (stsLearningAcceleration.weather_crypto_regime_decay_crypto as Record<string, unknown>)
      : {};
  const stsRegimeDecayByDomain = [
    ...Object.entries(stsWeatherRegimeDecay),
    ...Object.entries(stsCryptoRegimeDecay),
  ]
    .filter((entry): entry is [string, Record<string, unknown>] => {
      if (entry[1] == null || typeof entry[1] !== "object") {
        return false;
      }
      return "decay_factor" in entry[1];
    })
    .toSorted((a, b) => {
      const aDecay = performanceNumber((a[1] as { decay_factor?: unknown }).decay_factor) ?? 1;
      const bDecay = performanceNumber((b[1] as { decay_factor?: unknown }).decay_factor) ?? 1;
      return aDecay - bDecay;
    });
  const stsRegimeDecayBest = stsRegimeDecayByDomain[0];
  const stsRegimeDecayWorst = stsRegimeDecayByDomain[stsRegimeDecayByDomain.length - 1];
  const stsRegimeDecayCount = stsRegimeDecayByDomain.length;
  const stsRegimeDecayRows = stsRegimeDecayByDomain.slice(0, 10).map(
    ([regime_key, values]) =>
      ({
        regime_key,
        decay_factor: performanceNumber((values as { decay_factor?: unknown }).decay_factor),
        late_edge: performanceNumber((values as { late_edge?: unknown }).late_edge),
        reason: String(
          (values as { reason?: unknown }).reason ?? "No regime-specific reason logged.",
        ),
      }) as const,
  );
  const stsStochasticReason = String(
    stsLearningAcceleration.stochastic_decay_reason ??
      stsStochasticProcessDownsides[0] ??
      "Time-window decay guard is unavailable.",
  );
  const stsModelHealth = supremeTradingStrategy.model_health ?? {};
  const stsDataHealth = supremeTradingStrategy.data_health ?? {};
  const stsFeatureSummary =
    typeof stsDataHealth.feature_rows_summary === "object" &&
    stsDataHealth.feature_rows_summary !== null &&
    !Array.isArray(stsDataHealth.feature_rows_summary)
      ? (stsDataHealth.feature_rows_summary as Record<string, unknown>)
      : {};
  const stsDomainDiagnostics = Array.isArray(stsDataHealth.domain_diagnostics)
    ? (stsDataHealth.domain_diagnostics as Array<Record<string, unknown>>).slice(0, 4)
    : [];
  const stsSegmentDiagnostics = Array.isArray(stsDataHealth.segment_diagnostics)
    ? (stsDataHealth.segment_diagnostics as Array<Record<string, unknown>>).slice(0, 8)
    : [];
  const stsTimeWindowDiagnostics = Array.isArray(stsDataHealth.time_window_diagnostics)
    ? (stsDataHealth.time_window_diagnostics as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const stsRegimeDiagnostics = Array.isArray(stsDataHealth.regime_diagnostics)
    ? (stsDataHealth.regime_diagnostics as Array<Record<string, unknown>>).slice(0, 5)
    : [];
  const stsConfidence = performanceNumber(supremeTradingStrategy.confidence_score);
  const stsStatus = supremeTradingStrategy.status ?? "blocked";
  const stsTone: "ok" | "warn" | "danger" =
    supremeTradingStrategy.live_order_allowed === true
      ? "danger"
      : stsStatus === "validated_shadow_overlay"
        ? "ok"
        : stsStatus === "blocked" || stsStatus === "degraded"
          ? "warn"
          : "ok";
  const topMarkovMarket = markovMarkets[0];
  const topMarkovMakerEdge = markovBestMakerEdge(topMarkovMarket);
  const topMarkovTakerEdge = markovWorstTakerEdge(topMarkovMarket);
  const topMarkovConfidence =
    topMarkovMarket?.confidence_score ?? markovSummary.best_confidence_score;
  const cryptoReadinessStatus = cryptoEvidence.crypto_readiness_status;
  const cryptoReadinessLabel =
    cryptoReadinessStatus === "scheduled"
      ? "Scheduled"
      : cryptoReadinessStatus === "check_due_now"
        ? "Check due now"
        : cryptoReadinessStatus === "unavailable"
          ? "Unavailable"
          : "Unknown";
  const learningVelocity = snapshot?.learning_velocity ?? {};
  const plainStatus = snapshot?.plain_english_status ?? {};
  const opportunityEngine = snapshot?.opportunity_engine ?? {};
  const opportunityMetrics = opportunityEngine.metrics ?? {};
  const opportunityRepair = snapshot?.opportunity_repair ?? {};
  const opportunityRepairs = opportunityRepair.repair_records?.slice(0, 6) ?? [];
  const opportunities = opportunityEngine.opportunities?.slice(0, 6) ?? [];
  const opportunityExperiments = opportunityEngine.experiments?.slice(0, 8) ?? [];
  const strategyGovernor = snapshot?.strategy_governor ?? {};
  const governorActionCounts = Object.entries(strategyGovernor.action_counts ?? {}).toSorted(
    ([left], [right]) => left.localeCompare(right),
  );
  const governorLatest = strategyGovernor.latest_change ?? {};
  const governorActive = strategyGovernor.top_active_hypothesis ?? {};
  const governorBlocked = strategyGovernor.top_blocked_losing_lane ?? {};
  const rapidLearning = volume.rapid_learning_plan ?? {};
  const rapidProfile = rapidLearning.next_cycle_profile ?? {};
  const rapidTargets = rapidLearning.evidence_targets ?? {};
  const rapidEfficiency = rapidLearning.read_efficiency ?? {};
  const rapidProofRules = rapidLearning.proof_rules ?? {};
  const rapidBottlenecks = rapidLearning.bottlenecks?.slice(0, 5) ?? [];
  const rapidDomainTargets = rapidLearning.domain_targets?.slice(0, 7) ?? [];
  const resolvedAcceptedOutcomes = volumeMetrics.resolved_outcomes ?? distance.resolved_outcomes;
  const resolvedOutcomesTarget = rapidTargets.minimum_resolved_outcomes ?? 30;
  const resolvedAcceptedNeeded = Math.max(
    0,
    (resolvedOutcomesTarget ?? 0) - (resolvedAcceptedOutcomes ?? 0),
  );
  const scoreSummary = scorecard.summary ?? {};
  const stsLearningVelocityResolvedLast1h = performanceNumber(learningVelocity.resolved_last_1h);
  const stsLearningVelocityShadowLast1h = performanceNumber(
    learningVelocity.shadow_resolved_last_1h,
  );
  const stsLearningVelocityShadowLabel = stsLearningVelocityShadowLast1h != null ? "incl." : "no";
  const stsLearningVelocityDelta =
    stsLearningVelocityMultiplier != null ? stsLearningVelocityMultiplier - 1 : null;
  const stsLearningVelocityLabel =
    stsLearningVelocityMultiplier != null
      ? `x${stsLearningVelocityMultiplier.toFixed(2)}`
      : "x1.00";
  const stsLearningVelocityNote =
    stsLearningVelocityResolvedLast1h != null || stsLearningVelocityShadowLast1h != null
      ? `${fmt(stsLearningVelocityResolvedLast1h ?? 0)} accepted + ${fmt(stsLearningVelocityShadowLast1h ?? 0)} shadow outcomes this hour; ${stsLearningVelocityDelta == null || stsLearningVelocityDelta === 0 ? "neutral" : stsLearningVelocityDelta > 0 ? `+${(stsLearningVelocityDelta * 100).toFixed(0)}%` : `-${(Math.abs(stsLearningVelocityDelta) * 100).toFixed(0)}%`} speed`
      : "Learning-velocity data is still collecting.";
  const stsLearningVelocityTone: "ok" | "warn" | "danger" =
    stsLearningVelocityMultiplier == null
      ? "warn"
      : stsLearningVelocityMultiplier > 1
        ? "ok"
        : stsLearningVelocityMultiplier < 1
          ? "warn"
          : "warn";
  const stsSportsRowMultiplier = performanceNumber(
    stsLearningAcceleration.weather_crypto_sports_row_multiplier,
  );
  const stsSportsMultTone: "ok" | "warn" | "danger" =
    stsSportsRowMultiplier == null ? "warn" : stsSportsRowMultiplier > 0.01 ? "ok" : "danger";
  const standardShadowControlCount =
    scoreSummary.standard_shadow_control_categories ??
    profitFirewall.blocked_current_side_categories?.length ??
    0;
  const activePausedSegments =
    scoreSummary.active_paused_segments ?? scoreSummary.paused_segments ?? 0;
  const trendPoints = scorecard.trend?.points ?? [];
  const pnlSelection = selectedPnl(
    trendPoints,
    props.pnlTimeframe,
    metrics.realized_paper_pnl_all_time_usd,
  );
  const performanceSelection = selectedPerformance(metrics, props.pnlTimeframe, pnlSelection);
  const selectedPerformanceLabel = performanceSelection.label ?? pnlSelection.label;
  const selectedPerformanceScored = performanceScored(performanceSelection, pnlSelection.scored);
  const selectedPerformancePnl = performanceNumber(performanceSelection.net_pnl_usd);
  const categoryAccuracy = performanceSelection.category_accuracy ?? [];
  const categoryMap = categoryAccuracyByName(categoryAccuracy);
  const scoreSegments = scorecard.segments?.slice(0, 10) ?? [];
  const readableScoreSegments = scoreSegments.filter((segment) => !hideStrategyHealthRow(segment));
  const visibleScoreSegments = readableScoreSegments.slice(0, 6);
  const noEvidenceHiddenCount = scoreSegments.length - readableScoreSegments.length;
  const extraScoredHiddenCount = Math.max(
    0,
    readableScoreSegments.length - visibleScoreSegments.length,
  );
  const learningMap = scorecard.learning_map ?? {};
  const lessonsLearned = scorecard.lessons_learned?.slice(0, 6) ?? [];
  const improvementSummary = scorecard.improvement_summary ?? {};
  const domainPerformance = learningMap.domain_performance?.slice(0, 8) ?? [];
  const live = snapshot?.live_readiness ?? {};
  const scheduler = accelerator.scheduler ?? {};
  const weather = accelerator.weather_lane ?? {};
  const weatherExpansion = weather.weather_expansion ?? {};
  const weatherTradeReadyCities =
    weatherExpansion.active_trade_ready_cities ?? weatherExpansion.covered_cities ?? [];
  const weatherWaitingCities =
    weatherExpansion.cities_waiting_for_active_markets ??
    weatherExpansion.watchlist_cities_without_trade_ready_markets ??
    [];
  const weatherParserGapCities = weatherExpansion.cities_needing_parser_or_model_work ?? [];
  const topAction = snapshot?.top_action ?? {};
  const auditTablePages = props.auditTablePages ?? {};
  const auditTableQueries = props.auditTableQueries ?? {};
  const auditPages = snapshot?.audit_pages ?? {};
  const pending = snapshot?.pending_paper_trades ?? {};
  const pendingMeta = auditPages.pending;
  const pendingTradesAll = (pending.trades ?? []) as Array<Record<string, unknown>>;
  const pendingQuery = auditTableQueries.pending ?? "";
  const pendingTradesFiltered = pendingMeta?.server_sliced
    ? pendingTradesAll
    : filterAuditRows(pendingTradesAll, pendingQuery);
  const pendingWindow = auditWindowFromMeta(
    pendingMeta,
    auditWindow(pendingTradesFiltered.length, auditTablePages.pending),
  );
  const pendingTrades = pendingMeta?.server_sliced
    ? pendingTradesFiltered
    : pendingTradesFiltered.slice(pendingWindow.start, pendingWindow.end);
  const pendingTradesHidden = Math.max(
    0,
    auditNumber(pendingMeta?.filtered_rows, pendingTradesFiltered.length) - pendingTrades.length,
  );
  const overdueMeta = auditPages.overdue;
  const overduePendingTradesAll = (pending.overdue_trades ?? []) as Array<Record<string, unknown>>;
  const overdueQuery = auditTableQueries.overdue ?? "";
  const overduePendingTradesFiltered = overdueMeta?.server_sliced
    ? overduePendingTradesAll
    : filterAuditRows(overduePendingTradesAll, overdueQuery);
  const overdueWindow = auditWindowFromMeta(
    overdueMeta,
    auditWindow(overduePendingTradesFiltered.length, auditTablePages.overdue),
  );
  const overduePendingTrades = overdueMeta?.server_sliced
    ? overduePendingTradesFiltered
    : overduePendingTradesFiltered.slice(overdueWindow.start, overdueWindow.end);
  const overduePendingTradesHidden = Math.max(
    0,
    auditNumber(overdueMeta?.filtered_rows, overduePendingTradesFiltered.length) -
      overduePendingTrades.length,
  );
  const recent = snapshot?.recent_paper_bets ?? {};
  const recentMeta = auditPages.recent;
  const recentTradesAll = (recent.trades ?? []) as Array<Record<string, unknown>>;
  const recentQuery = auditTableQueries.recent ?? "";
  const recentTradesFiltered = recentMeta?.server_sliced
    ? recentTradesAll
    : filterAuditRows(recentTradesAll, recentQuery);
  const recentWindow = auditWindowFromMeta(
    recentMeta,
    auditWindow(recentTradesFiltered.length, auditTablePages.recent),
  );
  const recentTrades = recentMeta?.server_sliced
    ? recentTradesFiltered
    : recentTradesFiltered.slice(recentWindow.start, recentWindow.end);
  const recentTradesHidden = Math.max(
    0,
    auditNumber(recentMeta?.filtered_rows, recentTradesFiltered.length) - recentTrades.length,
  );
  const resolvedMeta = auditPages.resolved;
  const recentResolvedTradesAll = (recent.latest_resolved_trades ?? []) as Array<
    Record<string, unknown>
  >;
  const resolvedQuery = auditTableQueries.resolved ?? "";
  const recentResolvedTradesFiltered = resolvedMeta?.server_sliced
    ? recentResolvedTradesAll
    : filterAuditRows(recentResolvedTradesAll, resolvedQuery);
  const resolvedWindow = auditWindowFromMeta(
    resolvedMeta,
    auditWindow(recentResolvedTradesFiltered.length, auditTablePages.resolved),
  );
  const recentResolvedTrades = resolvedMeta?.server_sliced
    ? recentResolvedTradesFiltered
    : recentResolvedTradesFiltered.slice(resolvedWindow.start, resolvedWindow.end);
  const recentResolvedTradesHidden = Math.max(
    0,
    auditNumber(resolvedMeta?.filtered_rows, recentResolvedTradesFiltered.length) -
      recentResolvedTrades.length,
  );
  const rankedActions = accelerator.ranked_actions?.slice(0, 6) ?? [];
  const volumeActions = volume.ranked_actions?.slice(0, 5) ?? [];
  const reasons = Object.entries(decisionQuality.top_no_trade_or_rejection_reasons ?? {});
  const total = decisionQuality.total ?? paper.total_decisions ?? 0;
  const accepted = paper.accepted ?? decisionQuality.accepted ?? 0;
  const newlyScored1h = metrics.scored_decisions_last_1h ?? 0;
  const highSpeedLearning = learningVelocity.status === "HIGH_SPEED_LEARNING";
  const recentLearning1h =
    learningVelocity.resolved_last_1h ?? volumeMetrics.learning_resolved_last_1h ?? newlyScored1h;
  const acceptedProofAgeMinutes =
    learningVelocity.latest_accepted_proof_age_minutes ??
    volumeMetrics.latest_scored_outcome_age_minutes;
  const acceptedProofAgeLabel = formatAgeMinutes(acceptedProofAgeMinutes);
  const explorationTrades =
    metrics.exploration_paper_decisions ?? paper.exploration ?? decisionQuality.exploration ?? 0;
  const forwardPaperTrades =
    metrics.forward_paper_decisions ?? paper.forward_paper ?? decisionQuality.forward_paper ?? 0;
  const externalFairValues = Object.entries(metrics.fair_value_source_performance ?? {}).reduce(
    (count, [source, summary]) => {
      if (source === "market_implied_baseline" || source === "unknown") {
        return count;
      }
      return count + (summary?.decisions ?? summary?.scored ?? 0);
    },
    0,
  );
  const readiness = live.readiness ?? "UNKNOWN";
  const generatedAt =
    typeof snapshot?.generated_at_utc === "string" && snapshot.generated_at_utc
      ? formatTradeTime(snapshot.generated_at_utc, props.timezone)
      : "n/a";
  const refreshStatus = snapshot?.dashboard_refresh;
  const refreshLabel = refreshStatus?.in_progress
    ? "Snapshot updating in background"
    : refreshStatus?.stale
      ? "Snapshot queued for refresh"
      : "Snapshot current";
  const refreshAge = formatAgeMs(refreshStatus?.age_ms);
  const nextBestMove =
    rapidBottlenecks[0]?.fix ??
    topAction.implementation_hint ??
    rankedActions[0]?.implementation_hint ??
    volumeMetrics.what_must_happen_next_to_learn_faster ??
    improvementSummary.what_needs_to_happen_next?.[0] ??
    "Keep collecting clean, scoreable paper evidence and rerun outcome grading before expanding accepted paper volume.";
  const nextBestMovePlain = plainLearningText(nextBestMove);
  const liveTradingOff = live.live_order_allowed !== true && live.live_trading_enabled !== true;
  const proofIsStale = typeof acceptedProofAgeMinutes !== "number" || acceptedProofAgeMinutes > 60;
  const todayStatus = {
    note: liveTradingOff
      ? "No live orders can be placed here. This is paper learning only."
      : "Pause and review live-trading settings before trusting this dashboard.",
    tone: liveTradingOff ? "ok" : "danger",
    value: liveTradingOff ? "Live trading is off" : "Check live trading",
  } as const;
  const learningStatus = {
    note: highSpeedLearning
      ? `${fmt(recentLearning1h)} practice-only result${recentLearning1h === 1 ? "" : "s"} landed in the last hour.`
      : recentLearning1h > 0
        ? `${fmt(recentLearning1h)} learning result${recentLearning1h === 1 ? "" : "s"} landed in the last hour.`
        : "No fresh learning result landed in the last hour.",
    tone: highSpeedLearning || recentLearning1h > 0 ? "ok" : "warn",
    value: highSpeedLearning
      ? "Learning fast"
      : recentLearning1h > 0
        ? "Learning"
        : "Learning is quiet",
  } as const;
  const profitProofStatus = {
    note: proofIsStale
      ? `Newest accepted-paper proof is ${acceptedProofAgeLabel}. Need 100 fresh profitable forward-paper outcomes before live review.`
      : "Fresh accepted-paper proof exists, but live review still requires profitable baseline-beating evidence.",
    tone:
      selectedPerformancePnl == null || selectedPerformancePnl < 0 || proofIsStale ? "warn" : "ok",
    value: proofIsStale ? "Profit proof is stale" : "Profit proof updated",
  } as const;
  const nextActionStatus = {
    note: "This changes paper learning only. Live trading remains off.",
    tone: "ok",
    value: nextBestMovePlain,
  } as const;
  const routingStatusTone = stsSportsStatus === "Halted" ? "danger" : "warn";
  const routingMultiplierLabel =
    stsWeatherCryptoBoost == null
      ? "n/a"
      : `${stsWeatherCryptoBoost.toFixed(2)}x (${stsLearningAccelerationEnabled ? "learning-enabled" : "learning-disabled"})`;
  const routingMultiplierLift = weatherCryptoBoostToPercent(stsWeatherCryptoBoost, 2);
  const routingMultiplierNote =
    stsWeatherCryptoBoost == null || !Number.isFinite(stsWeatherCryptoBoost)
      ? "No active Weather/Crypto route lift is available yet."
      : `Weather/Crypto lift ${routingMultiplierLift} vs neutral routing, sports hold ${stsSportsStatus.toLowerCase()}.`;
  const weatherCryptoBoostActive =
    stsWeatherCryptoBoost != null &&
    Number.isFinite(stsWeatherCryptoBoost) &&
    stsWeatherCryptoBoost > 1.0;
  const weatherCryptoBoostTone: "ok" | "warn" | "danger" = weatherCryptoBoostActive ? "ok" : "warn";
  const weatherTradeReadyCount =
    weather.latest_run_trade_ready ??
    weather.latest_discovery_trade_ready ??
    weatherTradeReadyCities.length;
  const cryptoCreatedCount = cryptoEvidence.created_count ?? 0;
  const recentChanges = [
    `Updated ${generatedAt}`,
    `${fmt(recentLearning1h)} new learning result${recentLearning1h === 1 ? "" : "s"}`,
    `Weather: ${fmt(weatherTradeReadyCount)} trade-ready practice candidate${weatherTradeReadyCount === 1 ? "" : "s"}`,
    `Crypto: ${fmt(cryptoCreatedCount)} practice candidate${cryptoCreatedCount === 1 ? "" : "s"}`,
    proofIsStale ? "No new profit proof yet" : "Profit proof refreshed",
  ];
  const weatherLane = categoryMap.get("weather");
  const cryptoLane = categoryMap.get("crypto");
  const sportsLane = categoryMap.get("sports");

  return html`
    <div class="kalshi-page">
      <section class="kalshi-hero kalshi-hero--${readiness === "READY" ? "ready" : "blocked"}">
        <div>
          <p class="kalshi-mission-label">Today</p>
          <p class="eyebrow">Prediction Market Paper Trading</p>
          <h2>Kalshi Paper Trading</h2>
          <p class="muted">
            ${plainStatus.headline ??
            "A simple read-only view of STS paper-readiness ETAs, safety, learning, profit proof, and the next paper-only step."}
          </p>
        </div>
        <span
          class="kalshi-live-pill ${liveTradingOff
            ? "kalshi-live-pill--safe"
            : "kalshi-live-pill--danger"}"
        >
          ${todayStatus.value}
        </span>
        <button
          class="btn btn--secondary"
          aria-label="Refresh Kalshi dashboard"
          ?disabled=${props.loading}
          @click=${props.onRefresh}
        >
          ${props.loading ? "Refreshing..." : "Refresh"}
        </button>
      </section>

      ${props.error ? html`<div class="alert danger">${props.error}</div>` : nothing}
      <section class="kalshi-routing-strip" aria-label="STS routing controls">
        <div>
          <p class="kalshi-overline">Routing gate you can test now</p>
          <h3>
            ${stsSportsStatus === "Halted"
              ? "STS sports hold is active"
              : "STS sports routing is currently available"}.
          </h3>
          <p class="kalshi-section-intro">${routingMultiplierNote}</p>
        </div>
        <div class="kalshi-grid kalshi-grid--three">
          ${metricCard(
            "Weather/Crypto ML Boost",
            routingMultiplierLabel,
            `Live boost: ${routingMultiplierLift}. Sports hold: ${stsSportsStatus.toLowerCase()}.`,
            weatherCryptoBoostTone,
          )}
          ${metricCard(
            "Calibration Gate",
            stsWeatherCryptoCalibrationFactor == null
              ? "n/a"
              : `${stsWeatherCryptoCalibrationFactor.toFixed(2)}x`,
            stsCalibrationReason ||
              "Calibration gate computed from STS ECE and caps route uplift when confidence is weak.",
            stsWeatherCryptoCalibrationFactor != null && stsWeatherCryptoCalibrationFactor >= 0.9
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Learning Reallocation",
            stsWeatherCryptoReallocation == null
              ? "1.00x"
              : `${stsWeatherCryptoReallocation.toFixed(2)}x`,
            stsWeatherCryptoReallocationReason || "No traffic reallocation is active.",
            stsWeatherCryptoReallocation != null && stsWeatherCryptoReallocation > 1.0
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Stochastic Process Lift",
            stsWeatherCryptoStochasticMultiplier == null
              ? "1.00x"
              : `${stsWeatherCryptoStochasticMultiplier.toFixed(2)}x`,
            stsWeatherCryptoStochasticReason ||
              "Stochastic diagnostics currently do not alter routing.",
            stsWeatherCryptoStochasticMultiplier != null &&
              stsWeatherCryptoStochasticMultiplier < 0.95
              ? "warn"
              : "ok",
          )}
          ${metricCard(
            "Walk-Forward Stability Lift",
            stsWeatherCryptoWalkForwardMultiplier == null
              ? "1.00x"
              : `${stsWeatherCryptoWalkForwardMultiplier.toFixed(2)}x`,
            stsWeatherCryptoWalkForwardReason ||
              "Walk-forward stability lift is not currently available.",
            stsWeatherCryptoWalkForwardMultiplier != null &&
              stsWeatherCryptoWalkForwardMultiplier < 0.95
              ? "warn"
              : "ok",
          )}
          ${metricCard(
            "Sports Safety Hold",
            `${fmt(stsSportsRouteHold)} hold`,
            stsSportsReason || "Sports routing is being held until cross-domain proof is stable.",
            routingStatusTone,
          )}
          ${metricCard(
            "Sports Execution Reliability",
            stsExecutionReliability == null ? "n/a" : pct(stsExecutionReliability),
            `${stsSportsBlockReason} · Sports hold ${stsSportsStatus.toLowerCase()}.`,
            stsExecutionReliability != null && stsExecutionReliability >= 0.6 ? "ok" : "warn",
          )}
          ${metricCard(
            "Sports Row Multiplier",
            stsSportsRowMultiplier == null ? "n/a" : `x${stsSportsRowMultiplier.toFixed(3)}`,
            stsSportsRowMultiplier == null
              ? "Sports row pressure from learning controls is not yet available."
              : `Sports routing multiplier is ${stsSportsRowMultiplier === 0 ? "halted" : "active"} in the route score.`,
            stsSportsMultTone,
          )}
          ${metricCard(
            "Stochastic Guard",
            pct(
              stsLearningAcceleration.stochastic_decay_reason ? (stsStochasticDecayFactor ?? 1) : 1,
            ),
            stsStochasticReason,
            stsStochasticDecayFactor != null && stsStochasticDecayFactor < 1 ? "warn" : "ok",
          )}
        </div>
      </section>
      <section
        class="kalshi-panel kalshi-panel--command kalshi-sts-command"
        aria-label="STS Domain Learning Command Center"
      >
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">
              STS Domain Learning Command Center${metricHelp("Supreme Trading Strategy")}
            </p>
            <h3>Domain-first learning, paper ETA, and live-review readiness.</h3>
            <p class="kalshi-section-intro">
              ${String(
                stsReadinessEta.plain_english ??
                  "Waiting means there is no defensible real-data rate yet; no dates are invented.",
              )}
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Paper only</span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          ${metricCard(
            "Best domain to improve next",
            plainStrategyToken(
              stsTopUnlockAction.domain ?? stsDomainOptimizerBest.domain ?? "unknown",
            ),
            String(
              stsTopUnlockAction.implementation_action ??
                stsDomainOptimizerBest.recommended_fix ??
                stsDomainLearningOptimizer.next_action ??
                "Run domain optimizer.",
            ),
            "warn",
          )}
          ${metricCard(
            "Future market categories separated",
            "Yes",
            "New domains automatically get their own STS learning lane.",
            "ok",
          )}
          ${metricCard(
            "Overall Route Mix",
            paperTradeRouteMixOverallSummary,
            `Totals: SHADOW ${fmt(paperTradeRouteMixOverall.SHADOW_ONLY || 0)} · EXPLORE ${fmt(paperTradeRouteMixOverall.ACCEPT_EXPLORATION || 0)} · PAPER ${fmt(paperTradeRouteMixOverall.ACCEPT_PAPER || 0)} · FORWARD ${fmt(paperTradeRouteMixOverall.FORWARD_PAPER || 0)}`,
            paperTradeRouteMixOverallTotal.length > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Weather / Crypto Route Mix",
            paperTradeRouteMixWeatherCryptoSummary,
            `Totals: EXPLORE ${fmt(paperTradeRouteMixWeatherCrypto.ACCEPT_EXPLORATION || 0)} · PAPER ${fmt(paperTradeRouteMixWeatherCrypto.ACCEPT_PAPER || 0)} · FORWARD ${fmt(paperTradeRouteMixWeatherCrypto.FORWARD_PAPER || 0)} · SHADOW ${fmt(paperTradeRouteMixWeatherCrypto.SHADOW_ONLY || 0)}`,
            paperTradeRouteMixWeatherCryptoTotal.length > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Weather selector repair",
            `${fmt(performanceNumber(stsWeatherSelectorRepair.selector_pass_count))} pass`,
            String(stsWeatherSelectorRepair.next_action ?? "Run weather selector repair."),
            performanceNumber(stsWeatherSelectorRepair.selector_pass_count) ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto evidence repair",
            `${fmt(performanceNumber(stsCryptoEvidenceRepair.fresh_clean_count))} fresh clean`,
            `${plainStrategyToken(stsCryptoEvidenceRepair.top_clean_evidence_blocker ?? "unknown")} · ${String(stsCryptoEvidenceRepair.next_action ?? "Run crypto evidence repair.")}`,
            performanceNumber(stsCryptoEvidenceRepair.fresh_clean_count) ? "ok" : "warn",
          )}
          ${metricCard(
            "Fresh crypto promotion blocker",
            plainStrategyToken(stsCryptoFreshWindowDiagnostics.top_blocker ?? "unknown"),
            `${fmt(performanceNumber(stsCryptoFreshWindowDiagnostics.clean_but_baseline_blocked_count))} clean-baseline blocked · ${fmt(performanceNumber(stsCryptoFreshWindowDiagnostics.clean_but_markov_blocked_count))} Markov blocked`,
            performanceNumber(stsCryptoFreshWindowDiagnostics.fresh_promotion_allowed_count)
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Crypto baseline calibration",
            plainStrategyToken(stsCryptoBaselineCalibration.status ?? "missing"),
            `uplift ${fmt(performanceNumber(stsCryptoBaselineCalibration.candidate_brier_uplift_vs_market))} · rows ${fmt(performanceNumber(stsCryptoBaselineCalibration.evaluated_crypto_rows))}`,
            stsCryptoBaselineCalibration.beats_market_baseline === true ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto probability recalibrator",
            plainStrategyToken(stsCryptoProbabilityRecalibrator.status ?? "missing"),
            `raw uplift ${fmt(performanceNumber(stsCryptoProbabilityRecalibrator.recalibrated_uplift_vs_raw))} · market uplift ${fmt(performanceNumber(stsCryptoProbabilityRecalibrator.recalibrated_uplift_vs_market))}`,
            stsCryptoProbabilityRecalibrator.improves_raw_candidate === true ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto segment edge",
            `${fmt(performanceNumber(stsCryptoSegmentEdge.market_beating_segment_count))} market-beating`,
            `${plainStrategyToken(stsCryptoSegmentEdge.status ?? "missing")} · ${fmt(performanceNumber(stsCryptoSegmentEdge.segment_count))} segments`,
            performanceNumber(stsCryptoSegmentEdge.market_beating_segment_count) ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto execution realism",
            `${fmt(performanceNumber(stsCryptoExecutionRealism.executable_shadow_edge_count))} executable`,
            `${plainStrategyToken(stsCryptoExecutionRealism.status ?? "missing")} · P&L + liquidity required`,
            performanceNumber(stsCryptoExecutionRealism.executable_shadow_edge_count)
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Execution-aware selector",
            `${fmt(performanceNumber(stsCryptoExecutionSelector.candidate_experiment_count))} shadow`,
            `${plainStrategyToken(stsCryptoExecutionSelector.status ?? "missing")} · no proof credit`,
            performanceNumber(stsCryptoExecutionSelector.candidate_experiment_count)
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Estimated time to STS paper trading",
            String(stsPaperTradingEta.eta_label ?? "Blocked — no defensible ETA"),
            `${plainStrategyToken(stsPaperTradingEta.top_blocker ?? "no real-data ETA yet")} · confidence ${plainStrategyToken(stsPaperTradingEta.confidence ?? "low")}`,
            stsPaperTradingEta.status === "ready" ? "ok" : "warn",
          )}
          ${metricCard(
            "Weather STS paper ETA",
            String(stsWeatherPaperEta.eta_label ?? "No data"),
            `${plainStrategyToken(stsWeatherPaperEta.top_blocker ?? "no weather scan")} · ${fmt(performanceNumber((stsWeatherPaperEta.real_data_basis as Record<string, unknown> | undefined)?.scanned_candidate_count))} scanned`,
            stsWeatherPaperEta.status === "ready" ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto STS paper ETA",
            String(stsCryptoPaperEta.eta_label ?? "No data"),
            `${plainStrategyToken(stsCryptoPaperEta.top_blocker ?? "no crypto scan")} · ${fmt(performanceNumber((stsCryptoPaperEta.real_data_basis as Record<string, unknown> | undefined)?.scanned_candidate_count))} scanned`,
            stsCryptoPaperEta.status === "ready" ? "ok" : "warn",
          )}
          ${metricCard(
            "Estimated time to live review",
            String(stsLiveReviewEta.eta_label ?? "Waiting"),
            `${plainStrategyToken(stsLiveReviewEta.top_blocker ?? "no accepted-forward proof rate")} · confidence ${plainStrategyToken(stsLiveReviewEta.confidence ?? "low")}`,
            stsLiveReviewEta.status === "review_ready" ? "ok" : "warn",
          )}
        </div>
        <div class="kalshi-promotion-gap">
          <div class="kalshi-promotion-gap__summary">
            <span
              ><b>${fmt(performanceNumber(stsPaperTradingEta.current_score))}/100</b> paper
              progress</span
            >
            <span
              ><b>${fmt(performanceNumber(stsLiveReviewEta.current_score))}/100</b> live-review
              progress</span
            >
            <span
              ><b
                >${fmt(
                  performanceNumber(stsPaperEtaBasis.weather_crypto_scanned_count) ??
                    performanceNumber(stsPaperEtaBasis.scanned_candidate_count),
                )}</b
              >
              Weather/Crypto scanned</span
            >
            <span
              ><b
                >${fmt(performanceNumber(stsLiveEtaBasis.scored))}/${fmt(
                  performanceNumber(stsLiveEtaBasis.target_scored),
                )}</b
              >
              proof outcomes</span
            >
          </div>
        </div>
        <details class="kalshi-card" open>
          <summary>Real-data ETA basis</summary>
          <div class="kalshi-promotion-gap__segments">
            <article>
              <b>Paper Trading ETA</b>
              <span
                >${String(stsPaperTradingEta.plain_english ?? "No paper-trading ETA yet.")}</span
              >
              <p>
                Promotion pass rate: ${pct(performanceNumber(stsPaperEtaBasis.promotion_pass_rate))}
                · Weather/Crypto scanned:
                ${fmt(performanceNumber(stsPaperEtaBasis.weather_crypto_scanned_count))} · eligible:
                ${fmt(performanceNumber(stsPaperEtaBasis.eligible_candidate_count))} · promoted:
                ${fmt(performanceNumber(stsPaperEtaBasis.promotion_allowed_count))}
              </p>
            </article>
            <article>
              <b>Categories are separated</b>
              <span
                >STS now reports Weather, Crypto, and every future market category as separate
                learning lanes because their data, settlement mechanics, liquidity, and model errors
                differ.</span
              >
              <p>
                Overall STS paper ETA is the combined gate; domain cards show which category can
                improve first without negative transfer.
              </p>
            </article>
            <article>
              <b>Live Review ETA</b>
              <span>${String(stsLiveReviewEta.plain_english ?? "No live-review ETA yet.")}</span>
              <p>
                Accepted-forward rate:
                ${fmt(performanceNumber(stsLiveEtaBasis.accepted_forward_rate_per_hour))}/h ·
                sample: ${fmt(performanceNumber(stsLiveEtaBasis.accepted_forward_rate_sample_size))}
                · P&L: ${money(performanceNumber(stsLiveEtaBasis.paper_pnl_usd))}
              </p>
            </article>
          </div>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS ETA blockers">
            ${stsPaperEtaBlockers.map(
              (blocker) => html`
                <span
                  >${plainStrategyToken(blocker.blocker)}
                  <b>${fmt(performanceNumber(blocker.count))}</b></span
                >
              `,
            )}
            ${stsLiveEtaBlockers.map(
              (blocker) => html`<span>${plainStrategyToken(blocker)} <b>live review</b></span>`,
            )}
          </div>
          <div class="kalshi-promotion-gap__segments">
            <article>
              <b>Highest-impact STS unlock</b>
              <span
                >${plainStrategyToken(stsTopUnlockAction.rank_key ?? "unknown")} · score
                ${fmt(performanceNumber(stsTopUnlockAction.priority_score))}</span
              >
              <p>
                ${String(
                  stsTopUnlockAction.why_it_matters ??
                    stsUnlockQueue.plain_english ??
                    "Run kalshi_sts_unlock_queue.py.",
                )}
              </p>
              <p>
                ${String(stsTopUnlockAction.success_metric ?? "Paper-only unlock action pending.")}
              </p>
            </article>
            ${stsUnlockActions.map(
              (action) => html`
                <article>
                  <b
                    >${plainStrategyToken(action.domain)} ·
                    ${plainStrategyToken(action.rank_key)}</b
                  >
                  <span
                    >${String(action.dashboard_label ?? "")} ·
                    ${plainStrategyToken(action.top_blocker)}</span
                  >
                  <p>${String(action.implementation_action ?? "No action available.")}</p>
                </article>
              `,
            )}
            <article>
              <b>Weather baseline/selector repair</b>
              <span
                >${fmt(performanceNumber(stsWeatherSelectorRepair.scanned_weather_count))} scanned ·
                ${fmt(performanceNumber(stsWeatherSelectorRepair.selector_pass_count))} selector
                pass</span
              >
              <p>
                ${String(
                  stsWeatherSelectorRepair.next_action ??
                    "Run kalshi_sts_weather_selector_repair.py.",
                )}
              </p>
              <p>
                ${stsWeatherSelectorBlockers
                  .map(
                    (blocker) =>
                      `${plainStrategyToken(blocker.blocker)} ${fmt(performanceNumber(blocker.count))}`,
                  )
                  .join(" · ")}
              </p>
            </article>
            <article>
              <b>Crypto clean-evidence repair</b>
              <span
                >${fmt(performanceNumber(stsCryptoEvidenceRepair.scanned_crypto_count))} scanned ·
                ${fmt(performanceNumber(stsCryptoEvidenceRepair.fresh_clean_count))} fresh
                clean</span
              >
              <p>
                ${String(
                  stsCryptoEvidenceRepair.next_action ??
                    "Run kalshi_sts_crypto_evidence_repair.py.",
                )}
              </p>
              <p>
                ${stsCryptoEvidenceBlockers
                  .map(
                    (blocker) =>
                      `${plainStrategyToken(blocker.blocker)} ${fmt(performanceNumber(blocker.count))}`,
                  )
                  .join(" · ")}
              </p>
            </article>
            <article>
              <b>Fresh crypto promotion diagnostics</b>
              <span
                >${fmt(performanceNumber(stsCryptoFreshWindowDiagnostics.fresh_candidate_count))}
                fresh candidates ·
                ${fmt(performanceNumber(stsCryptoFreshWindowDiagnostics.positive_edge_count))}
                positive edge</span
              >
              <p>
                ${String(
                  stsCryptoFreshWindowDiagnostics.next_action ??
                    "Run kalshi_sts_crypto_fresh_window_diagnostics.py.",
                )}
              </p>
              <p>
                ${String(
                  stsCryptoFreshWindowDiagnostics.plain_english ??
                    "Fresh-window diagnostics separate stale evidence from live paper-readiness blockers.",
                )}
              </p>
            </article>
            ${stsCryptoFreshWindowCandidates.map(
              (candidate) => html`
                <article>
                  <b>${plainStrategyToken(candidate.market_ticker)}</b>
                  <span
                    >${plainStrategyToken(candidate.window_bucket)} ·
                    ${fmt(performanceNumber(candidate.minutes_until_result))}m · edge
                    ${fmt(performanceNumber(candidate.edge_after_costs_pct))}</span
                  >
                  <p>
                    ${Array.isArray(candidate.blockers)
                      ? candidate.blockers.map((item) => plainStrategyToken(item)).join(" · ")
                      : "No blocker details."}
                  </p>
                </article>
              `,
            )}
            <article>
              <b>Crypto baseline calibration</b>
              <span
                >candidate Brier
                ${fmt(performanceNumber(stsCryptoBaselineCalibration.candidate_brier))} · market
                Brier ${fmt(performanceNumber(stsCryptoBaselineCalibration.market_brier))}</span
              >
              <p>
                ${String(
                  stsCryptoBaselineCalibration.next_action ??
                    "Run kalshi_sts_crypto_baseline_calibration.py.",
                )}
              </p>
              <p>
                ${String(
                  stsCryptoBaselineCalibration.plain_english ??
                    "Crypto baseline calibration decides whether fresh clean crypto candidates can challenge market-implied probability.",
                )}
              </p>
            </article>
            ${stsCryptoCalibrationBuckets.map(
              (bucket) => html`
                <article>
                  <b>Crypto bucket ${String(bucket.bucket ?? "unknown")}</b>
                  <span
                    >${fmt(performanceNumber(bucket.count))} rows · predicted
                    ${pct(performanceNumber(bucket.avg_prediction))} · outcome
                    ${pct(performanceNumber(bucket.outcome_rate))}</span
                  >
                  <p>Calibration error ${fmt(performanceNumber(bucket.calibration_error))}</p>
                </article>
              `,
            )}
            <article>
              <b>Crypto probability recalibrator</b>
              <span
                >test Brier
                ${fmt(performanceNumber(stsCryptoProbabilityRecalibrator.recalibrated_brier_test))}
                vs raw
                ${fmt(
                  performanceNumber(stsCryptoProbabilityRecalibrator.raw_candidate_brier_test),
                )}</span
              >
              <p>
                ${String(
                  stsCryptoProbabilityRecalibrator.next_action ??
                    "Run kalshi_sts_crypto_probability_recalibrator.py.",
                )}
              </p>
              <p>
                ${String(
                  stsCryptoProbabilityRecalibrator.plain_english ??
                    "Recalibrator uses older labeled rows, then tests on later rows to avoid look-ahead leakage.",
                )}
              </p>
            </article>
            ${stsCryptoRecalibrationBuckets.map(
              (bucket) => html`
                <article>
                  <b>Recalibrate ${String(bucket.bucket ?? "unknown")}</b>
                  <span
                    >${fmt(performanceNumber(bucket.count))} train rows ·
                    ${pct(performanceNumber(bucket.avg_prediction))} →
                    ${pct(performanceNumber(bucket.recalibrated_probability))}</span
                  >
                  <p>
                    Adjustment ${fmt(performanceNumber(bucket.adjustment))}; enough rows:
                    ${bucket.enough_rows ? "yes" : "no"}.
                  </p>
                </article>
              `,
            )}
            <article>
              <b>Crypto segment edge</b>
              <span
                >${fmt(performanceNumber(stsCryptoSegmentEdge.market_beating_segment_count))}
                market-beating shadow segments ·
                ${fmt(performanceNumber(stsCryptoSegmentEdge.test_rows))} test rows</span
              >
              <p>
                ${String(
                  stsCryptoSegmentEdge.next_action ?? "Run kalshi_sts_crypto_segment_edge.py.",
                )}
              </p>
            </article>
            ${stsCryptoTopSegments.map(
              (segment) => html`
                <article>
                  <b>${plainStrategyToken(segment.segment_id)}</b>
                  <span
                    >${fmt(performanceNumber(segment.test_rows))} rows · uplift vs market
                    ${fmt(performanceNumber(segment.recalibrated_uplift_vs_market))}</span
                  >
                  <p>
                    Recalibrated Brier ${fmt(performanceNumber(segment.recalibrated_brier))}; market
                    Brier ${fmt(performanceNumber(segment.market_brier))}; shadow only.
                  </p>
                </article>
              `,
            )}
            <article>
              <b>Crypto execution realism</b>
              <span
                >${fmt(performanceNumber(stsCryptoExecutionRealism.executable_shadow_edge_count))}
                executable shadow edges ·
                ${fmt(performanceNumber(stsCryptoExecutionRealism.segment_count))} segments tested ·
                pressure
                ${stsCryptoExecutionPressureFromLearning ||
                (stsCryptoExecutionRealism.execution_pressure as string) ||
                "neutral"}</span
              >
              <p>
                ${fmt(
                  stsCryptoExecutionExecutableRatio != null
                    ? stsCryptoExecutionExecutableRatio * 100
                    : performanceNumber(stsCryptoExecutionRealism.executable_shadow_edge_count) ===
                        0
                      ? 0
                      : Number.NaN,
                )}%
                executable,
                ${fmt(
                  stsCryptoExecutionLiquidityRatio != null
                    ? stsCryptoExecutionLiquidityRatio * 100
                    : performanceNumber(stsCryptoExecutionRealism.executable_shadow_edge_count) ===
                        0
                      ? 0
                      : Number.NaN,
                )}%
                liquidity-validated, multiplier
                x${stsCryptoExecutionRealismMultiplierFromLearning != null
                  ? stsCryptoExecutionRealismMultiplierFromLearning.toFixed(2)
                  : "1.00"}.
              </p>
              <p>
                ${String(
                  stsCryptoExecutionRealism.next_action ??
                    "Run kalshi_sts_crypto_execution_realism.py.",
                )}
              </p>
            </article>
            ${stsCryptoExecutionSegments.map(
              (segment) => html`
                <article>
                  <b>${plainStrategyToken(segment.segment_id)}</b>
                  <span
                    >P&L ${money(performanceNumber(segment.paper_pnl_usd))} ·
                    ${plainStrategyToken(
                      segment.executable_shadow_edge ? "executable shadow edge" : "blocked",
                    )}</span
                  >
                  <p>
                    ${Array.isArray(segment.blockers)
                      ? segment.blockers.map((item) => plainStrategyToken(item)).join(" · ")
                      : "No blockers."}
                  </p>
                </article>
              `,
            )}
            <article>
              <b>Execution-aware selector experiments</b>
              <span
                >${fmt(performanceNumber(stsCryptoExecutionSelector.candidate_experiment_count))}
                active ·
                ${fmt(performanceNumber(stsCryptoExecutionSelector.paused_experiment_count))} paused
                by decay · shadow-only</span
              >
              <p>
                ${String(
                  stsCryptoExecutionSelector.next_action ??
                    "Run kalshi_sts_crypto_execution_selector.py.",
                )}
              </p>
            </article>
            <article>
              <b>Selector outcome attribution</b>
              <span
                >${fmt(
                  performanceNumber(stsCryptoExecutionSelectorOutcomes.resolved_attributed_count),
                )}
                resolved ·
                ${fmt(
                  performanceNumber(
                    stsCryptoExecutionSelectorOutcomes.retrospective_shadow_replay_count,
                  ),
                )}
                replay-matched · no proof credit</span
              >
              <p>
                ${String(
                  stsCryptoExecutionSelectorOutcomes.plain_english ??
                    "Run kalshi_sts_crypto_execution_selector_outcomes.py to attribute shadow outcomes by selector experiment.",
                )}
              </p>
            </article>
            <article>
              <b>Fresh-forward crypto regime selector</b>
              <span
                >${fmt(performanceNumber(stsCryptoRegimeSelector.candidate_experiment_count))}
                regime experiments ·
                ${fmt(performanceNumber(stsCryptoRegimeSelector.paused_forward_regime_count))}
                forward-loss paused ·
                ${fmt(performanceNumber(stsCryptoRegimeSelector.regime_count))} regimes tested ·
                shadow-only</span
              >
              <p>
                ${String(
                  stsCryptoRegimeSelector.next_action ??
                    "Run kalshi_sts_crypto_regime_selector.py.",
                )}
              </p>
            </article>
            <article>
              <b>Regime selector outcome attribution</b>
              <span
                >${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_resolved_count,
                  ),
                )}
                forward-resolved ·
                ${fmt(
                  performanceNumber(stsCryptoRegimeSelectorOutcomes.forward_recorded_pending_count),
                )}
                forward-pending ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_due_pending_count,
                  ),
                )}
                due now ·
                ${fmt(
                  performanceNumber(stsCryptoRegimeSelectorOutcomes.retrospective_resolved_count),
                )}
                replay-resolved · no proof credit</span
              >
              <p>
                ${String(
                  stsCryptoRegimeSelectorOutcomes.resolver_action ??
                    stsCryptoRegimeSelectorOutcomes.plain_english ??
                    "Run kalshi_sts_crypto_regime_selector_outcomes.py.",
                )}
              </p>
            </article>
            <article>
              <b>Coverage probe cohort blocks</b>
              <span
                >${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_coverage_probe_resolved_count,
                  ),
                )}
                resolved ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_coverage_probe_pending_count,
                  ),
                )}
                pending ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_coverage_probe_due_count,
                  ),
                )}
                due · ${fmt(stsCryptoCoverageCohortRows.length)} blocked cohorts</span
              >
              <p>
                Coverage probes are learning-only; failed side/hour cohorts do not receive
                live-readiness credit.
              </p>
            </article>
            <article>
              <b>Inverse repair shadow proof</b>
              <span
                >${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_inverse_repair_shadow_resolved_count,
                  ),
                )}
                resolved ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_inverse_repair_shadow_pending_count,
                  ),
                )}
                pending ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeSelectorOutcomes.forward_recorded_inverse_repair_shadow_due_count,
                  ),
                )}
                due · zero-exposure</span
              >
              <p>
                ${plainStrategyToken(
                  stsCryptoInverseRepairProofGate.status ?? "inverse_repair_shadow_gate_missing",
                )}
                ·
                ${fmt(performanceNumber(stsCryptoInverseRepairProofGate.resolved_count))}/${fmt(
                  performanceNumber(
                    stsCryptoInverseRepairProofGate.target_resolved_shadow_outcomes,
                  ) ?? 10,
                )}
                resolved · P&L
                ${money(performanceNumber(stsCryptoInverseRepairProofGate.paper_pnl_usd))} ·
                accuracy ${pct(performanceNumber(stsCryptoInverseRepairProofGate.accuracy))}
              </p>
              <p>
                ${String(
                  stsCryptoInverseRepairProofGate.next_action ??
                    "Inverse repair shadows test the opposite side without accepted-paper or live-trading credit.",
                )}
              </p>
              <p>
                ${stsCryptoInverseRepairProofBlockers.length
                  ? stsCryptoInverseRepairProofBlockers
                      .map((item) => plainStrategyToken(item))
                      .join(" · ")
                  : "No inverse-repair shadow blockers remain for paper-only follow-up review."}
              </p>
            </article>
            <article>
              <b>Crypto regime inverse/abstain repair</b>
              <span
                >${fmt(performanceNumber(stsCryptoRegimeInverseRepair.repair_count))} regimes
                diagnosed ·
                ${fmt(
                  performanceNumber(
                    stsCryptoRegimeInverseRepair.scanned_forward_regime_outcome_count,
                  ),
                )}
                forward rows · shadow-only</span
              >
              <p>
                ${String(
                  stsCryptoRegimeInverseRepair.next_action ??
                    "Run kalshi_sts_crypto_regime_inverse_repair.py.",
                )}
              </p>
            </article>
            ${stsCryptoExecutionExperiments.map(
              (experiment) => html`
                <article>
                  <b>${plainStrategyToken(experiment.segment_id)}</b>
                  <span
                    >score ${fmt(performanceNumber(experiment.selector_score))} · P&L
                    ${money(performanceNumber(experiment.paper_pnl_usd))}</span
                  >
                  <p>${String(experiment.success_metric ?? "Shadow-only selector experiment.")}</p>
                </article>
              `,
            )}
            ${stsCryptoPausedExecutionExperiments.map(
              (experiment) => html`
                <article>
                  <b>${plainStrategyToken(experiment.segment_id)}</b>
                  <span
                    >paused · raw score
                    ${fmt(performanceNumber(experiment.raw_selector_score))}</span
                  >
                  <p>
                    ${plainStrategyToken(
                      String(
                        (experiment.experiment_health as Record<string, unknown> | undefined)
                          ?.decay_blockers ?? "shadow decay",
                      ),
                    )}
                  </p>
                </article>
              `,
            )}
            ${stsCryptoExecutionOutcomeRows.map(
              (experiment) => html`
                <article>
                  <b>${plainStrategyToken(experiment.segment_id)}</b>
                  <span
                    >${fmt(performanceNumber(experiment.resolved_count))} resolved · acc
                    ${pct(performanceNumber(experiment.accuracy))} · P&L
                    ${money(performanceNumber(experiment.paper_pnl_usd))}</span
                  >
                  <p>
                    ${plainStrategyToken(String(experiment.status ?? "shadow outcome attribution"))}
                    · ${plainStrategyToken(String(experiment.proof_credit ?? "no proof credit"))}
                  </p>
                </article>
              `,
            )}
            ${stsCryptoRegimeExperiments.map(
              (experiment) => html`
                <article>
                  <b>${plainStrategyToken(experiment.regime_id)}</b>
                  <span
                    >score ${fmt(performanceNumber(experiment.selector_score))} · P&L
                    ${money(performanceNumber(experiment.paper_pnl_usd))} · acc
                    ${pct(performanceNumber(experiment.accuracy))}</span
                  >
                  <p>
                    ${String(
                      experiment.success_metric ?? "Forward-shadow regime selector experiment.",
                    )}
                  </p>
                </article>
              `,
            )}
            ${stsCryptoCoverageCohortRows.map(
              (cohort) => html`
                <article>
                  <b>${plainStrategyToken(cohort.coverage_cohort_key)}</b>
                  <span
                    >${fmt(performanceNumber(cohort.resolved_count))} resolved ·
                    ${fmt(performanceNumber(cohort.loss_count))} losses · P&L
                    ${money(performanceNumber(cohort.paper_pnl_usd))}</span
                  >
                  <p>
                    ${plainStrategyToken(String(cohort.action ?? "coverage probe cohort blocked"))}
                    · no live-readiness credit
                  </p>
                </article>
              `,
            )}
            ${stsCryptoRegimePenalties.map(
              (penalty) => html`
                <article>
                  <b>${plainStrategyToken(penalty.regime_id)}</b>
                  <span
                    >paused by fresh forward loss ·
                    ${fmt(performanceNumber(penalty.forward_resolved_count))} resolved · P&L
                    ${money(performanceNumber(penalty.forward_paper_pnl_usd))}</span
                  >
                  <p>
                    ${Array.isArray(penalty.blockers)
                      ? penalty.blockers.map((item) => plainStrategyToken(item)).join(" · ")
                      : plainStrategyToken(String(penalty.reason ?? "forward regime penalty"))}
                  </p>
                </article>
              `,
            )}
            ${stsCryptoRegimeRepairRows.map(
              (repair) => html`
                <article>
                  <b>${plainStrategyToken(repair.regime_id)}</b>
                  <span
                    >${plainStrategyToken(String(repair.recommended_action ?? "repair diagnostic"))}
                    · selected ${money(performanceNumber(repair.selected_paper_pnl_usd))} · inverse
                    ${money(performanceNumber(repair.inverse_paper_pnl_usd))} · abstain uplift
                    ${money(performanceNumber(repair.abstain_pnl_uplift_usd))}</span
                  >
                  <p>
                    ${Array.isArray(repair.blockers)
                      ? repair.blockers.map((item) => plainStrategyToken(item)).join(" · ")
                      : "No inverse blockers."}
                  </p>
                </article>
              `,
            )}
            ${stsCryptoRegimeOutcomeRows.map(
              (experiment) => html`
                <article>
                  <b>${plainStrategyToken(experiment.regime_id)}</b>
                  <span
                    >${plainStrategyToken(stsCryptoRegimeOutcomeMode)} ·
                    ${fmt(performanceNumber(experiment.resolved_count))} resolved · P&L
                    ${money(performanceNumber(experiment.paper_pnl_usd))} · uplift
                    ${fmt(performanceNumber(experiment.market_brier_uplift))}</span
                  >
                  <p>
                    ${plainStrategyToken(String(experiment.status ?? "regime shadow outcome"))} ·
                    ${plainStrategyToken(String(experiment.proof_credit ?? "no proof credit"))}
                  </p>
                </article>
              `,
            )}
            ${stsDomainOptimizerLanes.length
              ? stsDomainOptimizerLanes.map(
                  (lane, index) => html`
                    <article>
                      <b>${plainStrategyToken(lane.domain)} optimizer</b>
                      <span
                        >rank #${fmt(performanceNumber(index + 1))} ·
                        ${fmt(performanceNumber(lane.learning_priority_score ?? 0))} score ·
                        ${plainStrategyToken(String(lane.priority_reason ?? "lane_balance"))} ·
                        ${plainStrategyToken(lane.top_blocker)} ·
                        ${String(lane.recommended_fix ?? "Review this domain.")}</span
                      >
                      <p>
                        ${fmt(performanceNumber(lane.scanned_candidate_count))} scanned ·
                        ${fmt(performanceNumber(lane.feature_rows))} feature rows ·
                        ${plainStrategyToken(lane.expected_learning_impact ?? "medium")} impact
                      </p>
                    </article>
                  `,
                )
              : html`<article>
                  <b>Domain optimizer</b><span>Run kalshi_sts_domain_optimizer.py.</span>
                </article>`}
          </div>
          <div class="kalshi-promotion-gap__segments">
            ${stsDomainPaperEtaRows.length
              ? stsDomainPaperEtaRows.map(({ domain, eta }) => {
                  const basis =
                    typeof eta.real_data_basis === "object" && eta.real_data_basis !== null
                      ? (eta.real_data_basis as Record<string, unknown>)
                      : {};
                  return html`
                    <article>
                      <b>${plainStrategyToken(domain)} lane</b>
                      <span
                        >${String(eta.eta_label ?? "No data")} ·
                        ${plainStrategyToken(eta.top_blocker ?? "none")}</span
                      >
                      <p>
                        ${fmt(performanceNumber(basis.scanned_candidate_count))} scanned ·
                        ${String(eta.plain_english ?? "No lane details yet.")}
                      </p>
                    </article>
                  `;
                })
              : html`<article>
                  <b>No separated lanes yet</b><span>Run STS ETA refresh.</span>
                </article>`}
          </div>
          <details class="kalshi-card" open>
            <summary>Domain Learning Optimizer</summary>
            <p class="kalshi-section-intro">
              ${String(
                stsDomainLearningPolicy?.plain_english ??
                  "Each market category is optimized as a separate STS learning lane.",
              )}
            </p>
            <div class="kalshi-promotion-gap__segments">
              ${stsDomainLearningActionRows.length
                ? stsDomainLearningActionRows.map(
                    (action) => html`
                      <article>
                        <b
                          >${plainStrategyToken(action.domain)} ·
                          ${plainStrategyToken(action.optimizer_action)}</b
                        >
                        <span
                          >${plainStrategyToken(action.top_blocker)} · score
                          ${fmt(performanceNumber(action.learning_priority_score ?? 0))} ·
                          ${plainStrategyToken(
                            String(action.priority_reason ?? "lane_balance"),
                          )}</span
                        >
                        <p>
                          ${String(action.recommended_fix ?? "No optimizer action available yet.")}
                        </p>
                      </article>
                    `,
                  )
                : html`<article>
                    <b>No optimizer lanes yet</b><span>Run STS domain optimizer.</span>
                  </article>`}
              <article>
                <b>Execution order</b>
                <span
                  >${stsDomainOptimizerBest.domain ? "Top lane" : "No lanes"} · score
                  ${fmt(
                    performanceNumber(stsDomainOptimizerBest.learning_priority_score ?? 0),
                  )}</span
                >
                <p>
                  ${String(
                    stsDomainOptimizerBest.recommended_fix ??
                      stsDomainLearningOptimizer.next_action ??
                      "Run STS domain learning optimizer.",
                  )}
                </p>
              </article>
            </div>
          </details>

          <details class="kalshi-card" open>
            <summary>Crypto Fresh Capture → STS Promotion Cycle</summary>
            <p class="kalshi-section-intro">
              This runs crypto capture and STS promotion diagnostics in the same paper-only cycle so
              15-minute windows are evaluated before stale historical rows dominate the blocker
              view.
            </p>
            <div class="kalshi-promotion-gap__segments">
              <article>
                <b>Fresh crypto capture</b>
                <span
                  >${fmt(performanceNumber(stsCryptoFreshCapture.created_count))} created ·
                  ${fmt(performanceNumber(stsCryptoFreshCapture.parseable_crypto_markets))}
                  parseable markets</span
                >
                <p>
                  ${fmt(performanceNumber(stsCryptoFreshCapture.candidate_count))} candidates built;
                  ${fmt(performanceNumber(stsCryptoFreshCapture.skipped_duplicate))} duplicates
                  skipped;
                  ${fmt(
                    performanceNumber(stsCryptoFreshCapture.execution_selector_attributed_count),
                  )}
                  selector-attributed;
                  ${fmt(performanceNumber(stsCryptoFreshCapture.regime_selector_attributed_count))}
                  regime-attributed.
                </p>
              </article>
              <article>
                <b>Immediate STS promotion check</b>
                <span
                  >${fmt(performanceNumber(stsCryptoFreshPromotion.promotion_allowed_count))}
                  tiny-paper allowed ·
                  ${fmt(performanceNumber(stsCryptoFreshPromotion.eligible_candidate_count))}
                  eligible</span
                >
                <p>
                  Global STS paper ETA: ${String(stsCryptoFreshCycle.paper_eta_label ?? "Waiting")}.
                  Dashboard refreshed: ${stsCryptoFreshCycle.dashboard_refreshed ? "yes" : "no"}.
                </p>
              </article>
              <article>
                <b>Next blocker to fix</b>
                <span
                  >${plainStrategyToken(
                    (
                      stsCryptoFreshCycle.best_domain_to_improve_next as
                        | Record<string, unknown>
                        | undefined
                    )?.optimizer_action ?? "unknown",
                  )}</span
                >
                <p>
                  ${String(
                    stsCryptoFreshCycle.next_action ?? "Run kalshi_sts_crypto_fresh_cycle.py.",
                  )}
                </p>
              </article>
            </div>
          </details>

          <details class="kalshi-card" open>
            <summary>Kalshi STS Agent Audit</summary>
            <p class="kalshi-section-intro">
              Specialized paper-only agents are audited for function, cadence, blockers, and no-live
              safety.
            </p>
            <div class="kalshi-promotion-gap__segments">
              <article>
                <b>Agent function</b>
                <span
                  >${fmt(performanceNumber(stsAgentAudit.functional_agent_count))}/${fmt(
                    performanceNumber(stsAgentAudit.agent_count),
                  )}
                  functional · specialization
                  ${fmt(performanceNumber(stsAgentAudit.average_specialization_score))}/100</span
                >
                <p>
                  ${String(stsAgentAudit.top_recommendation ?? "Run kalshi_sts_agent_audit.py.")}
                </p>
              </article>
              ${stsAgentAuditRows.length
                ? stsAgentAuditRows.map(
                    (agent) => html`
                      <article>
                        <b>${plainStrategyToken(agent.agent_id)}</b>
                        <span
                          >${plainStrategyToken(agent.status)} ·
                          ${fmt(performanceNumber(agent.specialization_score))}/100</span
                        >
                        <p>${String(agent.specialty ?? "Specialized paper-only STS agent.")}</p>
                      </article>
                    `,
                  )
                : html`<article>
                    <b>No agent audit yet</b><span>Run kalshi_sts_agent_audit.py.</span>
                  </article>`}
            </div>
          </details>

          ${stsPaperGovernorReasons.length
            ? html`
                <div class="kalshi-promotion-gap__segments">
                  <article>
                    <b>What unlocks STS paper ETA?</b>
                    <span>
                      The current Weather/Crypto stream is being stopped by these governor reasons.
                      Fix the first reason with the largest count first.
                    </span>
                    <p>
                      ${stsPaperGovernorReasons
                        .map(
                          (reason) =>
                            `${plainStrategyToken(reason.reason)} (${fmt(performanceNumber(reason.count))})`,
                        )
                        .join(" · ")}
                    </p>
                  </article>
                </div>
              `
            : nothing}
        </details>
      </section>
      <section
        class="kalshi-panel kalshi-panel--command kalshi-sts-command"
        aria-label="STS Readiness Roadmap"
      >
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">
              STS Readiness Roadmap${metricHelp("Supreme Trading Strategy")}
            </p>
            <h3>Lower-level readiness diagnostics.</h3>
            <p class="kalshi-section-intro">
              These are supporting gate diagnostics below the real-data ETA cards. Live trading
              cannot turn on automatically.
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Live trading is off</span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          <article class="kalshi-card">
            <p class="kalshi-overline">STS Paper Trading</p>
            <h3>
              ${stsPaperScore.toFixed(0)}/100 ·
              ${plainStrategyToken(stsRoadmapPaper.stage_label ?? "Unknown")}
            </h3>
            <div class="kalshi-progress"><span style="width:${stsPaperScore}%"></span></div>
            <div class="kalshi-promotion-gap__summary">
              <span
                ><b>${stsRoadmapPaper.can_sts_direct_paper === true ? "Yes" : "No"}</b> can STS
                direct paper?</span
              >
              <span
                ><b>${plainStrategyToken(stsRoadmapPaper.top_blocker ?? "none")}</b> top
                blocker</span
              >
            </div>
            <p class="kalshi-section-intro">
              ${String(
                stsRoadmapPaper.plain_english ?? "Roadmap is waiting for STS readiness data.",
              )}
            </p>
          </article>
          <article class="kalshi-card">
            <p class="kalshi-overline">Live Trading</p>
            <h3>
              ${stsLiveScore.toFixed(0)}/100 ·
              ${plainStrategyToken(stsRoadmapLive.stage_label ?? "Not live-ready")}
            </h3>
            <div class="kalshi-progress kalshi-progress--danger">
              <span style="width:${stsLiveScore}%"></span>
            </div>
            <div class="kalshi-promotion-gap__summary">
              <span
                ><b>${stsRoadmapLive.can_trade_live === true ? "Yes" : "No"}</b> can trade
                live?</span
              >
              <span
                ><b>${stsRoadmapLive.manual_review_required === false ? "No" : "Yes"}</b> manual
                review required</span
              >
            </div>
            <p class="kalshi-section-intro">
              ${String(stsRoadmapLive.plain_english ?? "Live trading is not ready.")}
            </p>
          </article>
        </div>
        <div class="kalshi-promotion-gap">
          <div class="kalshi-promotion-gap__summary">
            <span
              ><b>${performanceNumber(stsRoadmapDelta.paper_score_delta)?.toFixed(1) ?? "0.0"}</b>
              paper readiness delta</span
            >
            <span
              ><b>${performanceNumber(stsRoadmapDelta.live_score_delta)?.toFixed(1) ?? "0.0"}</b>
              live readiness delta</span
            >
            <span
              ><b
                >${Array.isArray(stsRoadmapDelta.newly_passed_gates)
                  ? stsRoadmapDelta.newly_passed_gates.length
                  : 0}</b
              >
              newly passed gates</span
            >
            <span
              ><b
                >${Array.isArray(stsRoadmapDelta.new_blockers)
                  ? stsRoadmapDelta.new_blockers.length
                  : 0}</b
              >
              new blockers</span
            >
          </div>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS stage rail">
            ${stsRoadmapStages.length
              ? stsRoadmapStages.map(
                  (stage) => html`
                    <span>
                      ${plainStrategyToken(stage.label ?? stage.stage_id)}
                      <b>${plainStrategyToken(stage.state ?? "future")}</b>
                    </span>
                  `,
                )
              : html`<span>Roadmap <b>Waiting</b></span>`}
          </div>
        </div>
        <details class="kalshi-card" open>
          <summary>What must happen next?</summary>
          <div class="kalshi-promotion-gap__segments">
            ${stsRoadmapGates
              .filter((gate) => gate.status === "blocked")
              .slice(0, 5)
              .map(
                (gate) => html`
                  <article>
                    <b>${plainStrategyToken(gate.blocker ?? gate.gate_id)}</b>
                    <span
                      >${String(
                        gate.why_it_matters ?? "This gate blocks readiness progress.",
                      )}</span
                    >
                    <p>
                      Unlocks when:
                      ${String(gate.unlocks_when ?? "The required proof is available.")}
                    </p>
                  </article>
                `,
              )}
            ${stsRoadmapNextActions.map(
              (action) => html`
                <article>
                  <b>Next action</b>
                  <span>${String(action)}</span>
                </article>
              `,
            )}
          </div>
        </details>
      </section>
      <section
        class="kalshi-panel kalshi-panel--command kalshi-sts-command"
        aria-label="STS Trading Dashboard"
      >
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">
              STS Trading Dashboard${metricHelp("Supreme Trading Strategy")}
            </p>
            <h3>
              ${stsCanAcceptPaper
                ? "STS can request bounded paper trades."
                : "STS is learning in shadow-only mode."}
            </h3>
            <p class="kalshi-section-intro">
              ${String(
                stsTradingSummary.plain_english ??
                  "STS trading status is waiting for the dashboard payload.",
              )}
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Live trading is off</span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          ${metricCard(
            "STS Paper Mode",
            String(stsTradingSummary.status_label ?? "Unknown"),
            String(stsTradingSummary.next_action ?? "Run the STS dashboard refresh."),
            stsCanAcceptPaper ? "ok" : "warn",
          )}
          ${metricCard(
            "Can STS Accept Paper?",
            stsCanAcceptPaper ? "Yes" : "No",
            String(stsTradingSummary.top_blocker ?? "No blocker recorded"),
            stsCanAcceptPaper ? "ok" : "warn",
          )}
          ${metricCard(
            "STS-Directed Trades",
            stsDirectedResolved + stsDirectedPending > 0
              ? `${fmt(stsDirectedResolved)} resolved · ${fmt(stsDirectedPending)} pending`
              : "None yet",
            "Only STS paper routes count here; shadow-only observations do not.",
            stsDirectedResolved + stsDirectedPending > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "STS-Directed Accuracy",
            performanceNumber(stsDirectedPaper.win_rate) == null
              ? "No resolved STS paper trades yet"
              : pct(performanceNumber(stsDirectedPaper.win_rate)),
            `${fmt(performanceNumber(stsDirectedPaper.wins))} wins · ${fmt(performanceNumber(stsDirectedPaper.losses))} losses`,
            performanceNumber(stsDirectedPaper.win_rate) == null ? "warn" : "ok",
          )}
          ${metricCard(
            "STS Paper P&L",
            performanceNumber(stsDirectedPaper.pnl_usd) == null
              ? "Not available yet"
              : money(performanceNumber(stsDirectedPaper.pnl_usd)),
            String(stsDirectedPaper.plain_english ?? "Resolved STS paper P&L only."),
            performanceNumber(stsDirectedPaper.pnl_usd) == null
              ? "warn"
              : performanceNumber(stsDirectedPaper.pnl_usd)! >= 0
                ? "ok"
                : "danger",
          )}
          ${metricCard(
            "Shadow Learning Rows",
            fmt(performanceNumber(stsShadowLearning.feature_rows)),
            "Learning data, not STS-directed trades.",
            "ok",
          )}
          ${metricCard(
            "STS Proof Promotion",
            fmt(performanceNumber(stsProofPromotion.promotion_allowed_count)),
            String(stsProofPromotion.next_action ?? "Run STS forward-paper promotion selector."),
            (performanceNumber(stsProofPromotion.promotion_allowed_count) ?? 0) > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Data Contract Repair",
            `${fmt(performanceNumber(stsDataContractRepair.weather_enriched_candidate_count))} enriched · ${fmt(performanceNumber(stsDataContractRepair.dataset_rows_added))} added`,
            String(stsDataContractRepair.plain_english ?? "Derived repair artifact not loaded."),
            performanceNumber(stsDataContractRepair.repaired_row_count) &&
              performanceNumber(stsDataContractRepair.repaired_row_count)! > 0
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Forward Weather Evidence",
            `${fmt(performanceNumber(stsForwardWeatherEvidence.evidence_complete_count))} complete`,
            String(
              stsForwardWeatherEvidence.plain_english ??
                "Forward weather evidence capture not loaded.",
            ),
            performanceNumber(stsForwardWeatherEvidence.evidence_complete_count) &&
              performanceNumber(stsForwardWeatherEvidence.evidence_complete_count)! > 0
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Segment Policy V2",
            `${fmt(performanceNumber(stsSegmentPolicy.tiny_forward_eligible_count))} tiny eligible`,
            String(stsSegmentPolicy.plain_english ?? "Segment-policy artifact not loaded."),
            performanceNumber(stsSegmentPolicy.tiny_forward_eligible_count) &&
              performanceNumber(stsSegmentPolicy.tiny_forward_eligible_count)! > 0
              ? "ok"
              : "warn",
          )}
        </div>
        <div class="kalshi-markov-callout">
          <b>What this tells you:</b>
          <span>
            This panel separates STS-directed paper trading from shadow learning. The proof
            milestones below are gates, not trading performance.
          </span>
        </div>

        <details class="kalshi-card" open>
          <summary>STS Proof Promotion</summary>
          <div class="kalshi-promotion-gap__summary">
            <span
              ><b
                >${fmt(
                  performanceNumber(stsProofPromotion.weather_crypto_scanned_count) ??
                    performanceNumber(stsProofPromotion.scanned_candidate_count),
                )}</b
              >
              Weather/Crypto scanned</span
            >
            <span
              ><b>${fmt(performanceNumber(stsProofPromotion.eligible_candidate_count))}</b> eligible
              candidates</span
            >
            <span
              ><b>${fmt(performanceNumber(stsProofPromotion.promotion_allowed_count))}</b> tiny
              paper probes</span
            >
            <span><b>Paper only</b> not live readiness</span>
          </div>
          <p class="kalshi-section-intro">
            ${String(
              stsProofPromotion.plain_english ??
                "No STS tiny-paper candidates passed all proof gates yet.",
            )}
          </p>
          ${stsProofPromotionBlockers.length
            ? html`
                <div class="kalshi-promotion-gap__blockers" aria-label="STS promotion blockers">
                  ${(stsProofPromotionDomainBlockers.length
                    ? stsProofPromotionDomainBlockers
                    : stsProofPromotionBlockers
                  ).map(
                    (blocker) => html`
                      <span>
                        ${plainStrategyToken(blocker.blocker)}
                        <b>${fmt(performanceNumber(blocker.count))}</b>
                      </span>
                    `,
                  )}
                </div>
              `
            : nothing}
          ${stsProofPromotionGovernorReasons.length
            ? html`
                <div class="kalshi-promotion-gap__segments">
                  <article>
                    <b>Highest-impact STS fix</b>
                    <span>Reduce the largest Weather/Crypto governor stop reason first.</span>
                    <p>
                      ${stsProofPromotionGovernorReasons
                        .map(
                          (reason) =>
                            `${plainStrategyToken(reason.reason)} (${fmt(performanceNumber(reason.count))})`,
                        )
                        .join(" · ")}
                    </p>
                  </article>
                </div>
              `
            : nothing}
          <div class="kalshi-promotion-gap__segments">
            ${stsProofPromotionCandidates.length
              ? stsProofPromotionCandidates.map(
                  (candidate) => html`
                    <article>
                      <b>${candidate.market_ticker ?? "candidate"}</b>
                      <span
                        >${plainStrategyToken(candidate.domain)} · score
                        ${fmt(performanceNumber(candidate.promotion_score))}</span
                      >
                      <p>
                        ${String(candidate.expected_result_known_time_utc ?? "result time pending")}
                      </p>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  No promoted STS tiny-paper candidates yet.
                </p>`}
          </div>
        </details>
        <details class="kalshi-card" open>
          <summary>Readiness gates</summary>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS readiness gates">
            ${stsReadinessGates.length
              ? stsReadinessGates.map(
                  (gate) => html`
                    <span title=${String(gate.plain_english ?? "")}>
                      ${plainStrategyToken(gate.label ?? gate.gate_id)}
                      <b>${plainStrategyToken(gate.status ?? "unknown")}</b>
                    </span>
                  `,
                )
              : html`<span>Readiness gates <b>Waiting</b></span>`}
          </div>
        </details>
        <details class="kalshi-card" open>
          <summary>Domain performance</summary>
          <div class="kalshi-promotion-gap__segments">
            ${stsTradingDomains.length
              ? stsTradingDomains.map(
                  (domain) => html`
                    <article>
                      <b
                        >${plainStrategyToken(domain.domain)} ·
                        ${plainStrategyToken(domain.stance)}</b
                      >
                      <span>
                        ${fmt(performanceNumber(domain.resolved_trades))} rows · win
                        ${pct(performanceNumber(domain.win_rate))} · paper P&L
                        ${money(performanceNumber(domain.pnl_usd))}
                      </span>
                      <p>
                        Candidate Brier
                        ${performanceNumber(domain.candidate_brier)?.toFixed(3) ?? "—"}; market
                        Brier ${performanceNumber(domain.market_brier)?.toFixed(3) ?? "—"}.
                      </p>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  No STS domain diagnostics are available yet.
                </p>`}
          </div>
        </details>
        <details class="kalshi-card">
          <summary>Recent STS-directed paper decisions</summary>
          <div class="kalshi-promotion-gap__segments">
            ${stsRecentDecisions.length
              ? stsRecentDecisions.map(
                  (decision) => html`
                    <article>
                      <b>${decision.market_ticker ?? "unknown market"}</b>
                      <span
                        >${plainStrategyToken(decision.route)} ·
                        ${plainStrategyToken(decision.domain)} · ${decision.side ?? "no side"}</span
                      >
                      <p>
                        ${decision.resolved ? "Resolved" : "Pending"};
                        ${decision.won == null ? "not scored" : decision.won ? "won" : "lost"}; P&L
                        ${performanceNumber(decision.pnl_usd) == null
                          ? "not available"
                          : money(performanceNumber(decision.pnl_usd))}.
                      </p>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  No STS-directed paper trades yet. Shadow-only records are intentionally excluded.
                </p>`}
          </div>
        </details>
      </section>
      <section
        class="kalshi-panel kalshi-panel--command kalshi-sts-command"
        aria-label="Supreme Trading Strategy"
      >
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">
              Supreme Trading Strategy · DuckDB Analytics
              v2${metricHelp("Supreme Trading Strategy")}
            </p>
            <h3>
              ${stsStatus === "validated_shadow_overlay"
                ? "STS has validated shadow-only lift."
                : stsStatus === "degraded"
                  ? "STS is learning, but a data or proof gap is holding it back."
                  : stsStatus === "blocked"
                    ? "STS is blocked until data quality is repaired."
                    : stsFeatureSummary.duckdb_created === true
                      ? "STS DuckDB analytics are live — test the new drilldowns below."
                      : "STS is the central paper-only decision layer."}
            </h3>
            <p class="kalshi-section-intro">
              ${supremeTradingStrategy.next_action ??
              "Run the STS read model so the dashboard can show weights, confidence, blockers, and next action."}
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Live trading is off</span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          ${metricCard(
            "STS Confidence",
            pct(stsConfidence),
            `${plainStrategyToken(stsStatus)} · ${plainStrategyToken(stsRisk.primary_blocker ?? "no blocker recorded")}`,
            stsTone,
          )}
          ${metricCard(
            "STS Regime",
            plainStrategyToken(stsRegime.label ?? "unknown_regime"),
            stsRegime.drivers?.[0] ?? "Regime evidence is still accumulating.",
            stsTone,
          )}
          ${metricCard(
            "Model Objective: Accuracy",
            pct(performanceNumber(stsObjectives.accuracy)),
            `Market champion: ${plainStrategyToken(supremeTradingStrategy.performance?.champion_status ?? "unknown")}.`,
            performanceNumber(stsObjectives.accuracy) != null ? "ok" : "warn",
          )}
          ${metricCard(
            "Calibration",
            pct(performanceNumber(stsObjectives.calibration)),
            "Lower expected calibration error is better; this score is 1 - min(1, ECE).",
            performanceNumber(stsObjectives.calibration) != null &&
              (performanceNumber(stsObjectives.calibration) ?? 0) < 0.65
              ? "warn"
              : "ok",
          )}
          ${metricCard(
            "Profit Direction",
            pct(performanceNumber(stsObjectives.profitability)),
            "Profitability remains capped until forward-paper proof beats baselines.",
            performanceNumber(stsObjectives.profitability) &&
              performanceNumber(stsObjectives.profitability)! > 0.25
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Learning Speed",
            pct(performanceNumber(stsObjectives.learning_speed)),
            `${fmt(stsLearning.weather_crypto_dataset_rows)} Weather/Crypto rows; ${fmt(stsLearning.sts_feature_rows)} STS feature rows.`,
            performanceNumber(stsObjectives.learning_speed) != null ? "ok" : "warn",
          )}
          ${metricCard(
            "W/C ML Weight",
            pct(stsChampionWeight ?? 0),
            stsChampionWeight && stsChampionWeight > 0
              ? "Weather/Crypto ML is currently the challenger lane in paper routing."
              : "Weather/Crypto challenger is currently blocked by proof/quality checks.",
            stsChampionWeight && stsChampionWeight > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Sports Routing",
            pct(stsSportsGuardrail ?? 0),
            stsSportsGuardrail == null || stsSportsGuardrail <= 0
              ? "Sports routing is intentionally held at zero in paper mode."
              : "Sports is still receiving a non-zero guardrail routing share.",
            stsSportsGuardrail == null || stsSportsGuardrail <= 0 ? "warn" : "ok",
          )}
          ${metricCard(
            "Domain Route Boost",
            pct(
              stsWeatherCryptoBoost && stsLearningAccelerationEnabled
                ? stsWeatherCryptoBoost - 1.0
                : 0.0,
            ),
            stsLearningAccelerationEnabled && stsWeatherCryptoBoost && stsWeatherCryptoBoost > 1
              ? `Decay-adjusted backtest boost: +${(stsWeatherCryptoBoost - 1.0) * 100.0 + 1e-9 < 1.0 ? "small" : ((stsWeatherCryptoBoost - 1.0) * 100).toFixed(0)}% route weight.`
              : "No backtest signal is currently active; route mix remains profile-driven.",
            stsLearningAccelerationEnabled ? "ok" : "warn",
          )}
          ${metricCard(
            "Route Multiplier (x)",
            stsWeatherCryptoBoost != null ? `x${stsWeatherCryptoBoost.toFixed(3)}` : "n/a",
            stsWeatherCryptoRawBoost != null
              ? `Raw evidence x${stsWeatherCryptoRawBoost.toFixed(3)} then decay factor x${stsStochasticDecayFactor?.toFixed(2)} => combined ${stsWeatherCryptoBoost != null ? `x${stsWeatherCryptoBoost.toFixed(3)}` : "n/a"}.`
              : "No route multiplier to show yet.",
            stsWeatherCryptoBoost != null && stsWeatherCryptoBoost > 1 ? "ok" : "warn",
          )}
          ${metricCard(
            "ML Route Boost",
            pct(stsWeatherCryptoRawBoost ?? 1),
            stsWeatherCryptoRawBoost && stsWeatherCryptoRawBoost > 1
              ? `Raw domain evidence suggests ${(stsWeatherCryptoRawBoost - 1.0) * 100.0 + 1e-9 < 1.0 ? "small" : ((stsWeatherCryptoRawBoost - 1.0) * 100).toFixed(0)}%.`
              : "No Weather/Crypto acceleration signal yet.",
            stsWeatherCryptoRawBoost && stsWeatherCryptoRawBoost > 1 ? "ok" : "warn",
          )}
          ${metricCard(
            "Weather Decay",
            pct(stsWeatherDecayFactor ?? 1),
            stsWeatherDecayFactor != null && stsWeatherDecayFactor < 1
              ? `Weather window decay multiplier is ${(stsWeatherDecayFactor * 100).toFixed(0)}% based on recent window edge.`
              : stsWeatherDecayFactor != null && stsWeatherDecayFactor > 1
                ? "Weather edge improved versus recent windows; guard is neutral."
                : "Weather decay history unavailable.",
            stsWeatherDecayFactor != null && stsWeatherDecayFactor < 1 ? "warn" : "ok",
          )}
          ${metricCard(
            "Crypto Decay",
            pct(stsCryptoDecayFactor ?? 1),
            stsCryptoDecayFactor != null && stsCryptoDecayFactor < 1
              ? `Crypto window decay multiplier is ${(stsCryptoDecayFactor * 100).toFixed(0)}% based on recent window edge.`
              : stsCryptoDecayFactor != null && stsCryptoDecayFactor > 1
                ? "Crypto edge improved versus recent windows; guard is neutral."
                : "Crypto decay history unavailable.",
            stsCryptoDecayFactor != null && stsCryptoDecayFactor < 1 ? "warn" : "ok",
          )}
          ${metricCard(
            "Regime Decay Coverage",
            `${stsRegimeDecayCount} x regimes`,
            stsRegimeDecayBest && stsRegimeDecayWorst
              ? `Most conservative guard: ${(performanceNumber(stsRegimeDecayBest[1]?.decay_factor) ?? 0) * 100.0}%. Most favorable: ${(performanceNumber(stsRegimeDecayWorst[1]?.decay_factor) ?? 0) * 100.0}%.`
              : "Regime-labeled decay history is still collecting.",
            stsRegimeDecayCount > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Regime Lift Check",
            stsRegimeDecayCount > 0 ? "enabled" : "pending",
            stsRegimeDecayCount > 0
              ? `Testing ${stsRegimeDecayCount} regime-label multipliers in weather/crypto row routing.`
              : "Add regime labels in your STS telemetry to see per-regime multipliers immediately.",
            stsRegimeDecayCount > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Stochastic Decay Guard",
            pct(stsStochasticDecayFactor ?? 1),
            stsStochasticDecayFactor != null && stsStochasticDecayFactor < 1
              ? `Windowed edge has decayed; multiplier is ${(stsStochasticDecayFactor * 100).toFixed(0)}%.`
              : stsStochasticDecayFactor != null && stsStochasticDecayFactor > 1
                ? "Edge improved versus recent windows; guard is neutral."
                : "No decay history yet; guard is neutral.",
            stsStochasticDecayFactor != null && stsStochasticDecayFactor < 1 ? "warn" : "ok",
          )}
          ${metricCard(
            "Recent W/C Edge",
            pct(stsStochasticRecentEdge ?? 0),
            stsStochasticReason,
            stsStochasticRecentEdge && stsStochasticRecentEdge > 0.2 ? "ok" : "warn",
          )}
          ${metricCard(
            "Weather Recent W/C Edge",
            pct(stsWeatherRecentEdge ?? 0),
            `Weather windowed edge: ${((stsWeatherRecentEdge ?? 0) * 100).toFixed(1)}%.`,
            stsWeatherRecentEdge != null && stsWeatherRecentEdge >= 0.15 ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto Recent W/C Edge",
            pct(stsCryptoRecentEdge ?? 0),
            `Crypto windowed edge: ${((stsCryptoRecentEdge ?? 0) * 100).toFixed(1)}%.`,
            stsCryptoRecentEdge != null && stsCryptoRecentEdge >= 0.15 ? "ok" : "warn",
          )}
          ${metricCard(
            "Crypto Execution Realism",
            `x${stsCryptoExecutionRealismMultiplier != null ? stsCryptoExecutionRealismMultiplier.toFixed(2) : "1.00"}`,
            stsCryptoExecutionReason ||
              `Execution pressure currently ${stsCryptoExecutionPressure || "neutral"}.`,
            stsCryptoExecutionRealismMultiplier == null ||
              stsCryptoExecutionRealismMultiplier >= 0.95
              ? "ok"
              : "warn",
          )}
          ${metricCard(
            "Learning Velocity Boost",
            stsLearningVelocityLabel,
            `Applies to weather/crypto acceleration only; this window shows ${fmt(stsLearningVelocityResolvedLast1h ?? 0)} accepted +${stsLearningVelocityShadowLabel} ${fmt(stsLearningVelocityShadowLast1h ?? 0)} shadow outcomes resolved in the last hour.`,
            stsLearningVelocityMultiplier != null && stsLearningVelocityMultiplier > 1.0
              ? "ok"
              : stsLearningVelocityResolvedLast1h != null
                ? "warn"
                : "warn",
          )}
          ${metricCard(
            "Sports Guardrail",
            pct(stsSportsRouteHold ?? 0),
            stsSportsRouteHold == null || stsSportsRouteHold <= 0
              ? "Sports remains blocked while out-of-sample signal stays below promotion threshold."
              : "Sports is tentatively back in allocation tests.",
            stsSportsRouteHold == null || stsSportsRouteHold <= 0 ? "warn" : "ok",
          )}
          ${metricCard(
            "STS Route Mix",
            `${pct(stsChampionWeight ?? 0)} W/C · ${pct(stsSportsGuardrail ?? 0)} Sports`,
            "Weather/Crypto stays prioritized for learning while sports remains blocked from route allocation.",
            (stsChampionWeight ?? 0) > 0 && (stsSportsGuardrail ?? 0) <= 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Data Freshness",
            plainStrategyToken(stsModelHealth.observability_status ?? "not generated"),
            `${fmt(stsLearning.telemetry_snapshot_count)} telemetry snapshots; Markov ${plainStrategyToken(stsLearning.markov_coverage_status ?? "unknown")}.`,
            stsModelHealth.observability_status === "blocked" ? "danger" : "warn",
          )}
          ${metricCard(
            "STS Store",
            stsFeatureSummary.duckdb_created === true || stsFeatureSummary.duckdb_available === true
              ? "DuckDB active"
              : "JSONL fallback",
            `${fmt(performanceNumber(stsFeatureSummary.duckdb_feature_row_count ?? stsFeatureSummary.written_row_count))} rows mirrored; parquet ${stsFeatureSummary.parquet_feature_rows_path ? "ready" : "pending"}.`,
            stsFeatureSummary.duckdb_created === true ? "ok" : "warn",
          )}
        </div>
        <div class="kalshi-markov-callout">
          <b>STS decision:</b>
          <span>
            ${supremeTradingStrategy.next_action ??
            "Build STS feature rows and keep live trading off."}
          </span>
        </div>
        <div class="kalshi-promotion-gap">
          <div class="kalshi-promotion-gap__summary">
            <span><b>${plainStrategyToken(stsRisk.primary_blocker ?? "none")}</b> blocker</span>
            <span><b>${fmt(stsWeights.length)}</b> strategy weights</span>
            <span><b>${pct(performanceNumber(stsObjectives.robustness))}</b> robustness</span>
            <span
              ><b>x${(stsCryptoExecutionRealismMultiplier ?? 1).toFixed(2)}</b> crypto execution
              realism</span
            >
            <span
              ><b>${pct(performanceNumber(stsObjectives.statistical_validity))}</b> statistical
              validity</span
            >
            <span><b>${pct(performanceNumber(stsObjectives.calibration))}</b> calibration</span>
            <span
              ><b>${stsFeatureSummary.duckdb_created === true ? "DuckDB" : "JSONL"}</b> STS
              storage</span
            >
            <span><b>Paper only</b> no live authority</span>
          </div>
          ${stsWeights.length
            ? html`
                <div class="kalshi-promotion-gap__blockers" aria-label="STS strategy weights">
                  ${stsWeights.map(
                    (weight) => html`
                      <span>
                        ${plainStrategyToken(weight.strategy_id)}
                        <b>${pct(performanceNumber(weight.weight))}</b>
                      </span>
                    `,
                  )}
                </div>
              `
            : html`<p class="kalshi-section-intro">STS weights are waiting for the read model.</p>`}
        </div>

        <details class="kalshi-card" open>
          <summary>NEW: DuckDB STS diagnostics — domain, regime, and time windows</summary>
          <div class="kalshi-promotion-gap__segments">
            ${stsDomainDiagnostics.length
              ? stsDomainDiagnostics.map(
                  (row) => html`
                    <article>
                      <b
                        >${plainStrategyToken(row.domain)} · ${fmt(performanceNumber(row.rows))}
                        rows</b
                      >
                      <span>
                        Win ${pct(performanceNumber(row.win_rate))} · Market Brier
                        ${performanceNumber(row.market_brier)?.toFixed(3) ?? "—"} · Candidate Brier
                        ${performanceNumber(row.candidate_brier)?.toFixed(3) ?? "—"}
                      </span>
                      <p>
                        P&L ${money(performanceNumber(row.paper_pnl_usd))}; avg spread
                        ${performanceNumber(row.avg_spread_cents)?.toFixed(1) ?? "—"}¢; avg depth
                        ${fmt(performanceNumber(row.avg_depth_contracts))}.
                      </p>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  DuckDB domain diagnostics are not available yet.
                </p>`}
          </div>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS regime diagnostics">
            ${stsRegimeDiagnostics.length
              ? stsRegimeDiagnostics.map(
                  (row) => html`
                    <span>
                      ${plainStrategyToken(row.regime_label)}
                      <b
                        >${fmt(performanceNumber(row.rows))} ·
                        ${money(performanceNumber(row.paper_pnl_usd))}</b
                      >
                    </span>
                  `,
                )
              : nothing}
          </div>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS time-window diagnostics">
            ${stsTimeWindowDiagnostics.length
              ? stsTimeWindowDiagnostics.map(
                  (row) => html`
                    <span>
                      Window ${fmt(performanceNumber(row.chronological_bucket))}
                      <b
                        >${pct(performanceNumber(row.win_rate))} ·
                        ${money(performanceNumber(row.paper_pnl_usd))}</b
                      >
                    </span>
                  `,
                )
              : nothing}
          </div>
          <div class="kalshi-promotion-gap__blockers" aria-label="STS segment diagnostics">
            ${stsSegmentDiagnostics.length
              ? stsSegmentDiagnostics.map(
                  (row) => html`
                    <span>
                      ${plainStrategyToken(row.segment_key ?? row.strategy_bucket)}
                      <b
                        >${fmt(performanceNumber(row.rows))} ·
                        ${money(performanceNumber(row.paper_pnl_usd))}</b
                      >
                    </span>
                  `,
                )
              : nothing}
          </div>
        </details>
        <details class="kalshi-card" open>
          <summary>Why STS believes this</summary>
          <div class="kalshi-promotion-gap__segments">
            ${stsRationales.length
              ? stsRationales.map(
                  (rationale) => html`
                    <article>
                      <b>${rationale.title ?? "STS rationale"}</b>
                      <span>${rationale.evidence ?? "No evidence text yet."}</span>
                      <p>${rationale.impact ?? "Impact is still being measured."}</p>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  No STS rationales have been generated yet.
                </p>`}
          </div>
        </details>
      </section>
      ${countdownMilestones.length
        ? html`
            <section class="kalshi-countdown-ticker" aria-label="Milestone countdown">
              <div class="kalshi-countdown-ticker__head">
                <div>
                  <p class="kalshi-overline">Proof Milestones</p>
                  <strong>Proof and review gates</strong>
                </div>
                <span>
                  These are proof and review gates. They are not live-trading timers and they are
                  not STS trade performance.
                </span>
              </div>

              <div class="kalshi-markov-callout">
                <b>Countdown Health:</b>
                <span>
                  Proof uses
                  ${plainStrategyToken(
                    countdownRateWindows.rate_source ?? "accepted_forward_paper_only",
                  )};
                  shadow learning is separate.
                </span>
              </div>
              <div class="kalshi-promotion-gap">
                <div class="kalshi-promotion-gap__summary">
                  <span
                    ><b>${plainStrategyToken(countdownHealth.status ?? "unknown")}</b> health</span
                  >
                  <span
                    ><b>${fmt(performanceNumber(countdownLearningMomentum.resolved_last_1h))}</b>
                    labels last hour</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownLearningMomentum.shadow_resolved_last_1h),
                      )}</b
                    >
                    shadow labels last hour</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownRateWindows.accepted_forward_sample_size),
                      )}</b
                    >
                    accepted-forward sample</span
                  >
                  <span
                    ><b>${countdownFreshness.latest_accepted_proof_at_utc ?? "none"}</b> latest
                    proof</span
                  >
                </div>
                <div
                  class="kalshi-promotion-gap__blockers"
                  aria-label="Accepted forward rate windows"
                >
                  ${countdownWindowRows.length
                    ? countdownWindowRows.map(
                        (row) => html`
                          <span>
                            ${row.window ?? "window"}
                            <b
                              >${fmt(performanceNumber(row.accepted_forward_resolved))} accepted ·
                              ${fmt(performanceNumber(row.proof_qualified_resolved))} proof</b
                            >
                          </span>
                        `,
                      )
                    : nothing}
                </div>

                <div class="kalshi-promotion-gap__summary">
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownCandidateQuality.accepted_forward_total),
                      )}</b
                    >
                    accepted-forward candidates</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownCandidateQuality.accepted_forward_resolved),
                      )}</b
                    >
                    resolved</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownCandidateQuality.accepted_forward_pending),
                      )}</b
                    >
                    pending</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownCandidateQuality.proof_qualified_resolved),
                      )}</b
                    >
                    proof-qualified</span
                  >
                  <span
                    ><b
                      >${fmt(
                        performanceNumber(countdownCandidateQuality.shadow_forward_probe_count),
                      )}</b
                    >
                    shadow probes</span
                  >
                </div>
                ${countdownCandidateBlockers.length
                  ? html`
                      <div
                        class="kalshi-promotion-gap__blockers"
                        aria-label="Accepted-forward candidate blockers"
                      >
                        ${countdownCandidateBlockers.map(
                          ([name, value]) => html`
                            <span>
                              ${plainStrategyToken(name)}
                              <b>${fmt(performanceNumber(value))}</b>
                            </span>
                          `,
                        )}
                      </div>
                    `
                  : nothing}
                ${countdownCandidateActions.length
                  ? html`
                      <div class="kalshi-promotion-gap__segments">
                        ${countdownCandidateActions.map(
                          (action) => html`
                            <article>
                              <b>Next proof action</b>
                              <span>${String(action)}</span>
                            </article>
                          `,
                        )}
                      </div>
                    `
                  : nothing}
                ${countdownProofBlockers.length
                  ? html`
                      <div class="kalshi-promotion-gap__segments">
                        ${countdownProofBlockers.map(
                          (blocker) => html`
                            <article>
                              <b
                                >${plainStrategyToken(blocker.milestone_id)} ·
                                ${plainStrategyToken(blocker.criterion)}</b
                              >
                              <span>${blocker.blocking_reason ?? "No blocker detail."}</span>
                              <p>${plainStrategyToken(blocker.reason_code)}</p>
                            </article>
                          `,
                        )}
                      </div>
                    `
                  : nothing}
                ${stsRegimeDecayRows.length
                  ? html`
                      <div
                        class="kalshi-promotion-gap__blockers"
                        aria-label="STS regime decay multipliers"
                      >
                        ${stsRegimeDecayRows.map(
                          (row) => html`
                            <span>
                              <b>${plainStrategyToken(row.regime_key)}</b>
                              decay x${(row.decay_factor ?? 1).toFixed(2)} · edge
                              ${(row.late_edge ?? 0).toFixed(3)}
                            </span>
                          `,
                        )}
                      </div>
                    `
                  : html`<p class="kalshi-section-intro">No regime-labeled decay samples yet.</p>`}
              </div>
              <div class="kalshi-countdown-ticker__rail">
                ${countdownMilestones.map(
                  (milestone) => html`
                    <article
                      class="kalshi-countdown-card kalshi-countdown-card--${countdownMilestoneTone(
                        milestone,
                      )}"
                    >
                      <div class="kalshi-countdown-card__top">
                        <span
                          >${milestone.label ?? plainStrategyToken(milestone.milestone_id)}</span
                        >
                        <b class="kalshi-countdown-card__score"
                          >${countdownScore(milestone.completion_score)}/10</b
                        >
                      </div>
                      <strong class="kalshi-countdown-card__eta"
                        >${countdownEtaLabel(milestone)}</strong
                      >
                      <div class="kalshi-countdown-card__criteria">
                        ${countdownCriteria(milestone).map(
                          (criterion) => html`
                            <span
                              class="kalshi-countdown-chip"
                              title=${criterion.blocking_reason ?? criterion.detail ?? ""}
                            >
                              ${countdownCriterionLabel(criterion.label)}
                              <b
                                >${criterion.status === "complete"
                                  ? "Complete"
                                  : criterion.status === "blocked"
                                    ? "Blocked"
                                    : `${countdownScore(criterion.score)}/10`}</b
                              >
                            </span>
                          `,
                        )}
                      </div>
                    </article>
                  `,
                )}
              </div>
            </section>
          `
        : nothing}

      <section class="kalshi-today-panel" aria-label="Today">
        <div class="kalshi-today-panel__header">
          <div>
            <p class="kalshi-overline">Today</p>
            <h3>Here’s what matters.</h3>
          </div>
          <label class="kalshi-inline-control">
            Timezone
            <select
              .value=${props.timezone}
              @change=${(event: Event) =>
                props.onTimezoneChange((event.currentTarget as HTMLSelectElement).value)}
            >
              ${CONTINENTAL_US_TIMEZONES.map(
                (zone) => html`<option value=${zone.value}>${zone.label} (${zone.sample})</option>`,
              )}
            </select>
          </label>
        </div>
        <div class="kalshi-today-grid">
          ${humanStatusCard("Safety", todayStatus.value, todayStatus.note, todayStatus.tone)}
          ${humanStatusCard(
            "Learning Velocity",
            stsLearningVelocityLabel,
            stsLearningVelocityNote,
            stsLearningVelocityTone,
          )}
          ${humanStatusCard(
            "Learning",
            learningStatus.value,
            learningStatus.note,
            learningStatus.tone,
          )}
          ${humanStatusCard(
            "Profit proof",
            profitProofStatus.value,
            profitProofStatus.note,
            profitProofStatus.tone,
          )}
          ${humanStatusCard(
            "Next",
            nextActionStatus.value,
            nextActionStatus.note,
            nextActionStatus.tone,
          )}
        </div>
      </section>

      <section class="kalshi-change-strip" aria-label="What changed?">
        <div>
          <span class="kalshi-overline">What changed?</span>
          <strong>${refreshLabel}${refreshStatus ? ` · ${refreshAge}` : ""}</strong>
        </div>
        <ul>
          ${recentChanges.map((item) => html`<li>${item}</li>`)}
        </ul>
      </section>

      <section class="kalshi-panel kalshi-strategy-cockpit" aria-label="Strategy Cockpit">
        <div class="kalshi-section-heading kalshi-strategy-cockpit__header">
          <div>
            <p class="kalshi-overline">Strategy Cockpit${metricHelp("Strategy Comparison")}</p>
            <h3>Every named strategy lane, one comparable table.</h3>
            <p class="kalshi-section-intro">
              ${strategyComparison.plain_english ??
              "Paper-only strategy comparison stays on the main page so losing, waiting, and high-volume lanes are visible without opening Advanced Audit."}
            </p>
          </div>
          <label class="kalshi-inline-control">
            Sort strategies
            <select
              .value=${props.strategySort}
              @change=${(event: Event) =>
                props.onStrategySortChange(
                  (event.currentTarget as HTMLSelectElement).value as KalshiStrategySort,
                )}
            >
              ${STRATEGY_SORT_OPTIONS.map(
                (option) => html`<option value=${option.value}>${option.label}</option>`,
              )}
            </select>
          </label>
        </div>
        <div class="kalshi-strategy-cockpit__summary" aria-label="Strategy comparison totals">
          <span><b>${fmt(strategyComparisonRows.length)}</b> named strategy lanes</span>
          <span><b>${fmt(strategyTotals.accepted)}</b> accepted paper</span>
          <span><b>${fmt(strategyTotals.shadow)}</b> shadow/control</span>
          <span><b>${fmt(strategyTotals.scored)}</b> scored</span>
          <span><b>${money(strategyTotals.pnl)}</b> strategy P&amp;L</span>
          <span><b>Live off</b> read-only comparison</span>
        </div>
        <div class="kalshi-table-scroll kalshi-table-scroll--strategy">
          <table class="kalshi-strategy-table" aria-label="Strategy comparison cockpit">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Status</th>
                <th>Domains</th>
                <th>Decisions</th>
                <th>Accepted / Shadow</th>
                <th>Scored</th>
                <th>Accuracy</th>
                <th>P&amp;L</th>
                <th>Avg/trade</th>
                <th title=${METRIC_DEFINITIONS["P&L Delta"]}>Δ vs Standard</th>
                <th>Unresolved</th>
                <th>Next</th>
              </tr>
            </thead>
            <tbody>
              ${sortedStrategyComparisonRows.length
                ? sortedStrategyComparisonRows.map((row) => {
                    const pnlDelta = strategyPnlDelta(
                      row,
                      actualStandardPnl,
                      actualStandardScoredForDelta,
                    );
                    const status = row.tracking_status
                      ? plainStrategyToken(row.tracking_status)
                      : "tracking";
                    const tone = strategyRowTone(row);
                    return html`
                      <tr class="kalshi-strategy-table__row kalshi-strategy-table__row--${tone}">
                        <td>
                          <b>${strategyDisplayName(row)}</b>
                          <span
                            >${row.role ? plainStrategyToken(row.role) : "Paper-only lane"}</span
                          >
                        </td>
                        <td>
                          <span class="kalshi-status-token kalshi-status-token--${tone}">
                            ${status}
                          </span>
                        </td>
                        <td>${strategyDomainsLabel(row)}</td>
                        <td>${fmt(strategyVolume(row))}</td>
                        <td>
                          <b>${fmt(row.accepted)}</b>
                          <span>${fmt(strategyShadowCount(row))} shadow</span>
                        </td>
                        <td>${fmt(row.scored)}</td>
                        <td>${pct(row.accuracy)}</td>
                        <td>${money(row.paper_pnl_usd)}</td>
                        <td>${money(strategyAveragePnl(row))}</td>
                        <td>
                          <b>${pnlDelta.amount == null ? "n/a" : signedMoney(pnlDelta.amount)}</b>
                          <span>${pnlDelta.label}</span>
                        </td>
                        <td>${fmt(row.unresolved)}</td>
                        <td>${row.next_step ?? "Keep collecting clean paper evidence."}</td>
                      </tr>
                    `;
                  })
                : html`<tr>
                    <td colspan="12">No strategy comparison snapshot is available yet.</td>
                  </tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <section class="kalshi-lanes-panel kalshi-lanes-panel--compact" aria-label="Learning lanes">
        <div class="kalshi-today-panel__header">
          <div>
            <p class="kalshi-overline">Learning lanes</p>
            <h3>
              Weather/Crypto is accelerator-guided. Sports remains gated until safety proof is
              strong.
            </h3>
          </div>
        </div>
        <div class="kalshi-lane-grid">
          ${learningLaneCard({
            detail: "Route control",
            label: "Weather/Crypto Boost",
            metric: stsWeatherCryptoBoostMetric,
            note: `STS weather/crypto learning pressure: ${stsWeatherCryptoRouteHold}.`,
            tone: stsWeatherCryptoBoost == null ? "warn" : "ok",
          })}
          ${learningLaneCard({
            detail: "ML safety",
            label: "Sports Safety Hold",
            metric: stsSportsStatus,
            note: stsSportsReason
              ? stsSportsReason
              : stsSportsBlocked
                ? "Sports route safety is being held until fresh cross-lane proof appears."
                : "Sports is currently passing gate checks and can use a tiny guardrail only in paper testing.",
            tone: stsSportsStatus === "Halted" ? "danger" : "ok",
          })}
          ${learningLaneCard({
            detail: "Learning focus",
            label: "Weather",
            metric: `${fmt(weatherTradeReadyCount)} ready`,
            note: weather.why_not_trading
              ? plainLearningText(weather.why_not_trading)
              : `${categoryAccuracyNote(weatherLane, "Weather", selectedPerformanceLabel)} Fresh source evidence stays domain-scoped.`,
            tone: weatherTradeReadyCount > 0 || (weatherLane?.scored ?? 0) > 0 ? "ok" : "warn",
          })}
          ${learningLaneCard({
            detail: "Learning focus",
            label: "Crypto",
            metric: `${fmt(cryptoCreatedCount)} practice`,
            note:
              cryptoEvidence.plain_english_summary ??
              categoryAccuracyNote(cryptoLane, "Crypto", selectedPerformanceLabel),
            tone: cryptoCreatedCount > 0 || (cryptoLane?.scored ?? 0) > 0 ? "ok" : "warn",
          })}
          ${learningLaneCard({
            detail: "Accepted exposure halted",
            label: "Sports",
            metric: pct(sportsLane?.accuracy),
            note: "Sports remains practice-only until fresh proof beats the baselines.",
            tone: "danger",
          })}
        </div>
      </section>

      <section class="kalshi-panel kalshi-markov-panel" aria-label="Probability Diagnostics">
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">
              Probability Diagnostics${metricHelp("Probability Diagnostics")}
            </p>
            <h3>Markov and microstructure risk, not a trade signal.</h3>
            <p class="kalshi-section-intro">
              ${markovSummary.plain_english ??
              markovMicrostructure.plain_english ??
              "This research-only panel checks price-path behavior, Becker longshot calibration, maker/taker drag, fees, spreads, and fill quality before any idea deserves paper review."}
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Research only</span>
        </div>
        <div class="kalshi-markov-callout">
          <b>Hard rule:</b>
          <span>
            This module can veto weak ideas or mark them observe-only. It cannot authorize live
            orders, accepted paper, or strategy promotion by itself.
          </span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          ${metricCard(
            "Markets Checked",
            fmt(markovSummary.analyzed_market_count ?? 0),
            `${fmt(markovSummary.low_data_market_count ?? 0)} low-data bucket${(markovSummary.low_data_market_count ?? 0) === 1 ? "" : "s"} visually punished.`,
            (markovSummary.analyzed_market_count ?? 0) > 0 ? "ok" : "warn",
          )}
          ${metricCard(
            "Markov Proxy",
            pct(topMarkovMarket?.raw_markov_yes_proxy),
            topMarkovMarket
              ? `${markovMarketLabel(topMarkovMarket)} raw terminal price-path proxy.`
              : "Waiting for price history.",
            markovTone(topMarkovConfidence),
          )}
          ${metricCard(
            "Becker Calibration",
            pct(topMarkovMarket?.calibrated_probability),
            topMarkovMarket
              ? `Market ${pct(topMarkovMarket.market_price)}; edge ${pctPoint(topMarkovMarket.edge_vs_market_pct)}.`
              : "Longshot and YES/NO priors load after diagnostics run.",
            markovTone(topMarkovConfidence),
          )}
          ${metricCard(
            "Maker/Taker Edge",
            pctPoint(topMarkovMakerEdge),
            topMarkovMarket
              ? `Worst taker edge ${pctPoint(topMarkovTakerEdge)}; fill quality ${plainStrategyToken(topMarkovMarket.execution?.fill_quality ?? "unknown")}.`
              : "Maker/taker warning appears after an executable price snapshot.",
            topMarkovMakerEdge != null && topMarkovMakerEdge > 0 ? "warn" : "danger",
          )}
          ${metricCard(
            "Confidence",
            `${fmt(topMarkovConfidence)}/10`,
            `${fmt(markovSummary.taker_trap_count ?? 0)} taker trap${(markovSummary.taker_trap_count ?? 0) === 1 ? "" : "s"}; ${fmt(markovSummary.tiny_paper_review_only_count ?? 0)} tiny paper-review-only.`,
            markovTone(topMarkovConfidence),
          )}
        </div>
        <div class="kalshi-markov-layout">
          <div class="kalshi-markov-list" aria-label="Probability diagnostic market list">
            ${markovMarkets.length
              ? markovMarkets.map(
                  (market) => html`
                    <article class="kalshi-markov-market">
                      <div>
                        <b>${market.market_ticker ?? "unknown ticker"}</b>
                        <span>${plainStrategyToken(market.category ?? "unknown")}</span>
                      </div>
                      <p>${market.title ?? "No title available."}</p>
                      <dl>
                        <div>
                          <dt>Raw</dt>
                          <dd>${pct(market.raw_markov_yes_proxy)}</dd>
                        </div>
                        <div>
                          <dt>Calibrated</dt>
                          <dd>${pct(market.calibrated_probability)}</dd>
                        </div>
                        <div>
                          <dt>Maker edge</dt>
                          <dd>${pctPoint(markovBestMakerEdge(market))}</dd>
                        </div>
                        <div>
                          <dt>Samples</dt>
                          <dd>${fmt(market.sample?.current_row_transitions)} row</dd>
                        </div>
                      </dl>
                      <span
                        class="kalshi-status-token kalshi-status-token--${markovRoutingTone(
                          market.routing_label,
                        )}"
                      >
                        ${plainStrategyToken(market.routing_label ?? "PASS")}
                      </span>
                    </article>
                  `,
                )
              : html`<p class="kalshi-section-intro">
                  No Markov diagnostics yet. The dashboard is ready; run
                  <code>kalshi_markov_microstructure.py</code> to populate the research panel.
                </p>`}
          </div>
          <div class="kalshi-markov-matrix">
            <div>
              <strong>State-transition heatmap</strong>
              <span>
                ${topMarkovMarket
                  ? `${markovMarketLabel(topMarkovMarket)} · bucket ${fmt(topMarkovMarket.current_bucket)}`
                  : "Waiting for a selected market"}
              </span>
            </div>
            ${markovHeatmap(topMarkovMarket)}
            <p>
              Grey cells mean sparse rows. The diagonal shows “stays put”; edges near 0¢/100¢ should
              usually be sticky, not magic.
            </p>
          </div>
        </div>
        <p class="kalshi-footnote">
          Study basis: ${markovMicrostructure.study_reference?.author ?? "Jonathan Becker"} ·
          ${markovMicrostructure.study_reference?.dataset_summary ??
          "72.1M Kalshi trades / $18.26B notional"}.
          ${markovSummary.next_action ??
          "Keep this as a veto/risk layer until forward-paper calibration proves value."}
        </p>
      </section>

      <section class="kalshi-panel" aria-label="Weather and crypto ML readiness">
        <div class="kalshi-section-heading">
          <div>
            <p class="kalshi-overline">Weather/Crypto ML${metricHelp("Weather/Crypto ML")}</p>
            <h3>
              ${weatherCryptoMl.status === "proven_forward_paper_ready"
                ? "A segment has proof."
                : weatherCryptoMl.status === "shadow_qualified_review"
                  ? "A shadow segment is ready for review."
                  : "The learner is abstaining until proof is real."}
            </h3>
            <p class="kalshi-section-intro">
              ${weatherCryptoMl.plain_english ??
              "Weather and crypto remain shadow-first until reality contracts, P&L, accuracy, and market-baseline gates agree."}
            </p>
          </div>
          <span class="kalshi-live-pill kalshi-live-pill--safe">Live trading is off</span>
        </div>
        <div class="kalshi-grid kalshi-grid--cards">
          ${metricCard(
            "Reality Contract",
            `${fmt(mlReality.training_eligible ?? 0)} trainable`,
            `${fmt(mlReality.quarantined_training ?? 0)} quarantined records cannot train ML.`,
          )}
          ${metricCard(
            "Weather ML",
            `${fmt(weatherMl.shadow_scored ?? 0)} shadow scored`,
            `${fmt(weatherMl.accepted_scored ?? 0)} accepted scored; promotion waits for ≥80% and positive paper profit/loss.`,
          )}
          ${metricCard(
            "Crypto ML",
            `${fmt(cryptoMl.shadow_scored ?? 0)} shadow scored`,
            `${fmt(cryptoMl.accepted_scored ?? 0)} accepted scored; parser blockers stay visible in Advanced Audit.`,
          )}
          ${metricCard(
            "Abstention Rate",
            pct(weatherCryptoMl.abstention_rate),
            `${fmt(weatherCryptoMl.accepted_paper_allowed_segment_count ?? 0)} segment${(weatherCryptoMl.accepted_paper_allowed_segment_count ?? 0) === 1 ? "" : "s"} currently allowed beyond shadow.`,
          )}
          ${metricCard(
            "Markov ML Overlay",
            fmt(mlMarkovOverlay.analyzed_weather_crypto_count ?? 0),
            `${fmt(mlMarkovOverlay.taker_trap_count ?? 0)} taker trap${(mlMarkovOverlay.taker_trap_count ?? 0) === 1 ? "" : "s"}; ${fmt(mlMarkovOverlay.tiny_paper_review_only_count ?? 0)} tiny paper-review-only. Features feed ML only when captured at decision time.`,
            (mlMarkovOverlay.analyzed_weather_crypto_count ?? 0) > 0 ? "warn" : "",
          )}
          ${metricCard(
            "Markov Uplift",
            plainStrategyToken(mlMarkovUplift.status ?? "collecting"),
            `${fmt(mlMarkovUplift.train_markov_rows ?? 0)} train / ${fmt(mlMarkovUplift.test_markov_rows ?? 0)} test resolved rows; Brier uplift ${pctPoint(mlMarkovUplift.brier_uplift_vs_candidate)}.`,
            mlMarkovUplift.can_influence_ml_training ? "ok" : "warn",
          )}
          ${metricCard(
            "Markov Coverage",
            `${fmt(mlMarkovCoverage.resolved_safe_markov_rows ?? 0)} resolved`,
            `${fmt(mlMarkovCoverage.pending_safe_markov_rows ?? 0)} pending; ${fmt(mlMarkovCoverage.due_safe_markov_rows ?? 0)} due now; ${fmt(mlMarkovCoverage.resolved_safe_markov_rows_needed ?? 75)} more resolved needed.`,
            (mlMarkovCoverage.resolved_safe_markov_rows ?? 0) > 0 ? "warn" : "",
          )}
        </div>
        ${mlMarkovOverlay.purpose
          ? html`
              <div class="kalshi-markov-callout">
                <b>Where Markov fits ML:</b>
                <span>
                  ${mlMarkovOverlay.usage ??
                  "Decision-time Markov diagnostics become leakage-safe ML features and abstention gates; latest diagnostics only slow or veto paper ideas."}
                </span>
              </div>
            `
          : nothing}
        ${mlMarkovCoverage.next_action
          ? html`
              <p class="kalshi-footnote">
                Markov coverage:
                ${plainStrategyToken(mlMarkovCoverage.coverage_status ?? "collecting")}.
                ${mlMarkovCoverage.next_action}
                ${mlMarkovCoverage.next_safe_markov_result_known_time_utc
                  ? ` Next due: ${formatTradeTime(
                      mlMarkovCoverage.next_safe_markov_result_known_time_utc,
                      props.timezone,
                    )}.`
                  : ""}
              </p>
            `
          : nothing}
        ${mlPromotionGap.status
          ? html`
              <div class="kalshi-promotion-gap">
                <div class="kalshi-promotion-gap__summary">
                  <span><b>${fmt(mlPromotionGap.allowed_segment_count ?? 0)}</b> allowed</span>
                  <span><b>${fmt(mlPromotionGap.near_miss_segment_count ?? 0)}</b> near</span>
                  <span><b>${fmt(mlPromotionGap.trainable_rows ?? 0)}</b> trainable</span>
                  <span><b>${fmt(mlPromotionGap.quarantined_rows ?? 0)}</b> quarantined</span>
                  <span
                    ><b>${plainStrategyToken(mlPromotionGap.top_blocker ?? "none")}</b>
                    blocker</span
                  >
                </div>
                <p class="kalshi-section-intro">
                  ${mlPromotionGap.next_action ??
                  "Promotion gap diagnostics are waiting for Weather/Crypto ML readiness."}
                </p>
                ${mlPromotionBlockers.length
                  ? html`
                      <div class="kalshi-promotion-gap__blockers" aria-label="Promotion blockers">
                        ${mlPromotionBlockers
                          .slice(0, 5)
                          .map(
                            ([blocker, count]) => html`
                              <span>${plainStrategyToken(blocker)} <b>${fmt(count)}</b></span>
                            `,
                          )}
                      </div>
                    `
                  : nothing}
                ${mlCalibrationRepair.status
                  ? html`
                      <div
                        class="kalshi-promotion-gap__repair"
                        aria-label="Calibration repair plan"
                      >
                        <div>
                          <strong>Calibration Repair</strong>
                          <span
                            >${plainStrategyToken(mlCalibrationRepair.status)} ·
                            ${plainStrategyToken(mlCalibrationRepair.top_blocker ?? "none")}</span
                          >
                        </div>
                        <p>
                          ${mlCalibrationRepair.next_action ??
                          "No calibration repair action is currently required."}
                        </p>
                        ${mlCalibrationRepairBehavior.status
                          ? html`
                              <div class="kalshi-promotion-gap__criteria">
                                <span
                                  >Crypto
                                  <b
                                    >${mlCalibrationRepairBehavior.crypto_reprice_active
                                      ? "repriced"
                                      : "observe"}</b
                                  ></span
                                >
                                <span
                                  >Rule
                                  <b
                                    >${plainStrategyToken(
                                      mlCalibrationRepairBehavior.probability_rule ??
                                        "market shrink",
                                    )}</b
                                  ></span
                                >
                                <span
                                  >Weather
                                  <b
                                    >${plainStrategyToken(
                                      mlCalibrationRepairBehavior.weather_label_rule ??
                                        "brier wins",
                                    )}</b
                                  ></span
                                >
                              </div>
                            `
                          : nothing}
                        ${mlCalibrationRepairSegments.length
                          ? html`
                              <div class="kalshi-promotion-gap__segments">
                                ${mlCalibrationRepairSegments.map(
                                  (segment) => html`
                                    <article>
                                      <div>
                                        <b>${segment.segment_key ?? "unknown segment"}</b>
                                        <span
                                          >${plainStrategyToken(segment.action ?? "monitor")}</span
                                        >
                                      </div>
                                      <p>${segment.reason ?? "Keep accepted paper closed."}</p>
                                      <div class="kalshi-promotion-gap__criteria">
                                        <span
                                          >Brier
                                          <b
                                            >${fmt(segment.shadow_brier_score)} /
                                            ${fmt(segment.shadow_market_brier_score)}</b
                                          ></span
                                        >
                                        <span
                                          >Weight
                                          <b>${fmt(segment.candidate_weight_cap ?? 0)}</b></span
                                        >
                                        <span
                                          >Accepted
                                          <b
                                            >${segment.accepted_paper_allowed === true
                                              ? "yes"
                                              : "no"}</b
                                          ></span
                                        >
                                      </div>
                                    </article>
                                  `,
                                )}
                              </div>
                            `
                          : nothing}
                      </div>
                    `
                  : nothing}
                ${mlPromotionGapSegments.length
                  ? html`
                      <div class="kalshi-promotion-gap__segments">
                        ${mlPromotionGapSegments.map(
                          (segment) => html`
                            <article>
                              <div>
                                <b>${segment.segment_key ?? "unknown segment"}</b>
                                <span
                                  >${plainStrategyToken(segment.primary_blocker ?? "ready")} ·
                                  ${countdownScore(segment.completion_score)}/10</span
                                >
                              </div>
                              <p>${segment.next_action ?? "Keep gated paper-only learning."}</p>
                              <div class="kalshi-promotion-gap__criteria">
                                ${(segment.criteria ?? []).slice(0, 6).map(
                                  (criterion) => html`
                                    <span title=${criterion.detail ?? ""}>
                                      ${countdownCriterionLabel(criterion.label)}
                                      <b>${countdownScore(criterion.score)}/10</b>
                                    </span>
                                  `,
                                )}
                              </div>
                            </article>
                          `,
                        )}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        ${mlQualifiedSegments.length
          ? html`
              <div class="kalshi-mini-list">
                <strong>Shadow-qualified review queue</strong>
                ${mlQualifiedSegments.map(
                  (segment) => html`
                    <p>
                      ${segment.segment_key}: ${pct(segment.shadow_accuracy)} over
                      ${fmt(segment.shadow_scored ?? 0)} shadow outcomes,
                      ${money(segment.shadow_pnl_usd)}.
                    </p>
                  `,
                )}
              </div>
            `
          : html`
              <p class="kalshi-section-intro">
                No weather/crypto segment is promoted yet. Next proof:
                ${weatherCryptoMl.next_required_proof ??
                "collect 100 fresh accepted forward-paper outcomes with ≥80% accuracy, positive paper profit/loss, and market-baseline outperformance."}
              </p>
            `}
        <p class="kalshi-footnote">
          Model ${mlGovernance.model_id ?? "paper-selective"} · schema
          ${mlGovernance.feature_schema_version ?? "pending"} · label source
          ${mlGovernance.label_source ?? "paper/shadow outcomes"}.
        </p>
      </section>

      <section class="kalshi-panel kalshi-panel--deep-toggle kalshi-panel--advanced-entry">
        <div>
          <p class="kalshi-overline">Advanced Audit</p>
          <h3>Detailed proof, strategy diagnostics, and paper logs</h3>
          <p class="kalshi-section-intro">
            Everything experts need is still here: baseline proof, strategy diagnostics, weather and
            crypto evidence, and searchable audit tables.
          </p>
        </div>
        <button
          type="button"
          class="btn btn--secondary"
          aria-expanded=${props.showDeepAudit ? "true" : "false"}
          @click=${props.onToggleDeepAudit}
        >
          ${props.showDeepAudit ? "Hide Advanced Audit" : "Show Advanced Audit"}
        </button>
      </section>

      ${props.showDeepAudit
        ? html`
            <section class="kalshi-panel">
              <h3>Strategy Comparison Details${metricHelp("Strategy Comparison")}</h3>
              <p class="kalshi-section-intro">
                The Strategy Cockpit above is now the primary comparison surface. Advanced Audit
                keeps the baseline explanation and proof caveats without duplicating the large card
                grid.
              </p>
              <div class="kalshi-status-grid">
                <p>
                  <b>Named strategy lanes:</b>
                  ${fmt(strategyComparisonRows.length)} visible on the main page with P&amp;L,
                  accuracy, volume, accepted/shadow counts, unresolved trades, and next action.
                </p>
                <p>
                  <b>Standard Strategy baseline:</b>
                  ${fmt(actualStandardScored)} scored · ${pct(actualStandardAccuracy)} ·
                  ${money(actualStandardPnl)} actual accepted-paper P&amp;L.
                </p>
                <p>
                  <b>Inverse Standard Strategy:</b>
                  ${fmt(actualInverseScored)} scored · ${pct(actualInverseAccuracy)} ·
                  ${money(actualInversePnl)} actual accepted-paper P&amp;L · delta
                  ${actualPnlDelta == null ? "n/a" : signedMoney(actualPnlDelta)}.
                </p>
                <p>
                  <b>Historical inverse audit:</b>
                  ${fmt(auditScored)} audited trades · Standard ${pct(auditStandardAccuracy)} vs
                  Inverse ${pct(auditInverseAccuracy)} · audit delta ${money(auditPnlDelta)}.
                </p>
                <p>
                  <b>Why keep proof gates?</b>
                  executable quality is ${pct(auditExecutableQuality)}, so any signal still must
                  prove it works with real visible prices before future live-trading review.
                </p>
                <p>
                  <b>Next proof step:</b>
                  ${inverseForwardCandidates.length
                    ? `${fmt(inverseForwardCandidates.length)} Inverse Standard segment(s) are ready for forward-paper review.`
                    : "Keep measuring named strategy lanes and only trust clean segment-scoped paper tests."}
                </p>
              </div>
            </section>

            <section class="kalshi-panel">
              <h3>Crypto Evidence${metricHelp("Crypto Evidence")}</h3>
              <p class="kalshi-section-intro">
                Crypto is now watched as a separate paper-only lane. OpenClaw only accepts simulated
                crypto trades when the Kalshi market is parseable, the orderbook is executable, and
                an external spot-price model shows enough edge after estimated costs.
              </p>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Crypto Markets Seen",
                  fmt(cryptoEvidence.active_crypto_markets_seen),
                  cryptoEvidence.timestamp_utc
                    ? `Latest crypto evidence run: ${formatTradeTime(cryptoEvidence.timestamp_utc, props.timezone)}.`
                    : "No completed crypto evidence run yet.",
                  (cryptoEvidence.active_crypto_markets_seen ?? 0) > 0 ? "ok" : "warn",
                )}
                ${metricCard(
                  "Parseable Crypto Markets",
                  fmt(cryptoEvidence.parseable_crypto_markets),
                  "Markets with clear asset, price threshold, direction, and result-known time.",
                  (cryptoEvidence.parseable_crypto_markets ?? 0) > 0 ? "ok" : "warn",
                )}
                ${metricCard(
                  "Crypto Paper Candidates",
                  fmt(cryptoEvidence.created_count),
                  cryptoEvidence.plain_english_summary ??
                    "No crypto paper candidates have been created by the evidence lane yet.",
                  (cryptoEvidence.created_count ?? 0) > 0 ? "ok" : "warn",
                )}
                ${metricCard(
                  "Crypto Readiness",
                  cryptoReadinessLabel,
                  cryptoEvidence.crypto_readiness_summary ??
                    cryptoEvidence.next_crypto_trade_ready_unavailable_reason ??
                    "No crypto readiness timing has been published yet.",
                  cryptoReadinessStatus === "scheduled" ? "ok" : "warn",
                )}
                ${metricCard(
                  "Crypto Spot Sources",
                  cryptoEvidence.spot_assets_available?.length
                    ? cryptoEvidence.spot_assets_available.join(", ")
                    : "n/a",
                  "External BTC/ETH spot sources available for paper-only fair-value estimates.",
                  cryptoEvidence.spot_assets_available?.length ? "ok" : "warn",
                )}
              </div>
            </section>

            <section class="kalshi-panel kalshi-panel--snapshot">
              <h3>Paper Learning Snapshot</h3>
              <p class="kalshi-section-intro">
                One practical view of paper volume, scored evidence, calibration, and practice mix.
                The same numbers feed the trend chart and strategy comparison, so duplicate summary
                cards stay out of the way.
              </p>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Paper Decisions",
                  fmt(paper.total_decisions),
                  "Total paper decisions logged. Volume matters only when outcomes can be scored.",
                )}
                ${metricCard(
                  "Accepted Paper Trades",
                  fmt(accepted),
                  "Accepted simulated trades that can create P&L evidence.",
                  accepted ? "ok" : "danger",
                )}
                ${metricCard(
                  "Resolved Outcomes",
                  fmt(resolvedAcceptedOutcomes),
                  `Need ${fmt(resolvedAcceptedNeeded)} more accepted paper outcomes for the current learning gate.`,
                  resolvedAcceptedNeeded ? "danger" : "ok",
                )}
                ${metricCard(
                  "Brier Score",
                  fmt(metrics.brier_score),
                  "Forecast-quality score after outcomes resolve. Lower is better.",
                  metrics.brier_score == null ? "warn" : "ok",
                )}
                ${metricCard(
                  "Exploration Trades",
                  fmt(explorationTrades),
                  "Small simulated trades used to learn faster without live exposure.",
                  explorationTrades ? "ok" : "warn",
                )}
                ${metricCard(
                  "Forward Paper Trades",
                  fmt(forwardPaperTrades),
                  "Stricter paper trades used as proof before any future live review.",
                  forwardPaperTrades ? "ok" : "warn",
                )}
              </div>
            </section>

            <div class="kalshi-grid kalshi-grid--cards">
              <section
                class="kalshi-card kalshi-card--${pnlTone(
                  selectedPerformancePnl,
                  selectedPerformanceScored,
                )}"
              >
                <div
                  class="kalshi-card__title"
                  title=${METRIC_DEFINITIONS["Paper P&L"]}
                  aria-label=${`Paper profit/loss: ${METRIC_DEFINITIONS["Paper P&L"]}`}
                >
                  Paper profit/loss${metricHelp("Paper P&L")}
                </div>
                <div class="kalshi-card__value">${money(selectedPerformancePnl)}</div>
                <div class="kalshi-card__note">
                  ${selectedPerformanceLabel}. ${fmt(selectedPerformanceScored)} scored trades in
                  selected window. Open or unresolved paper trades are not counted.
                </div>
                <div class="kalshi-card__controls" aria-label="Paper profit/loss timeframe">
                  ${PNL_TIMEFRAMES.map(
                    (option) => html`<button
                      type="button"
                      class="kalshi-chip ${props.pnlTimeframe === option.value
                        ? "kalshi-chip--active"
                        : ""}"
                      aria-pressed=${props.pnlTimeframe === option.value ? "true" : "false"}
                      @click=${() => props.onPnlTimeframeChange(option.value)}
                    >
                      ${option.label}
                    </button>`,
                  )}
                </div>
              </section>
              ${metricCard(
                "Total Profit",
                money(performanceSelection.total_profit_usd),
                `${selectedPerformanceLabel}. Gross paper winnings before losses.`,
                performanceSelection.total_profit_usd ? "ok" : "warn",
              )}
              ${metricCard(
                "Total Loss",
                money(performanceSelection.total_loss_usd),
                `${selectedPerformanceLabel}. Gross paper losses before winnings.`,
                performanceSelection.total_loss_usd ? "danger" : "ok",
              )}
              ${metricCard(
                "Accuracy",
                pct(performanceSelection.accuracy),
                performanceSelection.accuracy == null
                  ? "Unavailable until directional paper trades resolve."
                  : `${fmt(performanceSelection.wins)} wins, ${fmt(performanceSelection.losses)} losses in ${selectedPerformanceLabel}.`,
                performanceSelection.accuracy == null ? "warn" : "ok",
              )}
            </div>

            <section class="kalshi-panel">
              <h3>Category Accuracy${metricHelp("Category Accuracy")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${COMMON_KALSHI_CATEGORIES.map((category) => {
                  const row = categoryMap.get(category.category);
                  return metricCard(
                    `${category.label} Accuracy`,
                    pct(row?.accuracy),
                    categoryAccuracyNote(row, category.label, selectedPerformanceLabel),
                    categoryAccuracyTone(row),
                  );
                })}
              </div>
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Accuracy</th>
                      <th>Wins / Losses</th>
                      <th>Scored</th>
                      <th>Net profit/loss</th>
                      <th>Total Profit</th>
                      <th>Total Loss</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${categoryAccuracy.length
                      ? categoryAccuracy.map(
                          (row) => html`<tr>
                            <td>${row.label ?? row.category ?? "Unknown / Other"}</td>
                            <td>${pct(row.accuracy)}</td>
                            <td>${fmt(row.wins)} / ${fmt(row.losses)}</td>
                            <td>${fmt(row.scored)}</td>
                            <td>${money(row.net_pnl_usd)}</td>
                            <td>${money(row.total_profit_usd)}</td>
                            <td>${money(row.total_loss_usd)}</td>
                          </tr>`,
                        )
                      : html`<tr>
                          <td colspan="7">No resolved paper trades in this timeframe yet.</td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
            </section>

            <div class="kalshi-grid kalshi-grid--cards">
              ${metricCard(
                "Strategy Scorecard",
                "ACTIVE",
                `Scorecard id: ${fmt(scorecard.scorecard_id)}.`,
                "ok",
              )}
              ${metricCard(
                "Active Paused Segments",
                fmt(activePausedSegments),
                "Active Inverse Standard Strategy paper lanes blocked from new accepted paper trades.",
                activePausedSegments ? "danger" : "ok",
              )}
              ${metricCard(
                "Standard Strategy Shadowed",
                fmt(standardShadowControlCount),
                "Standard Strategy categories kept as shadow/control while Inverse Standard Strategy learns.",
                standardShadowControlCount ? "warn" : "ok",
              )}
              ${metricCard(
                "Forward Candidates",
                fmt(scoreSummary.forward_paper_candidates),
                "Segments ready for stricter paper testing.",
                scoreSummary.forward_paper_candidates ? "ok" : "warn",
              )}
              ${metricCard(
                "Trend Chart",
                fmt(trendPoints.length),
                "Scored trade points on the live dashboard graph.",
                trendPoints.length ? "ok" : "warn",
              )}
            </div>

            <section class="kalshi-panel">
              <h3>Accuracy and paper profit/loss trend</h3>
              <div class="kalshi-control-row">
                <label>
                  Timeframe
                  <select
                    .value=${props.timeframe}
                    @change=${(event: Event) =>
                      props.onTimeframeChange((event.currentTarget as HTMLSelectElement).value)}
                  >
                    ${TREND_TIMEFRAMES.map(
                      (option) => html`<option value=${option.value}>${option.label}</option>`,
                    )}
                  </select>
                </label>
              </div>
              ${trendChart(
                trendPoints,
                props.timeframe,
                props.timezone,
                snapshot?.generated_at_utc,
                selectedActivity(metrics, props.timeframe),
              )}
              <p class="muted">
                This graph updates from real paper outcomes. Accuracy should trend up and cumulative
                paper profit/loss should trend toward positive before live review. Projected
                accuracy is a simple paper-only trend extrapolation from recent scored trades, not
                proof of future results.
              </p>
            </section>
          `
        : html`
            <section class="kalshi-panel kalshi-panel--deep-placeholder">
              <h3>Advanced Audit hidden</h3>
              <p class="kalshi-section-intro">
                The simple view above has everything needed for a quick read. Show Advanced Audit
                when you need proof gates, source diagnostics, or searchable paper logs.
              </p>
            </section>
          `}
      ${props.showDeepAudit
        ? html`
            <section class="kalshi-panel">
              <h3>Paper Volume Accelerator${metricHelp("Paper Volume Accelerator")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Evidence Yield",
                  pct(volumeMetrics.accepted_rate),
                  `${fmt(volumeMetrics.accepted_decisions)} accepted of ${fmt(volumeMetrics.total_decisions)} logged decisions.`,
                  (volumeMetrics.accepted_rate ?? 0) >= 0.05 ? "ok" : "danger",
                )}
                ${metricCard(
                  "Exploration Trades",
                  fmt(volumeMetrics.exploration_decisions),
                  "Small paper-only bets that accelerate learning.",
                  volumeMetrics.exploration_decisions ? "ok" : "warn",
                )}
                ${metricCard(
                  "Outcome Backlog",
                  fmt(volumeMetrics.outcome_backlog),
                  `Resolved rate: ${pct(volumeMetrics.resolved_rate)}.`,
                  volumeMetrics.outcome_backlog ? "warn" : "ok",
                )}
                ${metricCard(
                  "Fast Pending",
                  fmt(volumeMetrics.pending_fast_resolution_count),
                  "Pending accepted paper trades expected within 24h or already overdue.",
                  volumeMetrics.pending_fast_resolution_count ? "ok" : "warn",
                )}
                ${metricCard(
                  "Slow/Unknown Pending",
                  fmt(volumeMetrics.pending_slow_or_unknown_count),
                  "Pending accepted trades that are long-dated or missing reliable timing.",
                  volumeMetrics.pending_slow_or_unknown_count ? "danger" : "ok",
                )}
                ${metricCard(
                  "Resolved / Day",
                  fmt(volumeMetrics.resolved_accepted_outcomes_per_day),
                  "Accepted paper trades scored in the last 24 hours.",
                  (volumeMetrics.resolved_accepted_outcomes_per_day ?? 0) > 0 ? "ok" : "warn",
                )}
                <section class="kalshi-card">
                  <div class="kalshi-card__title">Overall route mix</div>
                  ${routeMixBars(paperTradeRouteMixOverallTotal)}
                  <p class="kalshi-card__note">
                    SHADOW only: ${fmt(paperTradeRouteMixOverall.SHADOW_ONLY || 0)}, EXPLORATION:
                    ${fmt(paperTradeRouteMixOverall.ACCEPT_EXPLORATION || 0)}, ACCEPTED:
                    ${fmt(paperTradeRouteMixOverall.ACCEPT_PAPER || 0)}, FORWARD:
                    ${fmt(paperTradeRouteMixOverall.FORWARD_PAPER || 0)}.
                  </p>
                </section>
                <section class="kalshi-card">
                  <div class="kalshi-card__title">Weather / Crypto route mix</div>
                  ${routeMixBars(paperTradeRouteMixWeatherCryptoTotal)}
                  <p class="kalshi-card__note">
                    EXPLORATION: ${fmt(paperTradeRouteMixWeatherCrypto.ACCEPT_EXPLORATION || 0)},
                    FORWARD: ${fmt(paperTradeRouteMixWeatherCrypto.FORWARD_PAPER || 0)}, ACCEPTED:
                    ${fmt(paperTradeRouteMixWeatherCrypto.ACCEPT_PAPER || 0)}, SHADOW:
                    ${fmt(paperTradeRouteMixWeatherCrypto.SHADOW_ONLY || 0)}.
                  </p>
                </section>
                ${metricCard(
                  "Accepted → Resolved",
                  pct(
                    volumeMetrics.accepted_to_resolved_conversion_rate ??
                      volumeMetrics.resolved_rate,
                  ),
                  "Share of accepted paper trades that now have a scored outcome.",
                  (volumeMetrics.accepted_to_resolved_conversion_rate ??
                    volumeMetrics.resolved_rate ??
                    0) >= 0.25
                    ? "ok"
                    : "warn",
                )}
                ${metricCard(
                  "Unknown Timing",
                  fmt(volumeMetrics.unknown_timing_pending_count),
                  "Pending accepted trades missing reliable result-known timing.",
                  volumeMetrics.unknown_timing_pending_count ? "danger" : "ok",
                )}
                ${metricCard(
                  "Latest Scored Age",
                  volumeMetrics.latest_scored_outcome_age_minutes == null
                    ? "n/a"
                    : `${fmt(volumeMetrics.latest_scored_outcome_age_minutes)} min`,
                  "How long since a paper trade was last scored.",
                  (volumeMetrics.latest_scored_outcome_age_minutes ?? 999999) <= 360
                    ? "ok"
                    : "warn",
                )}
                ${metricCard(
                  "Recommended Cycle Settings",
                  fmt(volumeSettings.max_auto_candidates),
                  `observe=${fmt(volumeSettings.observe_limit)}, books=${fmt(volumeSettings.max_orderbooks)}, watchlist=${fmt(volumeSettings.max_watchlist_markets)}.`,
                  "ok",
                )}
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Paper Practice Mix</h4>
                  <ul>
                    <li>
                      Weather/objective fast resolution:
                      ${pct(volumeAllocation.weather_and_objective_fast_resolution)}
                    </li>
                    <li>
                      High-liquidity simulations:
                      ${pct(volumeAllocation.high_liquidity_market_making_simulation)}
                    </li>
                    <li>
                      Historical replay research:
                      ${pct(volumeAllocation.historical_replay_research)}
                    </li>
                    <li>New hypotheses: ${pct(volumeAllocation.new_hypotheses)}</li>
                  </ul>
                </div>
                <div>
                  <h4>Next Cycle Recommendation</h4>
                  <p><b>Focused watchlist:</b> ${fmt(volumeSettings.focused_watchlist)}</p>
                  <p>
                    <b>Estimated cycles to 100 accepted:</b>
                    ${fmt(volumeMetrics.estimated_cycles_to_100_accepted)}
                  </p>
                  <p><b>Resolution priority:</b> ${fmt(volumeSettings.resolution_priority)}</p>
                  <p>
                    <b>Current learning bottleneck:</b> ${fmt(
                      plainBottleneckLabel(volumeMetrics.current_learning_bottleneck),
                    )}
                  </p>
                  <p>
                    <b>What must happen next:</b>
                    ${plainLearningText(volumeMetrics.what_must_happen_next_to_learn_faster)}
                  </p>
                  <p>
                    <b>Pending timing buckets:</b>
                    ${Object.entries(volumeMetrics.pending_resolution_buckets ?? {})
                      .map(([bucket, count]) => `${bucket}: ${count}`)
                      .join(", ") || "none"}
                  </p>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Priority</th>
                    <th>Action</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  ${volumeActions.length
                    ? volumeActions.map(
                        (action) => html`
                          <tr>
                            <td>${fmt(action.rank)}</td>
                            <td>${fmt(action.priority)}</td>
                            <td>${plainOpportunityToken(action.type)}</td>
                            <td>${plainLearningText(action.evidence)}</td>
                          </tr>
                        `,
                      )
                    : html`<tr>
                        <td colspan="4">No paper-volume actions available.</td>
                      </tr>`}
                </tbody>
              </table>
              <p class="muted">
                This section increases useful simulated practice volume only. It never enables live
                orders, cancellations, quote acceptance, RFQs, or funds movement.
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Strategy Discovery${metricHelp("Strategy Discovery")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Strategy Discovery",
                  fmt(shadowMetrics.shadow_trades),
                  "Hypothetical YES/NO/no-trade choices created from observed markets.",
                  shadowMetrics.shadow_trades ? "ok" : "warn",
                )}
                ${metricCard(
                  "Shadow Scored",
                  fmt(shadowMetrics.scored_shadow_trades),
                  `${fmt(shadowMetrics.unresolved_shadow_trades)} shadow choices still need outcomes.`,
                  shadowMetrics.scored_shadow_trades ? "ok" : "warn",
                )}
                ${metricCard(
                  "Shadow P&L",
                  money(shadowMetrics.shadow_hypothetical_pnl_usd),
                  "Hypothetical discovery P&L only; it is not accepted paper exposure.",
                  (shadowMetrics.shadow_hypothetical_pnl_usd ?? 0) >= 0 ? "ok" : "warn",
                )}
                ${metricCard(
                  "Discovery Candidates",
                  fmt(shadowReviewCandidates.length),
                  "Promising shadow patterns that may deserve bounded paper exploration review.",
                  shadowReviewCandidates.length ? "ok" : "warn",
                )}
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Shadow Choices</h4>
                  <div class="kalshi-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Scored</th>
                          <th>Win Rate</th>
                          <th>Hypothetical P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${shadowActions.length
                          ? shadowActions.map(
                              (row) => html`<tr>
                                <td>${fmt(row.action)}</td>
                                <td>${fmt(row.scored)}</td>
                                <td>${pct(row.win_rate)}</td>
                                <td>${money(row.hypothetical_pnl_usd)}</td>
                              </tr>`,
                            )
                          : html`<tr>
                              <td colspan="4">No scored shadow trades yet.</td>
                            </tr>`}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <h4>Best Shadow Patterns</h4>
                  <div class="kalshi-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Domain</th>
                          <th>Action</th>
                          <th>Scored</th>
                          <th>Win Rate</th>
                          <th>P&L</th>
                          <th>Review</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${shadowSegments.length
                          ? shadowSegments.map(
                              (row) => html`<tr>
                                <td>${fmt(row.domain ?? row.market_category ?? "unknown")}</td>
                                <td>${fmt(row.shadow_action)}</td>
                                <td>${fmt(row.directional_scored)}</td>
                                <td>${pct(row.win_rate)}</td>
                                <td>${money(row.hypothetical_pnl_usd)}</td>
                                <td>${row.eligible_for_exploration_review ? "yes" : "not yet"}</td>
                              </tr>`,
                            )
                          : html`<tr>
                              <td colspan="6">No shadow pattern scores yet.</td>
                            </tr>`}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              <p class="muted">
                ${fmt(
                  shadowDiscovery.plain_english ??
                    "Strategy discovery appears after shadow trades and outcomes are available.",
                )}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>
                Inverse Standard Strategy Audit${metricHelp("Inverse Standard Strategy Audit")}
              </h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Inverse Standard Accuracy",
                  pct(inverseMetrics.inverse_accuracy),
                  `Standard: ${pct(inverseMetrics.original_accuracy)}. Delta: ${pct(inverseMetrics.accuracy_delta_inverse_minus_original)}.`,
                  typeof inverseMetrics.inverse_accuracy === "number" &&
                    inverseMetrics.inverse_accuracy > (inverseMetrics.original_accuracy ?? 0)
                    ? "ok"
                    : "warn",
                )}
                ${metricCard(
                  "Inverse Standard P&L",
                  money(inverseMetrics.inverse_pnl_usd),
                  `Standard: ${money(inverseMetrics.original_pnl_usd)}. Delta: ${money(inverseMetrics.pnl_delta_inverse_minus_original_usd)}.`,
                  typeof inverseMetrics.inverse_pnl_usd === "number" &&
                    inverseMetrics.inverse_pnl_usd > (inverseMetrics.original_pnl_usd ?? 0)
                    ? "ok"
                    : "warn",
                )}
                ${metricCard(
                  "Executable Quality",
                  pct(inverseMetrics.executable_quality_fraction),
                  `${fmt(inverseMetrics.synthetic_or_unpriced_trades)} Inverse Standard Strategy trades are synthetic or unpriced.`,
                  (inverseMetrics.executable_quality_fraction ?? 0) >= 0.8 ? "ok" : "danger",
                )}
                ${metricCard(
                  "Forward Candidates",
                  fmt(inverseForwardCandidates.length),
                  "Inverse Standard Strategy segments must pass executable-quality and out-of-sample gates before paper exploration.",
                  inverseForwardCandidates.length ? "ok" : "warn",
                )}
              </div>
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Scored</th>
                      <th>Standard Accuracy</th>
                      <th>Inverse Standard Accuracy</th>
                      <th>Standard P&L</th>
                      <th>Inverse Standard P&L</th>
                      <th>Executable Quality</th>
                      <th>Forward Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${inverseSegments.length
                      ? inverseSegments.map(
                          (row) => html`<tr>
                            <td>${fmt(row.domain ?? "unknown")}</td>
                            <td>${fmt(row.scored)}</td>
                            <td>${pct(row.original_win_rate)}</td>
                            <td>${pct(row.inverse_win_rate)}</td>
                            <td>${money(row.original_pnl_usd)}</td>
                            <td>${money(row.inverse_pnl_usd)}</td>
                            <td>${pct(row.executable_quality_fraction)}</td>
                            <td>${row.contrarian_forward_paper_candidate ? "yes" : "not yet"}</td>
                          </tr>`,
                        )
                      : html`<tr>
                          <td colspan="8">No Inverse Standard Strategy audit segments yet.</td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Recommendation</h4>
                  <ul>
                    ${inverseRecommendations.length
                      ? inverseRecommendations.map(
                          (item) => html`<li>
                            <b>${fmt(item.status ?? "REVIEW_REQUIRED")}:</b>
                            ${fmt(item.type ?? "inverse_review")} -
                            ${fmt(
                              item.evidence ??
                                item.proposed_change ??
                                "Review Inverse Standard Strategy audit.",
                            )}
                          </li>`,
                        )
                      : html`<li>No inverse-strategy recommendation yet.</li>`}
                  </ul>
                </div>
                <div>
                  <h4>Plain English</h4>
                  <p>
                    ${fmt(
                      inverseAudit.plain_english ??
                        "Inverse Standard Strategy audit appears after resolved directional paper trades exist.",
                    )}
                  </p>
                  <p class="muted">
                    Inverse Standard Strategy is active for paper learning, but it still cannot
                    enable live trading. It can only create review-required paper tests.
                  </p>
                </div>
              </div>
            </section>

            <section class="kalshi-panel">
              <h3>Hidden Opportunities${metricHelp("Hidden Opportunities")}</h3>
              <p class="kalshi-section-intro">
                This is OpenClaw's paper-only idea filter. It looks for ways to improve, separates
                real paper lessons from possible data mistakes, and only changes paper behavior when
                the proof is clean. Live trading stays blocked.
              </p>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Found",
                  fmt(opportunityMetrics.opportunities_detected),
                  "Possible improvements or problems OpenClaw found on its own.",
                  opportunityMetrics.opportunities_detected ? "ok" : "warn",
                )}
                ${metricCard(
                  "Being Watched",
                  fmt(opportunityMetrics.shadow_forward_watch),
                  "Promising signals watched without changing strategy yet.",
                  opportunityMetrics.shadow_forward_watch ? "warn" : "ok",
                )}
                ${metricCard(
                  "Needs Repair",
                  fmt(
                    opportunityRepair.repairable_opportunities ??
                      opportunityMetrics.quality_repair_ready,
                  ),
                  "Data, timing, parser, or executable-price issues to fix first.",
                  (opportunityRepair.repairable_opportunities ??
                    opportunityMetrics.quality_repair_ready)
                    ? "danger"
                    : "ok",
                )}
                ${metricCard(
                  "Paper Tests",
                  fmt(opportunityMetrics.experiments_created),
                  "Bounded paper-only tests currently created from clean findings.",
                  opportunityMetrics.experiments_created ? "ok" : "warn",
                )}
              </div>
              <div class="kalshi-opportunity-summary">
                <div>
                  <b>What this means right now</b>
                  <p>
                    ${opportunityMetrics.experiments_created
                      ? "OpenClaw has at least one clean paper-only test running."
                      : "OpenClaw is mostly watching and repairing signals before trusting them."}
                    ${opportunityMetrics.shadow_forward_watch
                      ? ` ${fmt(opportunityMetrics.shadow_forward_watch)} possible improvements are on watch.`
                      : ""}
                    ${(opportunityRepair.repairable_opportunities ?? 0) > 0
                      ? ` ${fmt(opportunityRepair.repairable_opportunities)} findings need cleanup before they can influence paper strategy.`
                      : ""}
                  </p>
                </div>
                <div>
                  <b>Safety rule</b>
                  <p>
                    Hidden opportunities can pause bad paper lanes or start bounded paper tests.
                    They cannot place live orders or unlock live trading.
                  </p>
                </div>
              </div>

              <h4>Opportunity Lifecycle</h4>
              <p class="muted">
                Detect a possible improvement, diagnose whether it is a real edge or bad data, test
                it with bounded paper-only experiments, score it against baselines, then update only
                reversible paper strategy state.
              </p>

              <h4>What OpenClaw Found</h4>
              <div class="kalshi-opportunity-list">
                ${opportunities.length
                  ? opportunities.map((item) => {
                      const summary = opportunityPlainSummary(item);
                      return html`<article
                        class="kalshi-opportunity-card kalshi-opportunity-card--${opportunityTone(
                          item.status,
                          item.diagnosis,
                        )}"
                      >
                        <div class="kalshi-opportunity-card__top">
                          <span>${summary.detector}</span>
                          <b>${summary.promotion}</b>
                        </div>
                        <h5>${summary.headline}</h5>
                        <p>${fmt(item.evidence ?? "No evidence text available yet.")}</p>
                        <dl>
                          <div>
                            <dt>Detector id</dt>
                            <dd>${fmt(item.detector)}</dd>
                          </div>
                          <div>
                            <dt>Market area</dt>
                            <dd>${plainOpportunityToken(item.domain)}</dd>
                          </div>
                          <div>
                            <dt>Read</dt>
                            <dd>${summary.diagnosis}</dd>
                          </div>
                          <div>
                            <dt>Next step</dt>
                            <dd>${fmt(summary.action)}</dd>
                          </div>
                          <div>
                            <dt>Still needed</dt>
                            <dd>
                              ${summary.blockers.length
                                ? summary.blockers.join(", ")
                                : "No major blocker listed."}
                            </dd>
                          </div>
                        </dl>
                      </article>`;
                    })
                  : html`<p class="muted">No hidden opportunities detected yet.</p>`}
              </div>

              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Repairs To Trust The Signal${metricHelp("Opportunity Repairs")}</h4>
                  <div class="kalshi-opportunity-repairs">
                    ${opportunityRepairs.length
                      ? opportunityRepairs.map(
                          (item) => html`<article class="kalshi-repair-card">
                            <b
                              >${plainOpportunityToken(item.detector)} -
                              ${plainOpportunityToken(item.domain)}</b
                            >
                            <p>
                              ${fmt(
                                item.why_this_matters ??
                                  item.next_proof_needed ??
                                  "Repair this signal, then score it again.",
                              )}
                            </p>
                            <ul>
                              ${(item.repair_tasks ?? []).slice(0, 4).map(
                                (task) => html`<li>
                                  ${plainOpportunityToken(task.type)}:
                                  <span class="muted">${fmt(task.success_criteria)}</span>
                                </li>`,
                              )}
                            </ul>
                          </article>`,
                        )
                      : html`<p class="muted">No opportunity repairs are queued.</p>`}
                  </div>
                </div>
                <div>
                  <h4>Autonomous Paper Experiments${metricHelp("Autonomous Paper Experiments")}</h4>
                  <div class="kalshi-opportunity-repairs">
                    ${opportunityExperiments.length
                      ? opportunityExperiments.map(
                          (item) => html`<article class="kalshi-repair-card">
                            <b
                              >${plainOpportunityToken(item.experiment_type)} -
                              ${plainOpportunityToken(item.domain)}</b
                            >
                            <p>
                              ${money(item.paper_notional_usd)} simulated notional. Status:
                              ${plainOpportunityToken(item.status)}.
                            </p>
                            <p class="muted">Experiment id: ${fmt(item.experiment_type)}</p>
                            <p class="muted">
                              Live allowed:
                              ${item.live_order_allowed === false
                                ? "false"
                                : fmt(item.live_order_allowed)}
                            </p>
                          </article>`,
                        )
                      : html`<p class="muted">No active autonomous paper experiments yet.</p>`}
                  </div>
                </div>
              </div>
              <h4>Bug vs Edge Diagnostics${metricHelp("Bug vs Edge Diagnostics")}</h4>
              <p class="muted">
                ${fmt(
                  opportunityEngine.diagnostics?.plain_english ??
                    "Opportunity engine data appears after paper evidence is available.",
                )}
                Live trading remains blocked and human-gated.
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Strategy Governor${metricHelp("Strategy Governor")}</h3>
              <p class="kalshi-section-intro">
                The governor is the paper-only traffic controller. It keeps losing or dirty lanes
                from receiving more simulated notional, keeps shadow learning running, and tests
                inverse ideas only when the current candidate has clean executable evidence.
              </p>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Governor Accepted",
                  fmt(strategyGovernor.accepted_or_tested_count),
                  "Accepted exploration, accepted forward-paper, and inverse probes allowed by the governor.",
                  strategyGovernor.accepted_or_tested_count ? "ok" : "warn",
                )}
                ${metricCard(
                  "Governor Blocked",
                  fmt(strategyGovernor.shadow_or_blocked_count),
                  "Candidates routed to shadow-only, pause, or data-quality rejection.",
                  strategyGovernor.shadow_or_blocked_count ? "warn" : "ok",
                )}
                ${metricCard(
                  "Inverse Forward Tests",
                  fmt(strategyGovernor.inverse_forward_tests),
                  "Tiny segment-scoped opposite-side paper tests. No global flip.",
                  strategyGovernor.inverse_forward_tests ? "ok" : "warn",
                )}
                ${metricCard(
                  "Strategy Governor",
                  strategyGovernor.routed_count ? "ACTIVE" : "WAITING",
                  `Routed ${fmt(strategyGovernor.routed_count)} recent candidates.`,
                  strategyGovernor.routed_count ? "ok" : "warn",
                )}
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Current Paper Hypothesis</h4>
                  <p>
                    <b>${plainOpportunityToken(governorActive.governor_action ?? "none")}</b>
                  </p>
                  <p>
                    ${fmt(
                      governorActive.plain_language_reason ??
                        "No accepted governor hypothesis is active yet.",
                    )}
                  </p>
                  <p class="muted">Scope: ${fmt(governorActive.segment_scope)}</p>
                </div>
                <div>
                  <h4>Top Blocked Lane</h4>
                  <p>
                    <b>${plainOpportunityToken(governorBlocked.governor_action ?? "none")}</b>
                  </p>
                  <p>
                    ${fmt(
                      governorBlocked.plain_language_reason ??
                        "No blocked losing lane from the governor yet.",
                    )}
                  </p>
                  <p class="muted">Rollback: ${fmt(governorBlocked.rollback_rule)}</p>
                </div>
              </div>
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Route</th>
                      <th>Count</th>
                      <th>Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${governorActionCounts.length
                      ? governorActionCounts.map(
                          ([action, count]) => html`<tr>
                            <td>${plainOpportunityToken(action)}</td>
                            <td>${fmt(count)}</td>
                            <td>
                              ${[
                                "ACCEPT_FORWARD_PAPER",
                                "ACCEPT_EXPLORATION",
                                "INVERSE_FORWARD_TEST",
                              ].includes(action)
                                ? "Allowed paper risk"
                                : "Shadow-only or blocked"}
                            </td>
                          </tr>`,
                        )
                      : html`<tr>
                          <td colspan="3">No strategy-governor routes have been recorded yet.</td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <p class="muted">
                <b>Latest governor change:</b>
                ${fmt(governorLatest.plain_language_reason ?? "None yet.")}
                ${"No live orders can be enabled by this governor."}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Weather Model Audit${metricHelp("Weather Model Audit")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Audit Scope",
                  weatherAudit.scope === "current_epoch"
                    ? "Current epoch"
                    : fmt(weatherAudit.scope ?? "unknown"),
                  weatherAudit.is_current === false
                    ? "Historical baseline only. Do not use this as current proof."
                    : `Updated ${formatTradeTime(weatherAudit.updated_at_utc, props.timezone)}.`,
                  weatherAudit.is_current === false ? "danger" : "ok",
                )}
                ${metricCard(
                  "Weather Source Health",
                  weatherAudit.source_freshness?.ok ? "FRESH" : "CHECK",
                  `${fmt(weatherAudit.source_freshness?.fresh_city_count ?? 0)} of ${fmt(
                    weatherAudit.source_freshness?.checked_city_count ?? 0,
                  )} registered cities have fresh source evidence.`,
                  weatherAudit.source_freshness?.ok ? "ok" : "warn",
                )}
                ${metricCard(
                  "Scored Weather",
                  fmt(weatherAudit.scored_weather_decisions),
                  `${fmt(weatherAudit.unresolved_weather_decisions)} weather paper trades still need outcomes.`,
                  weatherAudit.scored_weather_decisions ? "ok" : "warn",
                )}
                ${metricCard(
                  "Primary Weather Action",
                  plainOpportunityToken(
                    weatherAuditAction.type ?? "collect_more_scored_weather_evidence",
                  ),
                  fmt(weatherAuditAction.recommendation ?? "No scored weather audit action yet."),
                  weatherAuditAction.priority === "high" ? "danger" : "warn",
                )}
                ${metricCard(
                  "Top Failure Mode",
                  weatherTopFailure
                    ? plainFailureMode(weatherTopFailure).label
                    : "No current failure pattern",
                  weatherTopFailure
                    ? plainFailureMode(weatherTopFailure).explanation
                    : "No current-epoch scored weather failures are available yet.",
                  "warn",
                )}
                ${metricCard(
                  "Live Safety",
                  "BLOCKED",
                  "Weather audit may change paper behavior only. Live trading remains human-gated.",
                  "ok",
                )}
              </div>
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>City</th>
                      <th>Market Type</th>
                      <th>Side</th>
                      <th>Scored</th>
                      <th>Win Rate</th>
                      <th>P&L</th>
                      <th>What Went Wrong</th>
                      <th>What OpenClaw Should Do Next</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${weatherAuditBuckets.length
                      ? weatherAuditBuckets.map(
                          (item) => html`<tr>
                            <td>${fmt(item.city ?? "unknown")}</td>
                            <td>${plainOpportunityToken(item.market_type ?? "unknown")}</td>
                            <td>${fmt(item.side ?? "unknown")}</td>
                            <td>${fmt(item.scored)}</td>
                            <td>${pct(item.win_rate)}</td>
                            <td>${money(item.simulated_pnl_usd)}</td>
                            <td>${weatherFailureModeSummary(item)}</td>
                            <td>
                              <b
                                >${fmt(
                                  item.action?.plain_english ??
                                    item.action?.recommendation ??
                                    "Keep scoring.",
                                )}</b
                              >
                              <div class="kalshi-muted">
                                ${fmt(item.plain_english_summary ?? "")}
                              </div>
                            </td>
                          </tr>`,
                        )
                      : html`<tr>
                          <td colspan="8">
                            No current-epoch weather model audit buckets yet. Older weather evidence
                            is preserved as baseline, but this table waits for current paper weather
                            trades.
                          </td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <p class="muted">
                ${fmt(
                  weatherAudit.plain_english ??
                    "Weather audit appears after weather paper trades resolve.",
                )}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Rapid Learning Plan${metricHelp("Rapid Learning Plan")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Rapid Learning Plan",
                  rapidLearning.speed_mode_enabled ? "SPEED MODE" : "BALANCED",
                  `Primary bottleneck: ${plainBottleneckLabel(rapidLearning.primary_bottleneck ?? "none")}.`,
                  rapidLearning.speed_mode_enabled ? "warn" : "ok",
                )}
                ${metricCard(
                  "Recommended Cycle Settings",
                  fmt(rapidProfile.max_auto_candidates ?? volumeSettings.max_auto_candidates),
                  `observe=${fmt(rapidProfile.observe_limit)}, books=${fmt(rapidProfile.max_orderbooks)}, fast resolution=${fmt(rapidProfile.require_fast_resolution)}.`,
                  "ok",
                )}
                ${metricCard(
                  "Scored Trades",
                  fmt(rapidTargets.minimum_resolved_outcomes),
                  `Target accepted per cycle: ${fmt(rapidTargets.accepted_paper_trades_per_cycle)}. Prefer resolution within ${fmt(rapidTargets.prefer_resolution_within_hours)}h.`,
                  "ok",
                )}
                ${metricCard(
                  "No-Live Validator",
                  rapidProofRules.live_order_allowed === false ? "SAFE" : "CHECK",
                  `Exploration is learning only: ${fmt(rapidProofRules.exploration_counts_as_learning_not_live_proof)}. Live auto-apply: ${fmt(rapidProofRules.auto_apply_to_live_allowed)}.`,
                  rapidProofRules.live_order_allowed === false ? "ok" : "danger",
                )}
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>Current Bottlenecks</h4>
                  <ul>
                    ${rapidBottlenecks.length
                      ? rapidBottlenecks.map(
                          (item) => html`<li>
                            <b>${fmt(item.severity)}:</b> ${plainLearningText(item.evidence)}
                            <span class="muted">${plainLearningText(item.fix)}</span>
                          </li>`,
                        )
                      : html`<li>No rapid-learning bottlenecks detected.</li>`}
                  </ul>
                </div>
                <div>
                  <h4>Read Efficiency</h4>
                  <ul>
                    <li>Batch orderbooks: ${fmt(rapidEfficiency.use_batch_orderbooks)}</li>
                    <li>
                      Batch orderbook tickers: ${fmt(rapidEfficiency.batch_orderbook_limit_tickers)}
                    </li>
                    <li>
                      Batch candlesticks for historical replay:
                      ${fmt(rapidEfficiency.use_batch_candlesticks_for_historical_replay)}
                    </li>
                    <li>Avoid blind polling: ${fmt(rapidEfficiency.avoid_blind_polling)}</li>
                  </ul>
                </div>
              </div>
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Domain</th>
                      <th>Current Count</th>
                      <th>Next Target</th>
                      <th>Rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rapidDomainTargets.length
                      ? rapidDomainTargets.map(
                          (target) => html`<tr>
                            <td>${fmt(target.domain)}</td>
                            <td>${fmt(target.current_decision_count)}</td>
                            <td>${fmt(target.target)}</td>
                            <td>${fmt(target.rule)}</td>
                          </tr>`,
                        )
                      : html`<tr>
                          <td colspan="4">No domain targets available yet.</td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <p class="muted">
                Rapid learning is automatic in paper mode, but live trading remains blocked until
                separate statistical proof and human approval exist.
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Strategy Health${metricHelp("Strategy Lessons")}</h3>
              <div class="kalshi-grid kalshi-grid--cards">
                ${metricCard(
                  "Strategy Lessons",
                  fmt(lessonsLearned.length),
                  improvementSummary.plain_english ??
                    "Lessons appear after accepted paper trades resolve.",
                  lessonsLearned.length ? "ok" : "warn",
                )}
                ${metricCard(
                  "Active Paused Segments",
                  fmt(activePausedSegments),
                  "Paper lanes currently blocked from accepted practice. Loss-warning lanes stay unpaused so OpenClaw can keep learning.",
                  activePausedSegments ? "danger" : "ok",
                )}
                ${metricCard(
                  "Standard Strategy Shadowed",
                  fmt(standardShadowControlCount),
                  "Standard Strategy is preserved as the baseline and shadow/control, not active paper risk.",
                  standardShadowControlCount ? "warn" : "ok",
                )}
                ${metricCard(
                  "Forward Candidates",
                  fmt(scoreSummary.forward_paper_candidates),
                  "Only these lanes may move to stricter forward-paper proof, never straight to live.",
                  scoreSummary.forward_paper_candidates ? "ok" : "warn",
                )}
              </div>
              <div class="kalshi-grid kalshi-grid--two">
                <div>
                  <h4>What OpenClaw Learned</h4>
                  <ul>
                    ${lessonsLearned.length
                      ? lessonsLearned.slice(0, 4).map(
                          (lesson) => html`<li>
                            <b>${fmt(lesson.title)}</b><br />
                            <span>${fmt(lesson.segment_label)}</span><br />
                            <span class="muted">${fmt(lesson.evidence)}</span>
                          </li>`,
                        )
                      : html`<li>No scored lessons yet.</li>`}
                  </ul>
                </div>
                <div>
                  <h4>What Changes Next</h4>
                  <ul>
                    ${(improvementSummary.what_needs_to_happen_next ?? []).length
                      ? (improvementSummary.what_needs_to_happen_next ?? []).map(
                          (item) => html`<li>${item}</li>`,
                        )
                      : html`<li>
                          Prioritize fast-resolving paper candidates and outcome scoring.
                        </li>`}
                  </ul>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Bucket</th>
                    <th>What We Learned</th>
                    <th>Change</th>
                    <th>Metric To Watch</th>
                  </tr>
                </thead>
                <tbody>
                  ${lessonsLearned.length
                    ? lessonsLearned.map(
                        (lesson) => html`
                          <tr>
                            <td><strong>${fmt(lesson.title)}</strong></td>
                            <td>
                              ${fmt(lesson.segment_label)}<br />
                              <span class="muted">Confidence: ${fmt(lesson.confidence)}</span>
                            </td>
                            <td>${fmt(lesson.evidence)}</td>
                            <td>${fmt(lesson.change)}</td>
                            <td>${fmt(lesson.metric_to_watch)}</td>
                          </tr>
                        `,
                      )
                    : html`<tr>
                        <td colspan="5">No scored strategy lessons yet.</td>
                      </tr>`}
                </tbody>
              </table>
              <p class="muted">
                Plain English: OpenClaw groups similar paper trades into buckets. Loss-warning
                segments are still allowed to keep collecting paper evidence, but they are marked so
                you know they are currently losing or inaccurate. Active paused segments are true
                paper blocks. Standard Strategy shadowed means Standard Strategy is still measured
                as a control, not actively practiced. Blocked transfer means a lesson cannot spill
                into unrelated markets. Brier is a probability-quality score where lower is better;
                if OpenClaw's Brier is worse than market Brier, the market was better calibrated
                than our
                model.${noEvidenceHiddenCount > 0 || extraScoredHiddenCount > 0
                  ? ` Hidden for readability: ${[
                      noEvidenceHiddenCount > 0
                        ? `${fmt(noEvidenceHiddenCount)} no-evidence blocked bucket${noEvidenceHiddenCount === 1 ? "" : "s"}`
                        : "",
                      extraScoredHiddenCount > 0
                        ? `${fmt(extraScoredHiddenCount)} additional scored bucket${extraScoredHiddenCount === 1 ? "" : "s"}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}.`
                  : ""}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Strategy Learning Map${metricHelp("Strategy Learning Map")}</h3>
              <table>
                <thead>
                  <tr>
                    <th>Domain</th>
                    <th>Decisions</th>
                    <th>Accepted</th>
                    <th>Scored</th>
                    <th>Win Rate</th>
                    <th>P&L</th>
                    <th>Brier</th>
                    <th>Transfer Blocked</th>
                  </tr>
                </thead>
                <tbody>
                  ${domainPerformance.length
                    ? domainPerformance.map(
                        (row) => html`
                          <tr>
                            <td>${fmt(row.domain)}</td>
                            <td>${fmt(row.decisions)}</td>
                            <td>${fmt(row.accepted)}</td>
                            <td>${fmt(row.scored)}</td>
                            <td>${pct(row.win_rate)}</td>
                            <td>${money(row.simulated_pnl_usd)}</td>
                            <td>${fmt(row.brier_score)}</td>
                            <td>${fmt(row.transfer_blocked)}</td>
                          </tr>
                        `,
                      )
                    : html`<tr>
                        <td colspan="8">No domain-level scored evidence yet.</td>
                      </tr>`}
                </tbody>
              </table>
              <div class="kalshi-grid kalshi-grid--two kalshi-learning-map__lists">
                <div>
                  <h4>Transfer-Safe Lessons</h4>
                  <ul>
                    ${listItems(learningMap.transfer_safe_lessons)}
                  </ul>
                </div>
                <div>
                  <h4>Domain-Only Lessons</h4>
                  <ul>
                    ${listItems(learningMap.domain_only_lessons)}
                  </ul>
                </div>
              </div>
              <p class="muted">
                Cross-domain strategy transfer is blocked by default. Broad lessons are limited to
                structural execution and data-quality rules like liquidity, spread, depth,
                staleness, fill quality, fees, and time to close.
              </p>
              <p class="muted">
                <b>Negative transfer warnings${metricHelp("Negative Transfer Warnings")}:</b>
                ${learningMap.negative_transfer_warnings?.length
                  ? learningMap.negative_transfer_warnings.join("; ")
                  : "None"}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Decision Quality</h3>
              ${bar("Accepted", decisionQuality.accepted ?? 0, total, "ok")}
              ${bar("Explore", explorationTrades, total, "ok")}
              ${bar("Forward", forwardPaperTrades, total, "ok")}
              ${bar("No Trade", decisionQuality.no_trade ?? 0, total, "warn")}
              ${bar("Rejected", decisionQuality.rejected ?? 0, total, "danger")}
              <p class="muted">
                Accepted rate: ${pct(distance.accepted_rate)}. Missing outcome rate:
                ${pct(metrics.missing_outcome_rate)}.
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Live-Readiness Funnel</h3>
              ${bar("Observed", snapshot?.log_counts?.market_observations ?? 0, 100, "ok")}
              ${bar("Candidates", total, Math.max(total, 1), "warn")}
              ${bar("Fair Values", externalFairValues, Math.max(total, 1), "warn")}
              ${bar("Explore", explorationTrades, Math.max(accepted, explorationTrades, 1), "ok")}
              ${bar("Forward", forwardPaperTrades, Math.max(accepted, forwardPaperTrades, 1), "ok")}
              ${bar("Resolved", distance.resolved_outcomes ?? 0, 100, "danger")}
              <p class="muted">
                Exploration trades teach the system. Forward paper trades test whether the lesson
                holds. Live review remains blocked until evidence is strong.
              </p>
            </section>

            <div class="kalshi-grid kalshi-grid--two">
              <section class="kalshi-panel">
                <h3>Top Acceleration Action</h3>
                <p>
                  <span class="pill">${fmt(topAction.priority)}</span>
                  ${plainOpportunityToken(topAction.type)}
                </p>
                <p>${plainLearningText(topAction.evidence)}</p>
                <p class="muted">${plainLearningText(topAction.implementation_hint)}</p>
              </section>
              <section class="kalshi-panel">
                <h3>Live Blockers</h3>
                <ul>
                  ${listItems(live.blockers)}
                </ul>
              </section>
            </div>

            <div class="kalshi-grid kalshi-grid--three">
              ${metricCard(
                "No-Live Validator",
                snapshot?.no_live_validator?.critical_failures?.length ? "FAIL" : "PASS",
                "Write-capable behavior scan.",
                snapshot?.no_live_validator?.critical_failures?.length ? "danger" : "ok",
              )}
              ${metricCard(
                "Scheduled Runs",
                fmt(scheduler.scheduled_run_count),
                `Latest: ${fmt(scheduler.latest_scheduled_completed_at_utc)}`,
                scheduler.latest_scheduled_ok ? "ok" : "warn",
              )}
              ${metricCard(
                "Weather Runs",
                fmt(scheduler.weather_run_count),
                `Latest: ${fmt(scheduler.latest_weather_timestamp_utc)}`,
                scheduler.latest_weather_ok ? "ok" : "warn",
              )}
            </div>

            <div class="kalshi-grid kalshi-grid--two">
              <section class="kalshi-panel">
                <h3>Ranked Actions</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Priority</th>
                      <th>Action</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${rankedActions.map(
                      (action) => html`
                        <tr>
                          <td>${fmt(action.rank)}</td>
                          <td>${fmt(action.priority)}</td>
                          <td>${plainOpportunityToken(action.type)}</td>
                          <td>${plainLearningText(action.evidence)}</td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </section>
              <section class="kalshi-panel">
                <h3>Top No-Trade Reasons</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Reason</th>
                      <th>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${reasons.length
                      ? reasons.map(
                          ([reason, count]) =>
                            html`<tr>
                              <td>${reason}</td>
                              <td>${count}</td>
                            </tr>`,
                        )
                      : html`<tr>
                          <td>None</td>
                          <td>0</td>
                        </tr>`}
                  </tbody>
                </table>
              </section>
            </div>

            <div class="kalshi-grid kalshi-grid--three">
              ${metricCard(
                "Weather Parsed",
                fmt(weather.latest_run_parsed),
                "Latest weather cycle candidates.",
              )}
              ${metricCard(
                "Weather Trade Ready",
                fmt(weather.latest_run_trade_ready),
                "True parse-ready weather markets.",
                weather.latest_run_trade_ready ? "ok" : "warn",
              )}
              ${metricCard(
                "Observations",
                fmt(snapshot?.log_counts?.market_observations),
                "Read-only market/orderbook snapshots.",
              )}
            </div>

            <section class="kalshi-panel">
              <h3>Weather Expansion${metricHelp("Weather Expansion")}</h3>
              <div class="kalshi-grid kalshi-grid--three">
                ${metricCard(
                  "Weather City Coverage",
                  `${fmt(weatherExpansion.active_trade_ready_city_count ?? weatherExpansion.covered_city_count)} / ${fmt(weatherExpansion.registered_city_count)}`,
                  "Active trade-ready weather cities found now / registered watchlist cities.",
                  (weatherExpansion.active_trade_ready_city_count ??
                    weatherExpansion.covered_city_count)
                    ? "ok"
                    : "warn",
                )}
                ${metricCard(
                  "Weather Parsed",
                  fmt(weather.latest_discovery_parsed),
                  "Latest discovery parsed markets.",
                )}
                ${metricCard(
                  "Weather Trade Ready",
                  fmt(weather.latest_discovery_trade_ready),
                  "Latest discovery trade-ready markets.",
                  weather.latest_discovery_trade_ready ? "ok" : "warn",
                )}
              </div>
              <p class="muted">
                <b>Trade-ready now:</b>
                ${weatherTradeReadyCities.length ? weatherTradeReadyCities.join(", ") : "None"}
              </p>
              <p class="muted">
                <b>Waiting for active Kalshi markets:</b>
                ${weatherWaitingCities.length ? weatherWaitingCities.join(", ") : "None"}
              </p>
              <p class="muted">
                <b>Needs parser/model work:</b>
                ${weatherParserGapCities.length ? weatherParserGapCities.join(", ") : "None"}
              </p>
              <p class="muted">
                ${weather.weather_expansion?.current_trade_ready_note
                  ? html`${plainLearningText(weather.weather_expansion.current_trade_ready_note)}<br />`
                  : nothing}
                ${weather.why_not_trading
                  ? html`${plainLearningText(weather.why_not_trading)}<br />`
                  : nothing}
                OpenClaw only marks a city trade-ready when a real active Kalshi market exists, the
                weather parser extracts the city/type/strike/direction/rules, and the weather model
                can externally price it. If Kalshi has not listed an active eligible market,
                OpenClaw keeps the city registered and waiting rather than fabricating a trade-ready
                signal.
              </p>
              <p class="muted">
                <b>Unsupported weather series found:</b>
                ${weatherExpansion.unsupported_weather_series_cities?.length
                  ? weatherExpansion.unsupported_weather_series_cities.join(", ")
                  : "None"}
              </p>
              <p class="muted">
                <b>Discovery approach:</b>
                ${weatherExpansion.discovery_approach?.length
                  ? weatherExpansion.discovery_approach.join("; ")
                  : "Kalshi Climate and Weather series-first discovery; city alias fallback for Kalshi shorthand tickers/titles; external weather source pricing before paper trades; model-backed trade-ready gating before accepted paper bets"}
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Next 50 Upcoming Paper Trades To Resolve</h3>
              <p class="muted">
                ${fmt(pending.count)} unresolved accepted paper trades. Showing the next
                ${fmt(pendingTrades.length)} future-timed trades,
                ${"ordered by soonest expected result-known time."} ${fmt(pending.overdue_count)}
                older trades are separated below because their expected result time passed but
                Kalshi has not exposed a YES/NO result field yet. Simulated exposure:
                ${money(pending.total_unresolved_exposure_usd)}. Average estimated success odds:
                ${pct(pending.average_estimated_success_probability)}.
                ${pendingTradesHidden
                  ? `${fmt(pendingTradesHidden)} additional upcoming rows are held out of the DOM for dashboard speed.`
                  : ""}
              </p>
              ${auditControls(
                props,
                "pending",
                "upcoming trades",
                pendingTradesAll,
                pendingTradesFiltered,
                pendingWindow,
                pendingQuery,
                pendingTrades,
                pendingMeta,
              )}
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Bet</th>
                      <th>What Has To Happen</th>
                      <th>Expected Result Known</th>
                      <th>Est. Success</th>
                      <th>Entry</th>
                      <th>Stake</th>
                      <th>If Win / Wrong</th>
                      <th>Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${pendingTrades.length
                      ? pendingTrades.map(
                          (trade) => html`
                            <tr>
                              <td>${formatTradeTime(trade.timestamp_utc, props.timezone)}</td>
                              <td
                                class="kalshi-pending-market"
                                title=${trade.bet_summary ?? nothing}
                              >
                                <b>${fmt(trade.market_ticker)}</b>
                                <span
                                  >${shortText(trade.bet_summary ?? trade.market_title, 120)}</span
                                >
                              </td>
                              <td
                                class="kalshi-pending-condition"
                                title=${trade.win_condition ?? nothing}
                              >
                                ${shortText(trade.win_condition, 150)}
                              </td>
                              <td>
                                ${formatResultKnownTime(
                                  trade.expected_result_known_time_utc,
                                  trade.result_known_time_source_label,
                                  trade.result_known_timing_note,
                                  props.timezone,
                                  snapshot?.generated_at_utc,
                                )}
                              </td>
                              <td>${pct(trade.estimated_success_probability)}</td>
                              <td>
                                ${cents(trade.paper_fill_price_cents)} /
                                ${pct(trade.market_probability_at_entry)}
                              </td>
                              <td>${money(trade.simulated_size_usd)}</td>
                              <td>
                                ${money(trade.paper_profit_if_win_usd)} /
                                ${money(trade.paper_loss_if_wrong_usd)}
                              </td>
                              <td>${fmt(trade.evidence_tier)}</td>
                            </tr>
                          `,
                        )
                      : html`<tr>
                          <td colspan="9">
                            No upcoming accepted paper trades with future expected result timing.
                          </td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <p class="muted">
                Est. Success is OpenClaw's fair probability for the selected side at decision time.
                Entry is the simulated fill price and market-implied odds at entry, not a fresh live
                quote. If Win / Wrong shows estimated paper profit if the bet wins and paper loss if
                it loses. Expected Result Known uses logged Kalshi timing plus settlement timer data
                when available and says Unknown rather than guessing.
              </p>
            </section>

            <section class="kalshi-panel">
              <h3>Overdue Paper Trades Awaiting Kalshi Result</h3>
              <p class="muted">
                These paper trades are old because their expected result-known time has passed, but
                OpenClaw has not found a trusted Kalshi YES/NO result field yet. They are not scored
                until a read-only market result is available, which prevents fake wins/losses and
                false accuracy.
                ${overduePendingTradesHidden
                  ? `${fmt(overduePendingTradesHidden)} additional overdue rows are held out of the DOM for dashboard speed.`
                  : ""}
              </p>
              ${auditControls(
                props,
                "overdue",
                "overdue trades",
                overduePendingTradesAll,
                overduePendingTradesFiltered,
                overdueWindow,
                overdueQuery,
                overduePendingTrades,
                overdueMeta,
              )}
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Bet</th>
                      <th>What Has To Happen</th>
                      <th>Expected Result Known</th>
                      <th>Est. Success</th>
                      <th>Stake</th>
                      <th>Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${overduePendingTrades.length
                      ? overduePendingTrades.map(
                          (trade) => html`
                            <tr>
                              <td>
                                <b>${fmt(trade.resolution_status_label ?? "Overdue")}</b>
                                <span class="muted">
                                  ${fmt(trade.hours_overdue)} hours past expected result time
                                </span>
                              </td>
                              <td
                                class="kalshi-pending-market"
                                title=${trade.bet_summary ?? nothing}
                              >
                                <b>${fmt(trade.market_ticker)}</b>
                                <span
                                  >${shortText(trade.bet_summary ?? trade.market_title, 120)}</span
                                >
                              </td>
                              <td
                                class="kalshi-pending-condition"
                                title=${trade.win_condition ?? nothing}
                              >
                                ${shortText(trade.win_condition, 150)}
                              </td>
                              <td>
                                ${formatResultKnownTime(
                                  trade.expected_result_known_time_utc,
                                  trade.result_known_time_source_label,
                                  trade.result_known_timing_note,
                                  props.timezone,
                                  snapshot?.generated_at_utc,
                                )}
                              </td>
                              <td>${pct(trade.estimated_success_probability)}</td>
                              <td>${money(trade.simulated_size_usd)}</td>
                              <td>${fmt(trade.evidence_tier)}</td>
                            </tr>
                          `,
                        )
                      : html`<tr>
                          <td colspan="7">
                            No overdue accepted paper trades waiting on a Kalshi result field.
                          </td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
            </section>

            <section class="kalshi-panel">
              <h3>Recent Paper Bets</h3>
              <p class="muted">
                Showing ${fmt(recentTrades.length)} of ${fmt(recent.count)} accepted paper bets,
                newest first. ${fmt(recent.resolved_in_shown)} visible rows are resolved and
                ${fmt(recent.pending_in_shown)} are still pending. This all-time audit log is
                preserved for review; active-epoch performance cards still use the active epoch.
                ${recentTradesHidden
                  ? `${fmt(recentTradesHidden)} additional recent rows are held out of the DOM for dashboard speed.`
                  : ""}
              </p>
              ${auditControls(
                props,
                "recent",
                "recent bets",
                recentTradesAll,
                recentTradesFiltered,
                recentWindow,
                recentQuery,
                recentTrades,
                recentMeta,
              )}
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Bet</th>
                      <th>Side</th>
                      <th>Expected Result Known</th>
                      <th>Est. Success</th>
                      <th>Stake</th>
                      <th>Outcome</th>
                      <th>Result</th>
                      <th>Paper P&L</th>
                      <th>Tier</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentTrades.length
                      ? recentTrades.map(
                          (trade) => html`
                            <tr>
                              <td>${formatTradeTime(trade.timestamp_utc, props.timezone)}</td>
                              <td
                                class="kalshi-pending-market"
                                title=${trade.bet_summary ?? nothing}
                              >
                                <b>${fmt(trade.market_ticker)}</b>
                                <span
                                  >${shortText(trade.bet_summary ?? trade.market_title, 130)}</span
                                >
                              </td>
                              <td>${fmt(trade.side)}</td>
                              <td>
                                ${formatResultKnownTime(
                                  trade.expected_result_known_time_utc,
                                  trade.result_known_time_source_label,
                                  trade.result_known_timing_note,
                                  props.timezone,
                                  snapshot?.generated_at_utc,
                                )}
                              </td>
                              <td>${pct(trade.estimated_success_probability)}</td>
                              <td>${money(trade.simulated_size_usd)}</td>
                              <td>${fmt(trade.outcome_status)}</td>
                              <td>${fmt(trade.paper_result ?? "pending")}</td>
                              <td>${money(trade.paper_pnl_usd)}</td>
                              <td>${fmt(trade.evidence_tier)}</td>
                            </tr>
                          `,
                        )
                      : html`<tr>
                          <td colspan="10">No accepted paper bet history yet.</td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
              <h4>Latest Resolved Paper Results</h4>
              <p class="muted">
                These are the most recently scored paper bets, so outcome, result, and paper P&L
                should be populated here whenever scoring is working.
                ${recentResolvedTradesHidden
                  ? `${fmt(recentResolvedTradesHidden)} additional resolved rows are held out of the DOM for dashboard speed.`
                  : ""}
              </p>
              ${auditControls(
                props,
                "resolved",
                "resolved bets",
                recentResolvedTradesAll,
                recentResolvedTradesFiltered,
                resolvedWindow,
                resolvedQuery,
                recentResolvedTrades,
                resolvedMeta,
              )}
              <div class="kalshi-table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Scored</th>
                      <th>Bet</th>
                      <th>Side</th>
                      <th>Outcome</th>
                      <th>Result</th>
                      <th>Paper P&L</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${recentResolvedTrades.length
                      ? recentResolvedTrades.map(
                          (trade) => html`
                            <tr>
                              <td>
                                ${formatTradeTime(trade.settlement_checked_at_utc, props.timezone)}
                              </td>
                              <td
                                class="kalshi-pending-market"
                                title=${trade.win_condition ?? trade.bet_summary ?? nothing}
                              >
                                <b>${fmt(trade.market_ticker)}</b>
                                <span
                                  >${shortText(
                                    trade.win_condition ?? trade.bet_summary ?? trade.market_title,
                                    150,
                                  )}</span
                                >
                              </td>
                              <td>${fmt(trade.side)}</td>
                              <td>
                                ${trade.outcome_yes === 1
                                  ? "YES"
                                  : trade.outcome_yes === 0
                                    ? "NO"
                                    : "n/a"}
                              </td>
                              <td>${fmt(trade.paper_result)}</td>
                              <td>${money(trade.paper_pnl_usd)}</td>
                              <td>${fmt(trade.settlement_source)}</td>
                            </tr>
                          `,
                        )
                      : html`<tr>
                          <td colspan="7">
                            No resolved paper bets are available in the current dashboard scope yet.
                          </td>
                        </tr>`}
                  </tbody>
                </table>
              </div>
            </section>
          `
        : nothing}
    </div>
  `;
}
