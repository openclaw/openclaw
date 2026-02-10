# Genkit Eval Framework for UI generation（轉為繁體中文）
（轉為繁體中文）
This is for evaluating A2UI (v0.8) against various LLMs.（轉為繁體中文）
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
## Running all evals (warning: can use *lots* of model quota)（轉為繁體中文）
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
pnpm run eval -- --model='<model_name>' --prompt=<prompt_name>（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
### Example（轉為繁體中文）
（轉為繁體中文）
To run the test with the `gpt-5-mini (reasoning: minimal)` model and the `generateDogUIs` prompt, use the following command:（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run eval -- --model='gpt-5-mini (reasoning: minimal)' --prompt=generateDogUIs（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
## Controlling Output（轉為繁體中文）
（轉為繁體中文）
By default, the script only prints the summary table and any errors that occur during generation. To see the full JSON output for each successful generation, use the `--verbose` flag.（轉為繁體中文）
（轉為繁體中文）
To keep the input and output for each run in separate files, specify the `--keep=<output_dir>` flag, which will create a directory hierarchy with the input and output for each LLM call in separate files.（轉為繁體中文）
（轉為繁體中文）
### Example（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run evalAll -- --verbose（轉為繁體中文）
```（轉為繁體中文）
（轉為繁體中文）
```bash（轉為繁體中文）
pnpm run evalAll -- --keep=output（轉為繁體中文）
```（轉為繁體中文）
