# @studio/core-types

Shared TypeScript types for Remotion projects.

## Installation

```bash
pnpm add @studio/core-types
```

## Usage

```typescript
import type {
  CompositionMetadata,
  AnimationConfig,
  TimingSegment,
  Theme,
} from "@studio/core-types";

// Use in your components
const metadata: CompositionMetadata = {
  id: "MyComp",
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
};

const animation: AnimationConfig = {
  duration: 60,
  delay: 10,
  easing: "easeInOut",
};
```

## Type Categories

### Composition Types

- `CompositionMetadata`: Basic composition configuration
- `CompositionProps<T>`: Generic composition input props
- `TextCompositionProps`: Common text properties
- `MediaCompositionProps`: Common media properties

### Animation Types

- `EasingFunction`: Easing function type
- `AnimationConfig`: Animation configuration
- `SpringConfig`: Spring animation configuration
- `TransitionType`: Transition types (fade, slide, zoom, etc.)
- `TransitionConfig`: Transition configuration
- `AnimationDirection`: Animation direction
- `AnimationState`: Animation state (idle, running, paused, finished)

### Timing Types

- `TimingSegment`: Timing segment with start/duration
- `TimelineConfig`: Timeline configuration
- `FrameRange`: Frame range (from/to)
- `TimeRange`: Time range in seconds

### Theme Types

- `ColorPalette`: Color palette definition
- `Typography`: Typography configuration
- `Spacing`: Spacing scale
- `Theme`: Complete theme configuration
