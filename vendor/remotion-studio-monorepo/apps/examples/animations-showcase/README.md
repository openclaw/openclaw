# Animations Showcase

This sample app demonstrates the usage of @studio packages:

- `@studio/timing` - Timing utilities
- `@studio/hooks` - Custom React hooks for Remotion
- `@studio/easings` - Easing functions
- `@studio/transitions` - Transition components

## Features Demonstrated

1. **Title Scene** - Bounce easing with custom interpolation
2. **Fade Transition** - FadeIn component from @studio/transitions
3. **Slide Transition** - SlideIn component with direction control
4. **Scale Transition** - ScaleIn component with custom scale
5. **Wipe Transition** - Wipe component with directional reveal

## Running the App

```bash
cd apps/examples/animations-showcase
pnpm dev
```

## Rendering

```bash
pnpm render AnimationsShowcase out/showcase.mp4
```

## Package Usage Examples

### @studio/easings

```typescript
import { easeOutCubic, easeInOutBack, bounce } from "@studio/easings";

const y = interpolate(frame, [0, 30], [0, 100], {
  easing: bounce,
});
```

### @studio/transitions

```typescript
import { FadeIn, SlideIn, ScaleIn } from '@studio/transitions';

<FadeIn startFrame={0} duration={30}>
  <YourComponent />
</FadeIn>
```

### @studio/hooks

```typescript
import { useFrameProgress, useVideoMetadata } from "@studio/hooks";

const progress = useFrameProgress(0, 60);
const { fps, width, height } = useVideoMetadata();
```

### @studio/timing

```typescript
import { secondsToFrames, createSegment } from "@studio/timing";

const frames = secondsToFrames(2.5, 30); // 75 frames
const segment = createSegment(0, 60);
```
