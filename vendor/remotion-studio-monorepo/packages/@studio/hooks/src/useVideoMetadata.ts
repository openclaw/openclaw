import { useCurrentFrame, useVideoConfig } from "remotion";

export interface VideoMetadata {
  currentFrame: number;
  currentTime: number;
  totalFrames: number;
  totalDuration: number;
  fps: number;
  width: number;
  height: number;
  progress: number;
}

/**
 * Get comprehensive video metadata
 * @returns Video metadata object
 */
export function useVideoMetadata(): VideoMetadata {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  return {
    currentFrame: frame,
    currentTime: frame / config.fps,
    totalFrames: config.durationInFrames,
    totalDuration: config.durationInFrames / config.fps,
    fps: config.fps,
    width: config.width,
    height: config.height,
    progress: Math.min(frame / config.durationInFrames, 1),
  };
}

/**
 * Check if video is in the first/last N frames
 */
export function useVideoEdges(edgeFrames: number = 10) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  return {
    isStart: frame < edgeFrames,
    isEnd: frame >= durationInFrames - edgeFrames,
  };
}
