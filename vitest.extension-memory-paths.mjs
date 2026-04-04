export const memoryExtensionTestRoots = ["extensions/memory-core", "extensions/memory-lancedb"];

export function isMemoryExtensionRoot(root) {
  return memoryExtensionTestRoots.includes(root);
}
