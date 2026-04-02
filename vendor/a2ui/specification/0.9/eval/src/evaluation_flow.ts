
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
import { rateLimiter } from "./rateLimiter";
import { logger } from "./logger";
import * as yaml from "js-yaml";

// Define an evaluation flow
export const evaluationFlow = ai.defineFlow(
  {
    name: "evaluationFlow",
    inputSchema: z.object({
      originalPrompt: z.string(),
      generatedOutput: z.string(),
      evalModel: z.string(),
      schemas: z.any(),
    }),
    outputSchema: z.object({
      pass: z.boolean(),
      reason: z.string(),
      issues: z
        .array(
          z.object({
            issue: z.string(),
            severity: z.enum(["minor", "significant", "critical"]),
          })
        )
        .optional(),
      evalPrompt: z.string().optional(),
    }),
  },
  async ({ originalPrompt, generatedOutput, evalModel, schemas }) => {
    const schemaDefs = Object.values(schemas)
      .map((s: any) => JSON.stringify(s, null, 2))
      .join("\n\n");

    const EvalResultSchema = z.object({
      pass: z
        .boolean()
        .describe("Whether the generated UI meets the requirements"),
      reason: z.string().describe("Summary of the reason for a failure."),
      issues: z
        .array(
          z.object({
            issue: z.string().describe("Description of the issue"),
            severity: z
              .enum(["minor", "significant", "critical"])
              .describe("Severity of the issue"),
          })
        )
        .describe("List of specific issues found."),
    });

    const evalPrompt = `You are an expert QA evaluator for a UI generation system.
Your task is to evaluate whether the generated UI JSON matches the user's request and conforms to the expected behavior.

User Request:
${originalPrompt}

Expected Schemas:
${schemaDefs}

Generated Output (JSONL in Markdown):
${generatedOutput}

Instructions:
1. Analyze the Generated Output against the User Request.
2. Check if all requested components are present and match the user's intent.
3. Check if the hierarchy and properties match the description.
4. Verify that the content (text, labels, etc.) is correct and makes sense.
5. Ignore minor formatting differences.
6. If the output is correct and satisfies the request, return "pass": true.
7. If there are missing components, incorrect values, or structural issues that affect the user experience, return "pass": false and provide a detailed "reason".
8. In the "reason", explicitly quote the part of the JSON that is incorrect if possible.

- You can be lenient in your evaluation for URLs, as the generated output may use a placeholder URL for images and icons.
- If label text is similar but not exact, you can still pass the test as long as the meaning is the same. (e.g. "Cancel" vs "Cancel Order")
- If the generated output is missing a component that is specified in the user request, it is required to exist in the output in order to pass the test. If it is not specified, it is not required.
- If the request is vague about the contents of a label or other property, you can still pass the test as long as it can be construed as matching the intent.
- Unless explicitly required to be absent by the user request, extra components or attributes are allowed.

Severity Definitions:
- Minor: Merely cosmetic or a slight deviation from the request.
- Significant: The UI isn't very ergonomic or would be hard to understand.
- Critical: That part of the UI is left off, or the structure isn't valid and can't be rendered.

Return a JSON object with the following schema:

\`\`\`json
{
  "type": "object",
  "properties": {
    "pass": {
      "type": "boolean",
      "description": "Whether the generated UI meets the requirements"
    },
    "reason": {
      "type": "string",
      "description": "Summary of the reason for a failure."
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "issue": {
            "type": "string",
            "description": "Description of the issue"
          },
          "severity": {
            "type": "string",
            "enum": ["minor", "significant", "critical"],
            "description": "Severity of the issue"
          }
        },
        "required": ["issue", "severity"]
      },
      "description": "List of specific issues found."
    }
  },
  "required": ["pass", "reason", "issues"]
}
\`\`\`
`;

    // Calculate estimated tokens for rate limiting
    const estimatedInputTokens = Math.ceil(evalPrompt.length / 2.5);

    // Find the model config for the eval model
    // We need to look it up from the models list or create a temporary config
    // For now, we'll try to find it in the imported models list, or default to a safe config
    const { modelsToTest } = await import("./models");
    let evalModelConfig = modelsToTest.find((m) => m.name === evalModel);

    if (!evalModelConfig) {
      // If not found, create a temporary config with default limits
      evalModelConfig = {
        name: evalModel,
        model: null, // We don't need the model object for rate limiting if we just use the name
        requestsPerMinute: 60, // Safe default
        tokensPerMinute: 100000, // Safe default
      };
    }

    await rateLimiter.acquirePermit(evalModelConfig, estimatedInputTokens);

    try {
      const response = await ai.generate({
        prompt: evalPrompt,
        model: evalModelConfig.model || evalModel, // Use the model object if available, otherwise the string
        config: evalModelConfig.config,
        output: {
          schema: EvalResultSchema,
        },
      });

      // Parse the output
      const result = response.output;
      if (!result) {
        throw new Error("No output from evaluation model");
      }

      return {
        pass: result.pass,
        reason: result.reason || "No reason provided",
        issues: result.issues || [],
        evalPrompt: evalPrompt,
      };
    } catch (e: any) {
      logger.error(`Error during evaluation: ${e}`);
      if (evalModelConfig) {
        rateLimiter.reportError(evalModelConfig, e);
      }
      throw e; // Re-throw to let the retry logic handle it
    }
  }
);
