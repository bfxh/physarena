/**
 * Engine-agnostic scene description.
 *
 * Every physics engine in PhysArena is driven through this intermediate
 * representation. Nothing here may leak a native handle, a matrices/vector
 * type, or an engine-specific option - the whole point of the lab is that the
 * exact same `WorldDesc` is replayed by 8 different solvers.
 */

export type Vec3 = [number, number, number];
/** [x, y, z, w] */
export type Quat = [number, number, number, number];

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

export type ShapeDesc =
  | { kind: 'box'; halfExtents: Vec3 }
  | { kind: 'sphere'; radius: number }
  | { kind: 'capsule'; radius: number; halfHeight: number }
  | { kind: 'cylinder'; radius: number; halfHeight: number }
  | { kind: 'cone'; radius: number; halfHeight: number }
  | { kind: 'convex'; points: number[]; indices?: number[] }
  | { kind: 'trimesh'; vertices: number[]; indices: number[] }
  | { kind: 'compound'; children: CompoundChild[] };

export interface CompoundChild {
  shape: ShapeDesc;
  offset: Vec3;
  rotation?: Quat;
}

export type BodyType = 'dynamic' | 'static' | 'kinematic';

export interface BodyDesc {
  /** Stable id, used to bind joints and to reuse meshes across rebuilds. */
  id: string;
  shape: ShapeDesc;
  type: BodyType;
  position: Vec3;
  rotation?: Quat;
  /** Mass is derived from density * volume when `mass` is omitted. */
  density?: number;
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** Continuous collision detection - the tunneling test depends on this. */
  ccd?: boolean;
  sensor?: boolean;
  /** Free-form tag used by scenarios to colour-code groups. */
  tag?: string;
  /** Initial linear velocity, mainly used by the projectile scenarios. */
  velocity?: Vec3;
  /** Initial angular velocity (rad/s), used by the spinning-top scenarios. */
  angularVelocity?: Vec3;
  /**
   * Marks a particle owned by the fluid solver rather than by the physics
   * engine.
   *
   * Fluid bodies are still listed in the world so every renderer draws them -
   * but the engine never sees them, because their motion comes from the PBF
   * solver instead of from rigid-body dynamics. Running both would double-count
   * the forces. This is why the renderer axis needs no change at all to support
   * real fluids.
   */
  fluid?: boolean;
}

export type JointKind =
  | 'fixed'
  | 'revolute'
  | 'prismatic'
  | 'spherical'
  | 'distance'
  | 'spring';

export interface JointDesc {
  id: string;
  kind: JointKind;
  bodyA: string;
  bodyB: string;
  anchorA: Vec3;
  anchorB: Vec3;
  axis?: Vec3;
  limits?: [number, number];
  motor?: { targetVelocity: number; maxForce: number };
  stiffness?: number;
  damping?: number;
  restLength?: number;
}

export interface WorldDesc {
  gravity: Vec3;
  bodies: BodyDesc[];
  joints: JointDesc[];
  /** Suggested sub-stepping; adapters may ignore it. */
  substeps?: number;
  /** Present when the scene contains a fluid volume; see BodyDesc.fluid. */
  fluid?: FluidSpec;
}

/**
 * Parameters for the fluid volume in a scene.
 *
 * The particle positions are authored through the scene builder like any other
 * body (so they land in  with ); this only carries the
 * solver settings and the static colliders the fluid should respect.
 */
export interface FluidSpec {
  /** Rest density and kernel radius; see src/fluid/pbf.ts. */
  restDensity?: number;
  h?: number;
  spacing?: number;
  iterations?: number;
  vorticity?: number;
  viscosity?: number;
  /** Draw radius multiplier: >1 makes neighbouring spheres overlap into a surface. */
  renderScale?: number;
  /** Half-extent of the tank the fluid is clamped inside. */
  halfX: number;
  halfZ: number;
  /** Y height above which particles are pushed back down (i.e. the open top). */
  ceiling: number;
}

export interface BodyState {
  position: Vec3;
  rotation: Quat;
  linearVelocity?: Vec3;
  angularVelocity?: Vec3;
  sleeping?: boolean;
}

export type EngineLanguage = 'C++' | 'Rust' | 'TypeScript' | 'JavaScript';
export type EngineBackend = 'WASM' | 'asm.js' | 'Pure JS';

export type ShapeKind = ShapeDesc['kind'];

export interface EngineCapabilities {
  /** Natively supported primitive shapes. Anything missing is approximated. */
  shapes: ShapeKind[];
  /** Natively supported joint types. Missing ones are silently skipped. */
  joints: JointKind[];
  ccd: boolean;
  sensors: boolean;
  /** Engine exposes its wasm heap size, so memory is comparable. */
  memoryReport: boolean;
}

export interface EngineMeta {
  id: string;
  name: string;
  /** Implementation language - the axis the user asked to compare. */
  language: EngineLanguage;
  backend: EngineBackend;
  license: string;
  homepage: string;
  /** Accent colour used by the UI and by the side-by-side viewports. */
  accent: string;
  /** One-line honest characterisation, shown on the engine card. */
  blurb: string;
  /** Solver family, useful when explaining benchmark deltas. */
  solver: string;
  status: 'stable' | 'experimental';
  capabilities: EngineCapabilities;
}

export interface EngineStats {
  /** Bytes currently held by the wasm heap, when the engine exposes it. */
  memoryBytes?: number;
  /** Number of native bodies actually allocated. */
  bodyCount?: number;
  /** Collision shapes retained by the engine (usually one per body). */
  shapeCount?: number;
  /** Active contact pairs in the last step, when the engine exposes them. */
  contactCount?: number;
  /** Constraints/joints that were actually created. */
  jointCount?: number;
  /** Solver iteration counts, e.g. `{ velocity: 4, position: 1 }`. */
  solverIterations?: Record<string, number>;
  /** Per-phase cost of the last step, when the engine can attribute it. */
  stepPhasesMs?: Record<string, number>;
  /**
   * Caveats keyed by field name.
   *
   * A missing figure must never be read as zero: every engine that cannot
   * measure something says so here, and the panel prints that instead of a
   * number. Reporting a page-wide JS heap as if it were solver memory is
   * exactly the kind of thing this lab exists to avoid.
   */
  notes?: Record<string, string>;
}

export interface IPhysicsEngine {
  readonly meta: EngineMeta;
  /** Load and instantiate the solver. Safe to call once per instance. */
  init(): Promise<void>;
  /**
   * Replace the entire world. Called on every scenario / body-count change and
   * on every engine hot-swap, so it must fully release the previous world.
   */
  build(desc: WorldDesc): void;
  /** Advance exactly one fixed step of `dt` seconds. */
  step(dt: number): void;
  /** Index-aligned with `WorldDesc.bodies`. */
  readStates(): BodyState[];
  /** Optional extra poke used by the interaction tools. */
  applyImpulse?(index: number, impulse: Vec3, point?: Vec3): void;
  stats?(): EngineStats;
  dispose(): void;
}

export interface EngineModuleStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
  /** Milliseconds spent in init() - a real, comparable metric. */
  initMs?: number;
}
