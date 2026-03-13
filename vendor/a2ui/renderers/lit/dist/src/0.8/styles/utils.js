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
export function merge(...classes) {
    const styles = {};
    for (const clazz of classes) {
        for (const [key, val] of Object.entries(clazz)) {
            const prefix = key.split("-").with(-1, "").join("-");
            const existingKeys = Object.keys(styles).filter((key) => key.startsWith(prefix));
            for (const existingKey of existingKeys) {
                delete styles[existingKey];
            }
            styles[key] = val;
        }
    }
    return styles;
}
export function appendToAll(target, exclusions, ...classes) {
    const updatedTarget = structuredClone(target);
    // Step through each of the new blocks we've been handed.
    for (const clazz of classes) {
        // For each of the items in the list, create the prefix value, e.g., for
        // typography-f-s reduce to typography-f-. This will allow us to find any
        // and all matches across the target that have the same prefix and swap them
        // out for the updated item.
        for (const key of Object.keys(clazz)) {
            const prefix = key.split("-").with(-1, "").join("-");
            // Now we have the prefix step through all iteme in the target, and
            // replace the value in the array when we find it.
            for (const [tagName, classesToAdd] of Object.entries(updatedTarget)) {
                if (exclusions.includes(tagName)) {
                    continue;
                }
                let found = false;
                for (let t = 0; t < classesToAdd.length; t++) {
                    if (classesToAdd[t].startsWith(prefix)) {
                        found = true;
                        // In theory we should be able to break after finding a single
                        // entry here because we shouldn't have items with the same prefix
                        // in the array, but for safety we'll run to the end of the array
                        // and ensure we've captured all possible items with the prefix.
                        classesToAdd[t] = key;
                    }
                }
                if (!found) {
                    classesToAdd.push(key);
                }
            }
        }
    }
    return updatedTarget;
}
export function createThemeStyles(palettes) {
    const styles = {};
    for (const palette of Object.values(palettes)) {
        for (const [key, val] of Object.entries(palette)) {
            const prop = toProp(key);
            styles[prop] = val;
        }
    }
    return styles;
}
export function toProp(key) {
    if (key.startsWith("nv")) {
        return `--nv-${key.slice(2)}`;
    }
    return `--${key[0]}-${key.slice(1)}`;
}
//# sourceMappingURL=utils.js.map