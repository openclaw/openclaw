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

import { html, render } from "lit";

/**
 * This is only safe for (and intended to be used for) text node positions. If
 * you are using attribute position, then this is only safe if the attribute
 * value is surrounded by double-quotes, and is unsafe otherwise (because the
 * value could break out of the attribute value and e.g. add another attribute).
 */
export function escapeNodeText(str: string | null | undefined) {
  const frag = document.createElement("div");
  render(html`${str}`, frag);

  return frag.innerHTML.replaceAll(/<!--([^-]*)-->/gim, "");
}

export function unescapeNodeText(str: string | null | undefined) {
  if (!str) {
    return "";
  }

  const frag = document.createElement("textarea");
  frag.innerHTML = str;
  return frag.value;
}
