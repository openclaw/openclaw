# Upgrading Remotion Dependencies

All apps and templates in this repository rely on the same `remotion` / `@remotion/*` version set. Keeping them aligned avoids mysterious runtime or rendering issues.

## One command

```bash
pnpm upgrade:remotion
```

This script:

1. Resolves the latest published `remotion` version (or a version you pass in).
2. Updates the `pnpm-workspace.yaml` `catalog` entries for `remotion` and `@remotion/*`.
3. Ensures workspace `package.json` files reference those dependencies via `catalog:` (when applicable).
4. Runs `pnpm install` to refresh `pnpm-lock.yaml`.

## Options

| Flag                                   | Description                                              |
| -------------------------------------- | -------------------------------------------------------- |
| `pnpm upgrade:remotion --dry-run`      | Show which packages would change without touching files. |
| `pnpm upgrade:remotion 4.0.373`        | Force a specific version.                                |
| `pnpm upgrade:remotion --tag canary`   | Resolve a dist-tag (e.g., `beta`, `canary`).             |
| `pnpm upgrade:remotion --skip-install` | Skip the final `pnpm install` (lockfile update).         |

## Skill-first checklist

When upgrading, apply `$remotion-best-practices` and confirm:

- Composition IDs match build scripts
- Asset references consistently use `staticFile()`
- duration / fps / width / height are aligned
- Transition overlap is accounted for in `durationInFrames`

## After upgrading

- Commit `package.json` changes + `pnpm-lock.yaml`.
- Verify version alignment with `pnpm remotion versions`.
- Run `pnpm lint` / `pnpm typecheck` / `pnpm test`.
- Re-run `pnpm create:project` when building new apps — the scaffolder now syncs Remotion versions from the repo root automatically, so every fresh app matches the upgraded toolchain.

If you maintain downstream repositories that were scaffolded from this template, re-run the same script there to stay up to date.
