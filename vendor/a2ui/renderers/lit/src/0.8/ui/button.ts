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
import { StateEvent } from "../events/events.js";
import { classMap } from "lit/directives/class-map.js";
import { Action } from "../types/components.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";

@customElement("a2ui-button")
export class Button extends Root {
  @property()
  accessor action: Action | null = null;

  static styles = [
    structuralStyles,
    css`
      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
      }
    `,
  ];

  render() {
    return html`<button
      class=${classMap(this.theme.components.Button)}
      style=${this.theme.additionalStyles?.Button
        ? styleMap(this.theme.additionalStyles?.Button)
        : nothing}
      @click=${() => {
        if (!this.action) {
          return;
        }
        const evt = new StateEvent<"a2ui.action">({
          eventType: "a2ui.action",
          action: this.action,
          dataContextPath: this.dataContextPath,
          sourceComponentId: this.id,
          sourceComponent: this.component,
        });
        this.dispatchEvent(evt);
      }}
    >
      <slot></slot>
    </button>`;
  }
}
