import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
      continue;
    }
    const ext = extname(entry.name);
    if (ext === ".ts" || ext === ".tsx") {
      out.push(full);
    }
  }
  return out;
}

function collectMsgIds(source: string): string[] {
  const ids: string[] = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf("msg(", cursor);
    if (start === -1) {
      break;
    }
    let i = start + 4;
    let depth = 1;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;

    while (i < source.length && depth > 0) {
      const ch = source[i] ?? "";
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }

    const call = source.slice(start, i);
    const literalId = call.match(/\bid\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    if (literalId && !literalId.includes("${")) {
      ids.push(literalId);
    }
    cursor = i;
  }
  return ids;
}

function collectUsageMsgCalls(source: string): { ids: string[]; dynamicCalls: string[] } {
  const ids: string[] = [];
  const dynamicCalls: string[] = [];
  const needle = "usageMsg(";
  let cursor = 0;

  while (true) {
    const start = source.indexOf(needle, cursor);
    if (start === -1) {
      break;
    }

    const prefix = source.slice(Math.max(0, start - 20), start);
    if (/\bfunction\s+$/.test(prefix)) {
      cursor = start + needle.length;
      continue;
    }

    let i = start + needle.length;
    let depth = 1;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;

    while (i < source.length && depth > 0) {
      const ch = source[i] ?? "";
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === quote) {
          quote = null;
        }
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      i += 1;
    }

    const call = source.slice(start, i);
    const firstArg = call.slice(needle.length).match(/^\s*(['"])((?:\\.|(?!\1).)*)\1/)?.[2];
    if (firstArg) {
      ids.push(`usage.${firstArg}`);
    } else {
      dynamicCalls.push(call.replace(/\s+/g, " ").trim());
    }

    cursor = i;
  }

  return { ids, dynamicCalls };
}

function collectLocaleKeys(source: string): Set<string> {
  const keys = new Set<string>();
  const keyRe = /^\s*['"]([^'"\n]+)['"]\s*:/gm;
  let match: RegExpExecArray | null;
  while ((match = keyRe.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

describe("ui localization coverage", () => {
  it("covers every static msg id used in UI for zh-CN", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const srcRoot = join(here, "..");
    const files = walkFiles(srcRoot).filter(
      (file) =>
        !file.endsWith("/locales/zh-CN.ts") &&
        !file.endsWith("/ui/localization-coverage.node.test.ts"),
    );

    const usedIds = new Set<string>();
    const dynamicUsageCalls: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const id of collectMsgIds(content)) {
        usedIds.add(id);
      }
      const usageCalls = collectUsageMsgCalls(content);
      for (const id of usageCalls.ids) {
        usedIds.add(id);
      }
      for (const call of usageCalls.dynamicCalls) {
        dynamicUsageCalls.push(`${file}: ${call}`);
      }
    }

    expect(dynamicUsageCalls).toEqual([]);

    const zhPath = join(srcRoot, "locales", "zh-CN.ts");
    const zhSource = readFileSync(zhPath, "utf8");
    const zhKeys = collectLocaleKeys(zhSource);

    const missing = [...usedIds].filter((id) => !zhKeys.has(id)).toSorted();
    expect(missing).toEqual([]);
  });
});
