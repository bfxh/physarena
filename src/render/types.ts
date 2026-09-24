import type { BodyDesc, BodyState, Vec3 } from '../core/types';
import type { GeometryData } from './geometry';

/**
 * Renderer-agnostic interface, deliberately shaped like `IPhysicsEngine`.
 *
 * Physics and rendering are the two independent axes of this lab: any physics
 * engine can be paired with any renderer, and the pairing is what makes the
 * numbers meaningful. A renderer therefore owes the host exactly the same
 * contract a solver does - build a layer from a `WorldDesc`, be told the new
 * states each frame, and report honest counters.
 *
 * Nothing in this file may leak a three.js / Babylon / WebGL handle.
 */

export type RenderLanguage = 'TypeScript' | 'JavaScript' | 'GLSL' | 'WGSL' | 'Rust' | 'C++';
export type RenderBackend = 'WebGL2' | 'WebGL1' | 'WebGPU' | 'Canvas2D' | 'Software';

export interface RenderFeatures {
  /** Can draw N copies of one mesh in a single call. */
  instancing: boolean;
  /** Shaded or flat/unlit only. */
  lighting: boolean;
  antialias: boolean;
  /** Can split its own canvas into panes (scissor / viewport). */
  scissorPanes: boolean;
  /** Depth buffer present (without it, back-to-front sorting is needed). */
  depthBuffer: boolean;
}

export interface RenderEngineMeta {
  id: string;
  name: string;
  /** Implementation language of the renderer itself. */
  language: RenderLanguage;
  backend: RenderBackend;
  license: string;
  homepage: string;
  /** Accent colour used by the UI. */
  accent: string;
  /** One-line honest characterisation, shown on the renderer card. */
  blurb: string;
  features: RenderFeatures;
  status: 'stable' | 'experimental';
  /** Rough gzip size of what this renderer adds to the bundle, in kB. 0 = built in. */
  costKb: number;
}

/**
 * One physics engine's visual state inside a renderer.
 *
 * The two mutators mirror the adapter lifecycle: `setBodies` on every rebuild
 * (scene / body-count / physics-engine change), `sync` every frame.
 */
export interface IRenderLayer {
  readonly id: string;
  /** Replaces the drawn set entirely. Must release the previous scene's meshes. */
  setBodies(bodies: BodyDesc[]): void;
  /** Index-aligned with `BodyDesc[]` from the last `setBodies`. */
  sync(states: BodyState[]): void;
  clear(): void;
  /**
   * Replaces the layer's fluid surface; `null` clears it.
   *
   * Optional on purpose. A backend that cannot rewrite a mesh's buffers in
   * place simply does not implement this, and the fluid keeps being drawn as
   * particles. Returning false counts as rejected, so the host can say so
   * instead of quietly drawing something different from what it claims.
   */
  setDynamicMesh?(data: GeometryData | null): boolean;
}

export interface RenderSlot {
  id: string;
  label: string;
  /**
   * Isosurface of the scene's fluid, when it has one.
   *
   * The buffers belong to the caller and are **reused every frame** - a backend
   * that keeps the data (an async upload, a retained copy) must copy it. A
   * backend that cannot update a mesh in place ignores this field, and the
   * fluid stays drawn as particles; that fallback is visible in the capability
   * panel rather than silent.
   */
  fluidMesh?: GeometryData | null;
}

/**
 * Honest renderer counters.
 *
 * Every field is optional and each renderer must say which ones it actually
 * measures (see `notes`). Reporting a whole-page JS heap figure as if it were
 * GPU memory is exactly the kind of thing this lab exists to avoid.
 */
export interface RenderStats {
  /** Draw calls submitted by the last `render()`. */
  drawCalls?: number;
  /** Triangles submitted by the last `render()`. */
  triangles?: number;
  /** Instances drawn by the last `render()`. */
  instances?: number;
  /** Resident geometries / textures / shader programs. */
  geometries?: number;
  textures?: number;
  programs?: number;
  /** Bytes of GPU-side vertex/index buffers currently held. */
  bufferBytes?: number;
  /** Bytes of texture memory currently held, when measurable. */
  textureBytes?: number;
  /** Per-field caveats, keyed by field name. Shown as tooltips in the UI. */
  notes?: Record<string, string>;
}

/** Free-form diagnostic dump, shown by the "渲染诊断" panel. */
export type RenderProbe = Record<string, unknown>;

export interface IRenderEngine {
  readonly meta: RenderEngineMeta;
  /**
   * Create the context and mount a canvas into `host`.
   * Must throw a readable error when the backend is unavailable - the host
   * surfaces it instead of showing a blank stage.
   */
  init(host: HTMLElement): Promise<void>;
  readonly canvas: HTMLCanvasElement;

  addLayer(id: string, accent: number): IRenderLayer;
  removeLayer(id: string): void;
  layer(id: string): IRenderLayer | undefined;
  /** `null` shows the empty grid only (used while a scene is being rebuilt). */
  setVisibleLayer(id: string | null): void;

  /** Draws one pane per slot across the canvas. */
  render(slots: RenderSlot[]): void;
  /** Frames content of the given radius, accounting for the ground plane. */
  frame(contentRadius: number, groundSize?: number, extent?: number, target?: Vec3, radiusScale?: number): void;
  resize(): void;
  /** Advance camera damping / controls. Called once per frame. */
  updateCamera(): void;

  stats(): RenderStats;
  probe(): RenderProbe;
  dispose(): void;

  /** Host hook: pane labels are CSS-positioned and must be relayed out. */
  onResize: () => void;
  /** Host hook: set so a lost GPU context can be surfaced instead of a blank stage. */
  onContextLost: (() => void) | null;
}

export interface RenderModuleStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
  initMs?: number;
}
