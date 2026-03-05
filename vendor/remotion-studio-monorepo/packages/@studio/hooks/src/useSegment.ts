import { useCurrentFrame } from "remotion";

export interface SegmentConfig {
  start: number;
  duration: number;
}

export interface SegmentState {
  isActive: boolean;
  localFrame: number;
  progress: number;
}

/**
 * Track state within a timing segment
 * @param segment - Segment configuration
 * @returns Segment state
 */
export function useSegment(segment: SegmentConfig): SegmentState {
  const frame = useCurrentFrame();
  const endFrame = segment.start + segment.duration;

  const isActive = frame >= segment.start && frame < endFrame;
  const localFrame = isActive ? frame - segment.start : -1;
  const progress = isActive ? localFrame / segment.duration : 0;

  return {
    isActive,
    localFrame,
    progress,
  };
}

/**
 * Check if current frame is within multiple segments
 * @param segments - Array of segment configurations
 * @returns Index of active segment or -1 if none
 */
export function useActiveSegment(segments: SegmentConfig[]): number {
  const frame = useCurrentFrame();

  return segments.findIndex(
    (segment) =>
      frame >= segment.start && frame < segment.start + segment.duration,
  );
}
