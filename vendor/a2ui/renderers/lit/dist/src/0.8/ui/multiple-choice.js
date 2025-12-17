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
import { extractStringValue } from "./utils/utils.js";
let MultipleChoice = (() => {
    let _classDecorators = [customElement("a2ui-multiplechoice")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _description_decorators;
    let _description_initializers = [];
    let _description_extraInitializers = [];
    let _options_decorators;
    let _options_initializers = [];
    let _options_extraInitializers = [];
    let _selections_decorators;
    let _selections_initializers = [];
    let _selections_extraInitializers = [];
    var MultipleChoice = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _description_decorators = [property()];
            _options_decorators = [property()];
            _selections_decorators = [property()];
            __esDecorate(this, null, _description_decorators, { kind: "accessor", name: "description", static: false, private: false, access: { has: obj => "description" in obj, get: obj => obj.description, set: (obj, value) => { obj.description = value; } }, metadata: _metadata }, _description_initializers, _description_extraInitializers);
            __esDecorate(this, null, _options_decorators, { kind: "accessor", name: "options", static: false, private: false, access: { has: obj => "options" in obj, get: obj => obj.options, set: (obj, value) => { obj.options = value; } }, metadata: _metadata }, _options_initializers, _options_extraInitializers);
            __esDecorate(this, null, _selections_decorators, { kind: "accessor", name: "selections", static: false, private: false, access: { has: obj => "selections" in obj, get: obj => obj.selections, set: (obj, value) => { obj.selections = value; } }, metadata: _metadata }, _selections_initializers, _selections_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            MultipleChoice = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #description_accessor_storage = __runInitializers(this, _description_initializers, null);
        get description() { return this.#description_accessor_storage; }
        set description(value) { this.#description_accessor_storage = value; }
        #options_accessor_storage = (__runInitializers(this, _description_extraInitializers), __runInitializers(this, _options_initializers, []));
        get options() { return this.#options_accessor_storage; }
        set options(value) { this.#options_accessor_storage = value; }
        #selections_accessor_storage = (__runInitializers(this, _options_extraInitializers), __runInitializers(this, _selections_initializers, []));
        get selections() { return this.#selections_accessor_storage; }
        set selections(value) { this.#selections_accessor_storage = value; }
        static { this.styles = [
            structuralStyles,
            css `
      * {
        box-sizing: border-box;
      }

      :host {
        display: block;
        flex: var(--weight);
        min-height: 0;
        overflow: auto;
      }

      select {
        width: 100%;
      }

      .description {
      }
    `,
        ]; }
        #setBoundValue(value) {
            console.log(value);
            if (!this.selections || !this.processor) {
                return;
            }
            if (!("path" in this.selections)) {
                return;
            }
            if (!this.selections.path) {
                return;
            }
            this.processor.setData(this.component, this.selections.path, value, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
        }
        willUpdate(changedProperties) {
            const shouldUpdate = changedProperties.has("options");
            if (!shouldUpdate) {
                return;
            }
            if (!this.processor || !this.component || Array.isArray(this.selections)) {
                return;
            }
            this.selections;
            const selectionValue = this.processor.getData(this.component, this.selections.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
            if (!Array.isArray(selectionValue)) {
                return;
            }
            this.#setBoundValue(selectionValue);
        }
        render() {
            return html `<section class=${classMap(this.theme.components.MultipleChoice.container)}>
      <label class=${classMap(this.theme.components.MultipleChoice.label)} for="data">${this.description ?? "Select an item"}</div>
      <select
        name="data"
        id="data"
        class=${classMap(this.theme.components.MultipleChoice.element)}
        style=${this.theme.additionalStyles?.MultipleChoice
                ? styleMap(this.theme.additionalStyles?.MultipleChoice)
                : nothing}
        @change=${(evt) => {
                if (!(evt.target instanceof HTMLSelectElement)) {
                    return;
                }
                this.#setBoundValue([evt.target.value]);
            }}
      >
        ${this.options.map((option) => {
                const label = extractStringValue(option.label, this.component, this.processor, this.surfaceId);
                return html `<option ${option.value}>${label}</option>`;
            })}
      </select>
    </section>`;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _selections_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return MultipleChoice = _classThis;
})();
export { MultipleChoice };
//# sourceMappingURL=multiple-choice.js.map