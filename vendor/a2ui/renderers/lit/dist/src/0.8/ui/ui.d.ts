export type TagName = keyof A2UITagNameMap;
export type CustomElementConstructorOf<T extends HTMLElement> = {
    new (): T;
} & typeof HTMLElement;
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
interface A2UITagNameMap {
    "a2ui-audioplayer": Audio;
    "a2ui-button": Button;
    "a2ui-card": Card;
    "a2ui-checkbox": Checkbox;
    "a2ui-column": Column;
    "a2ui-datetimeinput": DateTimeInput;
    "a2ui-divider": Divider;
    "a2ui-icon": Icon;
    "a2ui-image": Image;
    "a2ui-list": List;
    "a2ui-modal": Modal;
    "a2ui-multiplechoice": MultipleChoice;
    "a2ui-root": Root;
    "a2ui-row": Row;
    "a2ui-slider": Slider;
    "a2ui-surface": Surface;
    "a2ui-tabs": Tabs;
    "a2ui-text": Text;
    "a2ui-textfield": TextField;
    "a2ui-video": Video;
}
declare global {
    interface HTMLElementTagNameMap extends A2UITagNameMap {
    }
}
/**
 * Type-safely retrieves a custom element constructor using the tagName map.
 * @param tagName The tag name to look up (must exist in HTMLElementTagNameMap).
 * @returns The specific constructor type or undefined.
 */
export declare function instanceOf<T extends keyof A2UITagNameMap>(tagName: T): A2UITagNameMap[T] | undefined;
//# sourceMappingURL=ui.d.ts.map