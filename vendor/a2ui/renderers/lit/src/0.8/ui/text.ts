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
import { customElement, property } from "lit/decorators.js";
import { markdown } from "./directives/directives.js";
import { Root } from "./root.js";
import { StringValue } from "../types/primitives.js";
import { classMap } from "lit/directives/class-map.js";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { styleMap } from "lit/directives/style-map.js";
import { structuralStyles } from "./styles.js";
import { Styles } from "../index.js";
import { ResolvedText, Theme } from "../types/types.js";

interface HintedStyles {
  h1: Record<string, string>;
  h2: Record<string, string>;
  h3: Record<string, string>;
  h4: Record<string, string>;
  h5: Record<string, string>;
  body: Record<string, string>;
  caption: Record<string, string>;
}

@customElement("a2ui-text")
export class Text extends Root {
  @property()
  accessor text: StringValue | null = null;

  @property({ reflect: true, attribute: "usage-hint" })
  accessor usageHint: ResolvedText["usageHint"] | null = null;

  static styles = [
    structuralStyles,
    css`
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
  ];

  #renderText() {
    let textValue: string | null | undefined = null;

    if (this.text && typeof this.text === "object") {
      if ("literalString" in this.text && this.text.literalString) {
        textValue = this.text.literalString;
      } else if ("literal" in this.text && this.text.literal !== undefined) {
        textValue = this.text.literal;
      } else if (this.text && "path" in this.text && this.text.path) {
        if (!this.processor || !this.component) {
          return html`(no model)`;
        }

        const value = this.processor.getData(
          this.component,
          this.text.path,
          this.surfaceId ?? A2uiMessageProcessor.DEFAULT_SURFACE_ID
        );

        if (value !== null && value !== undefined) {
          textValue = value.toString();
        }
      }
    }

    if (textValue === null || textValue === undefined) {
      return html`(empty)`;
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

    return html`${markdown(
      markdownText,
      Styles.appendToAll(this.theme.markdown, ["ol", "ul", "li"], {})
    )}`;
  }

  #areHintedStyles(styles: unknown): styles is HintedStyles {
    if (typeof styles !== "object") return false;
    if (Array.isArray(styles)) return false;
    if (!styles) return false;

    const expected = ["h1", "h2", "h3", "h4", "h5", "h6", "caption", "body"];
    return expected.every((v) => v in styles);
  }

  #getAdditionalStyles() {
    let additionalStyles: Record<string, string> = {};
    const styles = this.theme.additionalStyles?.Text;
    if (!styles) return additionalStyles;

    if (this.#areHintedStyles(styles)) {
      const hint = this.usageHint ?? "body";
      additionalStyles = styles[hint] as Record<string, string>;
    } else {
      additionalStyles = styles;
    }

    return additionalStyles;
  }

  render() {
    const classes = Styles.merge(
      this.theme.components.Text.all,
      this.usageHint ? this.theme.components.Text[this.usageHint] : {}
    );

    return html`<section
      class=${classMap(classes)}
      style=${this.theme.additionalStyles?.Text
        ? styleMap(this.#getAdditionalStyles())
        : nothing}
    >
      ${this.#renderText()}
    </section>`;
  }
}
