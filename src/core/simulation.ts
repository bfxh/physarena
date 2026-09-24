import type { BodyDesc, BodyState, FluidSpec, IPhysicsEngine, Vec3, WorldDesc } from './types';
import { RollingWindow, type TimingSummary } from './stats';
import { FluidSolver, WATER, type FluidConfig, type FluidObstacle } from '../fluid/pbf';
import type { Scenario } from '../scenarios/types';

export interface SimulationOptions {
  scenario: Scenario;
  bodies: number;
  seed: number;
  gravity: Vec3;
}

/**
 * Owns exactly one engine instance and drives it with a fixed-step accumulator.
 *
 * The accumulator lives here rather than inside the engines on purpose: every
 * engine then receives the identical dt sequence, which is what makes the
 * timings and the resulting trajectories comparable.
 */
export class Simulation {
  engine: IPhysicsEngine | null = null;
  world: WorldDesc | null = null;
  opts: SimulationOptions;

  fixedDt = 1 / 60;
  maxSubSteps = 4;
  paused = false;

  steps = 0;
  simTime = 0;
  accumulator = 0;
  lastStepMs = 0;
  peakStepMs = 0;

  /** Rolling per-step timings for the live readout. */
  readonly window = new RollingWindow(240);
  /** Total time spent inside engine.step() for the whole run. */
  totalStepMs = 0;

  private states: ReturnType<IPhysicsEngine['readStates']> = [];
  /**
   * The PBF solver for scenes that contain a fluid volume, else null.
   *
   * Fluids are stepped here rather than by an engine: none of the nine
   * solvers implements SPH, and a pile of rigid spheres is not a fluid -
   * it has no pressure term, so it will not level out or pour.
   * See src/fluid/pbf.ts.
   */
  private fluid: FluidSolver | null = null;
  /** Rigid bodies handed to the engine; fluid particles follow them in states. */
  rigidCount = 0;

  constructor(opts: SimulationOptions) {
    this.opts = opts;
  }

  /** (Re)builds the world from the current scenario on the current engine. */
  rebuild(): void {
    if (!this.engine) return;
    const builder = this.opts.scenario.build({
      bodies: this.opts.bodies,
      seed: this.opts.seed,
      gravity: this.opts.gravity,
    });
    builder.gravity = this.opts.gravity;
    const world = builder.finish();
    this.world = world;
    this.extent = builder.extent;
    this.groundSize = builder.groundSize;
    this.contentRadius = builder.contentRadius;
    this.contentCenter = builder.contentCenter;
    this.dynamicCount = builder.dynamicCount;

    const rigid = world.bodies.filter((b) => !b.fluid);
    const particles = world.bodies.filter((b) => b.fluid);
    const t0 = performance.now();
    // The engine is handed the rigid bodies only. Fluid particles are stepped
    // by the PBF solver instead; letting an engine integrate them too would
    // fight the solver and double-count contact forces.
    this.engine.build({ ...world, bodies: rigid });
    this.buildMs = performance.now() - t0;

    this.fluid = this.buildFluid(world.fluid, particles);
    this.rigidCount = rigid.length;
    this.states = this.engine.readStates();
    this.resetClock();
  }

  /**
   * Creates the PBF solver for a scene's fluid volume, if it has one.
   *
   * Returns null when the scene has no fluid (the common case), so every
   * existing scenario runs through exactly the path it did before.
   */
  private buildFluid(spec: FluidSpec | undefined, particles: BodyDesc[]): FluidSolver | null {
    if (!spec || particles.length === 0) return null;
    const cfg: FluidConfig = {
      ...WATER,
      restDensity: spec.restDensity ?? WATER.restDensity,
      h: spec.h ?? WATER.h,
      spacing: spec.spacing ?? WATER.spacing,
      iterations: spec.iterations ?? WATER.iterations,
      vorticity: spec.vorticity ?? WATER.vorticity,
      viscosity: spec.viscosity ?? WATER.viscosity,
      sCorrDeltaQ: (spec.spacing ?? WATER.spacing) * 0.2 * (spec.h ?? WATER.h),
    };
    const solver = new FluidSolver(cfg, particles.length);
    solver.setBounds(0, spec.halfX, spec.halfZ, spec.ceiling);
    solver.setGravity(this.opts.gravity);
    for (const p of particles) {
      solver.addParticle(
        p.position[0], p.position[1], p.position[2],
        p.velocity?.[0] ?? 0, p.velocity?.[1] ?? 0, p.velocity?.[2] ?? 0,
      );
    }
    // Static scenery becomes fluid obstacles, so liquid poured onto a ramp
    // actually runs down it instead of passing through.
    const boxes: FluidObstacle[] = [];
    for (const b of this.world?.bodies ?? []) {
      if (b.type !== 'static') continue;
      if (b.shape.kind !== 'box') continue;
      const half = b.shape.halfExtents;
      boxes.push({
        min: [b.position[0] - half[0], b.position[1] - half[1], b.position[2] - half[2]],
        max: [b.position[0] + half[0], b.position[1] + half[1], b.position[2] + half[2]],
      });
    }
    solver.setObstacles(boxes);
    return solver;
  }

  extent = 20;
  /** Width of the visual ground plane; 0 when the scene has none. */
  groundSize = 0;
  /** Reach of the moving bodies around `contentCenter`. This is what framing should use. */
  contentRadius = 0;
  /** Centre of the moving bodies; the camera targets this, not the world origin. */
  contentCenter: Vec3 = [0, 0, 0];
  dynamicCount = 0;
  buildMs = 0;

  resetClock(): void {
    this.steps = 0;
    this.simTime = 0;
    this.accumulator = 0;
    this.lastStepMs = 0;
    this.peakStepMs = 0;
    this.totalStepMs = 0;
    this.window.clear();
  }

  /**
   * Advances by real elapsed time, running whole fixed steps only.
   * Returns how many steps were executed this frame.
   */
  advance(realDt: number): number {
    if (!this.engine || !this.world || this.paused) return 0;
    this.accumulator += Math.min(realDt, 0.25);
    let taken = 0;
    while (this.accumulator >= this.fixedDt && taken < this.maxSubSteps) {
      this.stepOnce();
      this.accumulator -= this.fixedDt;
      taken++;
    }
    if (taken === this.maxSubSteps) this.accumulator = 0;
    return taken;
  }

  /** One exact fixed step, timed. Used by both the loop and the benchmark. */
  stepOnce(): void {
    if (!this.engine) return;
    const t0 = performance.now();
    this.engine.step(this.fixedDt);
    // The fluid runs inside the same timed block on purpose: from the frame
    // budget point of view there is no difference between the engine being
    // slow and the fluid being slow, so the panel shows the combined cost.
    this.fluid?.step(this.fixedDt);
    const dt = performance.now() - t0;
    this.lastStepMs = dt;
    this.totalStepMs += dt;
    if (dt > this.peakStepMs) this.peakStepMs = dt;
    this.window.push(dt);
    this.steps++;
    this.simTime += this.fixedDt;
  }

  /** Runs n steps without timing them individually (warm-up). */
  warmup(n: number): void {
    if (!this.engine) return;
    for (let i = 0; i < n; i++) {
      this.engine.step(this.fixedDt);
      this.fluid?.step(this.fixedDt);
      this.steps++;
      this.simTime += this.fixedDt;
    }
  }

  /**
   * Engine states followed by fluid particle states.
   *
   * The order matches `world.bodies` (rigid first, fluid last - enforced in
   * SceneBuilder.finish), because renderers index their instance transforms
   * positionally. Appending rather than interleaving keeps this cheap: no
   * per-frame merge, no map, and the engine array is reused untouched.
   */
  readStates(): BodyState[] {
    if (!this.engine) return this.states;
    this.states = this.engine.readStates();
    if (!this.fluid) return this.states;
    const out: BodyState[] = this.states.slice();
    const f = this.fluid;
    for (let i = 0; i < f.count; i++) {
      const q = i * 3;
      out.push({
        position: [f.pos[q], f.pos[q + 1], f.pos[q + 2]],
        rotation: [0, 0, 0, 1],
        linearVelocity: [f.vel[q], f.vel[q + 1], f.vel[q + 2]],
        angularVelocity: [0, 0, 0],
      });
    }
    return out;
  }

  /**
   * Fluid statistics for the metrics panel, or null when the scene has none.
   *
   * `spanY` is the number that distinguishes a real fluid from a sphere pile:
   * poured in as a column and left alone, it has to shrink.
   */
  fluidStats(): {
    particles: number;
    avgNeighbours: number;
    maxNeighbours: number;
    iterations: number;
    minY: number;
    maxY: number;
    avgY: number;
    spanY: number;
  } | null {
    if (!this.fluid) return null;
    const f = this.fluid;
    return {
      particles: f.count,
      avgNeighbours: f.lastAvgNeighbours,
      maxNeighbours: f.lastMaxNeighbours,
      iterations: f.cfg.iterations,
      minY: f.lastMinY,
      maxY: f.lastMaxY,
      avgY: f.lastAvgY,
      spanY: f.lastMaxY - f.lastMinY,
    };
  }

  get timing(): TimingSummary {
    return this.window.summary();
  }

  /**
   * Coarse fingerprint of the final configuration. Two engines that agree here
   * produced the same solution to the same problem.
   */
  stateHash(): string {
    let h = 2166136261 >>> 0;
    for (const s of this.states) {
      for (let k = 0; k < 3; k++) {
        h ^= Math.round(s.position[k] * 100) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
    }
    return h.toString(16);
  }

  get notes(): string[] {
    const eng = this.engine as unknown as { notes?: Set<string>; skippedJoints?: number };
    const out: string[] = eng?.notes ? [...eng.notes] : [];
    if (eng?.skippedJoints) out.push(`跳过 ${eng.skippedJoints} 个不支持的关节`);
    return out;
  }

  dispose(): void {
    this.engine?.dispose();
    this.engine = null;
    this.world = null;
    this.states = [];
  }
}
