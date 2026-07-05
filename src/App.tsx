import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import Lenis from "lenis";
import {
  Activity,
  Camera,
  CameraIcon,
  CircleDot,
  Download,
  Gauge,
  Hand,
  Layers3,
  Mic,
  Orbit,
  Radio,
  Sparkles,
  Square,
  Video,
  Waves,
} from "lucide-react";
import { createHandTracker, type HandSnapshot } from "./handTracker";
import { RealityStageEngine, type EngineStats } from "./stageEngine";
import { ReactiveRiveGlyph } from "./ReactiveRiveGlyph";
import {
  idleAudio,
  idleTouch,
  type AudioSnapshot,
  type CameraFacingMode,
  type GestureMode,
  type PerformanceScene,
  type QualityMode,
  type TouchControl,
  type TouchMode,
} from "./performanceTypes";

type CameraState = "idle" | "requesting" | "tracking" | "denied" | "error";
type MicState = "idle" | "requesting" | "live" | "denied" | "error";
type RecordingState = "idle" | "recording" | "ready" | "error";

const scenes: PerformanceScene[] = [
  {
    title: "Ignition",
    kicker: "gesture wake",
    detail: "Pinch to catch light, then throw it into the stage.",
  },
  {
    title: "Gravity Well",
    kicker: "mass control",
    detail: "Open palm repels. Closed hand drops the room into slow gravity.",
  },
  {
    title: "Portal Bloom",
    kicker: "audio surface",
    detail: "Voice and bass inflate the Hydra portal and glow field.",
  },
  {
    title: "Zero-G Finale",
    kicker: "recordable burst",
    detail: "Swipe for a shockwave, then capture the performance as WebM.",
  },
];

const initialHand: HandSnapshot = {
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

const touchModeLabels: Record<TouchMode, string> = {
  spawn: "Spawn",
  repel: "Repel",
  freeze: "Freeze",
  shockwave: "Wave",
};

const qualityLabels: Record<QualityMode, string> = {
  battery: "Battery",
  balanced: "Balanced",
  cinema: "Cinema",
};

function App() {
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const hydraCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<RealityStageEngine | null>(null);
  const trackerCleanupRef = useRef<(() => void) | null>(null);
  const lenisRef = useRef<Lenis | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micFrameRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingTimerRef = useRef(0);
  const recordingIntervalRef = useRef(0);
  const [statusListRef] = useAutoAnimate<HTMLDivElement>();
  const [sceneListRef] = useAutoAnimate<HTMLDivElement>();
  const [controlsRef] = useAutoAnimate<HTMLDivElement>();
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [facingMode, setFacingMode] = useState<CameraFacingMode>("user");
  const [micState, setMicState] = useState<MicState>("idle");
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [hand, setHand] = useState<HandSnapshot>(initialHand);
  const [audio, setAudio] = useState<AudioSnapshot>(idleAudio);
  const [touch, setTouch] = useState<TouchControl>(idleTouch);
  const [touchMode, setTouchMode] = useState<TouchMode>("spawn");
  const [qualityMode, setQualityMode] = useState<QualityMode>("balanced");
  const [stats, setStats] = useState<EngineStats>({
    bodies: 0,
    grabbed: false,
    hydraReady: false,
    theatreReady: false,
    quality: "balanced",
    shockwaves: 0,
  });
  const [sceneIndex, setSceneIndex] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const scene = scenes[sceneIndex] ?? scenes[0];
  const gestureLabel = deriveGestureLabel(hand, touch, stats.grabbed);
  const canRecord = typeof MediaRecorder !== "undefined";

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
        active: hand.tracking || touch.active,
      },
      {
        icon: Mic,
        label: "mic",
        value: micState,
        active: micState === "live",
      },
      {
        icon: Radio,
        label: "audio",
        value: `${Math.round(audio.level * 100)}%`,
        active: audio.enabled,
      },
      {
        icon: Gauge,
        label: "quality",
        value: qualityLabels[qualityMode],
        active: true,
      },
      {
        icon: Video,
        label: "record",
        value:
          recordingState === "recording"
            ? `${recordingElapsed}s`
            : recordingState,
        active: recordingState === "recording",
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
    [
      audio.enabled,
      audio.level,
      cameraState,
      gestureLabel,
      hand.tracking,
      micState,
      qualityMode,
      recordingElapsed,
      recordingState,
      stats.hydraReady,
      stats.theatreReady,
      touch.active,
    ],
  );

  useEffect(() => {
    const lenis = new Lenis({
      smoothWheel: true,
      lerp: 0.08,
      wheelMultiplier: 0.9,
    });

    lenisRef.current = lenis;
    let frame = 0;
    const raf = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };

    lenis.on("scroll", ({ progress }: { progress: number }) => {
      const clamped = Math.max(0, Math.min(1, progress));
      const nextScene = Math.min(
        scenes.length - 1,
        Math.floor(clamped * scenes.length),
      );
      setScrollProgress(clamped);
      setSceneIndex(nextScene);
      engineRef.current?.setChapter(clamped, nextScene);
    });

    frame = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
      lenisRef.current = null;
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

  useEffect(() => {
    engineRef.current?.setAudio(audio);
  }, [audio]);

  useEffect(() => {
    engineRef.current?.setTouchControl(touch);
  }, [touch]);

  useEffect(() => {
    engineRef.current?.setQualityMode(qualityMode);
  }, [qualityMode]);

  const enableCamera = useCallback(
    async (mode = facingMode) => {
      if (!videoRef.current) {
        return;
      }

      setCameraState("requesting");
      setError(null);

      try {
        trackerCleanupRef.current?.();
        const cleanup = await createHandTracker({
          video: videoRef.current,
          facingMode: mode,
          onFrame: (snapshot) => {
            setHand(snapshot);
            setCameraState("tracking");
          },
          onError: (message) => {
            setError(message);
            setCameraState("error");
          },
        });

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
    },
    [facingMode],
  );

  const flipCamera = useCallback(() => {
    const next: CameraFacingMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
    if (cameraState === "tracking" || cameraState === "requesting") {
      void enableCamera(next);
    }
  }, [cameraState, enableCamera, facingMode]);

  const enableMic = useCallback(async () => {
    setMicState("requesting");
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.74;
      source.connect(analyser);

      micStreamRef.current = stream;
      micContextRef.current = context;
      setMicState("live");
      runAudioAnalyser(analyser);
    } catch (cause) {
      const message =
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : cause instanceof Error
            ? cause.message
            : "Microphone could not start.";
      setError(message);
      setMicState(message.includes("denied") ? "denied" : "error");
    }
  }, []);

  const runAudioAnalyser = (analyser: AnalyserNode) => {
    const frequency = new Uint8Array(analyser.frequencyBinCount);
    let lastUiUpdate = 0;

    const tick = (time: number) => {
      analyser.getByteFrequencyData(frequency);
      const snapshot = analyseFrequency(frequency);
      engineRef.current?.setAudio(snapshot);

      if (time - lastUiUpdate > 90) {
        lastUiUpdate = time;
        setAudio(snapshot);
      }

      micFrameRef.current = requestAnimationFrame(tick);
    };

    micFrameRef.current = requestAnimationFrame(tick);
  };

  const startRecording = useCallback(
    (durationSeconds = 15) => {
      if (!stageCanvasRef.current || !canRecord) {
        setRecordingError("Recording is not supported in this browser.");
        setRecordingState("error");
        return;
      }

      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl);
        setRecordingUrl(null);
      }

      const stream = stageCanvasRef.current.captureStream(30);
      micStreamRef.current?.getAudioTracks().forEach((track) => {
        stream.addTrack(track);
      });

      const mimeType = chooseRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = () => {
        window.clearTimeout(recordingTimerRef.current);
        window.clearInterval(recordingIntervalRef.current);
        setRecordingElapsed(0);
        stream.getVideoTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
        setRecordingUrl(URL.createObjectURL(blob));
        setRecordingState("ready");
      };

      recorder.onerror = () => {
        setRecordingError("Recording failed.");
        setRecordingState("error");
      };

      recorderRef.current = recorder;
      recorder.start(250);
      setRecordingState("recording");
      setRecordingError(null);
      setRecordingElapsed(0);

      const startedAt = Date.now();
      recordingIntervalRef.current = window.setInterval(() => {
        setRecordingElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      recordingTimerRef.current = window.setTimeout(() => {
        recorder.stop();
      }, durationSeconds * 1000);
    },
    [canRecord, recordingUrl],
  );

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const goToScene = (index: number) => {
    const target = window.innerHeight * 1.05 * index;
    lenisRef.current?.scrollTo(target, { duration: 1.1 });
    setSceneIndex(index);
    engineRef.current?.setChapter(index / Math.max(1, scenes.length - 1), index);
  };

  const updateTouchFromPointer = (
    event: ReactPointerEvent<HTMLDivElement>,
    active: boolean,
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2;
    const y = (0.5 - (event.clientY - bounds.top) / Math.max(1, bounds.height)) * 2;

    setTouch({
      active,
      x: Math.max(-1, Math.min(1, x)),
      y: Math.max(-1, Math.min(1, y)),
      mode: touchMode,
      intensity: active ? 1 : 0,
    });
  };

  useEffect(
    () => () => {
      trackerCleanupRef.current?.();
      window.cancelAnimationFrame(micFrameRef.current);
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      void micContextRef.current?.close();
      if (recordingUrl) {
        URL.revokeObjectURL(recordingUrl);
      }
    },
    [recordingUrl],
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
            <span>Performance Mode</span>
          </div>
        </div>
        <ReactiveRiveGlyph gesture={gestureLabel} chapter={sceneIndex} />
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
        {(error || recordingError) && (
          <div className="status-pill is-error">
            <Activity size={15} />
            <span>system</span>
            <strong>{error ?? recordingError}</strong>
          </div>
        )}
      </section>

      <section className="performance-controls" ref={controlsRef}>
        <div className="primary-actions">
          <button
            className="action-button is-primary"
            type="button"
            onClick={() => void enableCamera()}
            disabled={cameraState === "requesting"}
          >
            <Camera size={18} />
            <span>{cameraState === "requesting" ? "Camera..." : "Camera"}</span>
          </button>
          <button className="action-button" type="button" onClick={flipCamera}>
            <CameraIcon size={18} />
            <span>{facingMode === "user" ? "Front" : "Rear"}</span>
          </button>
          <button
            className="action-button"
            type="button"
            onClick={() => void enableMic()}
            disabled={micState === "requesting"}
          >
            <Mic size={18} />
            <span>{micState === "requesting" ? "Mic..." : "Mic"}</span>
          </button>
          {recordingState === "recording" ? (
            <button className="action-button is-danger" type="button" onClick={stopRecording}>
              <Square size={18} />
              <span>Stop</span>
            </button>
          ) : (
            <button
              className="action-button"
              type="button"
              onClick={() => startRecording(15)}
            >
              <Video size={18} />
              <span>Record</span>
            </button>
          )}
          {recordingUrl && (
            <a className="action-button is-link" href={recordingUrl} download="reality-stage-performance.webm">
              <Download size={18} />
              <span>WebM</span>
            </a>
          )}
        </div>

        <div className="segmented-control" aria-label="Quality mode">
          {(Object.keys(qualityLabels) as QualityMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={qualityMode === mode ? "is-selected" : ""}
              onClick={() => setQualityMode(mode)}
            >
              {qualityLabels[mode]}
            </button>
          ))}
        </div>

        <div className="audio-meter" aria-label="Audio level">
          <span style={{ transform: `scaleX(${Math.max(0.03, audio.level)})` }} />
        </div>
      </section>

      <section className="touch-console">
        <div className="touch-modes">
          {(Object.keys(touchModeLabels) as TouchMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={touchMode === mode ? "is-selected" : ""}
              onClick={() => setTouchMode(mode)}
            >
              {touchModeLabels[mode]}
            </button>
          ))}
        </div>
        <div
          className={`touch-pad ${touch.active ? "is-active" : ""}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            updateTouchFromPointer(event, true);
          }}
          onPointerMove={(event) => {
            if (touch.active) {
              updateTouchFromPointer(event, true);
            }
          }}
          onPointerUp={(event) => updateTouchFromPointer(event, false)}
          onPointerCancel={(event) => updateTouchFromPointer(event, false)}
        >
          <Orbit size={20} />
          <span>{hand.tracking ? "gesture live" : touchModeLabels[touchMode]}</span>
        </div>
      </section>

      <section className="scene-panel" ref={sceneListRef}>
        <div className="scene-index">
          <Layers3 size={16} />
          <span>
            {(sceneIndex + 1).toString().padStart(2, "0")} /{" "}
            {scenes.length.toString().padStart(2, "0")}
          </span>
        </div>
        <h1>{scene.title}</h1>
        <p>{scene.detail}</p>
        <div className="progress-track">
          <span style={{ transform: `scaleX(${scrollProgress})` }} />
        </div>
        <div className="scene-jump">
          {scenes.map((item, index) => (
            <button
              key={item.title}
              type="button"
              className={sceneIndex === index ? "is-selected" : ""}
              onClick={() => goToScene(index)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <p className="hint">
          {engineReady
            ? `${gestureLabel} | ${stats.bodies} bodies | ${stats.shockwaves} waves`
            : "Booting the stage engine."}
        </p>
      </section>

      <div className="scroll-rail" aria-hidden="true">
        {scenes.map((item) => (
          <section key={item.title} />
        ))}
      </div>
    </main>
  );
}

function deriveGestureLabel(
  hand: HandSnapshot,
  touch: TouchControl,
  grabbed: boolean,
): GestureMode {
  if (touch.active && !hand.tracking) {
    return "touch";
  }
  if (!hand.tracking) {
    return "waiting";
  }
  if (grabbed) {
    return "grab";
  }
  return hand.gesture;
}

function analyseFrequency(frequency: Uint8Array): AudioSnapshot {
  const bins = Array.from(frequency);
  const level = average(bins) / 255;
  const bass = average(bins.slice(0, 10)) / 255;
  const voice = average(bins.slice(16, 72)) / 255;
  const peak = Math.max(...bins) / 255;

  return {
    enabled: true,
    level: clamp01(level * 1.8),
    bass: clamp01(bass * 2.1),
    voice: clamp01(voice * 2.4),
    peak: clamp01(peak),
  };
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function chooseRecordingMimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export default App;
