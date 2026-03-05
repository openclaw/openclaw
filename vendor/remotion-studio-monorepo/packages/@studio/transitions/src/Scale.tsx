import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { TransitionProps } from "./types";

export interface ScaleProps extends TransitionProps {
  /** Initial scale (for ScaleIn) or final scale (for ScaleOut) */
  scale?: number;
  /** Transform origin (e.g., 'center', 'top left') */
  origin?: string;
}

/**
 * Scale In transition component
 */
export const ScaleIn: React.FC<ScaleProps> = ({
  children,
  startFrame,
  duration,
  scale = 0,
  origin = "center",
}) => {
  const frame = useCurrentFrame();

  const currentScale = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [scale, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <div
      style={{
        transform: `scale(${currentScale})`,
        transformOrigin: origin,
      }}
    >
      {children}
    </div>
  );
};

/**
 * Scale Out transition component
 */
export const ScaleOut: React.FC<ScaleProps> = ({
  children,
  startFrame,
  duration,
  scale = 0,
  origin = "center",
}) => {
  const frame = useCurrentFrame();

  const currentScale = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [1, scale],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  return (
    <div
      style={{
        transform: `scale(${currentScale})`,
        transformOrigin: origin,
      }}
    >
      {children}
    </div>
  );
};

/**
 * Generic Scale transition (in or out)
 */
export const Scale: React.FC<ScaleProps & { type?: "in" | "out" }> = ({
  children,
  startFrame,
  duration,
  scale = 0,
  origin = "center",
  type = "in",
}) => {
  if (type === "out") {
    return (
      <ScaleOut
        startFrame={startFrame}
        duration={duration}
        scale={scale}
        origin={origin}
      >
        {children}
      </ScaleOut>
    );
  }

  return (
    <ScaleIn
      startFrame={startFrame}
      duration={duration}
      scale={scale}
      origin={origin}
    >
      {children}
    </ScaleIn>
  );
};
