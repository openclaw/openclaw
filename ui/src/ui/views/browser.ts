import { html, nothing } from "lit";
import type { BrowserProfile, BrowserTab } from "../controllers/browser.ts";

export type BrowserProps = {
  loading: boolean;
  error: string | null;
  profiles: BrowserProfile[];
  onRefresh: () => void;
  /** URL input for opening a new tab */
  newTabUrl: string;
  onNewTabUrlChange: (v: string) => void;
  /** Which profile to open a new tab into */
  newTabProfile: string | null;
  onNewTabProfileChange: (v: string) => void;
  onOpenTab: (profile: string, url: string) => void;
  onCloseTab: (profile: string, targetId: string) => void;
  onFocusTab: (profile: string, targetId: string) => void;
  onStartProfile: (profile: string) => void;
  onStopProfile: (profile: string) => void;
  onDeleteProfile: (profile: string) => void;
  /** New profile creation */
  newProfileName: string;
  onNewProfileNameChange: (v: string) => void;
  onCreateProfile: (name: string) => void;
  /** Tap in/out — signals human is viewing */
  tappedTabs: Set<string>;
  onTapIn: (tab: BrowserTab, profile: string) => void;
  onTapOut: (targetId: string, profile: string) => void;
  actionBusy: boolean;
  autoRefreshActive: boolean;
};

/** Return just the hostname (e.g. "github.com") for display; falls back to full URL. */
function tabHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/**
 * Background tabs are internal browser pages the user never navigates to
 * intentionally: service workers, cookie-rotation pages, chrome-extension
 * pages, etc. They are collapsed into a "details" dropdown.
 */
function isBackgroundTab(tab: BrowserTab): boolean {
  const u = tab.url;
  if (u.startsWith("chrome-extension://")) {
    return true;
  }
  if (u.startsWith("chrome://")) {
    return true;
  }
  if (u.startsWith("about:")) {
    return true;
  }
  if (u.includes("service-worker")) {
    return true;
  }
  if (u.includes("RotateCookies")) {
    return true;
  }
  if (u.includes("/_/chrome/")) {
    return true;
  }
  return false;
}

/**
 * Filter out the built-in "existing-session" attach-only profile (the user's
 * own system Chrome). We only manage OpenClaw-controlled browser profiles here.
 */
function isManagedProfile(p: BrowserProfile): boolean {
  return p.driver !== "existing-session";
}

export function renderBrowser(props: BrowserProps) {
  const managed = props.profiles.filter(isManagedProfile);
  const runningProfiles = managed.filter((p) => p.running);
  const stoppedProfiles = managed.filter((p) => !p.running);
  const totalTabs = runningProfiles.reduce((n, p) => n + p.tabs.length, 0);
  const hasAttachedProfile = props.profiles.some((p) => !isManagedProfile(p));

  return html`
    <section class="card">
      <!-- Header row -->
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">OpenClaw Browser</div>
          <div class="card-subtitle">
            ${
              props.loading
                ? "Loading…"
                : `${runningProfiles.length} profile${runningProfiles.length !== 1 ? "s" : ""} running · ${totalTabs} tab${totalTabs !== 1 ? "s" : ""} open`
            }
          </div>
        </div>
        <div class="row" style="gap:8px; align-items:center;">
          ${
            props.autoRefreshActive
              ? html`
                  <span style="font-size: 0.75rem; color: var(--fg-muted)">Auto-refresh on</span>
                `
              : nothing
          }
          <button class="btn btn-sm" @click=${props.onRefresh} ?disabled=${props.loading}>
            ${props.loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      <!-- Error banner -->
      ${
        props.error
          ? html`<div class="alert alert-error" style="margin-top:12px;">${props.error}</div>`
          : nothing
      }

      <!-- Open tab form (shared across profiles) -->
      ${
        runningProfiles.length > 0
          ? html`
              <div class="row" style="margin-top:14px; gap:8px; flex-wrap:wrap;">
                ${
                  managed.length > 1
                    ? html`
                        <select
                          class="input input-sm"
                          style="flex:0 0 auto; min-width:120px;"
                          .value=${props.newTabProfile ?? ""}
                          @change=${(e: Event) =>
                            props.onNewTabProfileChange((e.target as HTMLSelectElement).value)}
                        >
                          ${managed
                            .filter((p) => p.running)
                            .map(
                              (p) => html`
                                <option value=${p.name} ?selected=${props.newTabProfile === p.name}>
                                  ${p.name}
                                </option>
                              `,
                            )}
                        </select>
                      `
                    : nothing
                }
                <input
                  class="input input-sm"
                  style="flex:1; min-width:180px;"
                  type="text"
                  placeholder="https://…"
                  .value=${props.newTabUrl}
                  @input=${(e: Event) =>
                    props.onNewTabUrlChange((e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    const profile = props.newTabProfile ?? runningProfiles[0]?.name;
                    if (e.key === "Enter" && props.newTabUrl.trim() && profile) {
                      props.onOpenTab(profile, props.newTabUrl.trim());
                    }
                  }}
                  ?disabled=${props.actionBusy}
                />
                <button
                  class="btn btn-sm btn-primary"
                  ?disabled=${
                    props.actionBusy ||
                    !props.newTabUrl.trim() ||
                    !(props.newTabProfile ?? runningProfiles[0]?.name)
                  }
                  @click=${() => {
                    const profile = props.newTabProfile ?? runningProfiles[0]?.name;
                    if (profile && props.newTabUrl.trim()) {
                      props.onOpenTab(profile, props.newTabUrl.trim());
                    }
                  }}
                >
                  ${props.actionBusy ? "Working…" : "Open Tab"}
                </button>
              </div>
            `
          : nothing
      }

      <!-- Empty state -->
      ${
        !props.loading && managed.length === 0
          ? html`
              <div class="empty-state" style="margin-top: 24px; text-align: center; color: var(--fg-muted)">
                <div style="font-size: 2rem">🌐</div>
                <div style="margin-top: 8px">No OpenClaw browser profiles configured.</div>
                <div style="font-size: 0.85rem; margin-top: 4px">
                  Create a profile below to get started.
                  ${
                    hasAttachedProfile
                      ? html`
                          <br />Your system browser is detected but managed separately.
                        `
                      : nothing
                  }
                </div>
              </div>
            `
          : nothing
      }

      <!-- Running profiles -->
      ${runningProfiles.map(
        (p) => html`
          <div class="card" style="margin-top:14px; border:1px solid var(--border);">
            <!-- Profile header -->
            <div class="row" style="justify-content:space-between; align-items:center;">
              <div class="row" style="gap:8px; align-items:center;">
                ${
                  p.color
                    ? html`<span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block;flex-shrink:0;"></span>`
                    : nothing
                }
                <div>
                  <span style="font-weight:600; font-size:0.95rem;">${p.name}</span>
                  <span class="badge badge-ok" style="margin-left:6px; font-size:0.72rem;">running</span>
                  ${
                    p.driver
                      ? html`<span style="font-size:0.78rem; color:var(--fg-muted); margin-left:6px;">${p.driver}</span>`
                      : nothing
                  }
                </div>
              </div>
              <div class="row" style="gap:6px;">
                <button
                  class="btn btn-sm"
                  title="Stop this browser profile"
                  ?disabled=${props.actionBusy}
                  @click=${() => props.onStopProfile(p.name)}
                >
                  Stop
                </button>
              </div>
            </div>

            <!-- Tabs -->
            ${(() => {
              const primaryTabs = p.tabs.filter((t) => !isBackgroundTab(t));
              const bgTabs = p.tabs.filter((t) => isBackgroundTab(t));

              const renderPrimaryTab = (t: BrowserTab) => html`
                <div
                  class="row"
                  style="justify-content:space-between; align-items:center; padding:6px 8px; background:var(--bg-subtle,var(--bg-2)); border-radius:6px; gap:8px;"
                >
                  <div style="min-width:0; flex:1;">
                    <div style="font-size:0.85rem; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                      ${t.title || tabHost(t.url)}
                    </div>
                    <div style="font-size:0.75rem; color:var(--fg-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                      ${tabHost(t.url)}
                    </div>
                    ${
                      props.tappedTabs.has(t.targetId)
                        ? html`
                            <span class="badge badge-warn" style="font-size: 0.72rem; margin-top: 3px">👤 Human Viewing</span>
                          `
                        : nothing
                    }
                  </div>
                  <div class="row" style="gap:6px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end;">
                    <button
                      class="btn btn-sm"
                      title="Copy URL"
                      @click=${() => {
                        void navigator.clipboard.writeText(t.url);
                      }}
                    >Copy</button>
                    ${
                      props.tappedTabs.has(t.targetId)
                        ? html`
                            <button class="btn btn-sm" title="Hand back to agent" @click=${() => props.onTapOut(t.targetId, p.name)}>
                              Tap Out
                            </button>
                          `
                        : html`
                            <button class="btn btn-sm btn-primary" title="Bring to front and mark human-controlled" @click=${() => props.onTapIn(t, p.name)}>
                              Tap In
                            </button>
                          `
                    }
                    <button class="btn btn-sm btn-danger" title="Close tab" ?disabled=${props.actionBusy} @click=${() => props.onCloseTab(p.name, t.targetId)}>✕</button>
                  </div>
                </div>
              `;

              return html`
                <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
                  ${
                    primaryTabs.length === 0
                      ? html`
                          <div style="font-size: 0.85rem; color: var(--fg-muted)">No open tabs.</div>
                        `
                      : primaryTabs.map(renderPrimaryTab)
                  }
                  ${
                    bgTabs.length > 0
                      ? html`
                          <details style="margin-top:4px;">
                            <summary style="font-size:0.75rem; color:var(--fg-muted); cursor:pointer; user-select:none; list-style:none; display:flex; align-items:center; gap:4px;">
                              <span>▸</span>
                              <span>${bgTabs.length} background page${bgTabs.length !== 1 ? "s" : ""}</span>
                            </summary>
                            <div style="margin-top:6px; display:flex; flex-direction:column; gap:4px; padding-left:8px; border-left:2px solid var(--border);">
                              ${bgTabs.map(
                                (t) => html`
                                  <div class="row" style="justify-content:space-between; align-items:center; padding:4px 6px; background:var(--bg-subtle,var(--bg-2)); border-radius:4px; gap:6px; opacity:0.75;">
                                    <div style="min-width:0; flex:1; font-size:0.78rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--fg-muted);">
                                      ${tabHost(t.url)}
                                    </div>
                                    <button class="btn btn-sm btn-danger" style="font-size:0.72rem; padding:2px 6px;" title="Close" ?disabled=${props.actionBusy} @click=${() => props.onCloseTab(p.name, t.targetId)}>✕</button>
                                  </div>
                                `,
                              )}
                            </div>
                          </details>
                        `
                      : nothing
                  }
                </div>
              `;
            })()}
          </div>
        `,
      )}

      <!-- Stopped profiles -->
      ${
        stoppedProfiles.length > 0
          ? html`
              <div style="margin-top:14px;">
                <div style="font-size:0.8rem; color:var(--fg-muted); margin-bottom:6px;">
                  Stopped profiles
                </div>
                ${stoppedProfiles.map(
                  (p) => html`
                    <div
                      class="row"
                      style="justify-content:space-between; align-items:center; padding:8px 10px; border:1px solid var(--border); border-radius:6px; margin-bottom:6px;"
                    >
                      <div class="row" style="gap:8px; align-items:center;">
                        ${
                          p.color
                            ? html`<span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block;opacity:0.4;"></span>`
                            : nothing
                        }
                        <span style="font-size:0.9rem; color:var(--fg-muted);">${p.name}</span>
                        <span class="badge" style="font-size:0.72rem; opacity:0.7;">stopped</span>
                      </div>
                      <div class="row" style="gap:6px;">
                        <button
                          class="btn btn-sm btn-primary"
                          ?disabled=${props.actionBusy}
                          @click=${() => props.onStartProfile(p.name)}
                        >
                          Start
                        </button>
                        <!-- Profile deletion requires editing openclaw config; not available at runtime -->
                      </div>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }

      <!-- Profile management requires openclaw config (not available at runtime via browser.request) -->
      <div style="margin-top:18px; border-top:1px solid var(--border); padding-top:12px; font-size:0.8rem; color:var(--fg-muted);">
        <strong>Add / remove profiles</strong> via config:<br />
        <code style="font-size:0.75rem;">openclaw config set browser.profiles.&lt;name&gt;.driver=playwright</code>
      </div>

      <!-- Footer hint -->
      <div style="margin-top:14px; font-size:0.8rem; color:var(--fg-muted);">
        <strong>Tap In</strong> brings that tab to the front of OpenClaw's browser so you can
        take over (fill passwords, guide navigation, etc.) — the agent pauses and waits.
        <strong>Tap Out</strong> hands full control back to the agent.
      </div>
    </section>
  `;
}
