import { defineBrowserCommand } from "@vitest/browser-playwright";
import type { OverlayMedia } from "../src/test-helpers/overlay-browser-media.ts";

export const overlayEmulateMedia = defineBrowserCommand(async ({ page }, media: OverlayMedia) => {
  await page.emulateMedia(media);
});
