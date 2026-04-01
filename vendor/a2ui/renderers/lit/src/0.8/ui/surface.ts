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
import { SurfaceID, Surface as SurfaceState } from "../types/types";
import { A2uiMessageProcessor } from "../data/model-processor.js";
import { Root } from "./root.js";
import { styleMap } from "lit/directives/style-map.js";

@customElement("a2ui-surface")
export class Surface extends Root {
  @property()
  accessor surfaceId: SurfaceID | null = null;

  @property()
  accessor surface: SurfaceState | null = null;

  @property()
  accessor processor: A2uiMessageProcessor | null = null;

  static styles = [
    css`
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
  ];

  #renderLogo() {
    if (!this.surface?.styles.logoUrl) {
      return nothing;
    }

    return html`<div id="surface-logo">
      <img src=${this.surface.styles.logoUrl} />
    </div>`;
  }

  #renderSurface() {
    const styles: Record<string, string> = {};
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

    return html`<a2ui-root
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

    return html`${[this.#renderLogo(), this.#renderSurface()]}`;
  }
}
