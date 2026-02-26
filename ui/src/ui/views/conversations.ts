import { html } from "lit";

export function renderConversations() {
  const src = `${window.location.origin}/conversations`;
  return html`<iframe
    src=${src}
    style="width:100%;height:100%;border:none;display:block"
    title="Conversas"
  ></iframe>`;
}
