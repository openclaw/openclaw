
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
import { genkit } from "genkit";
import { openAI } from "@genkit-ai/compat-oai/openai";
import { anthropic } from "genkitx-anthropic";
import { logger } from "./logger";

const plugins = [];

if (process.env.GEMINI_API_KEY) {
  logger.info("Initializing Google AI plugin...");
  plugins.push(
    googleAI({
      apiKey: process.env.GEMINI_API_KEY!,
      experimental_debugTraces: true,
    })
  );
}
if (process.env.OPENAI_API_KEY) {
  logger.info("Initializing OpenAI plugin...");
  plugins.push(openAI());
}
if (process.env.ANTHROPIC_API_KEY) {
  logger.info("Initializing Anthropic plugin...");
  plugins.push(anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));
}

export const ai = genkit({
  plugins,
});
