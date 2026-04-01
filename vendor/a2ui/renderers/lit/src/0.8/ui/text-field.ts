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
import { ResolvedTextField } from "../types/types";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { styleMap } from "lit/directives/style-map.js";
import { extractStringValue } from "./utils/utils.js";
import { structuralStyles } from "./styles.js";

@customElement("a2ui-textfield")
export class TextField extends Root {
  @property()
  accessor text: StringValue | null = null;

  @property()
  accessor label: StringValue | null = null;

  @property()
  accessor inputType: ResolvedTextField["type"] | null = null;

  static styles = [
    structuralStyles,
    css`
      * {
        box-sizing: border-box;
      }

      :host {
        display: flex;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      label {
        display: block;
        margin-bottom: 4px;
      }
    `,
  ];

  #setBoundValue(value: string) {
    if (!this.text || !this.processor) {
      return;
    }
    if (!("path" in this.text)) {
      return;
    }
    if (!this.text.path) {
      return;
    }

    this.processor.setData(
      this.component,
      this.text.path,
      value,
      this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID
    );
  }

  #renderField(value: string | number, label: string) {
    return html` <section
      class=${classMap(this.theme.components.TextField.container)}
    >
      ${label && label !== ""
        ? html`<label
            class=${classMap(this.theme.components.TextField.label)}
            for="data"
            >${label}</label
          >`
        : nothing}
      <input
        autocomplete="off"
        class=${classMap(this.theme.components.TextField.element)}
        style=${this.theme.additionalStyles?.TextField
          ? styleMap(this.theme.additionalStyles?.TextField)
          : nothing}
        @input=${(evt: Event) => {
          if (!(evt.target instanceof HTMLInputElement)) {
            return;
          }

          this.#setBoundValue(evt.target.value);
        }}
        name="data"
        id="data"
        .value=${value}
        .placeholder=${"Please enter a value"}
        type=${this.inputType === "number" ? "number" : "text"}
      />
    </section>`;
  }

  render() {
    const label = extractStringValue(
      this.label,
      this.component,
      this.processor,
      this.surfaceId
    );
    const value = extractStringValue(
      this.text,
      this.component,
      this.processor,
      this.surfaceId
    );

    return this.#renderField(value, label);
  }
}
