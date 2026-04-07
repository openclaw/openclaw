// ESM loader hook: convert raw Windows drive-letter paths (C:\...) to file:// URLs.
// Jiti's native import path passes resolved absolute paths directly to import(),
// but Node's ESM loader rejects drive-letter paths as unknown URL schemes.
import { pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (/^[a-zA-Z]:/.test(specifier)) {
    return nextResolve(pathToFileURL(specifier).href, context);
  }
  return nextResolve(specifier, context);
}
