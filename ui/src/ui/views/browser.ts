import { html, nothing } from "lit";
import type { BrowserProfile } from "../controllers/browser.ts";

export type BrowserProps = {
  loading: boolean;
  error: string | null;
  profiles: BrowserProfile[];
  onRefresh: () => void;
  onOpenTab: (profile: string, url: string) => void;
  onCloseTab: (profile: string, targetId: string) => void;
  onStartProfile: (profile: string) => void;
  newTabUrl: string;
  onNewTabUrlChange: (v: string) => void;
};

export function renderBrowser(props: BrowserProps) {
  const runningProfiles = props.profiles.filter((p) => p.running);
  const stoppedProfiles = props.profiles.filter((p) => !p.running);
  const totalTabs = runningProfiles.reduce((n, p) => n + p.tabs.length, 0);

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between; align-items: center;">
        <div>
          <div class="card-title">Browser Sessions</div>
          <div class="card-subtitle">
            ${
              props.loading
                ? "Loading…"
                : `${runningProfiles.length} profile${runningProfiles.length !== 1 ? "s" : ""} running · ${totalTabs} tab${totalTabs !== 1 ? "s" : ""} open`
            }
          </div>
        </div>
        <button class="btn btn-sm" @click=${props.onRefresh} ?disabled=${props.loading}>
          ${props.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${
        props.error
          ? html`<div class="alert alert-error" style="margin-top:12px;">${props.error}</div>`
          : nothing
      }

      ${
        !props.loading && props.profiles.length === 0
          ? html`
              <div class="empty-state" style="margin-top: 24px; text-align: center; color: var(--fg-muted)">
                <div style="font-size: 2rem">🌐</div>
                <div style="margin-top: 8px">No browser profiles configured.</div>
                <div style="font-size: 0.85rem; margin-top: 4px">
                  Browser profiles appear here once OpenClaw's browser service is enabled.
                </div>
              </div>
            `
          : nothing
      }

      ${runningProfiles.map(
        (p) => html`
          <div class="card" style="margin-top:14px; border:1px solid var(--border);">
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
                  ${p.driver ? html`<span style="font-size:0.78rem; color:var(--fg-muted); margin-left:6px;">${p.driver}</span>` : nothing}
                </div>
              </div>
              <div class="row" style="gap:6px; align-items:center;">
                <input
                  class="input input-sm"
                  style="width:220px;"
                  type="text"
                  placeholder="https://…"
                  .value=${props.newTabUrl}
                  @input=${(e: Event) => props.onNewTabUrlChange((e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter" && props.newTabUrl.trim()) {
                      props.onOpenTab(p.name, props.newTabUrl.trim());
                    }
                  }}
                />
                <button
                  class="btn btn-sm btn-primary"
                  ?disabled=${!props.newTabUrl.trim()}
                  @click=${() => props.onOpenTab(p.name, props.newTabUrl.trim())}
                >
                  Open Tab
                </button>
              </div>
            </div>

            ${
              p.tabs.length === 0
                ? html`
                    <div style="margin-top: 10px; font-size: 0.85rem; color: var(--fg-muted)">No open tabs.</div>
                  `
                : html`
                    <div style="margin-top:10px; display:flex; flex-direction:column; gap:6px;">
                      ${p.tabs.map(
                        (t) => html`
                          <div class="row" style="justify-content:space-between; align-items:center; padding:6px 8px; background:var(--bg-subtle,var(--bg-2)); border-radius:6px; gap:8px;">
                            <div style="min-width:0; flex:1;">
                              <div style="font-size:0.85rem; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${t.title || t.url}
                              </div>
                              <div style="font-size:0.75rem; color:var(--fg-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${t.url}
                              </div>
                            </div>
                            <button
                              class="btn btn-sm"
                              style="flex-shrink:0;"
                              title="Close tab"
                              @click=${() => props.onCloseTab(p.name, t.targetId)}
                            >
                              ✕
                            </button>
                          </div>
                        `,
                      )}
                    </div>
                  `
            }
          </div>
        `,
      )}

      ${
        stoppedProfiles.length > 0
          ? html`
              <div style="margin-top:14px;">
                <div style="font-size:0.8rem; color:var(--fg-muted); margin-bottom:6px;">Stopped profiles</div>
                ${stoppedProfiles.map(
                  (p) => html`
                    <div class="row" style="justify-content:space-between; align-items:center; padding:8px 10px; border:1px solid var(--border); border-radius:6px; margin-bottom:6px;">
                      <div class="row" style="gap:8px; align-items:center;">
                        ${p.color ? html`<span style="width:10px;height:10px;border-radius:50%;background:${p.color};display:inline-block;opacity:0.4;"></span>` : nothing}
                        <span style="font-size:0.9rem; color:var(--fg-muted);">${p.name}</span>
                        <span class="badge" style="font-size:0.72rem; opacity:0.7;">stopped</span>
                      </div>
                      <button class="btn btn-sm" @click=${() => props.onStartProfile(p.name)}>Start</button>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
    </section>
  `;
}
