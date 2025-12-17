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
import { markdown } from "./directives/directives.js";
import { Root } from "./root.js";
import { classMap } from "lit/directives/class-map.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { Styles } from "../index.js";
let Text = (() => {
    let _classDecorators = [customElement("a2ui-text")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Root;
    let _text_decorators;
    let _text_initializers = [];
    let _text_extraInitializers = [];
    let _usageHint_decorators;
    let _usageHint_initializers = [];
    let _usageHint_extraInitializers = [];
    var Text = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _text_decorators = [property()];
            _usageHint_decorators = [property({ reflect: true, attribute: "usage-hint" })];
            __esDecorate(this, null, _text_decorators, { kind: "accessor", name: "text", static: false, private: false, access: { has: obj => "text" in obj, get: obj => obj.text, set: (obj, value) => { obj.text = value; } }, metadata: _metadata }, _text_initializers, _text_extraInitializers);
            __esDecorate(this, null, _usageHint_decorators, { kind: "accessor", name: "usageHint", static: false, private: false, access: { has: obj => "usageHint" in obj, get: obj => obj.usageHint, set: (obj, value) => { obj.usageHint = value; } }, metadata: _metadata }, _usageHint_initializers, _usageHint_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Text = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #text_accessor_storage = __runInitializers(this, _text_initializers, null);
        get text() { return this.#text_accessor_storage; }
        set text(value) { this.#text_accessor_storage = value; }
        #usageHint_accessor_storage = (__runInitializers(this, _text_extraInitializers), __runInitializers(this, _usageHint_initializers, null));
        get usageHint() { return this.#usageHint_accessor_storage; }
        set usageHint(value) { this.#usageHint_accessor_storage = value; }
        static { this.styles = [
            structuralStyles,
            css `
      :host {
        display: block;
        flex: var(--weight);
      }

      h1,
      h2,
      h3,
      h4,
      h5 {
        line-height: inherit;
        font: inherit;
      }
    `,
        ]; }
        #renderText() {
            let textValue = null;
            if (this.text && typeof this.text === "object") {
                if ("literalString" in this.text && this.text.literalString) {
                    textValue = this.text.literalString;
                }
                else if ("literal" in this.text && this.text.literal !== undefined) {
                    textValue = this.text.literal;
                }
                else if (this.text && "path" in this.text && this.text.path) {
                    if (!this.processor || !this.component) {
                        return html `(no model)`;
                    }
                    const value = this.processor.getData(this.component, this.text.path, this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID);
                    if (value !== null && value !== undefined) {
                        textValue = value.toString();
                    }
                }
            }
            if (textValue === null || textValue === undefined) {
                return html `(empty)`;
            }
            let markdownText = textValue;
            switch (this.usageHint) {
                case "h1":
                    markdownText = `# ${markdownText}`;
                    break;
                case "h2":
                    markdownText = `## ${markdownText}`;
                    break;
                case "h3":
                    markdownText = `### ${markdownText}`;
                    break;
                case "h4":
                    markdownText = `#### ${markdownText}`;
                    break;
                case "h5":
                    markdownText = `##### ${markdownText}`;
                    break;
                case "caption":
                    markdownText = `*${markdownText}*`;
                    break;
                default:
                    break; // Body.
            }
            return html `${markdown(markdownText, Styles.appendToAll(this.theme.markdown, ["ol", "ul", "li"], {}))}`;
        }
        #areHintedStyles(styles) {
            if (typeof styles !== "object")
                return false;
            if (Array.isArray(styles))
                return false;
            if (!styles)
                return false;
            const expected = ["h1", "h2", "h3", "h4", "h5", "h6", "caption", "body"];
            return expected.every((v) => v in styles);
        }
        #getAdditionalStyles() {
            let additionalStyles = {};
            const styles = this.theme.additionalStyles?.Text;
            if (!styles)
                return additionalStyles;
            if (this.#areHintedStyles(styles)) {
                const hint = this.usageHint ?? "body";
                additionalStyles = styles[hint];
            }
            else {
                additionalStyles = styles;
            }
            return additionalStyles;
        }
        render() {
            const classes = Styles.merge(this.theme.components.Text.all, this.usageHint ? this.theme.components.Text[this.usageHint] : {});
            return html `<section
      class=${classMap(classes)}
      style=${this.theme.additionalStyles?.Text
                ? styleMap(this.#getAdditionalStyles())
                : nothing}
    >
      ${this.#renderText()}
    </section>`;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _usageHint_extraInitializers);
        }
        static {
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Text = _classThis;
})();
export { Text };
//# sourceMappingURL=text.js.map