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
import { repeat } from "lit/directives/repeat.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { Styles } from "../index.js";
let Tabs = (() => {
    let _classDecorators = [customElement("a2ui-tabs")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _titles_decorators;
    let _titles_initializers = [];
    let _titles_extraInitializers = [];
    let _selected_decorators;
    let _selected_initializers = [];
    let _selected_extraInitializers = [];
    var Tabs = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _titles_decorators = [property()];
            _selected_decorators = [property()];
            __esDecorate(this, null, _titles_decorators, { kind: "accessor", name: "titles", static: false, private: false, access: { has: obj => "titles" in obj, get: obj => obj.titles, set: (obj, value) => { obj.titles = value; } }, metadata: _metadata }, _titles_initializers, _titles_extraInitializers);
            __esDecorate(this, null, _selected_decorators, { kind: "accessor", name: "selected", static: false, private: false, access: { has: obj => "selected" in obj, get: obj => obj.selected, set: (obj, value) => { obj.selected = value; } }, metadata: _metadata }, _selected_initializers, _selected_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Tabs = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #titles_accessor_storage = __runInitializers(this, _titles_initializers, null);
        get titles() { return this.#titles_accessor_storage; }
        set titles(value) { this.#titles_accessor_storage = value; }
        #selected_accessor_storage = (__runInitializers(this, _titles_extraInitializers), __runInitializers(this, _selected_initializers, 0));
        get selected() { return this.#selected_accessor_storage; }
        set selected(value) { this.#selected_accessor_storage = value; }
        static { this.styles = [
            structuralStyles,
            css `
      :host {
        display: block;
        flex: var(--weight);
      }
    `,
        ]; }
        willUpdate(changedProperties) {
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
            return html `<div
      id="buttons"
      class=${classMap(this.theme.components.Tabs.element)}
    >
      ${repeat(this.titles, (title, idx) => {
                let titleString = "";
                if ("literalString" in title && title.literalString) {
                    titleString = title.literalString;
                }
                else if ("literal" in title && title.literal !== undefined) {
                    titleString = title.literal;
                }
                else if (title && "path" in title && title.path) {
                    if (!this.processor || !this.component) {
                        return html `(no model)`;
                    }
                    const textValue = this.processor.getData(this.component, title.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
                    if (typeof textValue !== "string") {
                        return html `(invalid)`;
                    }
                    titleString = textValue;
                }
                let classes;
                if (this.selected === idx) {
                    classes = Styles.merge(this.theme.components.Tabs.controls.all, this.theme.components.Tabs.controls.selected);
                }
                else {
                    classes = { ...this.theme.components.Tabs.controls.all };
                }
                return html `<button
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
            return html `<slot name="current"></slot>`;
        }
        render() {
            return html `<section
      class=${classMap(this.theme.components.Tabs.container)}
      style=${this.theme.additionalStyles?.Tabs
                ? styleMap(this.theme.additionalStyles?.Tabs)
                : nothing}
    >
      ${[this.#renderTabs(), this.#renderSlot()]}
    </section>`;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _selected_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Tabs = _classThis;
})();
export { Tabs };
//# sourceMappingURL=tabs.js.map