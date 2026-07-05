import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { CameraFacingMode, GestureMode } from "./performanceTypes";

export type HandSnapshot = {
  tracking: boolean;
  x: number;
  y: number;
  z: number;
  hands: number;
  gesture: GestureMode;
  pinchDistance: number;
  pinching: boolean;
  openPalm: boolean;
  closedHand: boolean;
  fastSwipe: boolean;
  twoHand: boolean;
  secondary?: {
    x: number;
    y: number;
    z: number;
  };
  velocity: {
    x: number;
    y: number;
    z: number;
  };
};

type HandTrackerOptions = {
  video: HTMLVideoElement;
  facingMode: CameraFacingMode;
  onFrame: (snapshot: HandSnapshot) => void;
  onError: (message: string) => void;
};

const idleSnapshot: HandSnapshot = {
  tracking: false,
  x: 0,
  y: 0,
  z: 0,
  hands: 0,
  gesture: "waiting",
  pinchDistance: 1,
  pinching: false,
  openPalm: false,
  closedHand: false,
  fastSwipe: false,
  twoHand: false,
  velocity: { x: 0, y: 0, z: 0 },
};

export async function createHandTracker({
  video,
  facingMode,
  onFrame,
  onError,
}: HandTrackerOptions) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: { ideal: facingMode },
    },
    audio: false,
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const baseUrl = import.meta.env.BASE_URL;
  const vision = await FilesetResolver.forVisionTasks(`${baseUrl}mediapipe/wasm`);
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `${baseUrl}models/hand_landmarker.task`,
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
  });

  let frame = 0;
  let lastVideoTime = -1;
  let lastSnapshot = idleSnapshot;
  let lastTimestamp = performance.now();
  let cancelled = false;

  const tick = () => {
    if (cancelled) {
      return;
    }

    try {
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const result = handLandmarker.detectForVideo(video, performance.now());
        const now = performance.now();
        const snapshot = toSnapshot(result, lastSnapshot, now - lastTimestamp);
        lastTimestamp = now;
        lastSnapshot = snapshot;
        onFrame(snapshot);
      }
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Hand tracking failed.");
    }

    frame = requestAnimationFrame(tick);
  };

  frame = requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
    handLandmarker.close();
    stream.getTracks().forEach((track) => track.stop());
    if (video.srcObject === stream) {
      video.srcObject = null;
    }
  };
}

function toSnapshot(
  result: HandLandmarkerResult,
  previous: HandSnapshot,
  elapsedMs: number,
): HandSnapshot {
  const landmarks = result.landmarks[0];
  const secondary = result.landmarks[1];

  if (!landmarks) {
    return {
      ...idleSnapshot,
      velocity: dampVelocity(previous.velocity),
    };
  }

  const index = landmarks[8];
  const thumb = landmarks[4];
  const wrist = landmarks[0];

  if (!index || !thumb || !wrist) {
    return idleSnapshot;
  }

  const pinchDistance = distance(index, thumb);
  const openness = palmOpenness(landmarks);
  const x = (0.5 - index.x) * 2;
  const y = (0.5 - index.y) * 2;
  const z = Math.max(-1, Math.min(1, (0.22 - wrist.z) * 2.2));
  const dt = Math.max(0.016, elapsedMs / 1000);
  const velocity = {
    x: (x - previous.x) / dt,
    y: (y - previous.y) / dt,
    z: (z - previous.z) / dt,
  };
  const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
  const pinching = pinchDistance < 0.075;
  const openPalm = !pinching && openness > 0.58;
  const closedHand = !pinching && openness < 0.38;
  const fastSwipe = speed > 7.5;
  const twoHand = Boolean(secondary);

  const snapshot: HandSnapshot = {
    tracking: true,
    x,
    y,
    z,
    hands: secondary ? 2 : 1,
    gesture: "tracking",
    pinchDistance,
    pinching,
    openPalm,
    closedHand,
    fastSwipe,
    twoHand,
    velocity,
  };

  if (secondary?.[8]) {
    snapshot.secondary = {
      x: (0.5 - secondary[8].x) * 2,
      y: (0.5 - secondary[8].y) * 2,
      z: Math.max(-1, Math.min(1, (0.22 - (secondary[0]?.z ?? 0)) * 2.2)),
    };
  }

  snapshot.gesture = twoHand
    ? "two-hand"
    : fastSwipe
      ? "swipe"
      : pinching
        ? "pinch"
        : openPalm
          ? "open-palm"
          : closedHand
            ? "closed-hand"
            : "tracking";

  return snapshot;
}

function distance(a: NormalizedLandmark, b: NormalizedLandmark) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

function dampVelocity(velocity: HandSnapshot["velocity"]) {
  return {
    x: velocity.x * 0.85,
    y: velocity.y * 0.85,
    z: velocity.z * 0.85,
  };
}

function palmOpenness(landmarks: NormalizedLandmark[]) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const tips = [landmarks[8], landmarks[12], landmarks[16], landmarks[20]];

  if (!wrist || !middleMcp || tips.some((tip) => !tip)) {
    return 0;
  }

  const palmSize = Math.max(0.001, distance(wrist, middleMcp));
  const averageTipDistance =
    tips.reduce((sum, tip) => sum + distance(wrist, tip), 0) / tips.length;

  return Math.max(0, Math.min(1, averageTipDistance / (palmSize * 3.2)));
}
