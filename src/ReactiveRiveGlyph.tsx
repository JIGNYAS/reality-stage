import { useEffect, useMemo } from "react";
import {
  Alignment,
  Fit,
  Layout,
  RuntimeLoader,
  useRive,
} from "@rive-app/react-canvas";

type ReactiveRiveGlyphProps = {
  gesture: string;
  chapter: number;
};

export function ReactiveRiveGlyph({ gesture, chapter }: ReactiveRiveGlyphProps) {
  RuntimeLoader.setWasmUrl("/rive/rive.wasm");
  RuntimeLoader.setWasmFallbackUrl("/rive/rive_fallback.wasm");

  const { RiveComponent, rive } = useRive({
    src: "/rive/vehicles.riv",
    autoplay: true,
    layout: new Layout({
      fit: Fit.Contain,
      alignment: Alignment.Center,
    }),
  });

  useEffect(() => {
    if (!rive) {
      return;
    }

    if (gesture === "grabbing" || gesture === "pinching") {
      rive.play();
    } else if (gesture === "waiting") {
      rive.pause();
    } else {
      rive.play();
    }
  }, [gesture, rive]);

  const mode = useMemo(() => {
    if (gesture === "grabbing") {
      return "locked";
    }
    if (gesture === "pinching") {
      return "charged";
    }
    return chapter > 1 ? "deep" : "awake";
  }, [chapter, gesture]);

  return (
    <div className={`rive-glyph is-${mode}`} title="Rive reactive glyph">
      <RiveComponent />
    </div>
  );
}
