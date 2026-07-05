/// <reference types="vite/client" />

declare module "hydra-synth" {
  type HydraOptions = {
    canvas?: HTMLCanvasElement;
    detectAudio?: boolean;
    makeGlobal?: boolean;
    enableStreamCapture?: boolean;
  };

  export default class Hydra {
    constructor(options?: HydraOptions);
  }
}
