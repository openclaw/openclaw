import type MarkdownIt from "markdown-it";
import Token from "markdown-it/lib/token.mjs";

function createCheckboxToken(_md: MarkdownIt, checked: boolean): Token {
  const token = new Token("html_inline", "", 0);
  token.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked=""' : ""}> `;
  return token;
}

function addClass(token: Token, className: string) {
  const existing = token.attrGet("class")?.trim();
  const classes = new Set((existing ? existing.split(/\s+/) : []).filter(Boolean));
  classes.add(className);
  token.attrSet("class", Array.from(classes).join(" "));
}

export function markdownTaskLists(md: MarkdownIt) {
  md.core.ruler.after("inline", "task_lists", (state) => {
    const listStack: Token[] = [];

    for (let index = 0; index < state.tokens.length; index += 1) {
      const token = state.tokens[index];
      if (token.type === "bullet_list_open") {
        listStack.push(token);
        continue;
      }
      if (token.type === "bullet_list_close") {
        listStack.pop();
        continue;
      }
      if (token.type !== "inline" || !Array.isArray(token.children)) {
        continue;
      }
      if (
        state.tokens[index - 1]?.type !== "paragraph_open" ||
        state.tokens[index - 2]?.type !== "list_item_open"
      ) {
        continue;
      }

      const markerTextIndex = token.children.findIndex((child) => child.type === "text");
      if (markerTextIndex === -1) {
        continue;
      }
      const markerText = token.children[markerTextIndex];
      const match = markerText.content.match(/^\[( |x|X)]\s+/);
      if (!match) {
        continue;
      }

      const checked = /[xX]/.test(match[0]);
      const remaining = markerText.content.slice(match[0].length);
      if (remaining.length > 0) {
        markerText.content = remaining;
        token.children.splice(markerTextIndex, 0, createCheckboxToken(md, checked));
      } else {
        token.children.splice(markerTextIndex, 1, createCheckboxToken(md, checked));
      }

      const listItemOpen = state.tokens[index - 2] ?? null;
      if (listItemOpen) {
        addClass(listItemOpen, "task-list-item");
      }
      const currentList = listStack[listStack.length - 1];
      if (currentList) {
        addClass(currentList, "contains-task-list");
      }
    }
  });
}
