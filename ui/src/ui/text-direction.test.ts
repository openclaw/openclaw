import { describe, expect, it } from "vitest";
import { detectTextDirection } from "./text-direction.ts";

describe("detectTextDirection", () => {
  it("returns ltr for null and empty input", () => {
    expect(detectTextDirection(null)).toBe("ltr");
    expect(detectTextDirection("")).toBe("ltr");
  });

  it("detects rtl when first significant char is rtl script", () => {
    expect(detectTextDirection("שלום עולם")).toBe("rtl");
    expect(detectTextDirection("مرحبا")).toBe("rtl");
  });

  it("detects ltr when first significant char is ltr", () => {
    expect(detectTextDirection("Hello world")).toBe("ltr");
  });

  it("skips punctuation and markdown prefix characters before detection", () => {
    expect(detectTextDirection("**שלום")).toBe("rtl");
    expect(detectTextDirection("# مرحبا")).toBe("rtl");
    expect(detectTextDirection("- hello")).toBe("ltr");
  });

  it("prefers dominant script in mixed-language text", () => {
    expect(detectTextDirection("Hello שלום עולם")).toBe("rtl");
    expect(detectTextDirection("שלום hello world test")).toBe("ltr");
  });

  it("ignores OpenClaw reply tags at the start", () => {
    expect(detectTextDirection("[[reply_to_current]] שלום עם Web UI")).toBe("rtl");
    expect(detectTextDirection("[[reply_to: 123]] hello עם קצת עברית")).toBe("ltr");
  });

  it("ignores fenced and inline code for direction inference", () => {
    const mixed = "סגור — עשיתי.\n\n```bash\ngh auth login\ngit push\n```\n\nעוד טקסט בעברית";
    expect(detectTextDirection(mixed)).toBe("rtl");

    const mixedInline = "שלום זה `npm run build` ואז ממשיכים בעברית";
    expect(detectTextDirection(mixedInline)).toBe("rtl");
  });
});
