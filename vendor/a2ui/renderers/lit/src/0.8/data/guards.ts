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

import { BooleanValue, NumberValue, StringValue } from "../types/primitives";
import {
  AnyComponentNode,
  ComponentArrayReference,
  ResolvedAudioPlayer,
  ResolvedButton,
  ResolvedCard,
  ResolvedCheckbox,
  ResolvedColumn,
  ResolvedDateTimeInput,
  ResolvedDivider,
  ResolvedIcon,
  ResolvedImage,
  ResolvedList,
  ResolvedModal,
  ResolvedMultipleChoice,
  ResolvedRow,
  ResolvedSlider,
  ResolvedTabItem,
  ResolvedTabs,
  ResolvedText,
  ResolvedTextField,
  ResolvedVideo,
  ValueMap,
} from "../types/types";

export function isValueMap(value: unknown): value is ValueMap {
  return isObject(value) && "key" in value;
}

export function isPath(key: string, value: unknown): value is string {
  return key === "path" && typeof value === "string";
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isComponentArrayReference(
  value: unknown
): value is ComponentArrayReference {
  if (!isObject(value)) return false;
  return "explicitList" in value || "template" in value;
}

function isStringValue(value: unknown): value is StringValue {
  return (
    isObject(value) &&
    ("path" in value ||
      ("literal" in value && typeof value.literal === "string") ||
      "literalString" in value)
  );
}

function isNumberValue(value: unknown): value is NumberValue {
  return (
    isObject(value) &&
    ("path" in value ||
      ("literal" in value && typeof value.literal === "number") ||
      "literalNumber" in value)
  );
}

function isBooleanValue(value: unknown): value is BooleanValue {
  return (
    isObject(value) &&
    ("path" in value ||
      ("literal" in value && typeof value.literal === "boolean") ||
      "literalBoolean" in value)
  );
}

function isAnyComponentNode(value: unknown): value is AnyComponentNode {
  if (!isObject(value)) return false;
  const hasBaseKeys = "id" in value && "type" in value && "properties" in value;
  if (!hasBaseKeys) return false;

  return true;
}

export function isResolvedAudioPlayer(
  props: unknown
): props is ResolvedAudioPlayer {
  return isObject(props) && "url" in props && isStringValue(props.url);
}

export function isResolvedButton(props: unknown): props is ResolvedButton {
  return (
    isObject(props) &&
    "child" in props &&
    isAnyComponentNode(props.child) &&
    "action" in props
  );
}

export function isResolvedCard(props: unknown): props is ResolvedCard {
  if (!isObject(props)) return false;
  if (!("child" in props)) {
    if (!("children" in props)) {
      return false;
    } else {
      return (
        Array.isArray(props.children) &&
        props.children.every(isAnyComponentNode)
      );
    }
  }

  return isAnyComponentNode(props.child);
}

export function isResolvedCheckbox(props: unknown): props is ResolvedCheckbox {
  return (
    isObject(props) &&
    "label" in props &&
    isStringValue(props.label) &&
    "value" in props &&
    isBooleanValue(props.value)
  );
}

export function isResolvedColumn(props: unknown): props is ResolvedColumn {
  return (
    isObject(props) &&
    "children" in props &&
    Array.isArray(props.children) &&
    props.children.every(isAnyComponentNode)
  );
}

export function isResolvedDateTimeInput(
  props: unknown
): props is ResolvedDateTimeInput {
  return isObject(props) && "value" in props && isStringValue(props.value);
}

export function isResolvedDivider(props: unknown): props is ResolvedDivider {
  // Dividers can have all optional properties, so just checking if
  // it's an object is enough.
  return isObject(props);
}

export function isResolvedImage(props: unknown): props is ResolvedImage {
  return isObject(props) && "url" in props && isStringValue(props.url);
}

export function isResolvedIcon(props: unknown): props is ResolvedIcon {
  return isObject(props) && "name" in props && isStringValue(props.name);
}

export function isResolvedList(props: unknown): props is ResolvedList {
  return (
    isObject(props) &&
    "children" in props &&
    Array.isArray(props.children) &&
    props.children.every(isAnyComponentNode)
  );
}

export function isResolvedModal(props: unknown): props is ResolvedModal {
  return (
    isObject(props) &&
    "entryPointChild" in props &&
    isAnyComponentNode(props.entryPointChild) &&
    "contentChild" in props &&
    isAnyComponentNode(props.contentChild)
  );
}

export function isResolvedMultipleChoice(
  props: unknown
): props is ResolvedMultipleChoice {
  return isObject(props) && "selections" in props;
}

export function isResolvedRow(props: unknown): props is ResolvedRow {
  return (
    isObject(props) &&
    "children" in props &&
    Array.isArray(props.children) &&
    props.children.every(isAnyComponentNode)
  );
}

export function isResolvedSlider(props: unknown): props is ResolvedSlider {
  return isObject(props) && "value" in props && isNumberValue(props.value);
}

function isResolvedTabItem(item: unknown): item is ResolvedTabItem {
  return (
    isObject(item) &&
    "title" in item &&
    isStringValue(item.title) &&
    "child" in item &&
    isAnyComponentNode(item.child)
  );
}

export function isResolvedTabs(props: unknown): props is ResolvedTabs {
  return (
    isObject(props) &&
    "tabItems" in props &&
    Array.isArray(props.tabItems) &&
    props.tabItems.every(isResolvedTabItem)
  );
}

export function isResolvedText(props: unknown): props is ResolvedText {
  return isObject(props) && "text" in props && isStringValue(props.text);
}

export function isResolvedTextField(
  props: unknown
): props is ResolvedTextField {
  return isObject(props) && "label" in props && isStringValue(props.label);
}

export function isResolvedVideo(props: unknown): props is ResolvedVideo {
  return isObject(props) && "url" in props && isStringValue(props.url);
}
