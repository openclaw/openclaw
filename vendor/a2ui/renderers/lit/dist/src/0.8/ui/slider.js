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
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { extractNumberValue } from "./utils/utils.js";
let Slider = (() => {
    let _classDecorators = [customElement("a2ui-slider")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _value_decorators;
    let _value_initializers = [];
    let _value_extraInitializers = [];
    let _minValue_decorators;
    let _minValue_initializers = [];
    let _minValue_extraInitializers = [];
    let _maxValue_decorators;
    let _maxValue_initializers = [];
    let _maxValue_extraInitializers = [];
    let _label_decorators;
    let _label_initializers = [];
    let _label_extraInitializers = [];
    let _inputType_decorators;
    let _inputType_initializers = [];
    let _inputType_extraInitializers = [];
    var Slider = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _value_decorators = [property()];
            _minValue_decorators = [property()];
            _maxValue_decorators = [property()];
            _label_decorators = [property()];
            _inputType_decorators = [property()];
            __esDecorate(this, null, _value_decorators, { kind: "accessor", name: "value", static: false, private: false, access: { has: obj => "value" in obj, get: obj => obj.value, set: (obj, value) => { obj.value = value; } }, metadata: _metadata }, _value_initializers, _value_extraInitializers);
            __esDecorate(this, null, _minValue_decorators, { kind: "accessor", name: "minValue", static: false, private: false, access: { has: obj => "minValue" in obj, get: obj => obj.minValue, set: (obj, value) => { obj.minValue = value; } }, metadata: _metadata }, _minValue_initializers, _minValue_extraInitializers);
            __esDecorate(this, null, _maxValue_decorators, { kind: "accessor", name: "maxValue", static: false, private: false, access: { has: obj => "maxValue" in obj, get: obj => obj.maxValue, set: (obj, value) => { obj.maxValue = value; } }, metadata: _metadata }, _maxValue_initializers, _maxValue_extraInitializers);
            __esDecorate(this, null, _label_decorators, { kind: "accessor", name: "label", static: false, private: false, access: { has: obj => "label" in obj, get: obj => obj.label, set: (obj, value) => { obj.label = value; } }, metadata: _metadata }, _label_initializers, _label_extraInitializers);
            __esDecorate(this, null, _inputType_decorators, { kind: "accessor", name: "inputType", static: false, private: false, access: { has: obj => "inputType" in obj, get: obj => obj.inputType, set: (obj, value) => { obj.inputType = value; } }, metadata: _metadata }, _inputType_initializers, _inputType_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Slider = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #value_accessor_storage = __runInitializers(this, _value_initializers, null);
        get value() { return this.#value_accessor_storage; }
        set value(value) { this.#value_accessor_storage = value; }
        #minValue_accessor_storage = (__runInitializers(this, _value_extraInitializers), __runInitializers(this, _minValue_initializers, 0));
        get minValue() { return this.#minValue_accessor_storage; }
        set minValue(value) { this.#minValue_accessor_storage = value; }
        #maxValue_accessor_storage = (__runInitializers(this, _minValue_extraInitializers), __runInitializers(this, _maxValue_initializers, 0));
        get maxValue() { return this.#maxValue_accessor_storage; }
        set maxValue(value) { this.#maxValue_accessor_storage = value; }
        #label_accessor_storage = (__runInitializers(this, _maxValue_extraInitializers), __runInitializers(this, _label_initializers, null));
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
        display: block;
        flex: var(--weight);
      }

      input {
        display: block;
        width: 100%;
      }

      .description {
      }
    `,
        ]; }
        #setBoundValue(value) {
            if (!this.value || !this.processor) {
                return;
            }
            if (!("path" in this.value)) {
                return;
            }
            if (!this.value.path) {
                return;
            }
            this.processor.setData(this.component, this.value.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
        }
        #renderField(value) {
            return html `<section
      class=${classMap(this.theme.components.Slider.container)}
    >
      <label class=${classMap(this.theme.components.Slider.label)} for="data">
        ${this.label?.literalString ?? ""}
      </label>
      <input
        autocomplete="off"
        class=${classMap(this.theme.components.Slider.element)}
        style=${this.theme.additionalStyles?.Slider
                ? styleMap(this.theme.additionalStyles?.Slider)
                : nothing}
        @input=${(evt) => {
                if (!(evt.target instanceof HTMLInputElement)) {
                    return;
                }
                this.#setBoundValue(evt.target.value);
            }}
        id="data"
        name="data"
        .value=${value}
        type="range"
        min=${this.minValue ?? "0"}
        max=${this.maxValue ?? "0"}
      />
      <span class=${classMap(this.theme.components.Slider.label)}
        >${this.value
                ? extractNumberValue(this.value, this.component, this.processor, this.surfaceId)
                : "0"}</span
      >
    </section>`;
        }
        render() {
            if (this.value && typeof this.value === "object") {
                if ("literalNumber" in this.value && this.value.literalNumber) {
                    return this.#renderField(this.value.literalNumber);
                }
                else if ("literal" in this.value && this.value.literal !== undefined) {
                    return this.#renderField(this.value.literal);
                }
                else if (this.value && "path" in this.value && this.value.path) {
                    if (!this.processor || !this.component) {
                        return html `(no processor)`;
                    }
                    const textValue = this.processor.getData(this.component, this.value.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
                    if (textValue === null) {
                        return html `Invalid value`;
                    }
                    if (typeof textValue !== "string" && typeof textValue !== "number") {
                        return html `Invalid value`;
                    }
                    return this.#renderField(textValue);
                }
            }
            return nothing;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _inputType_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Slider = _classThis;
})();
export { Slider };
//# sourceMappingURL=slider.js.map