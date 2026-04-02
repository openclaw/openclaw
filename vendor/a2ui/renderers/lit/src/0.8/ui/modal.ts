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
import { customElement, query, state } from "lit/decorators.js";
import { Root } from "./root.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { ref } from "lit/directives/ref.js";

@customElement("a2ui-modal")
export class Modal extends Root {
  static styles = [
    structuralStyles,
    css`
      * {
        box-sizing: border-box;
      }

      dialog {
        padding: 0 0 0 0;
        border: none;
        background: none;

        & section {
          & #controls {
            display: flex;
            justify-content: end;
            margin-bottom: 4px;

            & button {
              padding: 0;
              background: none;
              width: 20px;
              height: 20px;
              pointer: cursor;
              border: none;
              cursor: pointer;
            }
          }
        }
      }
    `,
  ];

  @state()
  accessor #showModal = false;

  @query("dialog")
  accessor #modalRef: HTMLDialogElement | null = null;

  #closeModal() {
    if (!this.#modalRef) {
      return;
    }

    if (this.#modalRef.open) {
      this.#modalRef.close();
    }

    this.#showModal = false;
  }

  render() {
    if (!this.#showModal) {
      return html`<section
        @click=${() => {
          this.#showModal = true;
        }}
      >
        <slot name="entry"></slot>
      </section>`;
    }

    return html`<dialog
      class=${classMap(this.theme.components.Modal.backdrop)}
      @click=${(evt: Event) => {
        // Only clicks on the background close the dialog.
        const [top] = evt.composedPath();
        if (!(top instanceof HTMLDialogElement)) {
          return;
        }

        this.#closeModal();
      }}
      ${ref((el?: Element) => {
        const showModalIfNeeded = () => {
          const validElement = el && el instanceof HTMLDialogElement;
          if (!validElement || el.open) {
            return;
          }

          el.showModal();
        };
        requestAnimationFrame(showModalIfNeeded);
      })}
    >
      <section
        class=${classMap(this.theme.components.Modal.element)}
        style=${this.theme.additionalStyles?.Modal
        ? styleMap(this.theme.additionalStyles?.Modal)
        : nothing}
      >
        <div id="controls">
          <button
            @click=${() => {
        this.#closeModal();
      }}
          >
            <span class="g-icon">close</span>
          </button>
        </div>
        <slot></slot>
      </section>
    </dialog>`;
  }
}
