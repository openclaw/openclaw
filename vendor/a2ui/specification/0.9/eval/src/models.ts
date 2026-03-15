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

import { googleAI } from "@genkit-ai/google-genai";
import { openAI } from "@genkit-ai/compat-oai/openai";
import { claude35Haiku, claude4Sonnet } from "genkitx-anthropic";

export interface ModelConfiguration {
  model: any;
  name: string;
  config?: any;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export const modelsToTest: ModelConfiguration[] = [
  {
    model: openAI.model("gpt-5.1"),
    name: "gpt-5.1",
    config: { reasoning_effort: "minimal" },
    requestsPerMinute: 500,
    tokensPerMinute: 30000,
  },
  {
    model: openAI.model("gpt-5-mini"),
    name: "gpt-5-mini",
    config: { reasoning_effort: "minimal" },
    requestsPerMinute: 500,
    tokensPerMinute: 500000,
  },
  {
    model: openAI.model("gpt-5-nano"),
    name: "gpt-5-nano",
    config: {},
    requestsPerMinute: 500,
    tokensPerMinute: 200000,
  },
  {
    model: googleAI.model("gemini-2.5-pro"),
    name: "gemini-2.5-pro",
    config: { thinkingConfig: { thinkingBudget: 1000 } },
    requestsPerMinute: 150,
    tokensPerMinute: 2000000,
  },
  {
    model: googleAI.model("gemini-3-pro-preview"),
    name: "gemini-3-pro",
    config: { thinkingConfig: { thinkingBudget: 1000 } },
    requestsPerMinute: 50,
    tokensPerMinute: 1000000,
  },
  {
    model: googleAI.model("gemini-2.5-flash"),
    name: "gemini-2.5-flash",
    config: { thinkingConfig: { thinkingBudget: 0 } },
    requestsPerMinute: 1000,
    tokensPerMinute: 1000000,
  },
  {
    model: googleAI.model("gemini-2.5-flash-lite"),
    name: "gemini-2.5-flash-lite",
    config: { thinkingConfig: { thinkingBudget: 0 } },
    requestsPerMinute: 4000,
    tokensPerMinute: 1200000,
  },
  {
    model: claude4Sonnet,
    name: "claude-4-sonnet",
    config: {},
    requestsPerMinute: 50,
    tokensPerMinute: 30000,
  },
  {
    model: claude35Haiku,
    name: "claude-35-haiku",
    config: {},
    requestsPerMinute: 50,
    tokensPerMinute: 50000,
  },
];
