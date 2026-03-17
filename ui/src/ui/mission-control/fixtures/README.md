# Mission Control Provenance-State Fixtures

These fixtures exercise provenance and fallback rendering states for Mission Control MVP.

## Fixtures

- `unavailable-provenance.json`
  - Synthetic provenance matrix including `unavailable` values.
- `malformed-seed-data.json`
  - Intentionally malformed structure to verify adapter failure behavior and `unavailable` surfacing.

## Expected UI checks

- Overview should show a warning callout when any provenance field is `unavailable`.
- Badge values must remain explicit (`live`, `mixed`, `seed-backed`, `unavailable`, `stale`).
- No silent escalation from inferred linkage to explicit linkage.
