/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
import { classMap } from "lit/directives/class-map.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";

@customElement("a2ui-audioplayer")
export class Audio extends Root {
  @property()
  accessor url: StringValue | null = null;

  static styles = [
    structuralStyles,
    css`
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      audio {
        display: block;
        width: 100%;
      }
    `,
  ];

  #renderAudio() {
    if (!this.url) {
      return nothing;
    }

    if (this.url && typeof this.url === "object") {
      if ("literalString" in this.url) {
        return html`<audio controls src=${this.url.literalString} />`;
      } else if ("literal" in this.url) {
        return html`<audio controls src=${this.url.literal} />`;
      } else if (this.url && "path" in this.url && this.url.path) {
        if (!this.processor || !this.component) {
          return html`(no processor)`;
        }

        const audioUrl = this.processor.getData(
          this.component,
          this.url.path,
          this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID
        );
        if (!audioUrl) {
          return html`Invalid audio URL`;
        }

        if (typeof audioUrl !== "string") {
          return html`Invalid audio URL`;
        }
        return html`<audio controls src=${audioUrl} />`;
      }
    }

    return html`(empty)`;
  }

  render() {
    return html`<section
      class=${classMap(this.theme.components.AudioPlayer)}
      style=${this.theme.additionalStyles?.AudioPlayer
        ? styleMap(this.theme.additionalStyles?.AudioPlayer)
        : nothing}
    >
      ${this.#renderAudio()}
    </section>`;
  }
}
