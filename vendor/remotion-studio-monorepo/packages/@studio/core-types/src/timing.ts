/**
 * Timing segment
 */
export interface TimingSegment {
  start: number;
  duration: number;
  label?: string;
}

/**
 * Timeline configuration
 */
export interface TimelineConfig {
  segments: TimingSegment[];
  totalDuration: number;
}

/**
 * Frame range
 */
export interface FrameRange {
  from: number;
  to: number;
}

/**
 * Time range (in seconds)
 */
export interface TimeRange {
  from: number;
  to: number;
}
