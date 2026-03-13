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
import { structuralStyles } from "./styles.js";
import { Styles } from "../index.js";
let Image = (() => {
    let _classDecorators = [customElement("a2ui-image")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _url_decorators;
    let _url_initializers = [];
    let _url_extraInitializers = [];
    let _usageHint_decorators;
    let _usageHint_initializers = [];
    let _usageHint_extraInitializers = [];
    let _fit_decorators;
    let _fit_initializers = [];
    let _fit_extraInitializers = [];
    var Image = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _url_decorators = [property()];
            _usageHint_decorators = [property()];
            _fit_decorators = [property()];
            __esDecorate(this, null, _url_decorators, { kind: "accessor", name: "url", static: false, private: false, access: { has: obj => "url" in obj, get: obj => obj.url, set: (obj, value) => { obj.url = value; } }, metadata: _metadata }, _url_initializers, _url_extraInitializers);
            __esDecorate(this, null, _usageHint_decorators, { kind: "accessor", name: "usageHint", static: false, private: false, access: { has: obj => "usageHint" in obj, get: obj => obj.usageHint, set: (obj, value) => { obj.usageHint = value; } }, metadata: _metadata }, _usageHint_initializers, _usageHint_extraInitializers);
            __esDecorate(this, null, _fit_decorators, { kind: "accessor", name: "fit", static: false, private: false, access: { has: obj => "fit" in obj, get: obj => obj.fit, set: (obj, value) => { obj.fit = value; } }, metadata: _metadata }, _fit_initializers, _fit_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Image = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #url_accessor_storage = __runInitializers(this, _url_initializers, null);
        get url() { return this.#url_accessor_storage; }
        set url(value) { this.#url_accessor_storage = value; }
        #usageHint_accessor_storage = (__runInitializers(this, _url_extraInitializers), __runInitializers(this, _usageHint_initializers, null));
        get usageHint() { return this.#usageHint_accessor_storage; }
        set usageHint(value) { this.#usageHint_accessor_storage = value; }
        #fit_accessor_storage = (__runInitializers(this, _usageHint_extraInitializers), __runInitializers(this, _fit_initializers, null));
        get fit() { return this.#fit_accessor_storage; }
        set fit(value) { this.#fit_accessor_storage = value; }
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

      img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: var(--object-fit, fill);
      }
    `,
        ]; }
        #renderImage() {
            if (!this.url) {
                return nothing;
            }
            const render = (url) => {
                return html `<img src=${url} />`;
            };
            if (this.url && typeof this.url === "object") {
                if ("literalString" in this.url) {
                    const imageUrl = this.url.literalString ?? "";
                    return render(imageUrl);
                }
                else if ("literal" in this.url) {
                    const imageUrl = this.url.literal ?? "";
                    return render(imageUrl);
                }
                else if (this.url && "path" in this.url && this.url.path) {
                    if (!this.processor || !this.component) {
                        return html `(no model)`;
                    }
                    const imageUrl = this.processor.getData(this.component, this.url.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
                    if (!imageUrl) {
                        return html `Invalid image URL`;
                    }
                    if (typeof imageUrl !== "string") {
                        return html `Invalid image URL`;
                    }
                    return render(imageUrl);
                }
            }
            return html `(empty)`;
        }
        render() {
            const classes = Styles.merge(this.theme.components.Image.all, this.usageHint ? this.theme.components.Image[this.usageHint] : {});
            return html `<section
      class=${classMap(classes)}
      style=${styleMap({
                ...(this.theme.additionalStyles?.Image ?? {}),
                "--object-fit": this.fit ?? "fill",
            })}
    >
      ${this.#renderImage()}
    </section>`;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _fit_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Image = _classThis;
})();
export { Image };
//# sourceMappingURL=image.js.map