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

import Ajv from "ajv/dist/2020";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { GeneratedResult, ValidatedResult, IssueSeverity } from "./types";
import { logger } from "./logger";

export class Validator {
  private ajv: Ajv;
  private validateFn: any;

  constructor(
    private schemas: Record<string, any>,
    private outputDir?: string
  ) {
    this.ajv = new Ajv({ allErrors: true, strict: false }); // strict: false to be lenient with unknown keywords if any
    for (const [name, schema] of Object.entries(schemas)) {
      this.ajv.addSchema(schema, name);
    }
    this.validateFn = this.ajv.getSchema(
      "https://a2ui.dev/specification/0.9/server_to_client.json"
    );
  }

  async run(results: GeneratedResult[]): Promise<ValidatedResult[]> {
    logger.info(
      `Starting Phase 2: Schema Validation (${results.length} items)`
    );
    const validatedResults: ValidatedResult[] = [];
    let passedCount = 0;
    let failedCount = 0;

    // Phase 2 is fast (CPU bound), so we can just iterate.
    // If we wanted to be fancy we could chunk it, but for < 1000 items it's instant.

    for (const result of results) {
      if (result.error || !result.components) {
        validatedResults.push({ ...result, validationErrors: [] }); // Already failed generation
        continue;
      }

      const errors: string[] = [];
      const components = result.components;

      // AJV Validation
      // AJV Validation
      if (this.ajv) {
        for (const message of components) {
          // Smart validation: check which key is present and validate against that specific definition
          // to avoid noisy "oneOf" errors.
          let validated = false;
          const schemaUri =
            "https://a2ui.dev/specification/0.9/server_to_client.json";

          if (message.createSurface) {
            validated = this.ajv.validate(
              `${schemaUri}#/$defs/CreateSurfaceMessage`,
              message
            );
          } else if (message.updateComponents) {
            validated = this.ajv.validate(
              `${schemaUri}#/$defs/UpdateComponentsMessage`,
              message
            );
          } else if (message.updateDataModel) {
            validated = this.ajv.validate(
              `${schemaUri}#/$defs/UpdateDataModelMessage`,
              message
            );
          } else if (message.deleteSurface) {
            validated = this.ajv.validate(
              `${schemaUri}#/$defs/DeleteSurfaceMessage`,
              message
            );
          } else {
            // Fallback to top-level validation if no known key matches (or if it's empty/invalid structure)
            validated = this.validateFn(message);
          }

          if (!validated) {
            errors.push(
              ...(this.ajv.errors || []).map(
                (err: any) => `${err.instancePath} ${err.message}`
              )
            );
          }
        }
      }

      // Custom Validation (Referential Integrity, etc.)
      this.validateCustom(components, errors);

      if (errors.length > 0) {
        failedCount++;
        if (this.outputDir) {
          this.saveFailure(result, errors);
        }
      } else {
        passedCount++;
      }

      validatedResults.push({
        ...result,
        validationErrors: errors,
      });
    }

    logger.info(
      `Phase 2: Validation Complete. Passed: ${passedCount}, Failed: ${failedCount}`
    );
    return validatedResults;
  }

  private saveFailure(result: GeneratedResult, errors: string[]) {
    if (!this.outputDir) return;
    const modelDir = path.join(
      this.outputDir,
      `output-${result.modelName.replace(/[\/:]/g, "_")}`
    );
    const detailsDir = path.join(modelDir, "details");
    const failureData = {
      pass: false,
      reason: "Schema validation failure",
      issues: errors.map((e) => ({
        issue: e,
        severity: "criticalSchema" as IssueSeverity,
      })),
      overallSeverity: "criticalSchema" as IssueSeverity,
    };

    fs.writeFileSync(
      path.join(
        detailsDir,
        `${result.prompt.name}.${result.runNumber}.failed.yaml`
      ),
      yaml.dump(failureData)
    );
  }

  private validateCustom(messages: any[], errors: string[]) {
    let hasUpdateComponents = false;
    let hasRootComponent = false;
    const createdSurfaces = new Set<string>();

    for (const message of messages) {
      if (message.updateComponents) {
        hasUpdateComponents = true;
        const surfaceId = message.updateComponents.surfaceId;
        if (surfaceId && !createdSurfaces.has(surfaceId)) {
          errors.push(
            `updateComponents message received for surface '${surfaceId}' before createSurface message.`
          );
        }

        this.validateUpdateComponents(message.updateComponents, errors);

        // Check for root component in this message
        if (message.updateComponents.components) {
          for (const comp of message.updateComponents.components) {
            if (comp.id === "root") {
              hasRootComponent = true;
            }
          }
        }
      } else if (message.createSurface) {
        this.validateCreateSurface(message.createSurface, errors);
        if (message.createSurface.surfaceId) {
          createdSurfaces.add(message.createSurface.surfaceId);
        }
      } else if (message.updateDataModel) {
        this.validateUpdateDataModel(message.updateDataModel, errors);
      } else if (message.deleteSurface) {
        this.validateDeleteSurface(message.deleteSurface, errors);
      } else {
        errors.push(
          `Unknown message type in output: ${JSON.stringify(message)}`
        );
      }
    }

    // Algorithmic check for root component
    if (hasUpdateComponents && !hasRootComponent) {
      errors.push(
        "Missing root component: At least one 'updateComponents' message must contain a component with id: 'root'."
      );
    }
  }

  // ... Copied helper functions ...
  private validateCreateSurface(data: any, errors: string[]) {
    if (data.surfaceId === undefined) {
      errors.push("createSurface must have a 'surfaceId' property.");
    }
    if (data.catalogId === undefined) {
      errors.push("createSurface must have a 'catalogId' property.");
    }
    const allowed = ["surfaceId", "catalogId"];
    for (const key in data) {
      if (!allowed.includes(key)) {
        errors.push(`createSurface has unexpected property: ${key}`);
      }
    }
  }

  private validateDeleteSurface(data: any, errors: string[]) {
    if (data.surfaceId === undefined) {
      errors.push("DeleteSurface must have a 'surfaceId' property.");
    }
    const allowed = ["surfaceId"];
    for (const key in data) {
      if (!allowed.includes(key)) {
        errors.push(`DeleteSurface has unexpected property: ${key}`);
      }
    }
  }

  private validateUpdateComponents(data: any, errors: string[]) {
    if (data.surfaceId === undefined) {
      errors.push("UpdateComponents must have a 'surfaceId' property.");
    }
    if (!data.components || !Array.isArray(data.components)) {
      errors.push("UpdateComponents must have a 'components' array.");
      return;
    }

    const componentIds = new Set<string>();
    for (const c of data.components) {
      const id = c.id;
      if (id) {
        if (componentIds.has(id)) {
          errors.push(`Duplicate component ID found: ${id}`);
        }
        componentIds.add(id);
      }

      // Smart Component Validation
      if (this.ajv && c.component) {
        const componentType = c.component;
        const schemaUri =
          "https://a2ui.dev/specification/0.9/standard_catalog_definition.json";

        const defRef = `${schemaUri}#/$defs/${componentType}`;

        const valid = this.ajv.validate(defRef, c);
        if (!valid) {
          errors.push(
            ...(this.ajv.errors || []).map(
              (err: any) =>
                `${err.instancePath} ${err.message} (in component '${
                  c.id || "unknown"
                }')`
            )
          );
        }
      }
    }

    for (const component of data.components) {
      this.validateComponent(component, componentIds, errors);
    }
  }

  private validateUpdateDataModel(data: any, errors: string[]) {
    // Schema validation handles types, required fields (surfaceId, op), and extra properties.
    // We only need to validate the conditional requirement of 'value' based on 'op'.

    if (data.op === "remove") {
      if (data.value !== undefined) {
        errors.push(
          "updateDataModel 'value' property must not be present when op is 'remove'."
        );
      }
    } else {
      // op is 'add' or 'replace' (schema validates enum values)
      if (data.value === undefined) {
        errors.push(
          `updateDataModel 'value' property is required when op is '${data.op}'.`
        );
      }
    }
  }

  private validateComponent(
    component: any,
    allIds: Set<string>,
    errors: string[]
  ) {
    const id = component.id;
    if (!id) {
      errors.push(`Component is missing an 'id'.`);
      return;
    }

    const componentType = component.component;
    if (!componentType || typeof componentType !== "string") {
      errors.push(`Component '${id}' is missing 'component' property.`);
      return;
    }

    // Basic required checks that might be missed by AJV if it's lenient or if we want specific messages
    // Actually AJV covers most of this, but the custom logic for 'children' and 'refs' is key.

    const checkRefs = (ids: (string | undefined)[]) => {
      for (const id of ids) {
        if (id && !allIds.has(id)) {
          errors.push(
            `Component ${JSON.stringify(id)} references non-existent component ID.`
          );
        }
      }
    };

    switch (componentType) {
      case "Row":
      case "Column":
      case "List":
        if (component.children) {
          if (Array.isArray(component.children)) {
            checkRefs(component.children);
          } else if (
            typeof component.children === "object" &&
            component.children !== null
          ) {
            if (component.children.componentId) {
              checkRefs([component.children.componentId]);
            }
          }
        }
        break;
      case "Card":
        checkRefs([component.child]);
        break;
      case "Tabs":
        if (component.tabItems && Array.isArray(component.tabItems)) {
          component.tabItems.forEach((tab: any) => {
            checkRefs([tab.child]);
          });
        }
        break;
      case "Modal":
        checkRefs([component.entryPointChild, component.contentChild]);
        break;
      case "Button":
        checkRefs([component.child]);
        break;
    }
  }
}
