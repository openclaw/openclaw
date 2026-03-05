import { useCurrentFrame } from "remotion";

/**
 * Delay mounting of a component until a specific frame
 * @param startFrame - Frame to start showing content
 * @returns True if content should be shown
 */
export function useDelayedMount(startFrame: number): boolean {
  const frame = useCurrentFrame();
  return frame >= startFrame;
}

/**
 * Show content only within a frame range
 * @param startFrame - Start frame
 * @param endFrame - End frame
 * @returns True if content should be shown
 */
export function useFrameRange(startFrame: number, endFrame: number): boolean {
  const frame = useCurrentFrame();
  return frame >= startFrame && frame < endFrame;
}

/**
 * Delay mounting based on time in seconds
 * @param startSeconds - Time in seconds to start showing content
 * @param fps - Frames per second
 * @returns True if content should be shown
 */
export function useDelayedMountByTime(
  startSeconds: number,
  fps: number,
): boolean {
  const frame = useCurrentFrame();
  return frame >= startSeconds * fps;
}
