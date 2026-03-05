/**
 * Common frame rate constants
 */
export const FPS = {
  CINEMA: 24,
  PAL: 25,
  NTSC: 29.97,
  WEB: 30,
  HIGH: 60,
  ULTRA: 120,
} as const;

/**
 * Common duration constants (in seconds)
 */
export const DURATION = {
  SHORT: 5,
  MEDIUM: 15,
  LONG: 30,
  MINUTE: 60,
} as const;
