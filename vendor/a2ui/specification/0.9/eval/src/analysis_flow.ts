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

export const analysisFlow = ai.defineFlow(
  {
    name: "analysisFlow",
    inputSchema: z.object({
      modelName: z.string(),
      failures: z.array(
        z.object({
          promptName: z.string(),
          runNumber: z.number(),
          failureType: z.string(),
          reason: z.string(),
          issues: z.array(z.string()).optional(),
        })
      ),
      numRuns: z.number(),
      evalModel: z.string(),
    }),
    outputSchema: z.string(),
  },
  async ({ modelName, failures, numRuns, evalModel }) => {
    const failureDetails = failures
      .map((f) => {
        let details = `Prompt: ${f.promptName} (Run ${f.runNumber})\nType: ${f.failureType}\nReason: ${f.reason}`;
        if (f.issues && f.issues.length > 0) {
          details += `\nIssues:\n- ${f.issues.join("\n- ")}`;
        }
        return details;
      })
      .join("\n\n---\n\n");

    const analysisPrompt = `You are an expert AI analyst.
Your task is to analyze the following failures from an evaluation run of the model "${modelName}".

Out of the ${failures.length} failures, ${failures.filter((f) => f.failureType === "Schema Validation").length} are schema validation failures, ${failures.filter((f) => f.failureType === "Missing Components").length} are missing components failures, and ${failures.filter((f) => f.failureType === "Incorrect Logic").length} are incorrect logic failures.

There were ${numRuns - failures.length} successful runs. Take this into account in the final summary of the analysis.

Failures:
${failureDetails}

Instructions:
1. Identify and list the broad types of errors (e.g., Schema Validation, Missing Components, Incorrect Logic, etc.).
2. Analyze succinctly any patterns you see in the failures (e.g., "The model consistently fails to include the 'id' property", "The model struggles with nested layouts") and list them in a bullet point list. Try to give short examples of the patterns taken from the actual failures.
3. Provide a concise summary of your findings in a single paragraph.

The output is meant to be a short summary, not a full report. It should be easy to read and understand at a glance.

Output Format:
Return a Markdown formatted summary. Use headers and bullet points.
`;

    // Calculate estimated tokens for rate limiting
    const estimatedInputTokens = Math.ceil(analysisPrompt.length / 2.5);

    const { modelsToTest } = await import("./models");
    let evalModelConfig = modelsToTest.find((m) => m.name === evalModel);

    if (!evalModelConfig) {
      evalModelConfig = {
        name: evalModel,
        model: null,
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      };
    }

    await rateLimiter.acquirePermit(evalModelConfig, estimatedInputTokens);

    try {
      const response = await ai.generate({
        prompt: analysisPrompt,
        model: evalModelConfig.model || evalModel,
        config: evalModelConfig.config,
        output: {
          format: "text",
        },
      });

      const output = response.output;
      if (!output) {
        throw new Error("No output from analysis model");
      }

      if (typeof output !== "string") {
        return "Analysis failed: Output was not a string.";
      }

      return output;
    } catch (e: any) {
      logger.error(`Error during analysis: ${e}`);
      if (evalModelConfig) {
        rateLimiter.reportError(evalModelConfig, e);
      }
      return `Analysis failed: ${e.message}`;
    }
  }
);
