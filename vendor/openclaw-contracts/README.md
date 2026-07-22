# @openclaw/contracts

Public process-boundary contracts for OpenClaw Platform v1.

## Source of truth

JSON Schema Draft 2020-12 files under `schemas/` are authoritative. Generated
TypeScript declarations and OpenAPI output are committed under `generated/`.
Internal ports and adapters do not belong in this package.

## Commands

```powershell
corepack pnpm build
corepack pnpm test
corepack pnpm check
corepack pnpm check:compatibility -- --base <previous-schemas-directory>
corepack pnpm pack:local
```

`check` fails when generated artifacts drift from the schemas.
It also verifies the exact `pnpm pack` file manifest. `pack:local` regenerates
the derived files and creates `.artifacts/openclaw-contracts-<version>.tgz`.
The ignored `.artifacts/` directory is reproducible output and is never
published by this workflow.

## Compatibility checks

`check:compatibility` compares the current `schemas/` tree with a previous
released schema tree. It rejects removed public schemas and changes that can
reduce the accepted JSON instance set for the repository's supported JSON
Schema Draft 2020-12 subset:

- `type`, `enum`, `const`, `pattern`, `format`, string and numeric bounds;
- array bounds, `uniqueItems`, and `items`;
- object properties, `required`, `additionalProperties`, and
  `unevaluatedProperties`;
- `$defs`, local `$ref`, `oneOf`, `allOf`, and `x-openclaw-uniqueBy`.

The checker deliberately fails closed when it encounters an unsupported schema
keyword, non-local `$ref`, non-boolean object-closure schema, malformed
supported keyword, unresolved reference, or another JSON Schema dialect.
Annotations (`title`, `description`, `default`, and `examples`) do not affect
compatibility.

The analysis is conservative rather than a general JSON Schema implication
solver. Pattern, format, type, `$ref`, custom uniqueness, and `oneOf` changes
are treated as breaking when equivalence cannot be proved. The supported
composition subset is the indexed `oneOf`/`allOf` shape used by the current v1
schemas; keywords such as `anyOf`, `not`, conditionals, `contains`,
`prefixItems`, `patternProperties`, and dynamic or remote references are
unsupported and stop the check.

## Local consumption

Set a new semantic version in `package.json`, run `corepack pnpm check`, then
create the versioned artifact:

```powershell
corepack pnpm pack:local
Get-FileHash .artifacts\openclaw-contracts-<version>.tgz -Algorithm SHA256
```

Copy the exact artifact bytes into each consumer repository (for example,
`vendor/packages/openclaw-contracts-<version>.tgz`) and pin the dependency with
a repository-relative URL:

```json
"@openclaw/contracts": "file:vendor/packages/openclaw-contracts-<version>.tgz"
```

Consumers must commit the artifact, its lockfile integrity entry, and a
pre-build SHA-256 verification step. They must not depend on this sibling
checkout, a workspace link, a symlink, or an absolute path. Approved artifact
hashes are recorded under `docs/artifacts/`.

Runtime validators, generated declarations, all source schemas, and generated
OpenAPI are available through package exports:

```js
import { validate, validators } from "@openclaw/contracts";
import openapi from "@openclaw/contracts/openapi" with { type: "json" };
import createProjectSchema from "@openclaw/contracts/schemas/v1/projects/create-project-request.schema.json" with { type: "json" };
```

This repository intentionally has no external publish command. JSON Schema
under `schemas/` remains authoritative; declarations and OpenAPI must only be
changed through `pnpm build`.

## v1 rules

- HTTP/JSON with Command → Event → Query semantics.
- Immutable commands, events, and response snapshots.
- UUIDv7 identifiers with entity prefixes.
- UTC RFC 3339 timestamps.
- `additionalProperties: false` or `unevaluatedProperties: false` at public
  object boundaries.
- No paths, credentials, tokens, stack traces, or infrastructure details.
