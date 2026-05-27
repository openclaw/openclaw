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

import { SchemaMatcher, ValidationResult } from "./schema_matcher";

/**
 * A schema matcher that validates the presence of a component type within a
 * `surfaceUpdate` message, and optionally validates the presence and value of
 * a property on that component.
 */
export class SurfaceUpdateSchemaMatcher extends SchemaMatcher {
  constructor(
    public componentType: string,
    public propertyName?: string,
    public propertyValue?: any,
    public caseInsensitive: boolean = false
  ) {
    super();
  }

  private getComponentById(components: any[], id: string): any | undefined {
    return components.find((c: any) => c.id === id);
  }

  validate(schema: any): ValidationResult {
    if (!schema.surfaceUpdate) {
      return {
        success: false,
        error: `Expected a 'surfaceUpdate' message but found none.`,
      };
    }
    if (!Array.isArray(schema.surfaceUpdate.components)) {
      return {
        success: false,
        error: `'surfaceUpdate' message does not contain a 'components' array.`,
      };
    }

    const components = schema.surfaceUpdate.components;

    for (const c of components) {
      if (c.component && Object.keys(c.component).length > 1) {
        return {
          success: false,
          error: `Component ID '${c.id}' has multiple component types defined: ${Object.keys(c.component).join(", ")}`,
        };
      }
    }

    const matchingComponents = components.filter(
      (c: any) => c.component && c.component[this.componentType]
    );

    if (matchingComponents.length === 0) {
      return {
        success: false,
        error: `Failed to find component of type '${this.componentType}'.`,
      };
    }

    if (!this.propertyName) {
      return { success: true };
    }

    for (const component of matchingComponents) {
      const properties = component.component[this.componentType];
      if (properties) {
        // Check for property directly on the component
        if (properties[this.propertyName] !== undefined) {
          if (this.propertyValue === undefined) {
            return { success: true };
          }
          const actualValue = properties[this.propertyName];
          if (this.valueMatches(actualValue, this.propertyValue)) {
            return { success: true };
          }
        }

        // Specifically for Buttons, check for label in a child Text component
        if (
          this.componentType === "Button" &&
          this.propertyName === "label" &&
          properties.child
        ) {
          const childComponent = this.getComponentById(
            components,
            properties.child
          );
          if (
            childComponent &&
            childComponent.component &&
            childComponent.component.Text
          ) {
            const textValue = childComponent.component.Text.text;
            if (this.valueMatches(textValue, this.propertyValue)) {
              return { success: true };
            }
          }
        }
      }
    }

    if (this.propertyValue !== undefined) {
      return {
        success: false,
        error: `Failed to find component of type '${this.componentType}' with property '${this.propertyName}' containing value ${JSON.stringify(this.propertyValue)}.`,
      };
    } else {
      return {
        success: false,
        error: `Failed to find component of type '${this.componentType}' with property '${this.propertyName}'.`,
      };
    }
  }

  private valueMatches(actualValue: any, expectedValue: any): boolean {
    if (actualValue === null || actualValue === undefined) {
      return false;
    }

    const compareStrings = (s1: string, s2: string) => {
      return this.caseInsensitive
        ? s1.toLowerCase() === s2.toLowerCase()
        : s1 === s2;
    };

    // Handle new literal/path object structure
    if (typeof actualValue === "object" && !Array.isArray(actualValue)) {
      if (actualValue.literalString !== undefined) {
        return (
          typeof expectedValue === "string" &&
          compareStrings(actualValue.literalString, expectedValue)
        );
      }
      if (actualValue.literalNumber !== undefined) {
        return actualValue.literalNumber === expectedValue;
      }
      if (actualValue.literalBoolean !== undefined) {
        return actualValue.literalBoolean === expectedValue;
      }
      // Could also have a 'path' key, but for matching we'd expect a literal value in expectedValue
    }

    // Handle array cases (e.g., for MultipleChoice options)
    if (Array.isArray(actualValue)) {
      for (const item of actualValue) {
        if (typeof item === "object" && item !== null) {
          // Check if the item itself is a bound value object
          if (
            item.literalString !== undefined &&
            typeof expectedValue === "string" &&
            compareStrings(item.literalString, expectedValue)
          )
            return true;
          if (
            item.literalNumber !== undefined &&
            item.literalNumber === expectedValue
          )
            return true;
          if (
            item.literalBoolean !== undefined &&
            item.literalBoolean === expectedValue
          )
            return true;

          // Check for structures like MultipleChoice options {label: {literalString: ...}, value: ...}
          if (
            item.label &&
            typeof item.label === "object" &&
            item.label.literalString !== undefined &&
            typeof expectedValue === "string" &&
            compareStrings(item.label.literalString, expectedValue)
          ) {
            return true;
          }
          if (item.value === expectedValue) {
            return true;
          }
        } else if (
          typeof item === "string" &&
          typeof expectedValue === "string" &&
          compareStrings(item, expectedValue)
        ) {
          return true;
        } else if (item === expectedValue) {
          return true;
        }
      }
    }

    // Fallback to direct comparison
    return JSON.stringify(actualValue) === JSON.stringify(expectedValue);
  }
}
