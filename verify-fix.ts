import { buildOpenAIResponsesParams } from "./src/agents/openai-transport-stream.js";
import type { Model } from "./src/llm/types.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

const context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [],
  tools: [],
};

const params = buildOpenAIResponsesParams(model, context, undefined);
console.log("Params:", JSON.stringify(params, null, 2));
console.log("Has instructions:", "instructions" in params);
console.log("Input array:", params.input);
console.log("System prompt in instructions?", params.instructions === context.systemPrompt);
console.log("Input does not contain system message?", !(params.input?.some((item: any) => item.role === "system" || item.role === "developer")));
