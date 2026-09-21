import type {
  BodyState, EngineMeta, EngineStats, IPhysicsEngine, Vec3, WorldDesc,
} from '../core/types';
import { quatOr } from './shared';

/**
 * Bookkeeping shared by all eight adapters: state array, fidelity notes,
 * joint-skip accounting and lifecycle ordering.
 *
 * Subclasses implement only the five engine-touching hooks.
 */
export abstract class PhysicsEngineBase implements IPhysicsEngine {
  abstract readonly meta: EngineMeta;

  protected desc: WorldDesc | null = null;
  protected states: BodyState[] = [];

  /** Fidelity warnings surfaced in the UI, e.g. "cone→凸包". */
  readonly notes = new Set<string>();
  /** Joints the engine has no equivalent for. */
  skippedJoints = 0;

  abstract init(): Promise<void>;
  protected abstract buildWorld(desc: WorldDesc): void;
  protected abstract stepWorld(dt: number): void;
  protected abstract syncStates(): void;
  protected abstract disposeWorld(): void;

  build(desc: WorldDesc): void {
    try {
      this.disposeWorld();
    } catch {
      /* a half-built world must never block the next one */
    }
    this.notes.clear();
    this.skippedJoints = 0;
    this.desc = desc;
    this.states = desc.bodies.map((b) => ({
      position: [...b.position] as Vec3,
      rotation: quatOr(b.rotation),
      linearVelocity: [0, 0, 0],
      angularVelocity: [0, 0, 0],
      sleeping: false,
    }));
    this.buildWorld(desc);
  }

  step(dt: number): void {
    this.stepWorld(dt);
  }

  readStates(): BodyState[] {
    this.syncStates();
    return this.states;
  }

  applyImpulse?(index: number, impulse: Vec3, point?: Vec3): void;
  stats?(): EngineStats;

  dispose(): void {
    try {
      this.disposeWorld();
    } catch {
      /* ignore */
    }
    this.desc = null;
    this.states = [];
  }

  /** Convenience for subclasses that only need a per-body mark. */
  protected markSkippedJoint(): void {
    this.skippedJoints++;
  }
}
