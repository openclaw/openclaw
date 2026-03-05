# @studio/hooks

Shared React hooks for Remotion projects.

## Installation

```bash
pnpm add @studio/hooks
```

## Usage

### Frame Progress

```typescript
import {
  useFrameProgress,
  useTimeProgress,
  useVideoProgress,
} from "@studio/hooks";

// Get progress between specific frames
const progress = useFrameProgress(0, 100); // 0-1

// Get progress based on time
const timeProgress = useTimeProgress(2, 5); // from 2s to 7s

// Get overall video progress
const videoProgress = useVideoProgress(); // 0-1
```

### Segments

```typescript
import { useSegment, useActiveSegment } from "@studio/hooks";

// Track state within a segment
const { isActive, localFrame, progress } = useSegment({
  start: 30,
  duration: 60,
});

// Find active segment from multiple
const segments = [
  { start: 0, duration: 60 },
  { start: 60, duration: 120 },
];
const activeIndex = useActiveSegment(segments);
```

### Delayed Mount

```typescript
import { useDelayedMount, useFrameRange } from "@studio/hooks";

// Show content after frame 30
const shouldShow = useDelayedMount(30);

// Show content between frames 30-90
const isVisible = useFrameRange(30, 90);
```

### Video Metadata

```typescript
import { useVideoMetadata, useVideoEdges } from "@studio/hooks";

// Get all video metadata
const { currentFrame, currentTime, totalFrames, fps, width, height, progress } =
  useVideoMetadata();

// Check if at start/end of video
const { isStart, isEnd } = useVideoEdges(10); // within 10 frames of edges
```

## API

### useFrameProgress

- `useFrameProgress(startFrame, endFrame)`: Progress (0-1) within frame range
- `useTimeProgress(startSeconds, durationSeconds)`: Progress based on time
- `useVideoProgress()`: Overall video progress

### useSegment

- `useSegment(segment)`: Track state within a timing segment
- `useActiveSegment(segments)`: Find active segment index

### useDelayedMount

- `useDelayedMount(startFrame)`: Delay content until frame
- `useFrameRange(startFrame, endFrame)`: Show content within range
- `useDelayedMountByTime(startSeconds, fps)`: Delay based on time

### useVideoMetadata

- `useVideoMetadata()`: Get comprehensive video metadata
- `useVideoEdges(edgeFrames)`: Check if at start/end of video
