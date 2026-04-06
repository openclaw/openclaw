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

import { html, css, PropertyValues, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Root } from "./root.js";
import { repeat } from "lit/directives/repeat.js";
import { StringValue } from "../types/primitives.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { Styles } from "../index.js";

@customElement("a2ui-tabs")
export class Tabs extends Root {
  @property()
  accessor titles: StringValue[] | null = null;

  @property()
  accessor selected = 0;

  static styles = [
    structuralStyles,
    css`
      :host {
        display: block;
        flex: var(--weight);
      }
    `,
  ];

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    super.willUpdate(changedProperties);

    if (changedProperties.has("selected")) {
      for (const child of this.children) {
        child.removeAttribute("slot");
      }
      const selectedChild = this.children[this.selected];
      if (!selectedChild) {
        return;
      }

      selectedChild.slot = "current";
    }
  }

  #renderTabs() {
    if (!this.titles) {
      return nothing;
    }

    return html`<div
      id="buttons"
      class=${classMap(this.theme.components.Tabs.element)}
    >
      ${repeat(this.titles, (title, idx) => {
        let titleString = "";
        if ("literalString" in title && title.literalString) {
          titleString = title.literalString;
        } else if ("literal" in title && title.literal !== undefined) {
          titleString = title.literal;
        } else if (title && "path" in title && title.path) {
          if (!this.processor || !this.component) {
            return html`(no model)`;
          }

          const textValue = this.processor.getData(
            this.component,
            title.path,
            this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID
          );

          if (typeof textValue !== "string") {
            return html`(invalid)`;
          }

          titleString = textValue;
        }

        let classes;
        if (this.selected === idx) {
          classes = Styles.merge(
            this.theme.components.Tabs.controls.all,
            this.theme.components.Tabs.controls.selected
          );
        } else {
          classes = { ...this.theme.components.Tabs.controls.all };
        }

        return html`<button
          ?disabled=${this.selected === idx}
          class=${classMap(classes)}
          @click=${() => {
            this.selected = idx;
          }}
        >
          ${titleString}
        </button>`;
      })}
    </div>`;
  }

  #renderSlot() {
    return html`<slot name="current"></slot>`;
  }

  render() {
    return html`<section
      class=${classMap(this.theme.components.Tabs.container)}
      style=${this.theme.additionalStyles?.Tabs
        ? styleMap(this.theme.additionalStyles?.Tabs)
        : nothing}
    >
      ${[this.#renderTabs(), this.#renderSlot()]}
    </section>`;
  }
}
