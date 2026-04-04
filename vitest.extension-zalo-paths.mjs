export const zaloExtensionTestRoots = ["extensions/zalo", "extensions/zalouser"];

export function isZaloExtensionRoot(root) {
  return zaloExtensionTestRoots.includes(root);
}
