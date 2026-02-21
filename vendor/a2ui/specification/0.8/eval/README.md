# Genkit Eval Framework for UI generation

This is for evaluating A2UI (v0.8) against various LLMs.

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

## Running all evals (warning: can use *lots* of model quota)

To run the flow, use the following command:

```bash
pnpm run evalAll
```

## Running a Single Test

You can run the script for a single model and data point by using the `--model` and `--prompt` command-line flags. This is useful for quick tests and debugging.

### Syntax

```bash
pnpm run eval -- --model='<model_name>' --prompt=<prompt_name>
```

### Example

To run the test with the `gpt-5-mini (reasoning: minimal)` model and the `generateDogUIs` prompt, use the following command:

```bash
pnpm run eval -- --model='gpt-5-mini (reasoning: minimal)' --prompt=generateDogUIs
```

## Controlling Output

By default, the script only prints the summary table and any errors that occur during generation. To see the full JSON output for each successful generation, use the `--verbose` flag.

To keep the input and output for each run in separate files, specify the `--keep=<output_dir>` flag, which will create a directory hierarchy with the input and output for each LLM call in separate files.

### Example

```bash
pnpm run evalAll -- --verbose
```

```bash
pnpm run evalAll -- --keep=output
```
