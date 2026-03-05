# Remotion Skill Playbook

This document defines the **skill-first** workflow for Remotion tasks in this monorepo.  
The default skill is `$remotion-best-practices`.

## Core policy

- Start from skills and read only the rules needed for the current task.
- Keep changes minimal and preserve template + shared package consistency.
- Use this repository's implementation/docs as the primary source of truth.
- MCP is optional. The default workflow should work without it.

## Skill updates

- To update Remotion skills: `pnpm skills:remotion:update`

## Standard flow

1. Declare the applied skill at task start.  
   Example: `Using $remotion-best-practices`
2. Select relevant rules only.  
   Example: compositions / assets / calculate-metadata / transitions
3. Implement with explicit checks for:
   - Composition IDs
   - `staticFile()` usage
   - duration/fps/size consistency
4. Run local validation:
   - `pnpm remotion versions`
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
5. Include the applied skill/rule checklist in the PR.

## Rule mapping by task

- Composition design: `rules/compositions.md`
- Dynamic duration/dimensions: `rules/calculate-metadata.md`
- Asset handling: `rules/assets.md`, `rules/videos.md`, `rules/audio.md`
- Text motion: `rules/text-animations.md`, `rules/measuring-text.md`
- Scene transitions: `rules/transitions.md`, `rules/sequencing.md`
- 3D projects: `rules/3d.md`

## Minimum PR checks

- Skill + rule usage is documented
- `pnpm create:project` output remains valid
- Remotion versions are aligned through the catalog
- Template build commands still work
