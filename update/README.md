Failover utilities

This folder contains two small Node.js utilities that help with model failover when the configured provider/model becomes unavailable:

- `update/session-failover.js` — per-session failover. Probes a list of candidate provider/model pairs and writes a per-session override into a sessions store (JSON file). It mirrors the minimal behavior of OpenClaw's `applyModelOverrideToSessionEntry`.
- `update/default-model-failover.js` — default/global failover. Probes candidates and, on success, updates `agents.defaults.model.primary` in the global OpenClaw config file (by default `%USERPROFILE%/.openclaw/openclaw.json`) while preserving other keys (e.g. `fallbacks`). A backup of the config is created before modification.

Why two scripts?

- Session failover targets a single session entry in a sessions store (e.g. `sessions.json`) and is useful when a specific channel/agent needs a working model quickly.
- Default failover changes the application-wide default model used when sessions do not have overrides.

Quick examples

Session failover (updates the session store):

```bash
node update/session-failover.js \
	--sessionKey agent:main:default \
	--models openai/gpt-4o,anthropic/claude-opus-4-6 \
	--store ./path/to/sessions.json \
	--timeout 5000
```

Default failover (updates global config, backups created):

```bash
node update/default-model-failover.js \
	--models openai/gpt-4o,anthropic/claude-opus-4-6 \
	--config "%USERPROFILE%/.openclaw/openclaw.json" \
	--timeout 5000
```

Behavior and safety

- Both scripts probe candidate models in the order provided and apply the first model that responds within the provided timeout (milliseconds). If none respond, `session-failover` resets session overrides to default; `default-model-failover` leaves the config unchanged and writes a backup before modifying the file if the target config already exists.
- `default-model-failover.js` creates a timestamped backup of the existing target config (same directory by default, or use `--backup-dir` to override); if the config file does not yet exist, no backup file is created.

Probing caveats and environment variables

- The `probeModel` implementation is intentionally lightweight and currently performs provider-specific HTTP checks for known providers (OpenAI, Anthropic) and simple heuristics for others:
  - For `openai`, the script attempts a GET to `https://api.openai.com/v1/models/<model>` using `OPENAI_API_KEY`.
  - For `anthropic`, it attempts `https://api.anthropic.com/v1/models/<model>` using `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_0`.
  - For CLI-style backends (provider ids ending with `-cli`), it assumes availability.
  - For other providers it falls back to checking for an environment variable named `<PROVIDER>_API_KEY` (provider uppercased, non-alphanumeric replaced with `_`).

Important: some providers use non-standard env var names in your environment (for example you may have `GEMINI_API_KEY` or `NVIDIA_API_KEY`). If the script expects `GOOGLE_API_KEY` or `MOONSHOTAI_API_KEY` it will not detect the key unless you export the expected name as well. You can either:

```powershell
$env:GOOGLE_API_KEY = $env:GEMINI_API_KEY
$env:MOONSHOTAI_API_KEY = $env:NVIDIA_API_KEY
node update/default-model-failover.js --models google/gemini-2.5-flash,moonshotai/kimi-k2.5
```

or extend `probeModel` in the scripts to check additional environment variable names or perform provider-specific health checks.

Customization

- You can extend `probeModel` with provider-specific endpoints and richer checks (model-listing, small completion / ping endpoints) for higher confidence before switching.
- Run the default failover as a periodic job (cron / Task Scheduler) or invoke it from a monitoring script when you detect repeated failures.

Safety checklist before running

- Ensure you have backups of `%USERPROFILE%/.openclaw/openclaw.json` and your session store files.
- Stop any running OpenClaw processes before running these scripts to avoid clobbering concurrent writes to config or session store files.
- Export any provider API keys the script expects, or modify `probeModel` to accept your existing env var names.
- Test with a short candidate list and a small timeout to verify behavior before automating.
