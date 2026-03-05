/**
 * Timing segment configuration
 */
export interface TimingSegment {
  start: number;
  duration: number;
}

/**
 * Create a timing segment
 * @param start - Start frame
 * @param duration - Duration in frames
 * @returns Timing segment object
 */
export function createSegment(start: number, duration: number): TimingSegment {
  return { start, duration };
}

/**
 * Get the end frame of a segment
 * @param segment - Timing segment
 * @returns End frame
 */
export function getSegmentEnd(segment: TimingSegment): number {
  return segment.start + segment.duration;
}

/**
 * Check if a frame is within a segment
 * @param frame - Current frame
 * @param segment - Timing segment
 * @returns True if frame is within segment
 */
export function isInSegment(frame: number, segment: TimingSegment): boolean {
  return frame >= segment.start && frame < getSegmentEnd(segment);
}

/**
 * Calculate local frame within a segment
 * @param frame - Current frame
 * @param segment - Timing segment
 * @returns Local frame (0-based) or -1 if outside segment
 */
export function getLocalFrame(frame: number, segment: TimingSegment): number {
  if (!isInSegment(frame, segment)) return -1;
  return frame - segment.start;
}

/**
 * Create sequential timing segments
 * @param durations - Array of durations for each segment
 * @param startFrame - Starting frame (default: 0)
 * @returns Array of timing segments
 */
export function createSequentialSegments(
  durations: number[],
  startFrame: number = 0,
): TimingSegment[] {
  const segments: TimingSegment[] = [];
  let currentStart = startFrame;

  for (const duration of durations) {
    segments.push(createSegment(currentStart, duration));
    currentStart += duration;
  }

  return segments;
}

/**
 * Stagger animation timing
 * @param index - Item index
 * @param staggerDelay - Delay between items (in frames)
 * @param startFrame - Starting frame (default: 0)
 * @returns Start frame for the item
 */
export function stagger(
  index: number,
  staggerDelay: number,
  startFrame: number = 0,
): number {
  return startFrame + index * staggerDelay;
}
