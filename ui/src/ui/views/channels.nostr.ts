import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { ChannelAccountSnapshot, NostrProfile, NostrStatus } from "../types.ts";
import { renderChannelConfigSection } from "./channels.config.ts";
import {
  renderNostrProfileForm,
  type NostrProfileFormState,
  type NostrProfileFormCallbacks,
} from "./channels.nostr-profile-form.ts";
import type { ChannelsProps } from "./channels.types.ts";

const RECOMMENDED_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.wine",
];

type NostrConfigValue = {
  privateKey: string;
  relays: string[];
  dmPolicy: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function parseRelaysInput(raw: string): string[] {
  const relays = raw
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  for (const relay of relays) {
    if (!deduped.includes(relay)) {
      deduped.push(relay);
    }
  }
  return deduped;
}

function formatRelayInput(relays: string[]): string {
  return relays.join("\n");
}

function readNostrConfig(configForm: Record<string, unknown> | null): NostrConfigValue {
  const root = asRecord(configForm);
  if (!root) {
    return { privateKey: "", relays: [], dmPolicy: null };
  }

  const rootChannels = asRecord(root.channels);
  const fromChannels = asRecord(rootChannels?.nostr);
  const resolved = fromChannels ?? {};
  const privateKey = typeof resolved.privateKey === "string" ? resolved.privateKey : "";

  return {
    privateKey: privateKey.trim(),
    relays: toStringList(resolved.relays),
    dmPolicy: typeof resolved.dmPolicy === "string" ? resolved.dmPolicy : null,
  };
}

function hasProfileData(profile: NostrProfile | undefined | null): boolean {
  if (!profile) {
    return false;
  }
  return ["name", "displayName", "about", "picture", "banner", "website", "nip05", "lud16"].some(
    (field) => Boolean(String(profile[field as keyof NostrProfile] ?? "").trim()),
  );
}

function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText?.(text).catch(() => {
    const fallback = document.createElement("input");
    fallback.value = text;
    fallback.setAttribute("readonly", "");
    fallback.style.position = "absolute";
    fallback.style.left = "-10000px";
    fallback.style.top = "-10000px";
    document.body.appendChild(fallback);
    fallback.select();
    document.execCommand("copy");
    document.body.removeChild(fallback);
  });
}

function renderChecklistItem(params: { label: string; done: boolean }) {
  return html`
    <div style="display: flex; gap: 8px; align-items: center;">
      <span style="color: var(--success-color); width: 16px; text-align: center;">
        ${params.done ? "✓" : "○"}
      </span>
      <span>${params.label}</span>
    </div>
  `;
}

function renderNostrSetupCard(params: {
  props: ChannelsProps;
  summaryConfigured: boolean;
  hasConfiguredKey: boolean;
  hasConfiguredRelays: boolean;
  hasProfile: boolean;
  running: boolean;
  publicKey: string | null | undefined;
  relaysText: string;
  onEditProfile?: () => void;
}) {
  const {
    props,
    summaryConfigured,
    hasConfiguredKey,
    hasConfiguredRelays,
    hasProfile,
    running,
    publicKey,
    relaysText,
    onEditProfile,
  } = params;

  const showWizard = props.onboarding || !hasConfiguredKey || !hasConfiguredRelays || !hasProfile;
  if (!showWizard) {
    return nothing;
  }

  const configDraft = readNostrConfig(props.configForm);
  const privateKeyValue = configDraft.privateKey;
  const canSave =
    props.connected && !props.configSaving && !props.configSchemaLoading && props.configFormDirty;

  const renderProfileButton = () => {
    if (!onEditProfile) {
      return nothing;
    }

    const label = hasProfile ? "Edit profile" : "Add profile";
    return html`
      <button class="btn" type="button" @click=${onEditProfile}>
        ${label}
      </button>
    `;
  };

  return html`
    <div
      class="callout info"
      style="margin-top: 12px; padding: 12px; border-radius: 8px;"
    >
      <div style="font-weight: 600; margin-bottom: 8px;">Nostr onboarding</div>
      <div class="status-list" style="margin-bottom: 12px;">
        ${renderChecklistItem({ label: "Private key configured", done: hasConfiguredKey })}
        ${renderChecklistItem({ label: "Relay list set", done: hasConfiguredRelays })}
        ${renderChecklistItem({ label: "Profile metadata set", done: hasProfile })}
        ${renderChecklistItem({
          label: "Gateway status shows configured",
          done: summaryConfigured || running,
        })}
      </div>

      <div style="display: grid; gap: 12px;">
        <label style="display: grid; gap: 6px;">
          <span style="font-size: 13px; font-weight: 500;">Private key (nsec or hex)</span>
          <div style="display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: start;">
            <input
              type="password"
              autocomplete="off"
              inputmode="text"
              placeholder=${hasConfiguredKey ? "Configured — paste to replace" : "nsec1..."}
              .value=${privateKeyValue}
              @input=${(e: InputEvent) => {
                const target = e.target as HTMLInputElement;
                props.onConfigPatch(["channels", "nostr", "privateKey"], target.value.trim());
              }}
            />
            <button
              type="button"
              class="btn btn-sm"
              title="Copy configured secret key"
              @click=${() => copyToClipboard(privateKeyValue)}
              ?disabled=${!privateKeyValue}
            >
              Copy
            </button>
          </div>
          <div style="font-size: 12px; color: var(--text-muted);">
            Secret key stays hidden; paste it here to replace, or use the generated key path output.
          </div>
          ${
            configDraft.dmPolicy
              ? html`<div style="font-size: 12px; color: var(--text-muted);">
                Access policy: ${configDraft.dmPolicy}
              </div>`
              : nothing
          }
        </label>

        <label style="display: grid; gap: 6px;">
          <span style="font-size: 13px; font-weight: 500;">Relay URLs</span>
          <textarea
            rows="4"
            style="width: 100%; border-radius: 4px; border: 1px solid var(--border-color); padding: 8px; resize: vertical; font-family: var(--font-mono, monospace);"
            placeholder="wss://relay.damus.io"
            .value=${relaysText}
            @input=${(e: InputEvent) => {
              const target = e.target as HTMLTextAreaElement;
              props.onConfigPatch(["channels", "nostr", "relays"], parseRelaysInput(target.value));
            }}
          ></textarea>
          <button
            class="btn btn-sm"
            type="button"
            @click=${() =>
              props.onConfigPatch(["channels", "nostr", "relays"], [...RECOMMENDED_NOSTR_RELAYS])}
          >
            Use recommended relays
          </button>
        </label>
      </div>

      <div class="row" style="margin-top: 12px; flex-wrap: wrap;">
        <button class="btn primary" ?disabled=${!canSave} @click=${props.onConfigSave}>
          ${props.configFormDirty ? "Save Nostr config" : "Config up to date"}
        </button>
        <button
          class="btn"
          type="button"
          @click=${() => props.onRefresh(false)}
          style="margin-left: 8px;"
          ?disabled=${!props.connected}
        >
          Refresh status
        </button>
        ${renderProfileButton()}
        <a
          class="btn btn-sm"
          href="https://docs.openclaw.ai/channels/nostr"
          target="_blank"
          rel="noreferrer"
          style="margin-left: 8px; text-decoration: none; display: inline-flex; align-items: center;"
        >
          Read setup docs
        </a>
      </div>

      ${
        publicKey
          ? html`
          <div style="margin-top: 8px; font-size: 12px;">
            <span>Public key:</span>
            <span class="monospace">${publicKey}</span>
            <button
              class="btn btn-sm"
              type="button"
              style="margin-left: 8px;"
              @click=${() => copyToClipboard(publicKey)}
            >
              Copy
            </button>
          </div>
        `
          : nothing
      }
    </div>
  `;
}

/**
 * Truncate a pubkey for display (shows first and last 8 chars)
 */
function truncatePubkey(pubkey: string | null | undefined): string {
  if (!pubkey) {
    return "n/a";
  }
  if (pubkey.length <= 20) {
    return pubkey;
  }
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
}

export function renderNostrCard(params: {
  props: ChannelsProps;
  nostr?: NostrStatus | null;
  nostrAccounts: ChannelAccountSnapshot[];
  accountCountLabel: unknown;
  /** Profile form state (optional - if provided, shows form) */
  profileFormState?: NostrProfileFormState | null;
  /** Profile form callbacks */
  profileFormCallbacks?: NostrProfileFormCallbacks | null;
  /** Called when Edit Profile is clicked */
  onEditProfile?: () => void;
}) {
  const {
    props,
    nostr,
    nostrAccounts,
    accountCountLabel,
    profileFormState,
    profileFormCallbacks,
    onEditProfile,
  } = params;

  const primaryAccount = nostrAccounts[0];
  const summaryConfigured = nostr?.configured ?? primaryAccount?.configured ?? false;
  const summaryRunning = nostr?.running ?? primaryAccount?.running ?? false;
  const summaryPublicKey =
    nostr?.publicKey ?? (primaryAccount as { publicKey?: string } | undefined)?.publicKey;
  const summaryLastStartAt = nostr?.lastStartAt ?? primaryAccount?.lastStartAt ?? null;
  const summaryLastError = nostr?.lastError ?? primaryAccount?.lastError ?? null;
  const hasMultipleAccounts = nostrAccounts.length > 1;
  const showingForm = profileFormState !== null && profileFormState !== undefined;

  const profileFromStatus = (primaryAccount as { profile?: NostrProfile | null } | undefined)
    ?.profile;
  const hasProfileDataInStatus = hasProfileData(profileFromStatus ?? nostr?.profile);
  const configValues = readNostrConfig(props.configForm);
  const hasConfiguredKey = Boolean(summaryPublicKey) || Boolean(configValues.privateKey);
  const hasConfiguredRelays = configValues.relays.length > 0;

  const renderAccountCard = (account: ChannelAccountSnapshot) => {
    const publicKey = (account as { publicKey?: string }).publicKey;
    const profile = (account as { profile?: { name?: string; displayName?: string } }).profile;
    const displayName = profile?.displayName ?? profile?.name ?? account.name ?? account.accountId;

    return html`
      <div class="account-card">
        <div class="account-card-header">
          <div class="account-card-title">${displayName}</div>
          <div class="account-card-id">${account.accountId}</div>
        </div>
        <div class="status-list account-card-status">
          <div>
            <span class="label">Running</span>
            <span>${account.running ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Configured</span>
            <span>${account.configured ? "Yes" : "No"}</span>
          </div>
          <div>
            <span class="label">Public Key</span>
            <span class="monospace" title="${publicKey ?? ""}">${truncatePubkey(publicKey)}</span>
          </div>
          <div>
            <span class="label">Last inbound</span>
            <span>${account.lastInboundAt ? formatRelativeTimestamp(account.lastInboundAt) : "n/a"}</span>
          </div>
          ${
            account.lastError
              ? html`
                <div class="account-card-error">${account.lastError}</div>
              `
              : nothing
          }
        </div>
      </div>
    `;
  };

  const renderProfileSection = () => {
    if (showingForm && profileFormCallbacks) {
      return renderNostrProfileForm({
        state: profileFormState,
        callbacks: profileFormCallbacks,
        accountId: nostrAccounts[0]?.accountId ?? "default",
      });
    }

    const profile =
      (
        primaryAccount as
          | {
              profile?: {
                name?: string;
                displayName?: string;
                about?: string;
                picture?: string;
                nip05?: string;
              };
            }
          | undefined
      )?.profile ?? nostr?.profile;
    const { name, displayName, about, picture, nip05 } = profile ?? {};
    const hasAnyProfileData = name || displayName || about || picture || nip05;

    return html`
      <div style="margin-top: 16px; padding: 12px; background: var(--bg-secondary); border-radius: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div style="font-weight: 500;">Profile</div>
          ${
            summaryConfigured || hasProfileDataInStatus
              ? html`
                <button
                  class="btn btn-sm"
                  @click=${onEditProfile}
                  style="font-size: 12px; padding: 4px 8px;"
                >
                  Edit Profile
                </button>
              `
              : nothing
          }
        </div>
        ${
          hasAnyProfileData
            ? html`
              <div class="status-list">
                ${
                  picture
                    ? html`
                      <div style="margin-bottom: 8px;">
                        <img
                          src=${picture}
                          alt="Profile picture"
                          style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
                          @error=${(e: Event) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    `
                    : nothing
                }
                ${name ? html`<div><span class="label">Name</span><span>${name}</span></div>` : nothing}
                ${
                  displayName
                    ? html`<div><span class="label">Display Name</span><span>${displayName}</span></div>`
                    : nothing
                }
                ${
                  about
                    ? html`<div><span class="label">About</span><span style="max-width: 300px; overflow: hidden; text-overflow: ellipsis;">${about}</span></div>`
                    : nothing
                }
                ${nip05 ? html`<div><span class="label">NIP-05</span><span>${nip05}</span></div>` : nothing}
              </div>
            `
            : html`
                <div style="color: var(--text-muted); font-size: 13px">
                  No profile set. Use this section to add your name, bio, avatar, and Nostr metadata.
                </div>
              `
        }
      </div>
    `;
  };

  return html`
    <div class="card">
      <div class="card-title">Nostr</div>
      <div class="card-sub">Encrypted AI prompts over Nostr relays via NIP-63 and NIP-44.</div>
      ${accountCountLabel}

      ${
        hasMultipleAccounts
          ? html`
            <div class="account-card-list">
              ${nostrAccounts.map((account) => renderAccountCard(account))}
            </div>
          `
          : html`
            <div class="status-list" style="margin-top: 16px;">
              <div>
                <span class="label">Configured</span>
                <span>${summaryConfigured ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Running</span>
                <span>${summaryRunning ? "Yes" : "No"}</span>
              </div>
              <div>
                <span class="label">Public Key</span>
                <span class="monospace" title="${summaryPublicKey ?? ""}"
                  >${truncatePubkey(summaryPublicKey)}</span
                >
                ${
                  summaryPublicKey
                    ? html`
                      <button
                        class="btn btn-sm"
                        type="button"
                        title="Copy public key"
                        @click=${() => copyToClipboard(summaryPublicKey)}
                      >
                        Copy
                      </button>
                    `
                    : nothing
                }
              </div>
              <div>
                <span class="label">Last start</span>
                <span>${summaryLastStartAt ? formatRelativeTimestamp(summaryLastStartAt) : "n/a"}</span>
              </div>
            </div>
          `
      }

      ${
        summaryLastError
          ? html`<div class="callout danger" style="margin-top: 12px;">${summaryLastError}</div>`
          : nothing
      }

      ${renderNostrSetupCard({
        props,
        summaryConfigured,
        hasConfiguredKey,
        hasConfiguredRelays,
        hasProfile: hasProfileDataInStatus,
        running: summaryRunning,
        publicKey: summaryPublicKey,
        relaysText: formatRelayInput(configValues.relays),
        onEditProfile,
      })}

      ${renderProfileSection()}

      ${renderChannelConfigSection({ channelId: "nostr", props })}

      <div class="row" style="margin-top: 12px;">
        <button class="btn" @click=${() => props.onRefresh(false)}>Refresh</button>
      </div>
    </div>
  `;
}
