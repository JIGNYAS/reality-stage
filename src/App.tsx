import { useEffect, useMemo, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import Lenis from "lenis";
import {
  Activity,
  Camera,
  CircleDot,
  Cpu,
  Hand,
  Layers3,
  Sparkles,
  Waves,
} from "lucide-react";
import { createHandTracker, type HandSnapshot } from "./handTracker";
import { RealityStageEngine, type EngineStats } from "./stageEngine";
import { ReactiveRiveGlyph } from "./ReactiveRiveGlyph";

type CameraState = "idle" | "requesting" | "tracking" | "denied" | "error";

const chapters = [
  {
    title: "Dock",
    kicker: "gesture ignition",
    detail: "Pinch to mint light-matter. Release to throw it through the stage.",
  },
  {
    title: "Orbit",
    kicker: "camera drift",
    detail: "Scroll pushes the rig into a wider orbital camera path.",
  },
  {
    title: "Reactor",
    kicker: "physics pressure",
    detail: "Theatre values bend the camera while Rapier keeps objects honest.",
  },
  {
    title: "Portal",
    kicker: "hydra surface",
    detail: "Hydra feeds a live texture into the back wall of the room.",
  },
];

const initialHand: HandSnapshot = {
  tracking: false,
  x: 0,
  y: 0,
  z: 0,
  pinchDistance: 1,
  pinching: false,
  velocity: { x: 0, y: 0, z: 0 },
};

function App() {
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hydraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<RealityStageEngine | null>(null);
  const trackerCleanupRef = useRef<(() => void) | null>(null);
  const [statusListRef] = useAutoAnimate<HTMLDivElement>();
  const [chapterListRef] = useAutoAnimate<HTMLDivElement>();
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [engineReady, setEngineReady] = useState(false);
  const [hand, setHand] = useState<HandSnapshot>(initialHand);
  const [stats, setStats] = useState<EngineStats>({
    bodies: 0,
    grabbed: false,
    hydraReady: false,
    theatreReady: false,
  });
  const [chapterIndex, setChapterIndex] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const chapter = chapters[chapterIndex] ?? chapters[0];
  const gestureLabel = hand.tracking
    ? hand.pinching
      ? stats.grabbed
        ? "grabbing"
        : "pinching"
      : "tracking"
    : "waiting";

  const statusItems = useMemo(
    () => [
      {
        icon: Camera,
        label: "camera",
        value: cameraState,
        active: cameraState === "tracking",
      },
      {
        icon: Hand,
        label: "gesture",
        value: gestureLabel,
        active: hand.tracking,
      },
      {
        icon: Cpu,
        label: "physics",
        value: `${stats.bodies} bodies`,
        active: stats.bodies > 0,
      },
      {
        icon: Waves,
        label: "hydra",
        value: stats.hydraReady ? "live" : "booting",
        active: stats.hydraReady,
      },
      {
        icon: CircleDot,
        label: "theatre",
        value: stats.theatreReady ? "rigged" : "standby",
        active: stats.theatreReady,
      },
    ],
    [cameraState, gestureLabel, hand.tracking, stats],
  );

  useEffect(() => {
    const lenis = new Lenis({
      smoothWheel: true,
      lerp: 0.08,
      wheelMultiplier: 0.9,
    });

    let frame = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };

    lenis.on("scroll", ({ progress }: { progress: number }) => {
      const clamped = Math.max(0, Math.min(1, progress));
      const nextChapter = Math.min(
        chapters.length - 1,
        Math.floor(clamped * chapters.length),
      );
      setScrollProgress(clamped);
      setChapterIndex(nextChapter);
      engineRef.current?.setChapter(clamped, nextChapter);
    });

    frame = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, []);

  useEffect(() => {
    const canvas = stageCanvasRef.current;
    const hydraCanvas = hydraCanvasRef.current;

    if (!canvas || !hydraCanvas) {
      return;
    }

    const engine = new RealityStageEngine({
      canvas,
      hydraCanvas,
      onReady: () => setEngineReady(true),
      onStats: setStats,
      onError: (message) => setError(message),
    });

    engineRef.current = engine;
    void engine.init();

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setHand(hand);
  }, [hand]);

  const enableCamera = async () => {
    if (!videoRef.current) {
      return;
    }

    setCameraState("requesting");
    setError(null);

    try {
      const cleanup = await createHandTracker({
        video: videoRef.current,
        onFrame: (snapshot) => {
          setHand(snapshot);
          setCameraState("tracking");
        },
        onError: (message) => {
          setError(message);
          setCameraState("error");
        },
      });

      trackerCleanupRef.current?.();
      trackerCleanupRef.current = cleanup;
    } catch (cause) {
      const message =
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Camera permission was denied."
          : cause instanceof Error
            ? cause.message
            : "Camera tracking could not start.";
      setError(message);
      setCameraState(message.includes("denied") ? "denied" : "error");
    }
  };

  useEffect(
    () => () => {
      trackerCleanupRef.current?.();
    },
    [],
  );

  return (
    <main className="experience">
      <canvas
        ref={hydraCanvasRef}
        className="hydra-source"
        width={1024}
        height={1024}
        aria-hidden="true"
      />
      <canvas ref={stageCanvasRef} className="stage-canvas" />
      <video ref={videoRef} className="camera-feed" playsInline muted />

      <section className="hud top-left">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <p>Reality Stage</p>
            <span>{chapter.kicker}</span>
          </div>
        </div>
        <ReactiveRiveGlyph gesture={gestureLabel} chapter={chapterIndex} />
      </section>

      <section className="hud top-right" ref={statusListRef}>
        {statusItems.map((item) => {
          const Icon = item.icon;
          return (
            <div
              className={`status-pill ${item.active ? "is-active" : ""}`}
              key={item.label}
            >
              <Icon size={15} />
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          );
        })}
        {error && (
          <div className="status-pill is-error">
            <Activity size={15} />
            <span>system</span>
            <strong>{error}</strong>
          </div>
        )}
      </section>

      <section className="hud bottom-left">
        <button
          className="camera-button"
          type="button"
          onClick={enableCamera}
          disabled={cameraState === "requesting"}
        >
          <Camera size={18} />
          <span>
            {cameraState === "idle"
              ? "Enable camera"
              : cameraState === "requesting"
                ? "Requesting"
                : "Recalibrate"}
          </span>
        </button>
        <div className="gesture-readout">
          <div>
            <span>x</span>
            <strong>{hand.x.toFixed(2)}</strong>
          </div>
          <div>
            <span>y</span>
            <strong>{hand.y.toFixed(2)}</strong>
          </div>
          <div>
            <span>pinch</span>
            <strong>{Math.max(0, 1 - hand.pinchDistance * 10).toFixed(2)}</strong>
          </div>
        </div>
      </section>

      <section className="chapter-panel" ref={chapterListRef}>
        <div className="chapter-index">
          <Layers3 size={16} />
          <span>
            {(chapterIndex + 1).toString().padStart(2, "0")} /{" "}
            {chapters.length.toString().padStart(2, "0")}
          </span>
        </div>
        <h1>{chapter.title}</h1>
        <p>{chapter.detail}</p>
        <div className="progress-track">
          <span style={{ transform: `scaleX(${scrollProgress})` }} />
        </div>
        <p className="hint">
          {engineReady
            ? "Scroll to move the camera. Pinch in view to spawn, grab, and throw."
            : "Booting the stage engine."}
        </p>
      </section>

      <div className="scroll-rail" aria-hidden="true">
        {chapters.map((item) => (
          <section key={item.title} />
        ))}
      </div>
    </main>
  );
}

export default App;
