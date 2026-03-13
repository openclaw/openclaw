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
import { styleMap } from "lit/directives/style-map.js";
let Surface = (() => {
    let _classDecorators = [customElement("a2ui-surface")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _surfaceId_decorators;
    let _surfaceId_initializers = [];
    let _surfaceId_extraInitializers = [];
    let _surface_decorators;
    let _surface_initializers = [];
    let _surface_extraInitializers = [];
    let _processor_decorators;
    let _processor_initializers = [];
    let _processor_extraInitializers = [];
    var Surface = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _surfaceId_decorators = [property()];
            _surface_decorators = [property()];
            _processor_decorators = [property()];
            __esDecorate(this, null, _surfaceId_decorators, { kind: "accessor", name: "surfaceId", static: false, private: false, access: { has: obj => "surfaceId" in obj, get: obj => obj.surfaceId, set: (obj, value) => { obj.surfaceId = value; } }, metadata: _metadata }, _surfaceId_initializers, _surfaceId_extraInitializers);
            __esDecorate(this, null, _surface_decorators, { kind: "accessor", name: "surface", static: false, private: false, access: { has: obj => "surface" in obj, get: obj => obj.surface, set: (obj, value) => { obj.surface = value; } }, metadata: _metadata }, _surface_initializers, _surface_extraInitializers);
            __esDecorate(this, null, _processor_decorators, { kind: "accessor", name: "processor", static: false, private: false, access: { has: obj => "processor" in obj, get: obj => obj.processor, set: (obj, value) => { obj.processor = value; } }, metadata: _metadata }, _processor_initializers, _processor_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Surface = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #surfaceId_accessor_storage = __runInitializers(this, _surfaceId_initializers, null);
        get surfaceId() { return this.#surfaceId_accessor_storage; }
        set surfaceId(value) { this.#surfaceId_accessor_storage = value; }
        #surface_accessor_storage = (__runInitializers(this, _surfaceId_extraInitializers), __runInitializers(this, _surface_initializers, null));
        get surface() { return this.#surface_accessor_storage; }
        set surface(value) { this.#surface_accessor_storage = value; }
        #processor_accessor_storage = (__runInitializers(this, _surface_extraInitializers), __runInitializers(this, _processor_initializers, null));
        get processor() { return this.#processor_accessor_storage; }
        set processor(value) { this.#processor_accessor_storage = value; }
        static { this.styles = [
            css `
      :host {
        display: flex;
        min-height: 0;
        max-height: 100%;
        flex-direction: column;
        gap: 16px;
      }

      #surface-logo {
        display: flex;
        justify-content: center;

        & img {
          width: 50%;
          max-width: 220px;
        }
      }

      a2ui-root {
        flex: 1;
      }
    `,
        ]; }
        #renderLogo() {
            if (!this.surface?.styles.logoUrl) {
                return nothing;
            }
            return html `<div id="surface-logo">
      <img src=${this.surface.styles.logoUrl} />
    </div>`;
        }
        #renderSurface() {
            const styles = {};
            if (this.surface?.styles) {
                for (const [key, value] of Object.entries(this.surface.styles)) {
                    switch (key) {
                        // Here we generate a palette from the singular primary color received
                        // from the surface data. We will want the values to range from
                        // 0 <= x <= 100, where 0 = back, 100 = white, and 50 = the primary
                        // color itself. As such we use a color-mix to create the intermediate
                        // values.
                        //
                        // Note: since we use half the range for black to the primary color,
                        // and half the range for primary color to white the mixed values have
                        // to go up double the amount, i.e., a range from black to primary
                        // color needs to fit in 0 -> 50 rather than 0 -> 100.
                        case "primaryColor": {
                            styles["--p-100"] = "#ffffff";
                            styles["--p-99"] = `color-mix(in srgb, ${value} 2%, white 98%)`;
                            styles["--p-98"] = `color-mix(in srgb, ${value} 4%, white 96%)`;
                            styles["--p-95"] = `color-mix(in srgb, ${value} 10%, white 90%)`;
                            styles["--p-90"] = `color-mix(in srgb, ${value} 20%, white 80%)`;
                            styles["--p-80"] = `color-mix(in srgb, ${value} 40%, white 60%)`;
                            styles["--p-70"] = `color-mix(in srgb, ${value} 60%, white 40%)`;
                            styles["--p-60"] = `color-mix(in srgb, ${value} 80%, white 20%)`;
                            styles["--p-50"] = value;
                            styles["--p-40"] = `color-mix(in srgb, ${value} 80%, black 20%)`;
                            styles["--p-35"] = `color-mix(in srgb, ${value} 70%, black 30%)`;
                            styles["--p-30"] = `color-mix(in srgb, ${value} 60%, black 40%)`;
                            styles["--p-25"] = `color-mix(in srgb, ${value} 50%, black 50%)`;
                            styles["--p-20"] = `color-mix(in srgb, ${value} 40%, black 60%)`;
                            styles["--p-15"] = `color-mix(in srgb, ${value} 30%, black 70%)`;
                            styles["--p-10"] = `color-mix(in srgb, ${value} 20%, black 80%)`;
                            styles["--p-5"] = `color-mix(in srgb, ${value} 10%, black 90%)`;
                            styles["--0"] = "#00000";
                            break;
                        }
                        case "font": {
                            styles["--font-family"] = value;
                            styles["--font-family-flex"] = value;
                            break;
                        }
                    }
                }
            }
            return html `<a2ui-root
      style=${styleMap(styles)}
      .surfaceId=${this.surfaceId}
      .processor=${this.processor}
      .childComponents=${this.surface?.componentTree
                ? [this.surface.componentTree]
                : null}
    ></a2ui-root>`;
        }
        render() {
            if (!this.surface) {
                return nothing;
            }
            return html `${[this.#renderLogo(), this.#renderSurface()]}`;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _processor_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Surface = _classThis;
})();
export { Surface };
//# sourceMappingURL=surface.js.map