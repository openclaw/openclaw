# Genkit Eval Framework for UI generation（轉為繁體中文）
（轉為繁體中文）
This is for evaluating A2UI (v0.9) against various LLMs.（轉為繁體中文）
（轉為繁體中文）
This version embeds the JSON schemas directly into the prompt and instructs the LLM to output a JSON object within a markdown code block. The framework then extracts and validates this JSON.（轉為繁體中文）
（轉為繁體中文）
## Setup（轉為繁體中文）
（轉為繁體中文）
To use the models, you need to set the following environment variables with your API keys:（轉為繁體中文）
（轉為繁體中文）
- `GEMINI_API_KEY`（轉為繁體中文）
- `OPENAI_API_KEY`（轉為繁體中文）
- `ANTHROPIC_API_KEY`（轉為繁體中文）
（轉為繁體中文）
You can set these in a `.env` file in the root of the project, or in your shell's configuration file (e.g., `.bashrc`, `.zshrc`).（轉為繁體中文）
（轉為繁體中文）
You also need to install dependencies before running:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm install（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Running all evals (warning: can use _lots_ of model quota)（轉為繁體中文）
（轉為繁體中文）
To run the flow, use the following command:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run evalAll（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Running a Single Test（轉為繁體中文）
（轉為繁體中文）
You can run the script for a single model and data point by using the `--model` and `--prompt` command-line flags. This is useful for quick tests and debugging.（轉為繁體中文）
（轉為繁體中文）
### Syntax（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run eval --model=<model_name> --prompt=<prompt_name>（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### Example（轉為繁體中文）
（轉為繁體中文）
To run the test with the `gemini-2.5-flash-lite` model and the `loginForm` prompt, use the following command:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run eval --model=gemini-2.5-flash-lite --prompt=loginForm（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Controlling Output（轉為繁體中文）
（轉為繁體中文）
By default, the script prints a progress bar and the final summary table to the console. Detailed logs are written to `output.log` in the results directory.（轉為繁體中文）
（轉為繁體中文）
### Command-Line Options（轉為繁體中文）
（轉為繁體中文）
- `--log-level=<level>`: Sets the console logging level (default: `info`). Options: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`.（轉為繁體中文）
  - Note: The file log (`output.log` in the results directory) always captures `debug` level logs regardless of this setting.（轉為繁體中文）
- `--results=<output_dir>`: (Default: `results/output-<model>` or `results/output-combined` if multiple models are specified) Preserves output files. To specify a custom directory, use `--results=my_results`.（轉為繁體中文）
- `--clean-results`: If set, cleans the results directory before running tests.（轉為繁體中文）
- `--runs-per-prompt=<number>`: Number of times to run each prompt (default: 1).（轉為繁體中文）
- `--model=<model_name>`: (Default: all models) Run only the specified model(s). Can be specified multiple times.（轉為繁體中文）
- `--prompt=<prompt_name>`: (Default: all prompts) Run only the specified prompt.（轉為繁體中文）
（轉為繁體中文）
### Examples（轉為繁體中文）
（轉為繁體中文）
Run with debug output in console:（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run eval -- --log-level=debug（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
Run 5 times per prompt and clean previous results:（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run eval -- --runs-per-prompt=5 --clean-results（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Rate Limiting（轉為繁體中文）
（轉為繁體中文）
The framework includes a two-tiered rate limiting system:（轉為繁體中文）
1. **Proactive Limiting**: Locally tracks token and request usage to stay within configured limits (defined in `src/models.ts`).（轉為繁體中文）
2. **Reactive Circuit Breaker**: Automatically pauses requests to a model if a `RESOURCE_EXHAUSTED` (429) error is received, resuming only after the requested retry duration.（轉為繁體中文）
