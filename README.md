# Reality Stage

Reality Stage is a browser-first local web app where webcam gestures control a cinematic Three.js stage with Rapier physics, MediaPipe hand tracking, Theatre.js camera rigging, Hydra visuals, Rive animation, Lenis scroll chapters, and AutoAnimate UI transitions.

V2, **Performance Mode**, turns it into a mobile-first visual instrument: gesture physics, audio-reactive portal energy, scene controls, touch fallback, and local WebM clip recording.

## Performance Mode Controls

- **Camera** starts MediaPipe hand tracking. **Front/Rear** switches camera facing mode when the browser and device support it.
- **Mic** starts the Web Audio analyser. Bass pulses object energy, overall level drives visual intensity, and voice/noise affects portal glow and camera shake.
- **Record** captures the rendered stage canvas with `MediaRecorder` and creates a local downloadable `.webm` clip. Nothing is uploaded.
- **Battery / Balanced / Cinema** adjust render quality, pixel ratio, shadows, and physics body budget.
- **Spawn / Repel / Freeze / Wave** are touch fallback modes for phones or browsers where hand tracking is unavailable.
- Scene buttons jump through the guided show sequence: **Ignition**, **Gravity Well**, **Portal Bloom**, and **Zero-G Finale**.

## Gesture Vocabulary

- **Pinch** grabs or spawns a glowing physics object.
- **Open palm** repels nearby objects.
- **Closed hand** reduces gravity and freezes the field.
- **Fast swipe** emits a visible shockwave.
- **Two hands** intensify the portal when tracking is stable.

The app is local-first. Camera, microphone, tracking, analysis, and recording all run in the browser.

## Local Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build
```

## GitHub Pages

This repo is configured for GitHub Pages from the `main` branch `/docs` folder. `pnpm build` writes the static production output into `docs/` with the `/reality-stage/` base path.

Do not commit `node_modules/`, `.venv/`, local caches, or `verification/` artifacts. They are ignored by `.gitignore`.

For a repository named `reality-stage`, the public URL will be:

```text
https://<github-username>.github.io/reality-stage/
```
