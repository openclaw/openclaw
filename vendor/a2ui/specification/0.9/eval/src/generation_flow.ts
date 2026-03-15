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

import { z } from "genkit";
import { ai } from "./ai";
import { ModelConfiguration } from "./models";
import { rateLimiter } from "./rateLimiter";
import { logger } from "./logger";

// Define a UI component generator flow
export const componentGeneratorFlow = ai.defineFlow(
  {
    name: "componentGeneratorFlow",
    inputSchema: z.object({
      prompt: z.string(),
      modelConfig: z.any(), // Ideally, we'd have a Zod schema for ModelConfiguration
      schemas: z.any(),
      catalogRules: z.string().optional(),
    }),
    outputSchema: z.any(),
  },
  async ({ prompt, modelConfig, schemas, catalogRules }) => {
    const schemaDefs = Object.values(schemas)
      .map((s: any) => JSON.stringify(s, null, 2))
      .join("\n\n");

    const fullPrompt = `You are an AI assistant. Based on the following request, generate a stream of JSON messages that conform to the provided JSON Schemas.
The output MUST be a series of JSON objects, each enclosed in a markdown code block (or a single block with multiple objects).

Standard Instructions:
1. Generate a 'createSurface' message with surfaceId 'main' and catalogId 'https://a2ui.dev/specification/0.9/standard_catalog_definition.json'.
2. Generate a 'updateComponents' message with surfaceId 'main' containing the requested UI.
3. Ensure all component children are referenced by ID (using the 'children' or 'child' property with IDs), NOT nested inline as objects.
4. If the request involves data binding, you may also generate 'updateDataModel' messages.
5. Among the 'updateComponents' messages in the output, there MUST be one root component with id: 'root'.
6. Components need to be nested within a root layout container (Column, Row). No need to add an extra container if the root is already a layout container.
7. There shouldn't be any orphaned components: no components should be generated which don't have a parent, except for the root component.
8. Do NOT output a list of lists (e.g. [[...]]). Output individual JSON objects separated by newlines.
9. STRICTLY follow the JSON Schemas. Do NOT add any properties that are not defined in the schema. Ensure ALL required properties are present.
10. Do NOT invent data bindings or action contexts. Only use them if the prompt explicitly asks for them.
11. Read the 'description' field of each component in the schema carefully. It contains critical usage instructions (e.g. regarding labels, single child limits, and layout behavior) that you MUST follow.
12. Do NOT define components inline inside 'child' or 'children'. Always use a string ID referencing a separate component definition.
13. Do NOT use a 'style' property. Use standard properties like 'alignment', 'distribution', 'usageHint', etc.
14. Do NOT invent properties that are not in the schema. Check the 'properties' list for each component type.
${catalogRules ? `\nInstructions specific to this catalog:\n${catalogRules}` : ""}

Schemas:
${schemaDefs}

Request:
${prompt}
`;
    const estimatedInputTokens = Math.ceil(fullPrompt.length / 2.5);
    await rateLimiter.acquirePermit(
      modelConfig as ModelConfiguration,
      estimatedInputTokens
    );

    // Generate text response
    let response;
    const startTime = Date.now();
    try {
      response = await ai.generate({
        prompt: fullPrompt,
        model: modelConfig.model,
        config: modelConfig.config,
      });
    } catch (e) {
      logger.error(`Error during ai.generate: ${e}`);
      rateLimiter.reportError(modelConfig as ModelConfiguration, e);
      throw e;
    }
    const latency = Date.now() - startTime;

    if (!response) throw new Error("Failed to generate component");

    let candidate = (response as any).candidates?.[0];

    // Fallback for different response structure (e.g. Genkit 0.9+ or specific model adapters)
    if (!candidate && (response as any).message) {
      const message = (response as any).message;
      candidate = {
        index: 0,
        content: message.content,
        finishReason: "STOP", // Assume STOP if not provided in this format
        message: message,
      };
    }

    if (!candidate) {
      logger.error(
        `No candidates returned in response. Full response: ${JSON.stringify(response, null, 2)}`
      );
      throw new Error("No candidates returned");
    }

    if (
      candidate.finishReason !== "STOP" &&
      candidate.finishReason !== undefined
    ) {
      logger.warn(
        `Model finished with reason: ${candidate.finishReason}. Content: ${JSON.stringify(
          candidate.content
        )}`
      );
    }

    // Record token usage (adjusting for actual usage)
    const inputTokens = response.usage?.inputTokens || 0;
    const outputTokens = response.usage?.outputTokens || 0;
    const totalTokens = inputTokens + outputTokens;

    // We already recorded estimatedInputTokens. We need to record the difference.
    // If actual > estimated, we record the positive difference.
    // If actual < estimated, we technically over-counted, but RateLimiter doesn't support negative adjustments yet.
    // For safety, we just record any *additional* tokens if we under-estimated.
    // And we definitely record the output tokens.

    const additionalInputTokens = Math.max(
      0,
      inputTokens - estimatedInputTokens
    );
    const tokensToAdd = additionalInputTokens + outputTokens;

    if (tokensToAdd > 0) {
      rateLimiter.recordUsage(
        modelConfig as ModelConfiguration,
        tokensToAdd,
        false
      );
    }

    return { text: response.text, latency };
  }
);
