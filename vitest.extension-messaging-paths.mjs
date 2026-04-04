import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const messagingExtensionIds = [
  "bluebubbles",
  "googlechat",
  "irc",
  "mattermost",
  "nextcloud-talk",
  "nostr",
  "qqbot",
  "synology-chat",
  "tlon",
  "twitch",
  "voice-call",
  "zalo",
  "zalouser",
];

export const messagingExtensionTestRoots = messagingExtensionIds.map((id) => bundledPluginRoot(id));

export function isMessagingExtensionRoot(root) {
  return messagingExtensionTestRoots.includes(root);
}
