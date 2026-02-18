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

import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { logger, setupLogger } from "./logger";
import { modelsToTest } from "./models";
import { prompts, TestPrompt } from "./prompts";
import { Generator } from "./generator";
import { Validator } from "./validator";
import { Evaluator } from "./evaluator";
import { EvaluatedResult } from "./types";
import { analysisFlow } from "./analysis_flow";

const schemaFiles = [
  "../../json/common_types.json",
  "../../json/standard_catalog_definition.json",
  "../../json/server_to_client.json",
];

function loadSchemas(): Record<string, any> {
  const schemas: Record<string, any> = {};
  for (const file of schemaFiles) {
    const schemaString = fs.readFileSync(path.join(__dirname, file), "utf-8");
    const schema = JSON.parse(schemaString);
    schemas[path.basename(file)] = schema;
  }
  return schemas;
}

function generateSummary(
  results: EvaluatedResult[],
  analysisResults: Record<string, string>
): string {
  const promptNameWidth = 40;
  const latencyWidth = 20;
  const failedRunsWidth = 15;
  const severityWidth = 15;

  // Group by model
  const resultsByModel: Record<string, EvaluatedResult[]> = {};
  for (const result of results) {
    if (!resultsByModel[result.modelName]) {
      resultsByModel[result.modelName] = [];
    }
    resultsByModel[result.modelName].push(result);
  }

  let summary = "# Evaluation Summary";
  for (const modelName in resultsByModel) {
    summary += `\n\n## Model: ${modelName}\n\n`;
    const header = `| ${"Prompt Name".padEnd(
      promptNameWidth
    )} | ${"Avg Latency (ms)".padEnd(latencyWidth)} | ${"Schema Fail".padEnd(
      failedRunsWidth
    )} | ${"Eval Fail".padEnd(failedRunsWidth)} | ${"Minor".padEnd(
      severityWidth
    )} | ${"Significant".padEnd(severityWidth)} | ${"Critical".padEnd(
      severityWidth
    )} |`;
    const divider = `|${"-".repeat(promptNameWidth + 2)}|${"-".repeat(
      latencyWidth + 2
    )}|${"-".repeat(failedRunsWidth + 2)}|${"-".repeat(
      failedRunsWidth + 2
    )}|${"-".repeat(severityWidth + 2)}|${"-".repeat(
      severityWidth + 2
    )}|${"-".repeat(severityWidth + 2)}|`;
    summary += header;
    summary += `\n${divider}`;

    const modelResults = resultsByModel[modelName];
    const promptsInModel = modelResults.reduce(
      (acc, result) => {
        if (!acc[result.prompt.name]) {
          acc[result.prompt.name] = [];
        }
        acc[result.prompt.name].push(result);
        return acc;
      },
      {} as Record<string, EvaluatedResult[]>
    );

    const sortedPromptNames = Object.keys(promptsInModel).sort();
    for (const promptName of sortedPromptNames) {
      const runs = promptsInModel[promptName];
      const totalRuns = runs.length;
      const schemaFailedRuns = runs.filter(
        (r) => r.error || r.validationErrors.length > 0
      ).length;
      const evalFailedRuns = runs.filter(
        (r) => r.evaluationResult && !r.evaluationResult.pass
      ).length;

      const totalLatency = runs.reduce((acc, r) => acc + r.latency, 0);
      const avgLatency = (totalLatency / totalRuns).toFixed(0);

      const schemaFailedStr =
        schemaFailedRuns > 0 ? `${schemaFailedRuns} / ${totalRuns}` : "";
      const evalFailedStr =
        evalFailedRuns > 0 ? `${evalFailedRuns} / ${totalRuns}` : "";

      let minorCount = 0;
      let significantCount = 0;
      let criticalCount = 0;

      for (const r of runs) {
        if (r.evaluationResult?.issues) {
          for (const issue of r.evaluationResult.issues) {
            if (issue.severity === "minor") minorCount++;
            else if (issue.severity === "significant") significantCount++;
            else if (issue.severity === "critical") criticalCount++;
          }
        }
      }

      const minorStr = minorCount > 0 ? `${minorCount}` : "";
      const significantStr = significantCount > 0 ? `${significantCount}` : "";
      const criticalStr = criticalCount > 0 ? `${criticalCount}` : "";

      summary += `\n| ${promptName.padEnd(
        promptNameWidth
      )} | ${avgLatency.padEnd(latencyWidth)} | ${schemaFailedStr.padEnd(
        failedRunsWidth
      )} | ${evalFailedStr.padEnd(failedRunsWidth)} | ${minorStr.padEnd(
        severityWidth
      )} | ${significantStr.padEnd(severityWidth)} | ${criticalStr.padEnd(
        severityWidth
      )} |`;
    }

    const totalRunsForModel = modelResults.length;
    const successfulRuns = modelResults.filter(
      (r) =>
        !r.error &&
        r.validationErrors.length === 0 &&
        (!r.evaluationResult || r.evaluationResult.pass)
    ).length;

    const successPercentage =
      totalRunsForModel === 0
        ? "0.0"
        : ((successfulRuns / totalRunsForModel) * 100.0).toFixed(1);

    summary += `\n\n**Total successful runs:** ${successfulRuns} / ${totalRunsForModel} (${successPercentage}% success)`;

    if (analysisResults[modelName]) {
      summary += `\n\n### Failure Analysis\n\n${analysisResults[modelName]}`;
    }
  }

  summary += "\n\n---\n\n## Overall Summary\n";
  const totalRuns = results.length;
  const totalToolErrorRuns = results.filter((r) => r.error).length;
  const totalRunsWithAnyFailure = results.filter(
    (r) =>
      r.error ||
      r.validationErrors.length > 0 ||
      (r.evaluationResult && !r.evaluationResult.pass)
  ).length;

  const modelsWithFailures = [
    ...new Set(
      results
        .filter(
          (r) =>
            r.error ||
            r.validationErrors.length > 0 ||
            (r.evaluationResult && !r.evaluationResult.pass)
        )
        .map((r) => r.modelName)
    ),
  ].join(", ");

  let totalMinor = 0;
  let totalSignificant = 0;
  let totalCritical = 0;
  let totalCriticalSchema = 0;

  for (const r of results) {
    if (r.evaluationResult?.issues) {
      for (const issue of r.evaluationResult.issues) {
        if (issue.severity === "minor") totalMinor++;
        else if (issue.severity === "significant") totalSignificant++;
        else if (issue.severity === "critical") totalCritical++;
        else if (issue.severity === "criticalSchema") totalCriticalSchema++;
      }
    }
  }

  summary += `\n- **Total tool failures:** ${totalToolErrorRuns} / ${totalRuns}`;
  const successPercentage =
    totalRuns === 0
      ? "0.0"
      : (((totalRuns - totalRunsWithAnyFailure) / totalRuns) * 100.0).toFixed(
          1
        );
  summary += `\n- **Number of runs with any failure (tool error, validation, or eval):** ${totalRunsWithAnyFailure} / ${totalRuns} (${successPercentage}% success)`;
  summary += `\n- **Severity Breakdown:**`;
  summary += `\n  - **Minor:** ${totalMinor}`;
  summary += `\n  - **Significant:** ${totalSignificant}`;
  summary += `\n  - **Critical (Eval):** ${totalCritical}`;
  summary += `\n  - **Critical (Schema):** ${totalCriticalSchema}`;

  const latencies = results.map((r) => r.latency).sort((a, b) => a - b);
  const totalLatency = latencies.reduce((acc, l) => acc + l, 0);
  const meanLatency =
    totalRuns > 0 ? (totalLatency / totalRuns).toFixed(0) : "0";
  let medianLatency = 0;
  if (latencies.length > 0) {
    const mid = Math.floor(latencies.length / 2);
    if (latencies.length % 2 === 0) {
      medianLatency = (latencies[mid - 1] + latencies[mid]) / 2;
    } else {
      medianLatency = latencies[mid];
    }
  }

  summary += `\n- **Mean Latency:** ${meanLatency} ms`;
  summary += `\n- **Median Latency:** ${medianLatency} ms`;

  if (modelsWithFailures) {
    summary += `\n- **Models with at least one failure:** ${modelsWithFailures}`;
  }
  return summary;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("log-level", {
      type: "string",
      description: "Set the logging level",
      default: "info",
      choices: ["debug", "info", "warn", "error"],
    })
    .option("results", {
      type: "string",
      description:
        "Directory to keep output files. If not specified, uses results/output-<model>. If specified, uses the provided directory (appending output-<model>).",
      coerce: (arg) => (arg === undefined ? true : arg),
      default: true,
    })
    .option("runs-per-prompt", {
      type: "number",
      description: "Number of times to run each prompt",
      default: 1,
    })
    .option("model", {
      type: "string",
      array: true,
      description: "Filter models by exact name",
      default: [],
      choices: modelsToTest.map((m) => m.name),
    })
    .option("prompt", {
      type: "string",
      array: true,
      description: "Filter prompts by name prefix",
    })
    .option("eval-model", {
      type: "string",
      description: "Model to use for evaluation",
      default: "gemini-2.5-flash",
      choices: modelsToTest.map((m) => m.name),
    })
    .option("clean-results", {
      type: "boolean",
      description: "Clear the output directory before starting",
      default: false,
    })

    .help()
    .alias("h", "help")
    .strict().argv;

  // Filter Models
  let filteredModels = modelsToTest;
  if (argv.model && argv.model.length > 0) {
    const modelNames = argv.model as string[];
    filteredModels = modelsToTest.filter((m) => modelNames.includes(m.name));
    if (filteredModels.length === 0) {
      logger.error(`No models found matching: ${modelNames.join(", ")}.`);
      process.exit(1);
    }
  }

  // Filter Prompts
  let filteredPrompts = prompts;
  if (argv.prompt && argv.prompt.length > 0) {
    const promptPrefixes = argv.prompt as string[];
    filteredPrompts = prompts.filter((p) =>
      promptPrefixes.some((prefix) => p.name.startsWith(prefix))
    );
    if (filteredPrompts.length === 0) {
      logger.error(
        `No prompt found with prefix "${promptPrefixes.join(", ")}".`
      );
      process.exit(1);
    }
  }

  // Determine Output Directory (Base)
  // Note: Generator/Validator/Evaluator handle per-model subdirectories if outputDir is provided.
  // But we need a base output dir to pass to them.
  let resultsBaseDir: string | undefined;
  const resultsArg = argv.results;
  if (typeof resultsArg === "string") {
    resultsBaseDir = resultsArg;
  } else if (resultsArg === true) {
    resultsBaseDir = "results";
  }

  // Clean Results
  if (
    argv["clean-results"] &&
    resultsBaseDir &&
    fs.existsSync(resultsBaseDir)
  ) {
    // Only clean if we are using the default structure or explicit path
    // We should be careful not to delete root if user passed "/" (unlikely but possible)
    // For safety, let's iterate over models and clean their specific dirs if they exist
    // Or just clean the base dir if it looks like our results dir.
    // The previous logic cleaned `outputDir` which was per-model.
    // Here we might want to clean the whole results dir if it's the default "results".
    if (resultsBaseDir === "results") {
      fs.rmSync(resultsBaseDir, { recursive: true, force: true });
    } else {
      // If custom dir, maybe just clean it?
      // User asked to clean results.
      fs.rmSync(resultsBaseDir, { recursive: true, force: true });
    }
  }

  // Setup Logger (Global)
  // We need to setup logger to write to file?
  // Previous logic setup logger per model output dir.
  // Now we have multiple models potentially.
  // We can setup logger to write to stdout/stderr primarily, and maybe a global log file?
  // Or we can setup logger to NOT write to file, and let phases write their own logs?
  // The `setupLogger` function takes an outputDir.
  // If we have multiple models, where do we log?
  // Maybe just log to the first model's dir or a "latest" dir?
  // Or just console for now if multiple models?
  // If single model, use that model's dir.

  if (resultsBaseDir) {
    if (filteredModels.length === 1) {
      const modelDirName = `output-${filteredModels[0].name.replace(/[\/:]/g, "_")}`;
      setupLogger(path.join(resultsBaseDir, modelDirName), argv["log-level"]);
    } else {
      // If multiple models, maybe just log to console or a shared log?
      // For now, let's just use console logging (default if setupLogger not called with dir?)
      // Actually setupLogger needs a dir to create 'eval.log'.
      // Let's create a 'combined' log if multiple models?
      // Or just skip file logging for multiple models for now.
      setupLogger(undefined, argv["log-level"]);
    }
  } else {
    setupLogger(undefined, argv["log-level"]);
  }

  const schemas = loadSchemas();
  const catalogRulesPath = path.join(
    __dirname,
    "../../json/standard_catalog_rules.txt"
  );
  let catalogRules: string | undefined;
  if (fs.existsSync(catalogRulesPath)) {
    catalogRules = fs.readFileSync(catalogRulesPath, "utf-8");
  } else {
    logger.warn(
      `Catalog rules file not found at ${catalogRulesPath}. Proceeding without specific catalog rules.`
    );
  }

  // Phase 1: Generation
  const generator = new Generator(schemas, resultsBaseDir, catalogRules);
  const generatedResults = await generator.run(
    filteredPrompts,
    filteredModels,
    argv["runs-per-prompt"]
  );

  // Phase 2: Validation
  const validator = new Validator(schemas, resultsBaseDir);
  const validatedResults = await validator.run(generatedResults);

  // Phase 3: Evaluation
  const evaluator = new Evaluator(schemas, argv["eval-model"], resultsBaseDir);
  const evaluatedResults = await evaluator.run(validatedResults);

  // Phase 4: Failure Analysis
  const analysisResults: Record<string, string> = {};
  const resultsByModel: Record<string, EvaluatedResult[]> = {};
  for (const result of evaluatedResults) {
    if (!resultsByModel[result.modelName]) {
      resultsByModel[result.modelName] = [];
    }
    resultsByModel[result.modelName].push(result);
  }

  for (const modelName in resultsByModel) {
    const modelResults = resultsByModel[modelName];
    const failures = modelResults
      .filter(
        (r) =>
          r.error ||
          r.validationErrors.length > 0 ||
          (r.evaluationResult && !r.evaluationResult.pass)
      )
      .map((r) => {
        let failureType = "Unknown";
        let reason = "Unknown";
        let issues: string[] = [];

        if (r.error) {
          failureType = "Tool Error";
          reason = r.error.message || String(r.error);
        } else if (r.validationErrors.length > 0) {
          failureType = "Schema Validation";
          reason = "Schema validation failed";
          issues = r.validationErrors;
        } else if (r.evaluationResult && !r.evaluationResult.pass) {
          failureType = "Evaluation Failure";
          reason = r.evaluationResult.reason;
          if (r.evaluationResult.issues) {
            issues = r.evaluationResult.issues.map(
              (i) => `${i.severity}: ${i.issue}`
            );
          }
        }

        return {
          promptName: r.prompt.name,
          runNumber: r.runNumber,
          failureType,
          reason,
          issues,
        };
      });

    if (failures.length > 0) {
      logger.info(`Running failure analysis for model: ${modelName}...`);
      try {
        const analysis = await analysisFlow({
          modelName,
          failures,
          numRuns: modelResults.length,
          evalModel: argv["eval-model"],
        });
        analysisResults[modelName] = analysis;
      } catch (e) {
        logger.error(`Failed to run failure analysis for ${modelName}: ${e}`);
        analysisResults[modelName] = "Failed to run analysis.";
      }
    }
  }

  // Summary
  const summary = generateSummary(evaluatedResults, analysisResults);
  logger.info(summary);

  if (resultsBaseDir) {
    // Save summary to each model dir?
    // Or just one summary?
    // Previous logic saved summary.md in model dir.
    for (const model of filteredModels) {
      const modelDirName = `output-${model.name.replace(/[\/:]/g, "_")}`;
      const modelDir = path.join(resultsBaseDir, modelDirName);
      if (fs.existsSync(modelDir)) {
        fs.writeFileSync(path.join(modelDir, "summary.md"), summary);
      }
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}
