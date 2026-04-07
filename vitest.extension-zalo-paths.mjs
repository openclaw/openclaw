export const zaloExtensionTestRoots = ["extensions/zalo", "extensions/zalouser"];

export const zaloLifecycleTestFiles = [
  "extensions/zalo/src/channel.startup.test.ts",
  "extensions/zalo/src/monitor.image.polling.test.ts",
  "extensions/zalo/src/monitor.lifecycle.test.ts",
  "extensions/zalo/src/monitor.pairing.lifecycle.test.ts",
  "extensions/zalo/src/monitor.reply-once.lifecycle.test.ts",
  "extensions/zalo/src/monitor.webhook.test.ts",
];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
