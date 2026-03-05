# Remotion App Template

This is a minimal Remotion project template.

## How to use

1. Generate a new project using the workspace CLI:
   - From monorepo root: `pnpm tsx scripts/create-project.ts`
   - Follow the prompts (project name, resolution, FPS, duration)

2. Start developing:
   - `pnpm -F @studio/<your-project> run dev` to open Remotion Studio
   - `pnpm -F @studio/<your-project> run preview` for preview server
   - `pnpm -F @studio/<your-project> run build` to render the default composition

3. Assets (images / audio / video)
   - Each app exposes `public/` as static root. Create subfolders for assets as needed:

   ```bash
   mkdir -p public/assets/{images,audio,video}
   ```

   - Examples to reference in code:
     - Image: `/assets/images/logo.png`
     - Audio: `/assets/audio/bgm.mp3`
     - Video: `/assets/video/clip.mp4`

   - Lyrics (LRC) placement (recommended):
     - Put `.lrc` next to the audio file with the same basename.
     - Example: `/assets/audio/song.mp3` ↔ `/assets/audio/song.lrc`
     - Fetch example:
       ```ts
       const text = await fetch("/assets/audio/song.lrc").then((r) => r.text());
       ```

   - To reuse shared design assets, link/copy from the monorepo package `@design/assets/assets`:
     - Symlink: `pnpm -C ../../ sync:assets`
     - Copy: `pnpm -C ../../ sync:assets --mode copy`

## Optional: Use React Three Fiber (R3F)

This template renders 3D using plain `three` by default (no R3F required).

If you prefer R3F + Remotion Three, add these to this app:

```bash
pnpm add @react-three/fiber @react-three/drei @remotion/three --filter @studio/3d-template
```

Then you can create R3F components and mount them alongside or instead of the plain `three` scene. For headless stability, keep Remotion’s frame‑driven updates (avoid requestAnimationFrame in render pipelines).

## Optional: PodcastSlides3D composite

The `PodcastSlides3D` composite references an optional external app alias `@app/remotion3`. It is disabled by default to avoid resolution errors.

To enable it:

1. Provide the alias in your workspace (e.g. map `@app/remotion3` to another app’s `src/`). In `remotion.config.ts`, the alias is added automatically if `../remotion3/src` exists.

2. Re‑add the composition to `src/Root.tsx`:

```tsx
// import {PodcastSlides3D} from './composites/PodcastSlides3D';
// <Composition id="PodcastSlides3D" component={PodcastSlides3D} ... />
```

3. If you need GPU/WebGL flags for stability, see `remotion.config.ts` and pass Chromium flags via CLI as needed.

## Customization

- The default composition lives in `src/Root.tsx` with placeholders for width/height/FPS/duration
- Update dependencies in `package.json` as needed
- Add public assets under `public/`
