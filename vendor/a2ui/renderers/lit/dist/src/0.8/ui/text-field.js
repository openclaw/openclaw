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
import { html, css, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { Root } from "./root.js";
import { classMap } from "lit/directives/class-map.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { styleMap } from "lit/directives/style-map.js";
import { extractStringValue } from "./utils/utils.js";
import { structuralStyles } from "./styles.js";
let TextField = (() => {
    let _classDecorators = [customElement("a2ui-textfield")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _text_decorators;
    let _text_initializers = [];
    let _text_extraInitializers = [];
    let _label_decorators;
    let _label_initializers = [];
    let _label_extraInitializers = [];
    let _inputType_decorators;
    let _inputType_initializers = [];
    let _inputType_extraInitializers = [];
    var TextField = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _text_decorators = [property()];
            _label_decorators = [property()];
            _inputType_decorators = [property()];
            __esDecorate(this, null, _text_decorators, { kind: "accessor", name: "text", static: false, private: false, access: { has: obj => "text" in obj, get: obj => obj.text, set: (obj, value) => { obj.text = value; } }, metadata: _metadata }, _text_initializers, _text_extraInitializers);
            __esDecorate(this, null, _label_decorators, { kind: "accessor", name: "label", static: false, private: false, access: { has: obj => "label" in obj, get: obj => obj.label, set: (obj, value) => { obj.label = value; } }, metadata: _metadata }, _label_initializers, _label_extraInitializers);
            __esDecorate(this, null, _inputType_decorators, { kind: "accessor", name: "inputType", static: false, private: false, access: { has: obj => "inputType" in obj, get: obj => obj.inputType, set: (obj, value) => { obj.inputType = value; } }, metadata: _metadata }, _inputType_initializers, _inputType_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            TextField = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #text_accessor_storage = __runInitializers(this, _text_initializers, null);
        get text() { return this.#text_accessor_storage; }
        set text(value) { this.#text_accessor_storage = value; }
        #label_accessor_storage = (__runInitializers(this, _text_extraInitializers), __runInitializers(this, _label_initializers, null));
        get label() { return this.#label_accessor_storage; }
        set label(value) { this.#label_accessor_storage = value; }
        #inputType_accessor_storage = (__runInitializers(this, _label_extraInitializers), __runInitializers(this, _inputType_initializers, null));
        get inputType() { return this.#inputType_accessor_storage; }
        set inputType(value) { this.#inputType_accessor_storage = value; }
        static { this.styles = [
            structuralStyles,
            css `
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
        ]; }
        #setBoundValue(value) {
            if (!this.text || !this.processor) {
                return;
            }
            if (!("path" in this.text)) {
                return;
            }
            if (!this.text.path) {
                return;
            }
            this.processor.setData(this.component, this.text.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
        }
        #renderField(value, label) {
            return html ` <section
      class=${classMap(this.theme.components.TextField.container)}
    >
      ${label && label !== ""
                ? html `<label
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
        @input=${(evt) => {
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
            const label = extractStringValue(this.label, this.component, this.processor, this.surfaceId);
            const value = extractStringValue(this.text, this.component, this.processor, this.surfaceId);
            return this.#renderField(value, label);
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _inputType_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return TextField = _classThis;
})();
export { TextField };
//# sourceMappingURL=text-field.js.map