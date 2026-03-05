import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { SlideProps } from "./types";

/**
 * Slide In transition component
 */
export const SlideIn: React.FC<SlideProps> = ({
  children,
  startFrame,
  duration,
  direction = "right",
  distance = 100,
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const getTransform = () => {
    const offset = (1 - progress) * distance;

    switch (direction) {
      case "left":
        return `translateX(${offset}%)`;
      case "right":
        return `translateX(-${offset}%)`;
      case "up":
        return `translateY(${offset}%)`;
      case "down":
        return `translateY(-${offset}%)`;
      default:
        return "none";
    }
  };

  return <div style={{ transform: getTransform() }}>{children}</div>;
};

/**
 * Slide Out transition component
 */
export const SlideOut: React.FC<SlideProps> = ({
  children,
  startFrame,
  duration,
  direction = "left",
  distance = 100,
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(
    frame,
    [startFrame, startFrame + duration],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    },
  );

  const getTransform = () => {
    const offset = progress * distance;

    switch (direction) {
      case "left":
        return `translateX(-${offset}%)`;
      case "right":
        return `translateX(${offset}%)`;
      case "up":
        return `translateY(-${offset}%)`;
      case "down":
        return `translateY(${offset}%)`;
      default:
        return "none";
    }
  };

  return <div style={{ transform: getTransform() }}>{children}</div>;
};

/**
 * Generic Slide transition (in or out)
 */
export const Slide: React.FC<SlideProps & { type?: "in" | "out" }> = ({
  children,
  startFrame,
  duration,
  direction = "right",
  distance = 100,
  type = "in",
}) => {
  if (type === "out") {
    return (
      <SlideOut
        startFrame={startFrame}
        duration={duration}
        direction={direction}
        distance={distance}
      >
        {children}
      </SlideOut>
    );
  }

  return (
    <SlideIn
      startFrame={startFrame}
      duration={duration}
      direction={direction}
      distance={distance}
    >
      {children}
    </SlideIn>
  );
};
