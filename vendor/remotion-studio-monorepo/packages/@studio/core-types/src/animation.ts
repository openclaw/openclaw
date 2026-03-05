/**
 * Easing function type
 */
export type EasingFunction = (t: number) => number;

/**
 * Animation configuration
 */
export interface AnimationConfig {
  duration: number;
  delay?: number;
  easing?: EasingFunction | string;
}

/**
 * Spring animation configuration
 */
export interface SpringConfig {
  fps: number;
  frame: number;
  config?: {
    mass?: number;
    damping?: number;
    stiffness?: number;
    overshootClamping?: boolean;
  };
}

/**
 * Transition types
 */
export type TransitionType =
  | "fade"
  | "slide"
  | "zoom"
  | "wipe"
  | "dissolve"
  | "none";

/**
 * Transition configuration
 */
export interface TransitionConfig {
  type: TransitionType;
  duration: number;
  easing?: EasingFunction | string;
}

/**
 * Animation direction
 */
export type AnimationDirection =
  | "normal"
  | "reverse"
  | "alternate"
  | "alternate-reverse";

/**
 * Animation state
 */
export type AnimationState = "idle" | "running" | "paused" | "finished";
