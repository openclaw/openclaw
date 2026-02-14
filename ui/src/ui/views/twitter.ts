/**
 * Twitter dashboard view with tabs
 */

import type { TwitterData } from "../controllers/twitter.js";

export function renderTwitterView(
  data: TwitterData | null,
  loading: boolean,
  activeTab: "dashboard" | "relationships" = "dashboard",
): string {
  return `
    <div class="twitter-view">
      <div class="twitter-tabs">
        <button 
          class="tab-button ${activeTab === "dashboard" ? "active" : ""}" 
          data-tab="dashboard"
        >
          📊 Dashboard
        </button>
        <button 
          class="tab-button ${activeTab === "relationships" ? "active" : ""}" 
          data-tab="relationships"
        >
          🌐 Relationships
        </button>
      </div>

      <div class="twitter-content">
        <div class="tab-panel ${activeTab === "dashboard" ? "active" : ""}" data-panel="dashboard">
          ${renderDashboard(data, loading)}
        </div>
        <div class="tab-panel ${activeTab === "relationships" ? "active" : ""}" data-panel="relationships">
          <div id="twitter-graph-container" class="graph-container"></div>
        </div>
      </div>
    </div>
  `;
}

function renderDashboard(data: TwitterData | null, loading: boolean): string {
  if (loading) {
    return `
      <div class="loading">
        <div class="spinner"></div>
        <p>Loading Twitter data...</p>
      </div>
    `;
  }

  if (!data) {
    return `
      <div class="error">Failed to load Twitter data. Check gateway logs.</div>
    `;
  }

  const { profile, engagement, tweets, alerts } = data;

  return `
    ${
      alerts.length > 0
        ? `
      <div class="alerts-section">
        ${alerts
          .map(
            (alert) => `
          <div class="alert alert-${alert.severity}">
            <strong>${alert.type.toUpperCase()}:</strong> ${alert.message}
          </div>
        `,
          )
          .join("")}
      </div>
    `
        : ""
    }

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Followers</div>
        <div class="stat-value">${profile.followers.toLocaleString()}</div>
        ${
          profile.followers_growth_24h !== 0
            ? `
          <div class="stat-change ${profile.followers_growth_24h > 0 ? "positive" : "negative"}">
            ${profile.followers_growth_24h > 0 ? "+" : ""}${profile.followers_growth_24h} (24h)
          </div>
        `
            : ""
        }
      </div>

      <div class="stat-card">
        <div class="stat-label">Following</div>
        <div class="stat-value">${profile.following.toLocaleString()}</div>
        <div class="stat-meta">Ratio: ${profile.ff_ratio}</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Tweets</div>
        <div class="stat-value">${profile.tweet_count.toLocaleString()}</div>
        <div class="stat-meta">${profile.tweets_last_7d} last 7d</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Engagement</div>
        <div class="stat-value">${engagement.rate_avg_7d.toFixed(2)}%</div>
        <div class="stat-meta">Avg last 7d</div>
      </div>
    </div>

    <div class="tweets-section">
      <h3>Recent Tweets</h3>
      <div class="tweets-list">
        ${tweets
          .slice(0, 5)
          .map(
            (tweet) => `
          <div class="tweet-card">
            <div class="tweet-text">${escapeHtml(tweet.text)}</div>
            <div class="tweet-metrics">
              <span>❤️ ${tweet.likes}</span>
              <span>🔄 ${tweet.retweets}</span>
              <span>💬 ${tweet.replies}</span>
              ${tweet.impressions > 0 ? `<span>👁️ ${tweet.impressions}</span>` : ""}
              <span class="engagement-rate">${tweet.engagement_rate}% engagement</span>
            </div>
            <div class="tweet-meta">${new Date(tweet.created_at).toLocaleString()}</div>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>

    ${
      data.lastUpdated
        ? `
      <div class="view-footer">
        <div class="last-updated">Last updated: ${new Date(data.lastUpdated).toLocaleString()}</div>
      </div>
    `
        : ""
    }
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
