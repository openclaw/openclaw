import { bundledPluginRoot } from "./scripts/lib/bundled-plugin-paths.mjs";

export const mediaToolsExtensionIds = [
  "alibaba",
  "deepgram",
  "elevenlabs",
  "fal",
  "fireworks",
  "image-generation-core",
  "runway",
  "talk-voice",
  "video-generation-core",
  "vydra",
];

export const mediaToolsExtensionTestRoots = mediaToolsExtensionIds.map((id) =>
  bundledPluginRoot(id),
);

export function isMediaToolsExtensionRoot(root) {
  return mediaToolsExtensionTestRoots.includes(root);
}
