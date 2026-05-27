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

export class BasicSchemaMatcher extends SchemaMatcher {
  constructor(
    public propertyPath: string,
    public propertyValue?: any,
  ) {
    super();
  }

  validate(schema: any): ValidationResult {
    if (!schema) {
      const result: ValidationResult = {
        success: false,
        error: "Schema is undefined.",
      };
      return result;
    }

    const pathParts = this.propertyPath.split(".");
    let actualValue = schema;
    for (const part of pathParts) {
      if (actualValue && typeof actualValue === "object") {
        actualValue = actualValue[part];
      } else {
        actualValue = undefined;
        break;
      }
    }

    if (actualValue === undefined) {
      const error = `Failed to find property '${this.propertyPath}'.`;
      return { success: false, error };
    }

    if (this.propertyValue !== undefined) {
      if (JSON.stringify(actualValue) !== JSON.stringify(this.propertyValue)) {
        const error = `Property '${
          this.propertyPath
        }' has value '${JSON.stringify(
          actualValue,
        )}', but expected '${JSON.stringify(this.propertyValue)}'.`;
        return { success: false, error };
      }
    }

    return { success: true };
  }
}
