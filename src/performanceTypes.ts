export type CameraFacingMode = "user" | "environment";

export type QualityMode = "battery" | "balanced" | "cinema";

export type GestureMode =
  | "waiting"
  | "tracking"
  | "pinch"
  | "grab"
  | "open-palm"
  | "closed-hand"
  | "swipe"
  | "two-hand"
  | "touch";

export type TouchMode = "spawn" | "repel" | "freeze" | "shockwave";

export type PerformanceScene = {
  title: "Ignition" | "Gravity Well" | "Portal Bloom" | "Zero-G Finale";
  kicker: string;
  detail: string;
};

export type AudioSnapshot = {
  enabled: boolean;
  level: number;
  bass: number;
  voice: number;
  peak: number;
};

export type TouchControl = {
  active: boolean;
  x: number;
  y: number;
  mode: TouchMode;
  intensity: number;
};

export const idleAudio: AudioSnapshot = {
  enabled: false,
  level: 0,
  bass: 0,
  voice: 0,
  peak: 0,
};

export const idleTouch: TouchControl = {
  active: false,
  x: 0,
  y: 0,
  mode: "spawn",
  intensity: 0,
};
