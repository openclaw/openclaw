import { useCurrentFrame, useVideoConfig } from "remotion";

/**
 * Get animation progress (0-1) for current frame within a range
 * @param startFrame - Start frame of the animation
 * @param endFrame - End frame of the animation
 * @returns Progress value between 0 and 1
 */
export function useFrameProgress(startFrame: number, endFrame: number): number {
  const frame = useCurrentFrame();

  if (frame <= startFrame) return 0;
  if (frame >= endFrame) return 1;

  return (frame - startFrame) / (endFrame - startFrame);
}

/**
 * Get animation progress based on duration in seconds
 * @param startSeconds - Start time in seconds
 * @param durationSeconds - Duration in seconds
 * @returns Progress value between 0 and 1
 */
export function useTimeProgress(
  startSeconds: number,
  durationSeconds: number,
): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const startFrame = startSeconds * fps;
  const endFrame = startFrame + durationSeconds * fps;

  if (frame <= startFrame) return 0;
  if (frame >= endFrame) return 1;

  return (frame - startFrame) / (endFrame - startFrame);
}

/**
 * Get overall video progress (0-1)
 * @returns Progress value between 0 and 1
 */
export function useVideoProgress(): number {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  return Math.min(frame / durationInFrames, 1);
}
