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

import { TestPrompt } from "./prompts";

export interface GeneratedResult {
  modelName: string;
  prompt: TestPrompt;
  runNumber: number;
  rawText?: string;
  components?: any[];
  latency: number;
  error?: any;
}

export interface ValidatedResult extends GeneratedResult {
  validationErrors: string[];
}

export type IssueSeverity =
  | "minor"
  | "significant"
  | "critical"
  | "criticalSchema";

export interface EvaluatedResult extends ValidatedResult {
  evaluationResult?: {
    pass: boolean;
    reason: string;
    issues?: { issue: string; severity: IssueSeverity }[];
    overallSeverity?: IssueSeverity;
    evalPrompt?: string;
  };
}
