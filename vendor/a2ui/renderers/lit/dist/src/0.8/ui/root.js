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
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
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
import { SignalWatcher } from "@lit-labs/signals";
import { consume } from "@lit/context";
import { css, html, LitElement, nothing, render, } from "lit";
import { customElement, property } from "lit/decorators.js";
import { map } from "lit/directives/map.js";
import { effect } from "signal-utils/subtle/microtask-effect";
import { themeContext } from "./context/theme.js";
import { structuralStyles } from "./styles.js";
import { componentRegistry } from "./component-registry.js";
// This is the base class all the components will inherit
let Root = (() => {
    let _classDecorators = [customElement("a2ui-root")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = SignalWatcher(LitElement);
    let _instanceExtraInitializers = [];
    let _surfaceId_decorators;
    let _surfaceId_initializers = [];
    let _surfaceId_extraInitializers = [];
    let _component_decorators;
    let _component_initializers = [];
    let _component_extraInitializers = [];
    let _theme_decorators;
    let _theme_initializers = [];
    let _theme_extraInitializers = [];
    let _childComponents_decorators;
    let _childComponents_initializers = [];
    let _childComponents_extraInitializers = [];
    let _processor_decorators;
    let _processor_initializers = [];
    let _processor_extraInitializers = [];
    let _dataContextPath_decorators;
    let _dataContextPath_initializers = [];
    let _dataContextPath_extraInitializers = [];
    let _enableCustomElements_decorators;
    let _enableCustomElements_initializers = [];
    let _enableCustomElements_extraInitializers = [];
    let _set_weight_decorators;
    var Root = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _surfaceId_decorators = [property()];
            _component_decorators = [property()];
            _theme_decorators = [consume({ context: themeContext })];
            _childComponents_decorators = [property({ attribute: false })];
            _processor_decorators = [property({ attribute: false })];
            _dataContextPath_decorators = [property()];
            _enableCustomElements_decorators = [property()];
            _set_weight_decorators = [property()];
            __esDecorate(this, null, _surfaceId_decorators, { kind: "accessor", name: "surfaceId", static: false, private: false, access: { has: obj => "surfaceId" in obj, get: obj => obj.surfaceId, set: (obj, value) => { obj.surfaceId = value; } }, metadata: _metadata }, _surfaceId_initializers, _surfaceId_extraInitializers);
            __esDecorate(this, null, _component_decorators, { kind: "accessor", name: "component", static: false, private: false, access: { has: obj => "component" in obj, get: obj => obj.component, set: (obj, value) => { obj.component = value; } }, metadata: _metadata }, _component_initializers, _component_extraInitializers);
            __esDecorate(this, null, _theme_decorators, { kind: "accessor", name: "theme", static: false, private: false, access: { has: obj => "theme" in obj, get: obj => obj.theme, set: (obj, value) => { obj.theme = value; } }, metadata: _metadata }, _theme_initializers, _theme_extraInitializers);
            __esDecorate(this, null, _childComponents_decorators, { kind: "accessor", name: "childComponents", static: false, private: false, access: { has: obj => "childComponents" in obj, get: obj => obj.childComponents, set: (obj, value) => { obj.childComponents = value; } }, metadata: _metadata }, _childComponents_initializers, _childComponents_extraInitializers);
            __esDecorate(this, null, _processor_decorators, { kind: "accessor", name: "processor", static: false, private: false, access: { has: obj => "processor" in obj, get: obj => obj.processor, set: (obj, value) => { obj.processor = value; } }, metadata: _metadata }, _processor_initializers, _processor_extraInitializers);
            __esDecorate(this, null, _dataContextPath_decorators, { kind: "accessor", name: "dataContextPath", static: false, private: false, access: { has: obj => "dataContextPath" in obj, get: obj => obj.dataContextPath, set: (obj, value) => { obj.dataContextPath = value; } }, metadata: _metadata }, _dataContextPath_initializers, _dataContextPath_extraInitializers);
            __esDecorate(this, null, _enableCustomElements_decorators, { kind: "accessor", name: "enableCustomElements", static: false, private: false, access: { has: obj => "enableCustomElements" in obj, get: obj => obj.enableCustomElements, set: (obj, value) => { obj.enableCustomElements = value; } }, metadata: _metadata }, _enableCustomElements_initializers, _enableCustomElements_extraInitializers);
            __esDecorate(this, null, _set_weight_decorators, { kind: "setter", name: "weight", static: false, private: false, access: { has: obj => "weight" in obj, set: (obj, value) => { obj.weight = value; } }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Root = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #surfaceId_accessor_storage = (__runInitializers(this, _instanceExtraInitializers), __runInitializers(this, _surfaceId_initializers, null));
        get surfaceId() { return this.#surfaceId_accessor_storage; }
        set surfaceId(value) { this.#surfaceId_accessor_storage = value; }
        #component_accessor_storage = (__runInitializers(this, _surfaceId_extraInitializers), __runInitializers(this, _component_initializers, null));
        get component() { return this.#component_accessor_storage; }
        set component(value) { this.#component_accessor_storage = value; }
        #theme_accessor_storage = (__runInitializers(this, _component_extraInitializers), __runInitializers(this, _theme_initializers, void 0));
        get theme() { return this.#theme_accessor_storage; }
        set theme(value) { this.#theme_accessor_storage = value; }
        #childComponents_accessor_storage = (__runInitializers(this, _theme_extraInitializers), __runInitializers(this, _childComponents_initializers, null));
        get childComponents() { return this.#childComponents_accessor_storage; }
        set childComponents(value) { this.#childComponents_accessor_storage = value; }
        #processor_accessor_storage = (__runInitializers(this, _childComponents_extraInitializers), __runInitializers(this, _processor_initializers, null));
        get processor() { return this.#processor_accessor_storage; }
        set processor(value) { this.#processor_accessor_storage = value; }
        #dataContextPath_accessor_storage = (__runInitializers(this, _processor_extraInitializers), __runInitializers(this, _dataContextPath_initializers, ""));
        get dataContextPath() { return this.#dataContextPath_accessor_storage; }
        set dataContextPath(value) { this.#dataContextPath_accessor_storage = value; }
        #enableCustomElements_accessor_storage = (__runInitializers(this, _dataContextPath_extraInitializers), __runInitializers(this, _enableCustomElements_initializers, false));
        get enableCustomElements() { return this.#enableCustomElements_accessor_storage; }
        set enableCustomElements(value) { this.#enableCustomElements_accessor_storage = value; }
        set weight(weight) {
            this.#weight = weight;
            this.style.setProperty("--weight", `${weight}`);
        }
        get weight() {
            return this.#weight;
        }
        #weight = (__runInitializers(this, _enableCustomElements_extraInitializers), 1);
        static { this.styles = [
            structuralStyles,
            css `
      :host {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 80%;
      }
    `,
        ]; }
        /**
         * Holds the cleanup function for our effect.
         * We need this to stop the effect when the component is disconnected.
         */
        #lightDomEffectDisposer = null;
        willUpdate(changedProperties) {
            if (changedProperties.has("childComponents")) {
                if (this.#lightDomEffectDisposer) {
                    this.#lightDomEffectDisposer();
                }
                // This effect watches the A2UI Children signal and updates the Light DOM.
                this.#lightDomEffectDisposer = effect(() => {
                    // 1. Read the signal to create the subscription.
                    const allChildren = this.childComponents ?? null;
                    // 2. Generate the template for the children.
                    const lightDomTemplate = this.renderComponentTree(allChildren);
                    // 3. Imperatively render that template into the component itself.
                    render(lightDomTemplate, this, { host: this });
                });
            }
        }
        /**
         * Clean up the effect when the component is removed from the DOM.
         */
        disconnectedCallback() {
            super.disconnectedCallback();
            if (this.#lightDomEffectDisposer) {
                this.#lightDomEffectDisposer();
            }
        }
        /**
         * Turns the SignalMap into a renderable TemplateResult for Lit.
         */
        renderComponentTree(components) {
            if (!components) {
                return nothing;
            }
            if (!Array.isArray(components)) {
                return nothing;
            }
            return html ` ${map(components, (component) => {
                // 1. Check if there is a registered custom component or override.
                if (this.enableCustomElements) {
                    const registeredCtor = componentRegistry.get(component.type);
                    // We also check customElements.get for non-registered but defined elements
                    const elCtor = registeredCtor || customElements.get(component.type);
                    if (elCtor) {
                        const node = component;
                        const el = new elCtor();
                        el.id = node.id;
                        if (node.slotName) {
                            el.slot = node.slotName;
                        }
                        el.component = node;
                        el.weight = node.weight ?? "initial";
                        el.processor = this.processor;
                        el.surfaceId = this.surfaceId;
                        el.dataContextPath = node.dataContextPath ?? "/";
                        for (const [prop, val] of Object.entries(component.properties)) {
                            // @ts-expect-error We're off the books.
                            el[prop] = val;
                        }
                        return html `${el}`;
                    }
                }
                // 2. Fallback to standard components.
                switch (component.type) {
                    case "List": {
                        const node = component;
                        const childComponents = node.properties.children;
                        return html `<a2ui-list
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .direction=${node.properties.direction ?? "vertical"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-list>`;
                    }
                    case "Card": {
                        const node = component;
                        let childComponents = node.properties.children;
                        if (!childComponents && node.properties.child) {
                            childComponents = [node.properties.child];
                        }
                        return html `<a2ui-card
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${childComponents}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-card>`;
                    }
                    case "Column": {
                        const node = component;
                        return html `<a2ui-column
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-column>`;
                    }
                    case "Row": {
                        const node = component;
                        return html `<a2ui-row
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .childComponents=${node.properties.children ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .alignment=${node.properties.alignment ?? "stretch"}
            .distribution=${node.properties.distribution ?? "start"}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-row>`;
                    }
                    case "Image": {
                        const node = component;
                        return html `<a2ui-image
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .usageHint=${node.properties.usageHint}
            .fit=${node.properties.fit}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-image>`;
                    }
                    case "Icon": {
                        const node = component;
                        return html `<a2ui-icon
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .name=${node.properties.name ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-icon>`;
                    }
                    case "AudioPlayer": {
                        const node = component;
                        return html `<a2ui-audioplayer
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .url=${node.properties.url ?? null}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-audioplayer>`;
                    }
                    case "Button": {
                        const node = component;
                        return html `<a2ui-button
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .action=${node.properties.action}
            .childComponents=${[node.properties.child]}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-button>`;
                    }
                    case "Text": {
                        const node = component;
                        return html `<a2ui-text
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .model=${this.processor}
            .surfaceId=${this.surfaceId}
            .processor=${this.processor}
            .dataContextPath=${node.dataContextPath}
            .text=${node.properties.text}
            .usageHint=${node.properties.usageHint}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-text>`;
                    }
                    case "CheckBox": {
                        const node = component;
                        return html `<a2ui-checkbox
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .label=${node.properties.label}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-checkbox>`;
                    }
                    case "DateTimeInput": {
                        const node = component;
                        return html `<a2ui-datetimeinput
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath ?? ""}
            .enableDate=${node.properties.enableDate ?? true}
            .enableTime=${node.properties.enableTime ?? true}
            .outputFormat=${node.properties.outputFormat}
            .value=${node.properties.value}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-datetimeinput>`;
                    }
                    case "Divider": {
                        // TODO: thickness, axis and color.
                        const node = component;
                        return html `<a2ui-divider
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .thickness=${node.properties.thickness}
            .axis=${node.properties.axis}
            .color=${node.properties.color}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-divider>`;
                    }
                    case "MultipleChoice": {
                        // TODO: maxAllowedSelections and selections.
                        const node = component;
                        return html `<a2ui-multiplechoice
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .options=${node.properties.options}
            .maxAllowedSelections=${node.properties.maxAllowedSelections}
            .selections=${node.properties.selections}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-multiplechoice>`;
                    }
                    case "Slider": {
                        const node = component;
                        return html `<a2ui-slider
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .value=${node.properties.value}
            .minValue=${node.properties.minValue}
            .maxValue=${node.properties.maxValue}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-slider>`;
                    }
                    case "TextField": {
                        // TODO: type and validationRegexp.
                        const node = component;
                        return html `<a2ui-textfield
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .label=${node.properties.label}
            .text=${node.properties.text}
            .type=${node.properties.type}
            .validationRegexp=${node.properties.validationRegexp}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-textfield>`;
                    }
                    case "Video": {
                        const node = component;
                        return html `<a2ui-video
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .url=${node.properties.url}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-video>`;
                    }
                    case "Tabs": {
                        const node = component;
                        const titles = [];
                        const childComponents = [];
                        if (node.properties.tabItems) {
                            for (const item of node.properties.tabItems) {
                                titles.push(item.title);
                                childComponents.push(item.child);
                            }
                        }
                        return html `<a2ui-tabs
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .titles=${titles}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-tabs>`;
                    }
                    case "Modal": {
                        const node = component;
                        const childComponents = [
                            node.properties.entryPointChild,
                            node.properties.contentChild,
                        ];
                        node.properties.entryPointChild.slotName = "entry";
                        return html `<a2ui-modal
            id=${node.id}
            slot=${node.slotName ? node.slotName : nothing}
            .component=${node}
            .weight=${node.weight ?? "initial"}
            .processor=${this.processor}
            .surfaceId=${this.surfaceId}
            .dataContextPath=${node.dataContextPath}
            .childComponents=${childComponents}
            .enableCustomElements=${this.enableCustomElements}
          ></a2ui-modal>`;
                    }
                    default: {
                        return this.renderCustomComponent(component);
                    }
                }
            })}`;
        }
        renderCustomComponent(component) {
            if (!this.enableCustomElements) {
                return;
            }
            const node = component;
            const registeredCtor = componentRegistry.get(component.type);
            const elCtor = registeredCtor || customElements.get(component.type);
            if (!elCtor) {
                return html `Unknown element ${component.type}`;
            }
            const el = new elCtor();
            el.id = node.id;
            if (node.slotName) {
                el.slot = node.slotName;
            }
            el.component = node;
            el.weight = node.weight ?? "initial";
            el.processor = this.processor;
            el.surfaceId = this.surfaceId;
            el.dataContextPath = node.dataContextPath ?? "/";
            for (const [prop, val] of Object.entries(component.properties)) {
                // @ts-expect-error We're off the books.
                el[prop] = val;
            }
            return html `${el}`;
        }
        render() {
            return html `<slot></slot>`;
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Root = _classThis;
})();
export { Root };
//# sourceMappingURL=root.js.map