/**
 * Nostr Profile Edit Form
 *
 * Provides UI for editing and publishing Nostr profile (kind:0).
 */

import { msg } from "@lit/localize";
import { html, nothing, type TemplateResult } from "lit";
import type { NostrProfile as NostrProfileType } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

export interface NostrProfileFormState {
  /** Current form values */
  values: NostrProfileType;
  /** Original values for dirty detection */
  original: NostrProfileType;
  /** Whether the form is currently submitting */
  saving: boolean;
  /** Whether import is in progress */
  importing: boolean;
  /** Last error message */
  error: string | null;
  /** Last success message */
  success: string | null;
  /** Validation errors per field */
  fieldErrors: Record<string, string>;
  /** Whether to show advanced fields */
  showAdvanced: boolean;
}

export interface NostrProfileFormCallbacks {
  /** Called when a field value changes */
  onFieldChange: (field: keyof NostrProfileType, value: string) => void;
  /** Called when save is clicked */
  onSave: () => void;
  /** Called when import is clicked */
  onImport: () => void;
  /** Called when cancel is clicked */
  onCancel: () => void;
  /** Called when toggle advanced is clicked */
  onToggleAdvanced: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function isFormDirty(state: NostrProfileFormState): boolean {
  const { values, original } = state;
  return (
    values.name !== original.name ||
    values.displayName !== original.displayName ||
    values.about !== original.about ||
    values.picture !== original.picture ||
    values.banner !== original.banner ||
    values.website !== original.website ||
    values.nip05 !== original.nip05 ||
    values.lud16 !== original.lud16
  );
}

// ============================================================================
// Form Rendering
// ============================================================================

export function renderNostrProfileForm(params: {
  state: NostrProfileFormState;
  callbacks: NostrProfileFormCallbacks;
  accountId: string;
}): TemplateResult {
  const { state, callbacks, accountId } = params;
  const isDirty = isFormDirty(state);

  const renderField = (
    field: keyof NostrProfileType,
    label: string,
    opts: {
      type?: "text" | "url" | "textarea";
      placeholder?: string;
      maxLength?: number;
      help?: string;
    } = {},
  ) => {
    const { type = "text", placeholder, maxLength, help } = opts;
    const value = state.values[field] ?? "";
    const error = state.fieldErrors[field];

    const inputId = `nostr-profile-${field}`;

    if (type === "textarea") {
      return html`
        <div class="form-field" style="margin-bottom: 12px;">
          <label for="${inputId}" style="display: block; margin-bottom: 4px; font-weight: 500;">
            ${label}
          </label>
          <textarea
            id="${inputId}"
            .value=${value}
            placeholder=${placeholder ?? ""}
            maxlength=${maxLength ?? 2000}
            rows="3"
            style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; resize: vertical; font-family: inherit;"
            @input=${(e: InputEvent) => {
              const target = e.target as HTMLTextAreaElement;
              callbacks.onFieldChange(field, target.value);
            }}
            ?disabled=${state.saving}
          ></textarea>
          ${help ? html`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${help}</div>` : nothing}
          ${error ? html`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${error}</div>` : nothing}
        </div>
      `;
    }

    return html`
      <div class="form-field" style="margin-bottom: 12px;">
        <label for="${inputId}" style="display: block; margin-bottom: 4px; font-weight: 500;">
          ${label}
        </label>
        <input
          id="${inputId}"
          type=${type}
          .value=${value}
          placeholder=${placeholder ?? ""}
          maxlength=${maxLength ?? 256}
          style="width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px;"
          @input=${(e: InputEvent) => {
            const target = e.target as HTMLInputElement;
            callbacks.onFieldChange(field, target.value);
          }}
          ?disabled=${state.saving}
        />
        ${help ? html`<div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${help}</div>` : nothing}
        ${error ? html`<div style="font-size: 12px; color: var(--danger-color); margin-top: 2px;">${error}</div>` : nothing}
      </div>
    `;
  };

  const renderPicturePreview = () => {
    const picture = state.values.picture;
    if (!picture) {
      return nothing;
    }

    return html`
      <div style="margin-bottom: 12px;">
        <img
          src=${picture}
          alt=${msg("Profile picture preview", { id: "channels.nostr.profileForm.picturePreviewAlt" })}
          style="max-width: 80px; max-height: 80px; border-radius: 50%; object-fit: cover; border: 2px solid var(--border-color);"
          @error=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            img.style.display = "none";
          }}
          @load=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            img.style.display = "block";
          }}
        />
      </div>
    `;
  };

  return html`
    <div class="nostr-profile-form" style="padding: 16px; background: var(--bg-secondary); border-radius: 8px; margin-top: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <div style="font-weight: 600; font-size: 16px;">${msg("Edit Profile", { id: "channels.nostr.profileForm.title" })}</div>
        <div style="font-size: 12px; color: var(--text-muted);">${msg("Account:", { id: "channels.nostr.profileForm.account" })} ${accountId}</div>
      </div>

      ${
        state.error
          ? html`<div class="callout danger" style="margin-bottom: 12px;">${state.error}</div>`
          : nothing
      }

      ${
        state.success
          ? html`<div class="callout success" style="margin-bottom: 12px;">${state.success}</div>`
          : nothing
      }

      ${renderPicturePreview()}

      ${renderField("name", msg("Username", { id: "channels.nostr.profileForm.username" }), {
        placeholder: msg("satoshi", { id: "channels.nostr.profileForm.usernamePlaceholder" }),
        maxLength: 256,
        help: msg("Short username (e.g., satoshi)", {
          id: "channels.nostr.profileForm.usernameHelp",
        }),
      })}

      ${renderField(
        "displayName",
        msg("Display Name", { id: "channels.nostr.profileForm.displayName" }),
        {
          placeholder: msg("Satoshi Nakamoto", {
            id: "channels.nostr.profileForm.displayNamePlaceholder",
          }),
          maxLength: 256,
          help: msg("Your full display name", { id: "channels.nostr.profileForm.displayNameHelp" }),
        },
      )}

      ${renderField("about", msg("Bio", { id: "channels.nostr.profileForm.bio" }), {
        type: "textarea",
        placeholder: msg("Tell people about yourself...", {
          id: "channels.nostr.profileForm.bioPlaceholder",
        }),
        maxLength: 2000,
        help: msg("A brief bio or description", { id: "channels.nostr.profileForm.bioHelp" }),
      })}

      ${renderField("picture", msg("Avatar URL", { id: "channels.nostr.profileForm.avatarUrl" }), {
        type: "url",
        placeholder: msg("https://example.com/avatar.jpg", {
          id: "channels.nostr.profileForm.avatarPlaceholder",
        }),
        help: msg("HTTPS URL to your profile picture", {
          id: "channels.nostr.profileForm.avatarHelp",
        }),
      })}

      ${
        state.showAdvanced
          ? html`
            <div style="border-top: 1px solid var(--border-color); padding-top: 12px; margin-top: 12px;">
              <div style="font-weight: 500; margin-bottom: 12px; color: var(--text-muted);">${msg("Advanced", { id: "channels.nostr.profileForm.advanced" })}</div>

              ${renderField(
                "banner",
                msg("Banner URL", { id: "channels.nostr.profileForm.bannerUrl" }),
                {
                  type: "url",
                  placeholder: msg("https://example.com/banner.jpg", {
                    id: "channels.nostr.profileForm.bannerPlaceholder",
                  }),
                  help: msg("HTTPS URL to a banner image", {
                    id: "channels.nostr.profileForm.bannerHelp",
                  }),
                },
              )}

              ${renderField(
                "website",
                msg("Website", { id: "channels.nostr.profileForm.website" }),
                {
                  type: "url",
                  placeholder: msg("https://example.com", {
                    id: "channels.nostr.profileForm.websitePlaceholder",
                  }),
                  help: msg("Your personal website", {
                    id: "channels.nostr.profileForm.websiteHelp",
                  }),
                },
              )}

              ${renderField(
                "nip05",
                msg("NIP-05 Identifier", { id: "channels.nostr.profileForm.nip05" }),
                {
                  placeholder: msg("you@example.com", {
                    id: "channels.nostr.profileForm.nip05Placeholder",
                  }),
                  help: msg("Verifiable identifier (e.g., you@domain.com)", {
                    id: "channels.nostr.profileForm.nip05Help",
                  }),
                },
              )}

              ${renderField(
                "lud16",
                msg("Lightning Address", { id: "channels.nostr.profileForm.lud16" }),
                {
                  placeholder: msg("you@getalby.com", {
                    id: "channels.nostr.profileForm.lud16Placeholder",
                  }),
                  help: msg("Lightning address for tips (LUD-16)", {
                    id: "channels.nostr.profileForm.lud16Help",
                  }),
                },
              )}
            </div>
          `
          : nothing
      }

      <div style="display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap;">
        <button
          class="btn primary"
          @click=${callbacks.onSave}
          ?disabled=${state.saving || !isDirty}
        >
          ${state.saving ? msg("Saving...", { id: "channels.nostr.profileForm.saving" }) : msg("Save & Publish", { id: "channels.nostr.profileForm.save" })}
        </button>

        <button
          class="btn"
          @click=${callbacks.onImport}
          ?disabled=${state.importing || state.saving}
        >
          ${state.importing ? msg("Importing...", { id: "channels.nostr.profileForm.importing" }) : msg("Import from Relays", { id: "channels.nostr.profileForm.import" })}
        </button>

        <button
          class="btn"
          @click=${callbacks.onToggleAdvanced}
        >
          ${state.showAdvanced ? msg("Hide Advanced", { id: "channels.nostr.profileForm.hideAdvanced" }) : msg("Show Advanced", { id: "channels.nostr.profileForm.showAdvanced" })}
        </button>

        <button
          class="btn"
          @click=${callbacks.onCancel}
          ?disabled=${state.saving}
        >
          ${msg("Cancel", { id: "channels.nostr.profileForm.cancel" })}
        </button>
      </div>

      ${
        isDirty
          ? html`
              <div style="font-size: 12px; color: var(--warning-color); margin-top: 8px">
                ${msg("You have unsaved changes", { id: "channels.nostr.profileForm.unsaved" })}
              </div>
            `
          : nothing
      }
    </div>
  `;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create initial form state from existing profile
 */
export function createNostrProfileFormState(
  profile: NostrProfileType | undefined,
): NostrProfileFormState {
  const values: NostrProfileType = {
    name: profile?.name ?? "",
    displayName: profile?.displayName ?? "",
    about: profile?.about ?? "",
    picture: profile?.picture ?? "",
    banner: profile?.banner ?? "",
    website: profile?.website ?? "",
    nip05: profile?.nip05 ?? "",
    lud16: profile?.lud16 ?? "",
  };

  return {
    values,
    original: { ...values },
    saving: false,
    importing: false,
    error: null,
    success: null,
    fieldErrors: {},
    showAdvanced: Boolean(profile?.banner || profile?.website || profile?.nip05 || profile?.lud16),
  };
}
