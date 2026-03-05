import { html } from "lit";

export function renderIframeDashboard(src: string, title: string) {
  const embeddedSrc = src + (src.includes("?") ? "&" : "?") + "embedded=1";
  return html`<iframe src=${embeddedSrc} class="iframe-dashboard" title=${title}></iframe>`;
}
