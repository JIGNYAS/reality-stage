import {
  FilesetResolver,
  HandLandmarker,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

export type HandSnapshot = {
  tracking: boolean;
  x: number;
  y: number;
  z: number;
  pinchDistance: number;
  pinching: boolean;
  velocity: {
    x: number;
    y: number;
    z: number;
  };
};

type HandTrackerOptions = {
  video: HTMLVideoElement;
  onFrame: (snapshot: HandSnapshot) => void;
  onError: (message: string) => void;
};

const idleSnapshot: HandSnapshot = {
  tracking: false,
  x: 0,
  y: 0,
  z: 0,
  pinchDistance: 1,
  pinching: false,
  velocity: { x: 0, y: 0, z: 0 },
};

export async function createHandTracker({
  video,
  onFrame,
  onError,
}: HandTrackerOptions) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user",
    },
    audio: false,
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/models/hand_landmarker.task",
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    numHands: 1,
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
  const x = (0.5 - index.x) * 2;
  const y = (0.5 - index.y) * 2;
  const z = Math.max(-1, Math.min(1, (0.22 - wrist.z) * 2.2));
  const dt = Math.max(0.016, elapsedMs / 1000);

  return {
    tracking: true,
    x,
    y,
    z,
    pinchDistance,
    pinching: pinchDistance < 0.075,
    velocity: {
      x: (x - previous.x) / dt,
      y: (y - previous.y) / dt,
      z: (z - previous.z) / dt,
    },
  };
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
