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
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
import { html, css, nothing } from "lit";
import { customElement, query, state } from "lit/decorators.js";
import { Root } from "./root.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { ref } from "lit/directives/ref.js";
let Modal = (() => {
    let _classDecorators = [customElement("a2ui-modal")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _private_showModal_decorators;
    let _private_showModal_initializers = [];
    let _private_showModal_extraInitializers = [];
    let _private_showModal_descriptor;
    let _private_modalRef_decorators;
    let _private_modalRef_initializers = [];
    let _private_modalRef_extraInitializers = [];
    let _private_modalRef_descriptor;
    var Modal = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _private_showModal_decorators = [state()];
            _private_modalRef_decorators = [query("dialog")];
            __esDecorate(this, _private_showModal_descriptor = { get: __setFunctionName(function () { return this.#showModal_accessor_storage; }, "#showModal", "get"), set: __setFunctionName(function (value) { this.#showModal_accessor_storage = value; }, "#showModal", "set") }, _private_showModal_decorators, { kind: "accessor", name: "#showModal", static: false, private: true, access: { has: obj => #showModal in obj, get: obj => obj.#showModal, set: (obj, value) => { obj.#showModal = value; } }, metadata: _metadata }, _private_showModal_initializers, _private_showModal_extraInitializers);
            __esDecorate(this, _private_modalRef_descriptor = { get: __setFunctionName(function () { return this.#modalRef_accessor_storage; }, "#modalRef", "get"), set: __setFunctionName(function (value) { this.#modalRef_accessor_storage = value; }, "#modalRef", "set") }, _private_modalRef_decorators, { kind: "accessor", name: "#modalRef", static: false, private: true, access: { has: obj => #modalRef in obj, get: obj => obj.#modalRef, set: (obj, value) => { obj.#modalRef = value; } }, metadata: _metadata }, _private_modalRef_initializers, _private_modalRef_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Modal = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static { this.styles = [
            structuralStyles,
            css `
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
        ]; }
        #showModal_accessor_storage = __runInitializers(this, _private_showModal_initializers, false);
        get #showModal() { return _private_showModal_descriptor.get.call(this); }
        set #showModal(value) { return _private_showModal_descriptor.set.call(this, value); }
        #modalRef_accessor_storage = (__runInitializers(this, _private_showModal_extraInitializers), __runInitializers(this, _private_modalRef_initializers, null));
        get #modalRef() { return _private_modalRef_descriptor.get.call(this); }
        set #modalRef(value) { return _private_modalRef_descriptor.set.call(this, value); }
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
                return html `<section
        @click=${() => {
                    this.#showModal = true;
                }}
      >
        <slot name="entry"></slot>
      </section>`;
            }
            return html `<dialog
      class=${classMap(this.theme.components.Modal.backdrop)}
      @click=${(evt) => {
                // Only clicks on the background close the dialog.
                const [top] = evt.composedPath();
                if (!(top instanceof HTMLDialogElement)) {
                    return;
                }
                this.#closeModal();
            }}
      ${ref((el) => {
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
        constructor() {
            super(...arguments);
            __runInitializers(this, _private_modalRef_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Modal = _classThis;
})();
export { Modal };
//# sourceMappingURL=modal.js.map