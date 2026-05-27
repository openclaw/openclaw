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

import { PaletteKey, PaletteKeyVals, shades } from "../types/colors.js";
import { toProp } from "./utils.js";

const color = <C extends PaletteKeyVals>(src: PaletteKey<C>) =>
  `
    ${src
      .map((key: string) => {
        const inverseKey = getInverseKey(key);
        return `.color-bc-${key} { border-color: light-dark(var(${toProp(
          key
        )}), var(${toProp(inverseKey)})); }`;
      })
      .join("\n")}

    ${src
      .map((key: string) => {
        const inverseKey = getInverseKey(key);
        const vals = [
          `.color-bgc-${key} { background-color: light-dark(var(${toProp(
            key
          )}), var(${toProp(inverseKey)})); }`,
          `.color-bbgc-${key}::backdrop { background-color: light-dark(var(${toProp(
            key
          )}), var(${toProp(inverseKey)})); }`,
        ];

        for (let o = 0.1; o < 1; o += 0.1) {
          vals.push(`.color-bbgc-${key}_${(o * 100).toFixed(0)}::backdrop {
            background-color: light-dark(oklch(from var(${toProp(
              key
            )}) l c h / calc(alpha * ${o.toFixed(1)})), oklch(from var(${toProp(
            inverseKey
          )}) l c h / calc(alpha * ${o.toFixed(1)})) );
          }
        `);
        }

        return vals.join("\n");
      })
      .join("\n")}

  ${src
    .map((key: string) => {
      const inverseKey = getInverseKey(key);
      return `.color-c-${key} { color: light-dark(var(${toProp(
        key
      )}), var(${toProp(inverseKey)})); }`;
    })
    .join("\n")}
  `;

const getInverseKey = (key: string): string => {
  const match = key.match(/^([a-z]+)(\d+)$/);
  if (!match) return key;
  const [, prefix, shadeStr] = match;
  const shade = parseInt(shadeStr, 10);
  const target = 100 - shade;
  const inverseShade = shades.reduce((prev, curr) =>
    Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev
  );
  return `${prefix}${inverseShade}`;
};

const keyFactory = <K extends PaletteKeyVals>(prefix: K) => {
  return shades.map((v) => `${prefix}${v}`) as PaletteKey<K>;
};

export const colors = [
  color(keyFactory("p")),
  color(keyFactory("s")),
  color(keyFactory("t")),
  color(keyFactory("n")),
  color(keyFactory("nv")),
  color(keyFactory("e")),
  `
    .color-bgc-transparent {
      background-color: transparent;
    }

    :host {
      color-scheme: var(--color-scheme);
    }
  `,
];
