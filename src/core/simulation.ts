import type { IPhysicsEngine, Vec3, WorldDesc } from './types';
import { RollingWindow, type TimingSummary } from './stats';
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
    const t0 = performance.now();
    this.engine.build(world);
    this.buildMs = performance.now() - t0;
    this.states = this.engine.readStates();
    this.resetClock();
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
      this.steps++;
      this.simTime += this.fixedDt;
    }
  }

  readStates() {
    if (!this.engine) return this.states;
    this.states = this.engine.readStates();
    return this.states;
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
