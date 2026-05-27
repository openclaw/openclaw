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

import { evaluationFlow } from "./evaluation_flow";
import { ValidatedResult, EvaluatedResult } from "./types";
import { logger } from "./logger";
import { rateLimiter } from "./rateLimiter";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { IssueSeverity } from "./types";

export class Evaluator {
  constructor(
    private schemas: any,
    private evalModel: string,
    private outputDir?: string
  ) {}

  async run(results: ValidatedResult[]): Promise<EvaluatedResult[]> {
    const passedResults = results.filter(
      (r) => r.validationErrors.length === 0 && r.components
    );
    const skippedCount = results.length - passedResults.length;

    logger.info(
      `Starting Phase 3: LLM Evaluation (${passedResults.length} items to evaluate, ${skippedCount} skipped due to validation failure)`
    );

    const totalJobs = passedResults.length;
    let completedCount = 0;
    let failedCount = 0;
    const evaluatedResults: EvaluatedResult[] = [];

    // Initialize results with skipped items
    for (const result of results) {
      if (result.validationErrors.length > 0) {
        evaluatedResults.push({
          ...result,
          evaluationResult: {
            pass: false,
            reason: "Schema validation failure",
            issues: [
              {
                issue: result.validationErrors.join("\n"),
                severity: "criticalSchema",
              },
            ],
            overallSeverity: "criticalSchema",
          },
        });
      } else if (!result.components) {
        evaluatedResults.push({ ...result });
      }
    }

    if (totalJobs === 0) {
      logger.info("Phase 3: Evaluation Complete (No items to evaluate)");
      return evaluatedResults;
    }

    const progressInterval = setInterval(() => {
      const queuedCount = rateLimiter.waitingCount;
      const inProgressCount =
        totalJobs - completedCount - failedCount - queuedCount;
      const pct = Math.round(
        ((completedCount + failedCount) / totalJobs) * 100
      );
      process.stderr.write(
        `\r[Phase 3] Progress: ${pct}% | Completed: ${completedCount} | In Progress: ${inProgressCount} | Queued: ${queuedCount} | Failed: ${failedCount}          `
      );
    }, 1000);

    const promises = passedResults.map((result) =>
      this.runJob(result).then((evalResult) => {
        if (evalResult.evaluationResult) {
          completedCount++;
        } else {
          failedCount++; // Failed to run evaluation flow (e.g. error)
        }
        evaluatedResults.push(evalResult);
        return evalResult;
      })
    );

    await Promise.all(promises);
    clearInterval(progressInterval);
    process.stderr.write("\n");
    logger.info("Phase 3: Evaluation Complete");

    return evaluatedResults;
  }

  private async runJob(result: ValidatedResult): Promise<EvaluatedResult> {
    const maxEvalRetries = 3;
    let evaluationResult:
      | {
          pass: boolean;
          reason: string;
          issues?: { issue: string; severity: IssueSeverity }[];
        }
      | undefined;

    for (let evalRetry = 0; evalRetry < maxEvalRetries; evalRetry++) {
      try {
        evaluationResult = await evaluationFlow({
          originalPrompt: result.prompt.promptText,
          generatedOutput: result.rawText || "",
          evalModel: this.evalModel,
          schemas: this.schemas,
        });
        break;
      } catch (e: any) {
        if (evalRetry === maxEvalRetries - 1) {
          logger.warn(
            `Evaluation failed for ${result.prompt.name} run ${result.runNumber}: ${e.message}`
          );
          evaluationResult = {
            pass: false,
            reason: `Evaluation flow failed: ${e.message}`,
          };
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * Math.pow(2, evalRetry))
          );
        }
      }
    }

    let overallSeverity: IssueSeverity | undefined;
    if (evaluationResult && !evaluationResult.pass && evaluationResult.issues) {
      const severities = evaluationResult.issues.map((i) => i.severity);
      if (severities.includes("critical")) {
        overallSeverity = "critical";
      } else if (severities.includes("significant")) {
        overallSeverity = "significant";
      } else if (severities.includes("minor")) {
        overallSeverity = "minor";
      }
    }

    if (this.outputDir && evaluationResult) {
      this.saveEvaluation(result, evaluationResult, overallSeverity);
    }

    return {
      ...result,
      evaluationResult: evaluationResult
        ? { ...evaluationResult, overallSeverity }
        : undefined,
    };
  }

  private saveEvaluation(
    result: ValidatedResult,
    evaluationResult: {
      pass: boolean;
      reason: string;
      issues?: { issue: string; severity: IssueSeverity }[];
      evalPrompt?: string;
    },
    overallSeverity?: IssueSeverity
  ) {
    if (!this.outputDir) return;

    // Only save if the evaluation failed
    if (evaluationResult.pass) return;

    const modelDir = path.join(
      this.outputDir,
      `output-${result.modelName.replace(/[\/:]/g, "_")}`
    );
    const detailsDir = path.join(modelDir, "details");
    fs.writeFileSync(
      path.join(
        detailsDir,
        `${result.prompt.name}.${result.runNumber}.failed.yaml`
      ),
      yaml.dump({ ...evaluationResult, overallSeverity })
    );

    if (evaluationResult.evalPrompt) {
      fs.writeFileSync(
        path.join(
          detailsDir,
          `${result.prompt.name}.${result.runNumber}.eval_prompt.txt`
        ),
        evaluationResult.evalPrompt
      );
    }
  }
}
