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

import { componentGeneratorFlow } from "./generation_flow";
import { ModelConfiguration } from "./models";
import { TestPrompt } from "./prompts";
import { GeneratedResult } from "./types";
import { extractJsonFromMarkdown } from "./utils";
import { rateLimiter } from "./rateLimiter";
import { logger } from "./logger";
import * as fs from "fs";
import * as path from "path";

export class Generator {
  constructor(
    private schemas: any,
    private outputDir?: string,
    private catalogRules?: string
  ) {}

  async run(
    prompts: TestPrompt[],
    models: ModelConfiguration[],
    runsPerPrompt: number
  ): Promise<GeneratedResult[]> {
    const totalJobs = prompts.length * models.length * runsPerPrompt;
    let completedCount = 0;
    let failedCount = 0;
    const results: GeneratedResult[] = [];
    const promises: Promise<GeneratedResult>[] = [];

    logger.info(`Starting Phase 1: Generation (${totalJobs} jobs)`);

    const progressInterval = setInterval(() => {
      const queuedCount = rateLimiter.waitingCount;
      const inProgressCount =
        totalJobs - completedCount - failedCount - queuedCount;
      const pct =
        totalJobs > 0
          ? Math.round(((completedCount + failedCount) / totalJobs) * 100)
          : 0;
      process.stderr.write(
        `\r[Phase 1] Progress: ${pct}% | Completed: ${completedCount} | In Progress: ${inProgressCount} | Queued: ${queuedCount} | Failed: ${failedCount}          `
      );
    }, 1000);

    for (const model of models) {
      for (const prompt of prompts) {
        for (let i = 1; i <= runsPerPrompt; i++) {
          promises.push(
            this.runJob(model, prompt, i).then((result) => {
              if (result.error) {
                failedCount++;
              } else {
                completedCount++;
              }
              results.push(result);
              return result;
            })
          );
        }
      }
    }

    await Promise.all(promises);
    clearInterval(progressInterval);
    process.stderr.write("\n");
    logger.info("Phase 1: Generation Complete");

    return results;
  }

  private async runJob(
    model: ModelConfiguration,
    prompt: TestPrompt,
    runIndex: number,
    retryCount: number = 0
  ): Promise<GeneratedResult> {
    const startTime = Date.now();
    try {
      const output: any = await componentGeneratorFlow({
        prompt: prompt.promptText,
        modelConfig: model,
        schemas: this.schemas,
        catalogRules: this.catalogRules,
      });

      const text = output?.text;
      const latency = output?.latency || 0;
      let components: any[] = [];
      let error = null;

      if (text) {
        try {
          components = extractJsonFromMarkdown(text);
          if (this.outputDir) {
            this.saveArtifacts(model, prompt, runIndex, text, components);
          }
        } catch (e) {
          error = e;
          if (this.outputDir) {
            this.saveError(model, prompt, runIndex, text, e);
          }
        }
      } else {
        error = new Error("No output text returned from model");
      }

      return {
        modelName: model.name,
        prompt,
        runNumber: runIndex,
        rawText: text,
        components,
        latency,
        error,
      };
    } catch (error: any) {
      if (retryCount < 1) {
        // Simple retry for tool errors
        return this.runJob(model, prompt, runIndex, retryCount + 1);
      }
      return {
        modelName: model.name,
        prompt,
        runNumber: runIndex,
        latency: Date.now() - startTime,
        error,
      };
    }
  }

  private saveArtifacts(
    model: ModelConfiguration,
    prompt: TestPrompt,
    runIndex: number,
    text: string,
    components: any[]
  ) {
    if (!this.outputDir) return;
    const modelDir = path.join(
      this.outputDir,
      `output-${model.name.replace(/[\/:]/g, "_")}`
    );
    const detailsDir = path.join(modelDir, "details");
    fs.mkdirSync(detailsDir, { recursive: true });

    fs.writeFileSync(
      path.join(detailsDir, `${prompt.name}.${runIndex}.json`),
      JSON.stringify(components, null, 2)
    );

    const samplePath = path.join(
      detailsDir,
      `${prompt.name}.${runIndex}.sample`
    );
    const yamlHeader = `---
description: ${prompt.description}
name: ${prompt.name}
prompt: |
${prompt.promptText
  .split("\n")
  .map((line) => "  " + line)
  .join("\n")}
---
`;
    let jsonlBody = "";
    for (const comp of components) {
      jsonlBody += JSON.stringify(comp) + "\n";
    }
    fs.writeFileSync(samplePath, yamlHeader + jsonlBody);
  }

  private saveError(
    model: ModelConfiguration,
    prompt: TestPrompt,
    runIndex: number,
    text: string | undefined,
    error: any
  ) {
    if (!this.outputDir) return;
    const modelDir = path.join(
      this.outputDir,
      `output-${model.name.replace(/[\/:]/g, "_")}`
    );
    const detailsDir = path.join(modelDir, "details");
    fs.mkdirSync(detailsDir, { recursive: true });

    fs.writeFileSync(
      path.join(detailsDir, `${prompt.name}.${runIndex}.output.txt`),
      text || "No output"
    );
    fs.writeFileSync(
      path.join(detailsDir, `${prompt.name}.${runIndex}.error.json`),
      JSON.stringify({ message: error.message, stack: error.stack }, null, 2)
    );
  }
}
