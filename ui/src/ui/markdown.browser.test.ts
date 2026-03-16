import { afterEach, describe, expect, it } from "vitest";
import "../styles.css";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("markdown code block copy button styles", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a single copy label state at a time", async () => {
    const container = document.createElement("div");
    container.className = "chat-text";
    container.innerHTML = toSanitizedMarkdownHtml(["```bash", "echo hello", "```"].join("\n"));
    document.body.append(container);

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const button = container.querySelector<HTMLButtonElement>(".code-block-copy");
    const idle = container.querySelector<HTMLElement>(".code-block-copy__idle");
    const done = container.querySelector<HTMLElement>(".code-block-copy__done");

    expect(button).not.toBeNull();
    expect(idle).not.toBeNull();
    expect(done).not.toBeNull();
    if (!button || !idle || !done) {
      return;
    }

    expect(getComputedStyle(button).display).toMatch(/flex/);
    expect(getComputedStyle(idle).display).not.toBe("none");
    expect(getComputedStyle(done).display).toBe("none");

    button.classList.add("copied");

    expect(getComputedStyle(idle).display).toBe("none");
    expect(getComputedStyle(done).display).not.toBe("none");
  });
});
