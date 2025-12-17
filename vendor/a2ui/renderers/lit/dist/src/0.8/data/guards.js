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
export function isValueMap(value) {
    return isObject(value) && "key" in value;
}
export function isPath(key, value) {
    return key === "path" && typeof value === "string";
}
export function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isComponentArrayReference(value) {
    if (!isObject(value))
        return false;
    return "explicitList" in value || "template" in value;
}
function isStringValue(value) {
    return (isObject(value) &&
        ("path" in value ||
            ("literal" in value && typeof value.literal === "string") ||
            "literalString" in value));
}
function isNumberValue(value) {
    return (isObject(value) &&
        ("path" in value ||
            ("literal" in value && typeof value.literal === "number") ||
            "literalNumber" in value));
}
function isBooleanValue(value) {
    return (isObject(value) &&
        ("path" in value ||
            ("literal" in value && typeof value.literal === "boolean") ||
            "literalBoolean" in value));
}
function isAnyComponentNode(value) {
    if (!isObject(value))
        return false;
    const hasBaseKeys = "id" in value && "type" in value && "properties" in value;
    if (!hasBaseKeys)
        return false;
    return true;
}
export function isResolvedAudioPlayer(props) {
    return isObject(props) && "url" in props && isStringValue(props.url);
}
export function isResolvedButton(props) {
    return (isObject(props) &&
        "child" in props &&
        isAnyComponentNode(props.child) &&
        "action" in props);
}
export function isResolvedCard(props) {
    if (!isObject(props))
        return false;
    if (!("child" in props)) {
        if (!("children" in props)) {
            return false;
        }
        else {
            return (Array.isArray(props.children) &&
                props.children.every(isAnyComponentNode));
        }
    }
    return isAnyComponentNode(props.child);
}
export function isResolvedCheckbox(props) {
    return (isObject(props) &&
        "label" in props &&
        isStringValue(props.label) &&
        "value" in props &&
        isBooleanValue(props.value));
}
export function isResolvedColumn(props) {
    return (isObject(props) &&
        "children" in props &&
        Array.isArray(props.children) &&
        props.children.every(isAnyComponentNode));
}
export function isResolvedDateTimeInput(props) {
    return isObject(props) && "value" in props && isStringValue(props.value);
}
export function isResolvedDivider(props) {
    // Dividers can have all optional properties, so just checking if
    // it's an object is enough.
    return isObject(props);
}
export function isResolvedImage(props) {
    return isObject(props) && "url" in props && isStringValue(props.url);
}
export function isResolvedIcon(props) {
    return isObject(props) && "name" in props && isStringValue(props.name);
}
export function isResolvedList(props) {
    return (isObject(props) &&
        "children" in props &&
        Array.isArray(props.children) &&
        props.children.every(isAnyComponentNode));
}
export function isResolvedModal(props) {
    return (isObject(props) &&
        "entryPointChild" in props &&
        isAnyComponentNode(props.entryPointChild) &&
        "contentChild" in props &&
        isAnyComponentNode(props.contentChild));
}
export function isResolvedMultipleChoice(props) {
    return isObject(props) && "selections" in props;
}
export function isResolvedRow(props) {
    return (isObject(props) &&
        "children" in props &&
        Array.isArray(props.children) &&
        props.children.every(isAnyComponentNode));
}
export function isResolvedSlider(props) {
    return isObject(props) && "value" in props && isNumberValue(props.value);
}
function isResolvedTabItem(item) {
    return (isObject(item) &&
        "title" in item &&
        isStringValue(item.title) &&
        "child" in item &&
        isAnyComponentNode(item.child));
}
export function isResolvedTabs(props) {
    return (isObject(props) &&
        "tabItems" in props &&
        Array.isArray(props.tabItems) &&
        props.tabItems.every(isResolvedTabItem));
}
export function isResolvedText(props) {
    return isObject(props) && "text" in props && isStringValue(props.text);
}
export function isResolvedTextField(props) {
    return isObject(props) && "label" in props && isStringValue(props.label);
}
export function isResolvedVideo(props) {
    return isObject(props) && "url" in props && isStringValue(props.url);
}
//# sourceMappingURL=guards.js.map