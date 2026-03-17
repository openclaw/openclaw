# generated-config.ts Drift Controls

`ui/src/ui/mission-control/generated-config.ts` is a **derived runtime adapter** over `mission-control.config.json`.

## Source of truth

- Canonical: `mission-control.config.json`
- Derived wrapper: `generated-config.ts`

`generated-config.ts` must not contain independently maintained values.
It should only expose typed access to the canonical JSON and fallback-safe shape guards.

## Generation and drift control

Generation script:

- `node scripts/mission-control/generate-config-wrapper.mjs`

Validation step:

- `ui/src/ui/mission-control/generated-config.node.test.ts` fails if wrapper content drifts.

Update rule when `mission-control.config.json` changes:

1. Regenerate wrapper with the script above.
2. Do not hand-edit config values into UI constants.
3. Run tests/typecheck; drift test must pass.

This prevents configuration drift and avoids introducing a second source of truth.
