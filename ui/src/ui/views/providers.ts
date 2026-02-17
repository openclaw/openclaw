import { html, nothing } from "lit";
import type { AuthProviderEntry, OAuthFlowState } from "../controllers/auth.ts";
import type {
  ModelCostTier,
  ProviderHealthEntry,
  ProviderModelEntry,
  UsageWindowEntry,
} from "../controllers/providers-health.ts";
import { icons } from "../icons.ts";
import { renderEmptyState } from "../render-utils.ts";

export type ProvidersProps = {
  loading: boolean;
  error: string | null;
  entries: ProviderHealthEntry[];
  updatedAt: number | null;
  showAll: boolean;
  expandedId: string | null;
  instanceCount: number;
  sessionCount: number | null;
  agentRunning: boolean;
  modelAllowlist: Set<string>;
  primaryModel: string | null;
  modelFallbacks: string[];
  modelsSaving: boolean;
  modelsCostFilter: "all" | "high" | "medium" | "low" | "free";
  authConfigProvider: string | null;
  authConfigSaving: boolean;
  authProvidersList: AuthProviderEntry[] | null;
  oauthFlow: OAuthFlowState | null;
  removingProvider: string | null;
  onRefresh: () => void;
  onToggleShowAll: () => void;
  onToggleExpand: (id: string) => void;
  onToggleModel: (key: string) => void;
  onSetPrimary: (key: string) => void;
  onSaveModels: () => void;
  onCostFilterChange: (filter: "all" | "high" | "medium" | "low" | "free") => void;
  onConfigureProvider: (id: string | null) => void;
  onSaveCredential: (
    provider: string,
    credential: string,
    credentialType: "api_key" | "token",
  ) => void;
  onStartOAuth: (provider: string) => void;
  onCancelOAuth: () => void;
  onSubmitOAuthCode: (code: string) => void;
  onRemoveCredential: (provider: string) => void;
};

export function renderProviders(props: ProvidersProps) {
  const detectedCount = props.entries.filter((e) => e.detected).length;
  const totalCount = props.entries.length;

  return html`
    <section class="grid grid-cols-3" style="margin-bottom: 18px;">
      <div class="card stat-card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${props.instanceCount}</div>
        <div class="muted">Active presence beacons.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${props.sessionCount ?? "n/a"}</div>
        <div class="muted">Tracked session keys.</div>
      </div>
      <div class="card stat-card">
        <div class="stat-label">Agent</div>
        <div class="stat-value ${props.agentRunning ? "ok" : ""}">${props.agentRunning ? "Running" : "Idle"}</div>
        <div class="muted">${props.agentRunning ? "An agent run is in progress." : "No active agent run."}</div>
      </div>
    </section>

    ${renderSystemModelConfig(props)}

    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: flex-start;">
        <div>
          <div class="card-title">Provider Health</div>
          <div class="card-sub">
            ${detectedCount} detected${props.showAll ? ` / ${totalCount} total` : ""}
            ${props.updatedAt ? html` &mdash; updated ${formatTimeAgo(props.updatedAt)}` : nothing}
          </div>
        </div>
        <div class="row" style="gap: 8px;">
          <label class="row" style="gap: 4px; cursor: pointer; font-size: 13px;">
            <input
              type="checkbox"
              ?checked=${props.showAll}
              @change=${props.onToggleShowAll}
            />
            Show all
          </label>
          <button class="btn" ?disabled=${props.loading} @click=${props.onRefresh}>
            ${props.loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      ${
        props.error
          ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
          : nothing
      }

      <div style="margin-top: 16px; display: flex; flex-direction: column; gap: 8px;">
        ${
          props.entries.length === 0
            ? renderEmptyState({
                icon: icons.plug,
                title: "No providers detected",
                subtitle: "Configure API keys to enable providers.",
              })
            : props.entries.map((entry) =>
                renderProviderCard(entry, props.expandedId === entry.id, props, () =>
                  props.onToggleExpand(entry.id),
                ),
              )
        }
      </div>
    </section>
  `;
}

function resolveAuthInfo(entry: ProviderHealthEntry, _props: ProvidersProps) {
  const authModes = entry.authModes ?? [];
  const hasApiKey = authModes.includes("api-key");
  const hasToken = authModes.includes("token");
  const hasOAuth = authModes.includes("oauth");
  const hasAwsSdk = !hasApiKey && !hasToken && authModes.includes("aws-sdk");
  const canConfigure = hasApiKey || hasToken;
  return { authModes, hasApiKey, hasToken, hasOAuth, hasAwsSdk, canConfigure };
}

function renderProviderCard(
  entry: ProviderHealthEntry,
  expanded: boolean,
  props: ProvidersProps,
  onToggle: () => void,
) {
  const color = getHealthColor(entry.healthStatus);
  const label = getHealthLabel(entry.healthStatus);
  const dotStyle = `width: 8px; height: 8px; border-radius: 50%; background: ${color}; flex-shrink: 0;`;
  const isConfiguring = props.authConfigProvider === entry.id;

  return html`
    <div
      class="list-item"
      style="border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; cursor: pointer;"
      @click=${onToggle}
    >
      <div style="display: flex; align-items: center; gap: 12px; grid-column: 1 / -1;">
        <div style="${dotStyle}"></div>
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-weight: 600;">${entry.name}</span>
            ${
              entry.authMode && entry.authMode !== "unknown"
                ? html`<span class="chip">${entry.authMode}</span>`
                : nothing
            }
            ${
              entry.isLocal
                ? html`
                    <span class="chip">local</span>
                  `
                : nothing
            }
          </div>
          ${renderQuickStatus(entry)}
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span
            class="chip"
            style="background: color-mix(in srgb, ${color} 12%, transparent); color: ${color}; border-color: color-mix(in srgb, ${color} 25%, transparent);"
          >
            ${label}
          </span>
          <span style="font-size: 12px; opacity: 0.5;">${expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      ${
        expanded
          ? html`
            <div
              style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); grid-column: 1 / -1;"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${renderCredentialInfo(entry)}
              ${renderConfigureSection(entry, props, isConfiguring)}
              ${renderModelsSection(entry, props)}
              ${renderUsageSection(entry)}
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function renderAuthModeChips(authModes: string[]) {
  if (authModes.length === 0) {
    return nothing;
  }
  return html`
    <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px;">
      ${authModes.map(
        (mode) => html`
          <span
            class="chip"
            style="font-size: 11px; background: color-mix(in srgb, var(--info) 10%, transparent); color: var(--info);"
          >
            ${mode}
          </span>
        `,
      )}
    </div>
  `;
}

function renderOAuthFlowStatus(entry: ProviderHealthEntry, props: ProvidersProps) {
  const flow = props.oauthFlow;
  if (!flow || flow.provider !== entry.id) {
    return nothing;
  }

  if (flow.status === "starting") {
    return html`
      <div style="display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 13px">
        <span class="spinner"></span>
        <span>Starting OAuth flow...</span>
      </div>
    `;
  }

  if (flow.status === "waiting" && flow.needsCode) {
    return html`
      <div style="margin-top: 8px; padding: 10px; border: 1px dashed var(--info); border-radius: 6px; background: color-mix(in srgb, var(--info) 5%, transparent);">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 6px;">
          Paste authorization code
        </div>
        <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
          ${flow.codePromptMessage ?? "Complete sign-in in the browser, then paste the authorization code shown on the page."}
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input
            type="text"
            class="input"
            placeholder="Paste code here..."
            style="flex: 1; font-size: 13px; font-family: monospace;"
            @click=${(e: Event) => e.stopPropagation()}
            @keydown=${(e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                const input = e.target as HTMLInputElement;
                const code = input.value.trim();
                if (code) {
                  props.onSubmitOAuthCode(code);
                }
              }
            }}
          />
          <button
            class="btn btn-sm btn-primary"
            @click=${(e: Event) => {
              e.stopPropagation();
              const container = (e.target as HTMLElement).closest("div")!;
              const input = container.querySelector("input") as HTMLInputElement;
              const code = input?.value.trim();
              if (code) {
                props.onSubmitOAuthCode(code);
              }
            }}
          >
            Submit
          </button>
          <button
            class="btn btn-sm"
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onCancelOAuth();
            }}
          >
            Cancel
          </button>
        </div>
        ${
          flow.authUrl
            ? html`
              <div style="margin-top: 6px;">
                <a
                  href=${flow.authUrl}
                  target="_blank"
                  rel="noopener"
                  class="muted"
                  style="font-size: 11px;"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  Re-open sign-in page
                </a>
              </div>
            `
            : nothing
        }
      </div>
    `;
  }

  if (flow.status === "waiting") {
    return html`
      <div style="margin-top: 8px; padding: 10px; border: 1px dashed var(--info); border-radius: 6px; background: color-mix(in srgb, var(--info) 5%, transparent);">
        <div style="display: flex; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 6px;">
          <span class="spinner"></span>
          <span style="font-weight: 600;">Waiting for authentication...</span>
        </div>
        <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
          A browser window should have opened. Complete the sign-in flow there, then return here.
        </div>
        ${
          flow.authUrl
            ? html`
              <div style="display: flex; gap: 8px; align-items: center;">
                <a
                  href=${flow.authUrl}
                  target="_blank"
                  rel="noopener"
                  class="btn btn-sm"
                  style="text-decoration: none;"
                  @click=${(e: Event) => e.stopPropagation()}
                >
                  Open again
                </a>
                <button
                  class="btn btn-sm"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    props.onCancelOAuth();
                  }}
                >
                  Cancel
                </button>
              </div>
            `
            : html`
              <button
                class="btn btn-sm"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  props.onCancelOAuth();
                }}
              >
                Cancel
              </button>
            `
        }
      </div>
    `;
  }

  if (flow.status === "error") {
    return html`
      <div style="margin-top: 8px; padding: 10px; border: 1px solid var(--danger); border-radius: 6px; background: color-mix(in srgb, var(--danger) 5%, transparent);">
        <div style="font-size: 13px; color: var(--danger); margin-bottom: 6px;">
          OAuth failed: ${flow.error ?? "Unknown error"}
        </div>
        <button
          class="btn btn-sm"
          @click=${(e: Event) => {
            e.stopPropagation();
            props.onCancelOAuth();
          }}
        >
          Dismiss
        </button>
      </div>
    `;
  }

  return nothing;
}

function renderConfigureSection(
  entry: ProviderHealthEntry,
  props: ProvidersProps,
  isConfiguring: boolean,
) {
  const { authModes, hasApiKey, hasToken, hasOAuth, hasAwsSdk, canConfigure } = resolveAuthInfo(
    entry,
    props,
  );

  if (authModes.length === 0) {
    return nothing;
  }

  // Check if there's an active OAuth flow for this provider
  const hasActiveOAuth = props.oauthFlow?.provider === entry.id;

  if (!isConfiguring && !hasActiveOAuth) {
    const buttons: unknown[] = [];

    if (canConfigure) {
      buttons.push(html`
        <button
          class="btn btn-sm"
          @click=${(e: Event) => {
            e.stopPropagation();
            props.onConfigureProvider(entry.id);
          }}
        >
          ${entry.detected ? "Reconfigure Key" : "Set API Key"}
        </button>
      `);
    }

    if (hasOAuth && entry.oauthAvailable) {
      buttons.push(html`
        <button
          class="btn btn-sm"
          @click=${(e: Event) => {
            e.stopPropagation();
            props.onStartOAuth(entry.id);
          }}
        >
          ${entry.detected ? "Reconfigure OAuth" : "Sign in with OAuth"}
        </button>
      `);
    }

    if (entry.detected) {
      const isRemoving = props.removingProvider === entry.id;
      buttons.push(html`
        <button
          class="btn btn-sm"
          style="color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent);"
          ?disabled=${isRemoving}
          @click=${(e: Event) => {
            e.stopPropagation();
            if (confirm(`Remove credentials for ${entry.name}?`)) {
              props.onRemoveCredential(entry.id);
            }
          }}
        >
          ${isRemoving ? "Removing..." : "Remove"}
        </button>
      `);
    }

    const hints: unknown[] = [];

    if (hasOAuth && !entry.oauthAvailable) {
      hints.push(html`
        <div class="muted" style="font-size: 12px;">
          OAuth: <code style="font-size: 11px">openclaw models auth login --provider ${entry.id}</code>
        </div>
      `);
    }

    if (hasAwsSdk) {
      hints.push(html`
        <div class="muted" style="font-size: 12px">
          AWS SDK: set <code style="font-size: 11px">AWS_ACCESS_KEY_ID</code> and
          <code style="font-size: 11px">AWS_SECRET_ACCESS_KEY</code> env vars
        </div>
      `);
    }

    if (entry.envVars && entry.envVars.length > 0 && !hasAwsSdk) {
      hints.push(html`
        <div class="muted" style="font-size: 12px;">
          Env: ${entry.envVars.map((v) => html`<code style="font-size: 11px">${v}</code> `)}
        </div>
      `);
    }

    return html`
      <div style="margin: 8px 0 12px 0;">
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Authentication</div>
        ${renderAuthModeChips(authModes)}
        ${
          buttons.length > 0
            ? html`<div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: ${hints.length > 0 ? "8" : "0"}px;">${buttons}</div>`
            : nothing
        }
        ${hints.length > 0 ? html`<div style="display: flex; flex-direction: column; gap: 4px;">${hints}</div>` : nothing}
      </div>
    `;
  }

  // Active OAuth flow
  if (hasActiveOAuth) {
    return html`
      <div style="margin: 8px 0 12px 0;">
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Authentication</div>
        ${renderAuthModeChips(authModes)}
        ${renderOAuthFlowStatus(entry, props)}
      </div>
    `;
  }

  // Configuring mode — show credential input form
  if (!canConfigure) {
    return nothing;
  }

  const credentialType = hasToken && !hasApiKey ? "token" : "api_key";
  const inputLabel = credentialType === "token" ? "Token" : "API Key";
  const inputId = `auth-input-${entry.id}`;

  return html`
    <div style="margin: 8px 0 12px 0;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Authentication</div>
      ${renderAuthModeChips(authModes)}
      <div style="padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: color-mix(in srgb, var(--bg-elevated) 50%, var(--bg));">
        <div style="font-size: 13px; margin-bottom: 8px; color: var(--text);">
          ${inputLabel} for ${entry.name}
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input
            id=${inputId}
            type="password"
            placeholder=${`Enter ${inputLabel.toLowerCase()}...`}
            style="flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--text); font-size: 13px; font-family: inherit;"
            autocomplete="off"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                const input = document.getElementById(inputId) as HTMLInputElement | null;
                const value = input?.value?.trim();
                if (value) {
                  props.onSaveCredential(entry.id, value, credentialType);
                }
              }
            }}
          />
          <button
            class="btn btn-sm"
            ?disabled=${props.authConfigSaving}
            @click=${(e: Event) => {
              e.stopPropagation();
              const input = document.getElementById(inputId) as HTMLInputElement | null;
              const value = input?.value?.trim();
              if (value) {
                props.onSaveCredential(entry.id, value, credentialType);
              }
            }}
          >
            ${props.authConfigSaving ? "Saving..." : "Save"}
          </button>
          <button
            class="btn btn-sm"
            ?disabled=${props.authConfigSaving}
            @click=${(e: Event) => {
              e.stopPropagation();
              props.onConfigureProvider(null);
            }}
          >
            Cancel
          </button>
        </div>
        ${
          hasOAuth && entry.oauthAvailable
            ? html`
                <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border);">
                  <button
                    class="btn btn-sm"
                    @click=${(e: Event) => {
                      e.stopPropagation();
                      props.onConfigureProvider(null);
                      props.onStartOAuth(entry.id);
                    }}
                  >
                    Or sign in with OAuth instead
                  </button>
                </div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderQuickStatus(entry: ProviderHealthEntry) {
  if (!entry.detected) {
    return html`
      <div class="muted" style="font-size: 12px">Not configured</div>
    `;
  }

  const parts: unknown[] = [];

  if (entry.inCooldown && entry.cooldownRemainingMs > 0) {
    parts.push(
      html`<span style="color: var(--danger); font-size: 12px;">
        Cooldown: ${formatCountdown(entry.cooldownRemainingMs)}
      </span>`,
    );
  }

  if (
    entry.tokenValidity === "expiring" &&
    entry.tokenRemainingMs !== null &&
    entry.tokenRemainingMs > 0
  ) {
    parts.push(
      html`<span style="color: var(--warn); font-size: 12px;">
        Token expires: ${formatCountdown(entry.tokenRemainingMs)}
      </span>`,
    );
  }

  if (entry.lastUsed) {
    const lastUsedTs = new Date(entry.lastUsed).getTime();
    if (Number.isFinite(lastUsedTs)) {
      parts.push(
        html`<span class="muted" style="font-size: 12px;">
          Last used: ${formatTimeAgo(lastUsedTs)}
        </span>`,
      );
    }
  }

  if (parts.length === 0) {
    return nothing;
  }

  return html`<div
    style="display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-top: 2px;"
  >
    ${parts}
  </div>`;
}

function renderCredentialInfo(entry: ProviderHealthEntry) {
  if (!entry.detected) {
    return html`
      <div class="muted" style="font-size: 13px">
        Provider not detected. Configure credentials to enable.
      </div>
    `;
  }

  return html`
    <div style="margin-bottom: 12px;">
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Credentials</div>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 13px;">
        <span class="muted">Source</span>
        <span>${entry.authSource ?? "unknown"}</span>

        <span class="muted">Mode</span>
        <span>${entry.authMode}</span>

        <span class="muted">Token</span>
        <span>
          ${
            entry.tokenValidity === "valid"
              ? entry.tokenRemainingMs != null && entry.tokenRemainingMs > 0
                ? html`<span style="color: var(--success)">Valid</span>
                    <span class="muted">(expires in ${formatCountdown(entry.tokenRemainingMs)})</span>`
                : html`
                    <span style="color: var(--success)">Valid</span>
                  `
              : entry.tokenValidity === "expiring"
                ? html`<span style="color: var(--warn)">Expiring</span>
                  ${
                    entry.tokenRemainingMs !== null
                      ? html` <span style="color: var(--warn)">(${formatCountdown(entry.tokenRemainingMs)})</span>`
                      : nothing
                  }`
                : entry.tokenValidity === "expired"
                  ? html`
                      <span style="color: var(--danger)">Expired</span>
                    `
                  : "No expiration"
          }
        </span>

        <span class="muted">Errors</span>
        <span>${entry.errorCount}</span>

        ${
          entry.inCooldown && entry.cooldownRemainingMs > 0
            ? html`
              <span class="muted">Cooldown</span>
              <span style="color: var(--danger);">
                ${formatCountdown(entry.cooldownRemainingMs)}
              </span>
            `
            : nothing
        }
        ${
          entry.disabledReason
            ? html`
              <span class="muted">Disabled</span>
              <span style="color: var(--danger);">${entry.disabledReason}</span>
            `
            : nothing
        }
      </div>
    </div>
  `;
}

function formatContextWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  const k = n / 1000;
  return Number.isInteger(k) ? `${k}k` : `${k.toFixed(0)}k`;
}

type CostFilterOption = { value: "all" | "high" | "medium" | "low" | "free"; label: string };
const COST_FILTER_OPTIONS: CostFilterOption[] = [
  { value: "all", label: "All" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
  { value: "free", label: "Free" },
];

function matchesCostFilter(
  tier: ModelCostTier,
  filter: "all" | "high" | "medium" | "low" | "free",
): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "high") {
    return tier === "expensive";
  }
  if (filter === "medium") {
    return tier === "moderate";
  }
  if (filter === "free") {
    return tier === "free";
  }
  // low = cheap + free
  return tier === "cheap" || tier === "free";
}

function costTierLabel(tier: ModelCostTier): string {
  switch (tier) {
    case "expensive":
      return "High";
    case "moderate":
      return "Medium";
    case "cheap":
      return "Low";
    case "free":
      return "Free";
    default:
      return tier;
  }
}

function costTierColor(tier: ModelCostTier): string {
  switch (tier) {
    case "expensive":
      return "var(--danger)";
    case "moderate":
      return "var(--warn)";
    case "cheap":
      return "var(--ok)";
    case "free":
      return "var(--info)";
    default:
      return "var(--muted)";
  }
}

function renderModelsSection(entry: ProviderHealthEntry, props: ProvidersProps) {
  if (!entry.detected || entry.models.length === 0) {
    if (entry.detected) {
      return html`
        <div style="margin-bottom: 12px">
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px">Models</div>
          <div class="muted" style="font-size: 12px">No models discovered.</div>
        </div>
      `;
    }
    return nothing;
  }

  const allowlistEmpty = props.modelAllowlist.size === 0;
  const filteredModels = entry.models.filter((m) =>
    matchesCostFilter(m.costTier, props.modelsCostFilter),
  );

  return html`
    <div style="margin-bottom: 12px;">
      <div
        style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;"
      >
        <div style="font-weight: 600; font-size: 13px;">
          Models (${entry.models.length})
        </div>
        <button
          class="btn btn-sm"
          ?disabled=${props.modelsSaving}
          @click=${(e: Event) => {
            e.stopPropagation();
            props.onSaveModels();
          }}
        >
          ${props.modelsSaving ? "Saving..." : "Save"}
        </button>
      </div>

      <div
        style="display: flex; gap: 4px; margin-bottom: 8px; flex-wrap: wrap;"
        @click=${(e: Event) => e.stopPropagation()}
      >
        ${COST_FILTER_OPTIONS.map(
          (opt) => html`
            <button
              class="chip"
              style="cursor: pointer; font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); ${
                props.modelsCostFilter === opt.value
                  ? "background: var(--text-strong); color: var(--bg); border-color: var(--text-strong);"
                  : ""
              }"
              @click=${() => props.onCostFilterChange(opt.value)}
            >
              ${opt.label}
            </button>
          `,
        )}
      </div>

      ${
        allowlistEmpty
          ? html`
              <div class="muted" style="font-size: 11px; margin-bottom: 6px">
                No allowlist configured — all models are available.
              </div>
            `
          : nothing
      }
      <div
        style="display: flex; flex-direction: column; gap: 4px; font-size: 13px;"
      >
        ${
          filteredModels.length === 0
            ? html`
                <div class="muted" style="font-size: 12px">No models match this filter.</div>
              `
            : filteredModels.map((model) =>
                renderModelRow(model, props, allowlistEmpty, entry.healthStatus),
              )
        }
      </div>
    </div>
  `;
}

function renderModelRow(
  model: ProviderModelEntry,
  props: ProvidersProps,
  allowlistEmpty: boolean,
  providerHealth?: string,
) {
  const isAllowed = allowlistEmpty || props.modelAllowlist.has(model.key);
  const isPrimary = props.primaryModel === model.key;
  const hasVision = model.input?.includes("image");
  const isProviderUnavailable =
    providerHealth === "cooldown" || providerHealth === "disabled" || providerHealth === "expired";

  return html`
    <div
      style="display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 6px; background: var(--bg-elevated);${isProviderUnavailable ? " opacity: 0.5;" : ""}"
      title=${isProviderUnavailable ? `Provider is ${providerHealth}` : ""}
    >
      <label
        style="display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer;"
        @click=${(e: Event) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          ?checked=${isAllowed}
          @change=${() => props.onToggleModel(model.key)}
        />
        <span
          style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"
          title=${model.key}
        >
          ${model.name}
        </span>
        ${
          isProviderUnavailable
            ? html`
                <span
                  class="chip"
                  style="
                    font-size: 10px;
                    background: color-mix(in srgb, var(--danger) 12%, transparent);
                    color: var(--danger);
                    border-color: color-mix(in srgb, var(--danger) 25%, transparent);
                  "
                >
                  unavailable
                </span>
              `
            : nothing
        }
      </label>
      <div
        style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;"
      >
        ${
          model.contextWindow
            ? html`<span
              class="chip"
              style="font-size: 11px;"
              title="Context window"
            >
              ${formatContextWindow(model.contextWindow)}
            </span>`
            : nothing
        }
        ${
          model.reasoning
            ? html`
                <span
                  class="chip"
                  style="
                    font-size: 11px;
                    background: color-mix(in srgb, var(--ok) 12%, transparent);
                    color: var(--ok);
                  "
                >
                  reasoning
                </span>
              `
            : nothing
        }
        ${
          hasVision
            ? html`
                <span
                  class="chip"
                  style="
                    font-size: 11px;
                    background: color-mix(in srgb, var(--info) 12%, transparent);
                    color: var(--info);
                  "
                >
                  vision
                </span>
              `
            : nothing
        }
        <span
          class="chip"
          style="font-size: 10px; background: color-mix(in srgb, ${costTierColor(model.costTier)} 12%, transparent); color: ${costTierColor(model.costTier)}; border-color: color-mix(in srgb, ${costTierColor(model.costTier)} 25%, transparent);"
          title="Cost tier: ${model.costTier}"
        >
          ${costTierLabel(model.costTier)}
        </span>
        ${
          isPrimary
            ? html`
                <span
                  class="chip"
                  style="
                    font-size: 11px;
                    background: color-mix(in srgb, var(--warn) 15%, transparent);
                    color: var(--warn);
                    border-color: color-mix(in srgb, var(--warn) 30%, transparent);
                  "
                >
                  Default
                </span>
              `
            : html`<button
              class="btn btn-sm"
              style="font-size: 11px; padding: 1px 6px;"
              @click=${(e: Event) => {
                e.stopPropagation();
                props.onSetPrimary(model.key);
              }}
            >
              Set default
            </button>`
        }
      </div>
    </div>
  `;
}

function renderUsageSection(entry: ProviderHealthEntry) {
  if (entry.usageError) {
    return html`
      <div>
        <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Usage Quota</div>
        <div class="muted" style="font-size: 12px;">${entry.usageError}</div>
      </div>
    `;
  }

  if (!entry.usageWindows || entry.usageWindows.length === 0) {
    if (entry.usagePlan) {
      return html`
        <div>
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">Usage Quota</div>
          <div class="muted" style="font-size: 12px;">Plan: ${entry.usagePlan}</div>
        </div>
      `;
    }
    return nothing;
  }

  return html`
    <div>
      <div style="font-weight: 600; font-size: 13px; margin-bottom: 6px;">
        Usage Quota
        ${entry.usagePlan ? html`<span class="muted" style="font-weight: 400;"> (${entry.usagePlan})</span>` : nothing}
      </div>
      ${entry.usageWindows.map((w) => renderUsageBar(w))}
    </div>
  `;
}

function renderUsageBar(window: UsageWindowEntry) {
  const pct = Math.min(100, Math.max(0, window.usedPercent));
  const barColor = pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warn)" : "var(--ok)";

  return html`
    <div style="margin-bottom: 8px;">
      <div
        style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 3px;"
      >
        <span>${window.label}</span>
        <span>
          ${pct.toFixed(1)}%
          ${
            window.resetRemainingMs !== null && window.resetRemainingMs > 0
              ? html`<span class="muted"> &middot; Resets: ${formatCountdown(window.resetRemainingMs)}</span>`
              : nothing
          }
        </span>
      </div>
      <div
        style="height: 6px; background: var(--border); border-radius: 3px; overflow: hidden;"
      >
        <div
          style="height: 100%; width: ${pct}%; background: ${barColor}; border-radius: 3px; transition: width 1s linear;"
        ></div>
      </div>
    </div>
  `;
}

function renderSystemModelConfig(props: ProvidersProps) {
  const detectedProviderIds = new Set(
    props.entries.filter((e) => e.detected).map((e) => e.id.toLowerCase()),
  );

  // Check if primary model is from a detected provider
  const primaryProvider = props.primaryModel?.split("/")[0]?.toLowerCase();
  const isPrimaryValid = primaryProvider ? detectedProviderIds.has(primaryProvider) : false;

  // Check which fallbacks are from detected providers
  const fallbacksInfo = props.modelFallbacks.map((fb) => {
    const provider = fb.split("/")[0]?.toLowerCase();
    const isValid = provider ? detectedProviderIds.has(provider) : false;
    return { key: fb, isValid };
  });

  const validFallbacks = fallbacksInfo.filter((f) => f.isValid);
  const invalidFallbacks = fallbacksInfo.filter((f) => !f.isValid);

  return html`
    <section class="card" style="margin-bottom: 18px;">
      <div class="card-title">System Default Model</div>
      <div class="card-sub" style="margin-bottom: 12px;">
        The default model used for all agents unless overridden. All other models in the allowlist
        become fallbacks automatically.
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 4px;">Primary</div>
          ${
            props.primaryModel
              ? html`
                  <div
                    class="chip"
                    style="font-size: 12px; padding: 4px 10px; ${
                      isPrimaryValid
                        ? "background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); border-color: color-mix(in srgb, var(--ok) 25%, transparent);"
                        : "background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 25%, transparent);"
                    }"
                    title=${isPrimaryValid ? "Provider is configured" : "Provider not configured!"}
                  >
                    ${props.primaryModel}
                    ${
                      !isPrimaryValid
                        ? html`
                            <span style="margin-left: 6px">⚠️ Provider not detected</span>
                          `
                        : nothing
                    }
                  </div>
                `
              : html`
                  <span class="muted" style="font-size: 13px">No default model set</span>
                `
          }
        </div>

        <div>
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 4px;">
            Fallbacks (${props.modelFallbacks.length})
          </div>
          ${
            props.modelFallbacks.length === 0
              ? html`
                  <span class="muted" style="font-size: 13px">No fallbacks configured</span>
                `
              : html`
                  <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                    ${validFallbacks.map(
                      (fb) => html`
                        <span
                          class="chip"
                          style="font-size: 11px; background: color-mix(in srgb, var(--ok) 10%, transparent); color: var(--ok);"
                          title="Provider is configured"
                        >
                          ${fb.key}
                        </span>
                      `,
                    )}
                    ${invalidFallbacks.map(
                      (fb) => html`
                        <span
                          class="chip"
                          style="font-size: 11px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); text-decoration: line-through; opacity: 0.7;"
                          title="Provider not configured - will be skipped"
                        >
                          ${fb.key}
                        </span>
                      `,
                    )}
                  </div>
                  ${
                    invalidFallbacks.length > 0
                      ? html`
                          <div
                            class="muted"
                            style="font-size: 11px; margin-top: 6px; color: var(--warn);"
                          >
                            ⚠️ ${invalidFallbacks.length} fallback(s) from unconfigured providers will
                            be skipped.
                          </div>
                        `
                      : nothing
                  }
                `
          }
        </div>
      </div>

      ${
        !isPrimaryValid && props.primaryModel
          ? html`
              <div
                class="callout danger"
                style="margin-top: 12px; font-size: 13px;"
              >
                <strong>Warning:</strong> The current default model
                <code>${props.primaryModel}</code> is from a provider that is not configured. Select
                a model from a detected provider below to fix this.
              </div>
            `
          : nothing
      }
    </section>
  `;
}

// --- Helpers ---

function getHealthColor(status: string): string {
  switch (status) {
    case "healthy":
      return "var(--ok)";
    case "warning":
      return "var(--warn)";
    case "cooldown":
    case "expired":
    case "disabled":
      return "var(--danger)";
    case "missing":
      return "var(--muted)";
    default:
      return "var(--muted)";
  }
}

function getHealthLabel(status: string): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "cooldown":
      return "Cooldown";
    case "expired":
      return "Expired";
    case "disabled":
      return "Disabled";
    case "missing":
      return "Not detected";
    default:
      return status;
  }
}

function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimeAgo(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  if (diff < 0) {
    return "just now";
  }
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
