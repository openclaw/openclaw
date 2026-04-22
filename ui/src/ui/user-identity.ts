import { coerceIdentityValue } from "../../../src/shared/assistant-identity-values.js";
import { normalizeOptionalString } from "./string-coerce.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";

const MAX_LOCAL_USER_NAME = 50;
const MAX_LOCAL_USER_TEXT_AVATAR = 16;
const MAX_LOCAL_USER_IMAGE_AVATAR = 2_000_000;

export type LocalUserIdentity = {
  name: string | null;
  avatar: string | null;
};

function normalizeAvatar(value?: string | null): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  if (isRenderableControlUiAvatarUrl(trimmed)) {
    return trimmed.length <= MAX_LOCAL_USER_IMAGE_AVATAR ? trimmed : null;
  }
  if (/[\r\n]/.test(trimmed)) {
    return null;
  }
  return trimmed.length <= MAX_LOCAL_USER_TEXT_AVATAR ? trimmed : null;
}

export function normalizeLocalUserIdentity(
  input?: Partial<LocalUserIdentity> | null,
): LocalUserIdentity {
  return {
    name:
      coerceIdentityValue(
        typeof input?.name === "string" ? input.name : undefined,
        MAX_LOCAL_USER_NAME,
      ) ?? null,
    avatar: normalizeAvatar(input?.avatar),
  };
}

export function hasLocalUserIdentity(identity: LocalUserIdentity): boolean {
  return Boolean(identity.name || identity.avatar);
}
