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
import { Audio } from "./audio.js";
import { Button } from "./button.js";
import { Card } from "./card.js";
import { Checkbox } from "./checkbox.js";
import { Column } from "./column.js";
import { DateTimeInput } from "./datetime-input.js";
import { Divider } from "./divider.js";
import { Icon } from "./icon.js";
import { Image } from "./image.js";
import { List } from "./list.js";
import { MultipleChoice } from "./multiple-choice.js";
import { Modal } from "./modal.js";
import { Root } from "./root.js";
import { Row } from "./row.js";
import { Slider } from "./slider.js";
import { Surface } from "./surface.js";
import { Tabs } from "./tabs.js";
import { TextField } from "./text-field.js";
import { Text } from "./text.js";
import { Video } from "./video.js";
export * as Context from "./context/theme.js";
export * as Utils from "./utils/utils.js";
export { ComponentRegistry, componentRegistry } from "./component-registry.js";
export { registerCustomComponents } from "./custom-components/index.js";
export { Audio, Button, Card, Column, Checkbox, DateTimeInput, Divider, Icon, Image, List, MultipleChoice, Modal, Row, Slider, Root, Surface, Tabs, Text, TextField, Video, };
/**
 * Type-safely retrieves a custom element constructor using the tagName map.
 * @param tagName The tag name to look up (must exist in HTMLElementTagNameMap).
 * @returns The specific constructor type or undefined.
 */
export function instanceOf(tagName) {
    // Use a type assertion: we tell TypeScript to trust that the value returned
    // by customElements.get(tagName) matches the type defined in our map.
    const ctor = customElements.get(tagName);
    if (!ctor) {
        console.warn("No element definition for", tagName);
        return;
    }
    return new ctor();
}
//# sourceMappingURL=ui.js.map