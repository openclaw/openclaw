# Genkit Eval Framework for UI generation

This is for evaluating A2UI (v0.9) against various LLMs.

This version embeds the JSON schemas directly into the prompt and instructs the LLM to output a JSON object within a markdown code block. The framework then extracts and validates this JSON.

## Setup

To use the models, you need to set the following environment variables with your API keys:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

You can set these in a `.env` file in the root of the project, or in your shell's configuration file (e.g., `.bashrc`, `.zshrc`).

You also need to install dependencies before running:

```bash
pnpm install
```

## Running all evals (warning: can use _lots_ of model quota)

To run the flow, use the following command:

```bash
pnpm run evalAll
```

## Running a Single Test

You can run the script for a single model and data point by using the `--model` and `--prompt` command-line flags. This is useful for quick tests and debugging.

### Syntax

```bash
pnpm run eval --model=<model_name> --prompt=<prompt_name>
```

### Example

To run the test with the `gemini-2.5-flash-lite` model and the `loginForm` prompt, use the following command:

```bash
pnpm run eval --model=gemini-2.5-flash-lite --prompt=loginForm
```

## Controlling Output

By default, the script prints a progress bar and the final summary table to the console. Detailed logs are written to `output.log` in the results directory.

### Command-Line Options

- `--log-level=<level>`: Sets the console logging level (default: `info`). Options: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly`.
  - Note: The file log (`output.log` in the results directory) always captures `debug` level logs regardless of this setting.
- `--results=<output_dir>`: (Default: `results/output-<model>` or `results/output-combined` if multiple models are specified) Preserves output files. To specify a custom directory, use `--results=my_results`.
- `--clean-results`: If set, cleans the results directory before running tests.
- `--runs-per-prompt=<number>`: Number of times to run each prompt (default: 1).
- `--model=<model_name>`: (Default: all models) Run only the specified model(s). Can be specified multiple times.
- `--prompt=<prompt_name>`: (Default: all prompts) Run only the specified prompt.

### Examples

Run with debug output in console:
```bash
pnpm run eval -- --log-level=debug
```

Run 5 times per prompt and clean previous results:
```bash
pnpm run eval -- --runs-per-prompt=5 --clean-results
```

## Rate Limiting

The framework includes a two-tiered rate limiting system:
1. **Proactive Limiting**: Locally tracks token and request usage to stay within configured limits (defined in `src/models.ts`).
2. **Reactive Circuit Breaker**: Automatically pauses requests to a model if a `RESOURCE_EXHAUSTED` (429) error is received, resuming only after the requested retry duration.
