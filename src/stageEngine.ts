import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";
import { getProject, val } from "@theatre/core";
import type { HandSnapshot } from "./handTracker";
import {
  idleAudio,
  idleTouch,
  type AudioSnapshot,
  type QualityMode,
  type TouchControl,
} from "./performanceTypes";

type StageEngineOptions = {
  canvas: HTMLCanvasElement;
  hydraCanvas: HTMLCanvasElement;
  onReady: () => void;
  onStats: (stats: EngineStats) => void;
  onError: (message: string) => void;
};

export type EngineStats = {
  bodies: number;
  grabbed: boolean;
  hydraReady: boolean;
  theatreReady: boolean;
  quality: QualityMode;
  shockwaves: number;
};

type StageBody = {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  light: THREE.PointLight;
  baseScale: number;
};

type Shockwave = {
  mesh: THREE.Mesh;
  origin: THREE.Vector3;
  age: number;
  pushed: Set<RAPIER.RigidBody>;
};

type CameraTarget = {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  fx: { pulse: number; portal: number; hue: number };
};

const cameraTargets: CameraTarget[] = [
  {
    position: { x: 0, y: 2.4, z: 8.8 },
    lookAt: { x: 0, y: 1, z: 0 },
    fx: { pulse: 0.35, portal: 0.28, hue: 0.52 },
  },
  {
    position: { x: 4.9, y: 3.25, z: 6.25 },
    lookAt: { x: 0, y: 1.35, z: -0.55 },
    fx: { pulse: 0.55, portal: 0.48, hue: 0.61 },
  },
  {
    position: { x: -5.3, y: 2.05, z: 5.15 },
    lookAt: { x: 0.55, y: 1.1, z: -1.05 },
    fx: { pulse: 0.8, portal: 0.72, hue: 0.77 },
  },
  {
    position: { x: 0.65, y: 4.75, z: 4.15 },
    lookAt: { x: 0, y: 1.2, z: -2.2 },
    fx: { pulse: 1, portal: 1, hue: 0.92 },
  },
];

const handNeutral: HandSnapshot = {
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

const qualitySettings: Record<
  QualityMode,
  { dpr: number; shadows: boolean; maxBodies: number; particleScale: number }
> = {
  battery: { dpr: 1, shadows: false, maxBodies: 14, particleScale: 0.88 },
  balanced: { dpr: 1.5, shadows: true, maxBodies: 22, particleScale: 1 },
  cinema: { dpr: 2, shadows: true, maxBodies: 34, particleScale: 1.16 },
};

const theatreState = {
  definitionVersion: "0.4.0",
  revisionHistory: ["reality-stage-runtime"],
  sheetsById: {
    Runtime: {
      staticOverrides: {
        byObject: {},
      },
      sequence: {
        type: "PositionalSequence",
        length: 4,
        subUnitsPerUnit: 30,
        tracksByObject: {},
      },
    },
  },
};

export class RealityStageEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly hydraCanvas: HTMLCanvasElement;
  private readonly onReady: () => void;
  private readonly onStats: (stats: EngineStats) => void;
  private readonly onError: (message: string) => void;
  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private world?: RAPIER.World;
  private frame = 0;
  private lastTime = performance.now();
  private bodies: StageBody[] = [];
  private grabbed: StageBody | null = null;
  private wasPinching = false;
  private wasFastSwipe = false;
  private hand = handNeutral;
  private touch = idleTouch;
  private audio = idleAudio;
  private qualityMode: QualityMode = "balanced";
  private bassPulseClock = 0;
  private cursor?: THREE.Mesh;
  private portal?: THREE.Mesh;
  private hydraTexture?: THREE.CanvasTexture;
  private shockwaves: Shockwave[] = [];
  private hydraReady = false;
  private theatreReady = false;
  private chapterProgress = 0;
  private chapterIndex = 0;
  private cameraRig = getProject("Reality Stage", { state: theatreState })
    .sheet("Runtime")
    .object("Camera Rig", cameraTargets[0]);

  constructor(options: StageEngineOptions) {
    this.canvas = options.canvas;
    this.hydraCanvas = options.hydraCanvas;
    this.onReady = options.onReady;
    this.onStats = options.onStats;
    this.onError = options.onError;
  }

  async init() {
    try {
      await RAPIER.init();
      this.setupScene();
      this.setupPhysics();
      await this.setupHydra();
      this.resize();
      window.addEventListener("resize", this.resize);
      this.theatreReady = true;
      this.onReady();
      this.emitStats();
      this.loop(performance.now());
    } catch (cause) {
      this.onError(cause instanceof Error ? cause.message : "Stage engine failed.");
    }
  }

  setHand(hand: HandSnapshot) {
    this.hand = hand;
  }

  setAudio(audio: AudioSnapshot) {
    this.audio = audio;
  }

  setTouchControl(touch: TouchControl) {
    this.touch = touch;
  }

  setQualityMode(mode: QualityMode) {
    this.qualityMode = mode;
    this.applyQualityMode();
    this.trimBodies();
    this.emitStats();
  }

  setChapter(progress: number, chapterIndex: number) {
    this.chapterProgress = progress;
    this.chapterIndex = chapterIndex;
    const local = progress * (cameraTargets.length - 1);
    const left = Math.max(0, Math.min(cameraTargets.length - 1, Math.floor(local)));
    const right = Math.max(0, Math.min(cameraTargets.length - 1, left + 1));
    const blend = smoother(local - left);
    const target = mixTarget(cameraTargets[left], cameraTargets[right], blend);

    this.cameraRig.initialValue = target;
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("resize", this.resize);
    this.bodies.forEach(({ mesh, light }) => {
      mesh.geometry.dispose();
      disposeMaterial(mesh.material);
      light.dispose();
    });
    this.shockwaves.forEach(({ mesh }) => {
      mesh.geometry.dispose();
      disposeMaterial(mesh.material);
    });
    this.portal?.geometry.dispose();
    if (this.portal) {
      disposeMaterial(this.portal.material);
    }
    this.hydraTexture?.dispose();
    this.renderer?.dispose();
  }

  private setupScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070910);
    scene.fog = new THREE.FogExp2(0x070910, 0.045);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
    camera.position.set(0, 2.4, 8.8);

    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, qualitySettings[this.qualityMode].dpr),
    );
    renderer.shadowMap.enabled = qualitySettings[this.qualityMode].shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const ambient = new THREE.HemisphereLight(0x77ddff, 0x140814, 1.35);
    scene.add(ambient);

    const key = new THREE.DirectionalLight(0xffffff, 2.25);
    key.position.set(4, 7, 4);
    key.castShadow = true;
    scene.add(key);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 18, 48, 48),
      new THREE.MeshStandardMaterial({
        color: 0x0e141b,
        roughness: 0.7,
        metalness: 0.25,
        emissive: 0x06131a,
        emissiveIntensity: 0.3,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    const grid = new THREE.GridHelper(18, 36, 0x27e7ff, 0x1f3845);
    grid.position.y = 0.012;
    scene.add(grid);

    const tunnel = new THREE.Group();
    for (let i = 0; i < 9; i += 1) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.8 + i * 0.26, 0.012, 12, 96),
        new THREE.MeshBasicMaterial({
          color: i % 2 === 0 ? 0x4be7ff : 0xffd166,
          transparent: true,
          opacity: 0.25,
        }),
      );
      ring.position.z = -2.2 - i * 0.65;
      ring.rotation.x = Math.PI / 2;
      tunnel.add(ring);
    }
    scene.add(tunnel);

    const cursor = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.18, 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.85,
      }),
    );
    scene.add(cursor);

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.cursor = cursor;
    this.applyQualityMode();
  }

  private setupPhysics() {
    const world = new RAPIER.World({ x: 0, y: -5.2, z: 0 });
    const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(9, 0.12, 9), floorBody);

    const backWall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 3, -7.5),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(7.5, 3, 0.15), backWall);

    const leftWall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(-7.5, 2, 0),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 2, 7.5), leftWall);

    const rightWall = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(7.5, 2, 0),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 2, 7.5), rightWall);

    this.world = world;

    for (let i = 0; i < 5; i += 1) {
      this.spawnBody({
        x: (i - 2) * 0.8,
        y: 2.8 + i * 0.14,
        z: -1.6 - i * 0.3,
      });
    }
  }

  private async setupHydra() {
    try {
      (globalThis as typeof globalThis & { global?: typeof globalThis }).global =
        globalThis;
      const mod = await import("hydra-synth");
      const Hydra = mod.default;
      new Hydra({
        canvas: this.hydraCanvas,
        detectAudio: false,
        makeGlobal: true,
        enableStreamCapture: false,
      });

      const hydraGlobal = globalThis as unknown as HydraRuntime;
      if (typeof hydraGlobal.osc !== "function") {
        throw new Error("Hydra global oscillator was not registered.");
      }

      hydraGlobal.osc(8, 0.08, 1.1)
        .rotate(0.15)
        .kaleid(5)
        .color(0.2, 0.95, 1.2)
        .modulate(hydraGlobal.noise(2.7, 0.18), 0.12)
        .out();

      this.hydraTexture = new THREE.CanvasTexture(this.hydraCanvas);
      this.hydraTexture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: this.hydraTexture,
        transparent: true,
        opacity: 0.82,
      });
      const portal = new THREE.Mesh(new THREE.PlaneGeometry(8.5, 4.8), material);
      portal.position.set(0, 2.75, -7.35);
      this.scene?.add(portal);
      this.portal = portal;
      this.hydraReady = true;
    } catch (cause) {
      this.hydraReady = false;
      this.onError(
        cause instanceof Error ? `Hydra failed: ${cause.message}` : "Hydra failed.",
      );
    }
  }

  private loop = (time: number) => {
    const dt = Math.min(0.033, Math.max(0.001, (time - this.lastTime) / 1000));
    this.lastTime = time;

    this.updateGesture(dt);
    this.updateShockwaves(dt);
    if (this.world) {
      this.world.timestep = dt;
      this.world.step();
    }
    this.syncBodies(time);
    this.updateCamera(time);
    if (this.hydraTexture) {
      this.hydraTexture.needsUpdate = true;
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }

    this.frame = requestAnimationFrame(this.loop);
  };

  private updateGesture(dt: number) {
    const usingTouch = this.touch.active && !this.hand.tracking;
    const controlWorld = usingTouch
      ? new THREE.Vector3(this.touch.x * 3.35, 1.45 + this.touch.y * 2.35, -2.25)
      : this.handToWorld(this.hand);
    const isActive = usingTouch || this.hand.tracking;
    const spawnAction =
      (usingTouch && this.touch.mode === "spawn") || this.hand.pinching;
    const repelAction =
      (usingTouch && this.touch.mode === "repel") || this.hand.openPalm;
    const freezeAction =
      (usingTouch && this.touch.mode === "freeze") || this.hand.closedHand;
    const shockwaveAction =
      (usingTouch && this.touch.mode === "shockwave") || this.hand.fastSwipe;

    if (this.cursor) {
      this.cursor.position.lerp(controlWorld, 0.35);
      this.cursor.scale.setScalar(spawnAction ? 1.8 : repelAction ? 2.15 : 1);
      const material = this.cursor.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.color.set(
          shockwaveAction
            ? 0xff6b9d
            : repelAction
              ? 0x7cffb2
              : freezeAction
                ? 0xb7a7ff
                : spawnAction
                  ? 0xffd166
                  : 0x7cf9ff,
        );
      }
    }

    if (this.world) {
      this.world.gravity = {
        x: 0,
        y: freezeAction ? -0.08 : -5.2 + this.audio.bass * 1.6,
        z: 0,
      };
    }

    if (spawnAction && !this.wasPinching && isActive) {
      this.grabbed = this.findNearestBody(controlWorld);
      if (!this.grabbed || this.grabbed.mesh.position.distanceTo(controlWorld) > 1.2) {
        this.grabbed = this.spawnBody(controlWorld);
      }
      this.emitStats();
    }

    if (spawnAction && this.grabbed) {
      const velocity = {
        x: usingTouch ? 0 : this.hand.velocity.x * 1.35,
        y: usingTouch ? 0 : this.hand.velocity.y * 1.35,
        z: usingTouch ? 0 : this.hand.velocity.z * 1.35,
      };
      this.grabbed.body.setTranslation(controlWorld, true);
      this.grabbed.body.setLinvel(velocity, true);
      this.grabbed.body.setAngvel(
        {
          x: velocity.y * 0.8,
          y: -velocity.x * 0.8,
          z: velocity.z,
        },
        true,
      );
    }

    if (!spawnAction && this.wasPinching && this.grabbed) {
      this.grabbed.body.applyImpulse(
        {
          x: usingTouch ? 0 : this.hand.velocity.x * 0.22,
          y: usingTouch ? 0.4 : Math.max(0.25, this.hand.velocity.y * 0.18),
          z: usingTouch
            ? -0.55
            : -Math.abs(this.hand.velocity.x) * 0.05 + this.hand.velocity.z * 0.2,
        },
        true,
      );
      this.grabbed = null;
      this.emitStats();
    }

    if (repelAction && isActive) {
      this.repelFrom(controlWorld, 0.09 + this.touch.intensity * 0.08, 3.2);
    }

    if (shockwaveAction && !this.wasFastSwipe && isActive) {
      this.triggerShockwave(controlWorld, 1 + this.audio.level);
    }

    this.bassPulseClock += dt;
    if (this.audio.enabled && this.audio.bass > 0.18 && this.bassPulseClock > 0.1) {
      this.bassPulseClock = 0;
      this.bodies.forEach(({ body, mesh }) => {
        const distance = mesh.position.distanceTo(controlWorld);
        const strength = Math.max(0.02, this.audio.bass * (distance < 4 ? 0.08 : 0.035));
        body.applyImpulse({ x: 0, y: strength, z: -strength * 0.8 }, true);
      });
    }

    this.wasPinching = spawnAction;
    this.wasFastSwipe = shockwaveAction;
  }

  private updateCamera(time: number) {
    if (!this.camera) {
      return;
    }

    const position = val(this.cameraRig.props.position);
    const lookAt = val(this.cameraRig.props.lookAt);
    const fx = val(this.cameraRig.props.fx);
    const drift = Math.sin(time * 0.00045 + this.chapterIndex) * 0.22;
    const pulse =
      1 + Math.sin(time * 0.003) * 0.02 * fx.pulse + this.audio.bass * 0.035;
    const shake = this.audio.voice * 0.11;

    this.camera.position.lerp(
      new THREE.Vector3(
        position.x + drift + Math.sin(time * 0.017) * shake,
        position.y + this.hand.y * 0.18 + Math.cos(time * 0.013) * shake,
        position.z * pulse,
      ),
      0.035,
    );
    this.camera.lookAt(lookAt.x + this.hand.x * 0.22, lookAt.y, lookAt.z);

    if (this.portal) {
      const portalPower = Math.min(
        1.8,
        fx.portal + this.audio.level * 0.65 + (this.hand.twoHand ? 0.55 : 0),
      );
      this.portal.scale.setScalar(1 + portalPower * 0.12);
      const material = this.portal.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = 0.52 + portalPower * 0.28;
      }
    }

    this.scene?.traverse((node) => {
      if (node instanceof THREE.Mesh && node.material instanceof THREE.MeshStandardMaterial) {
        node.material.emissiveIntensity =
          node === this.cursor ? 1 : 0.22 + this.chapterProgress * 0.38;
      }
    });
  }

  private syncBodies(time: number) {
    this.bodies.forEach(({ mesh, body, light }, index) => {
      const translation = body.translation();
      const rotation = body.rotation();
      mesh.position.set(translation.x, translation.y, translation.z);
      mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      light.position.copy(mesh.position);
      const material = mesh.material;
      const audioScale = 1 + this.audio.bass * 0.36;
      mesh.scale.setScalar(audioScale);
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissiveIntensity =
          0.7 +
          Math.sin(time * 0.004 + index) * 0.2 +
          this.chapterProgress * 0.5 +
          this.audio.level * 0.8;
      }

      if (translation.y < -4) {
        body.setTranslation(
          { x: Math.sin(index) * 2, y: 4.5, z: -1.5 - index * 0.25 },
          true,
        );
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
    });
  }

  private spawnBody(position: THREE.Vector3 | { x: number; y: number; z: number }) {
    if (!this.world || !this.scene) {
      throw new Error("Physics world is not ready.");
    }

    if (this.bodies.length > 22) {
      const oldest = this.bodies.shift();
      if (oldest) {
        this.scene.remove(oldest.mesh, oldest.light);
        this.world.removeRigidBody(oldest.body);
      }
    }

    const size = 0.24 + Math.random() * 0.18;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinearDamping(0.16)
        .setAngularDamping(0.18),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(size).setRestitution(0.74).setFriction(0.62),
      body,
    );

    const hue = 0.48 + Math.random() * 0.44;
    const color = new THREE.Color().setHSL(hue, 0.92, 0.62);
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(size, 3),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.23,
        metalness: 0.55,
        emissive: color,
        emissiveIntensity: 0.95,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const light = new THREE.PointLight(color, 1.25, 4.5);
    this.scene.add(mesh, light);

    const stageBody = { mesh, body, light, baseScale: size };
    this.bodies.push(stageBody);
    this.trimBodies();
    this.emitStats();
    return stageBody;
  }

  private findNearestBody(point: THREE.Vector3): StageBody | null {
    let nearest: StageBody | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const body of this.bodies) {
      const distance = body.mesh.position.distanceTo(point);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = body;
      }
    }

    return nearest;
  }

  private emitStats() {
    this.onStats({
      bodies: this.bodies.length,
      grabbed: Boolean(this.grabbed),
      hydraReady: this.hydraReady,
      theatreReady: this.theatreReady,
      quality: this.qualityMode,
      shockwaves: this.shockwaves.length,
    });
  }

  private resize = () => {
    if (!this.renderer || !this.camera) {
      return;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  private handToWorld(hand: HandSnapshot) {
    return new THREE.Vector3(
      hand.x * 3.2,
      1.65 + hand.y * 2.2,
      -2.25 + hand.z * 2.3,
    );
  }

  private repelFrom(origin: THREE.Vector3, strength: number, radius: number) {
    this.bodies.forEach(({ body, mesh }) => {
      const delta = mesh.position.clone().sub(origin);
      const distance = Math.max(0.001, delta.length());
      if (distance > radius) {
        return;
      }

      const falloff = 1 - distance / radius;
      const impulse = delta.normalize().multiplyScalar(strength * falloff);
      body.applyImpulse(
        { x: impulse.x, y: Math.abs(impulse.y) + strength * 0.25, z: impulse.z },
        true,
      );
    });
  }

  private triggerShockwave(origin: THREE.Vector3, strength: number) {
    if (!this.scene) {
      return;
    }

    const material = new THREE.MeshBasicMaterial({
      color: 0xff6b9d,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.018, 8, 128), material);
    mesh.position.copy(origin);
    mesh.rotation.x = Math.PI / 2;
    mesh.scale.setScalar(0.18);
    this.scene.add(mesh);
    this.shockwaves.push({ mesh, origin: origin.clone(), age: 0, pushed: new Set() });
    this.repelFrom(origin, 0.22 * strength, 4.6);
    this.emitStats();
  }

  private updateShockwaves(dt: number) {
    if (!this.scene) {
      return;
    }

    const survivors: Shockwave[] = [];
    for (const shockwave of this.shockwaves) {
      shockwave.age += dt;
      const radius = 0.28 + shockwave.age * 7.5;
      shockwave.mesh.scale.setScalar(radius);
      const material = shockwave.mesh.material;
      if (material instanceof THREE.MeshBasicMaterial) {
        material.opacity = Math.max(0, 1 - shockwave.age / 1.05);
      }

      this.bodies.forEach(({ body, mesh }) => {
        if (shockwave.pushed.has(body)) {
          return;
        }
        const distance = mesh.position.distanceTo(shockwave.origin);
        if (Math.abs(distance - radius) < 0.65) {
          shockwave.pushed.add(body);
          const impulse = mesh.position
            .clone()
            .sub(shockwave.origin)
            .normalize()
            .multiplyScalar(0.16);
          body.applyImpulse({ x: impulse.x, y: 0.12, z: impulse.z }, true);
        }
      });

      if (shockwave.age < 1.05) {
        survivors.push(shockwave);
      } else {
        this.scene.remove(shockwave.mesh);
        shockwave.mesh.geometry.dispose();
        disposeMaterial(shockwave.mesh.material);
      }
    }

    if (survivors.length !== this.shockwaves.length) {
      this.shockwaves = survivors;
      this.emitStats();
    } else {
      this.shockwaves = survivors;
    }
  }

  private trimBodies() {
    if (!this.world || !this.scene) {
      return;
    }

    const maxBodies = qualitySettings[this.qualityMode].maxBodies;
    while (this.bodies.length > maxBodies) {
      const oldest = this.bodies.shift();
      if (!oldest) {
        continue;
      }
      this.scene.remove(oldest.mesh, oldest.light);
      this.world.removeRigidBody(oldest.body);
      oldest.mesh.geometry.dispose();
      disposeMaterial(oldest.mesh.material);
      oldest.light.dispose();
    }
  }

  private applyQualityMode() {
    if (!this.renderer) {
      return;
    }

    const settings = qualitySettings[this.qualityMode];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.dpr));
    this.renderer.shadowMap.enabled = settings.shadows;
    this.bodies.forEach(({ mesh }) => {
      mesh.scale.setScalar(settings.particleScale);
    });
  }
}

function smoother(value: number) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function mixTarget(a: CameraTarget, b: CameraTarget, t: number): CameraTarget {
  return {
    position: mixVector(a.position, b.position, t),
    lookAt: mixVector(a.lookAt, b.lookAt, t),
    fx: mixVector(a.fx, b.fx, t),
  };
}

function mixVector<T extends Record<string, number>>(a: T, b: T, t: number) {
  return Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key] + (b[key] - a[key]) * t]),
  ) as T;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }
  material.dispose();
}

type HydraChain = {
  rotate: (...args: number[]) => HydraChain;
  kaleid: (...args: number[]) => HydraChain;
  color: (...args: number[]) => HydraChain;
  modulate: (source: HydraChain, amount?: number) => HydraChain;
  out: () => void;
};

type HydraRuntime = {
  osc: (...args: number[]) => HydraChain;
  noise: (...args: number[]) => HydraChain;
};
