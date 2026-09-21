import type { Vec3 } from '../core/types';
import type { SceneBuilder } from './kit';

export interface BuildContext {
  /** Total dynamic bodies the user asked for (load slider). */
  bodies: number;
  seed: number;
  gravity: Vec3;
}

export interface Scenario {
  id: string;
  name: string;
  group: ScenarioGroup;
  /** What this scene actually stresses - shown in the UI so results are readable. */
  description: string;
  /** Bodies used when the scenario is first opened. */
  defaultBodies: number;
  /** Upper bound accepted by the slider for this scene. */
  maxBodies: number;
  /** false => the slider is ignored, the scene is a fixed showcase. */
  scalable: boolean;
  build(ctx: BuildContext): SceneBuilder;
}

export type ScenarioGroup =
  | '堆叠与结构'
  | '经典动力学'
  | '约束与关节'
  | '极端工况'
  | '破坏与流体'
  | '碰撞形状';

export const SCENARIO_GROUPS: ScenarioGroup[] = [
  '堆叠与结构',
  '经典动力学',
  '约束与关节',
  '极端工况',
  '破坏与流体',
  '碰撞形状',
];

/** Number of levels in a triangular stack that holds roughly `n` bodies. */
export function triangularLevels(n: number): number {
  let l = 1;
  while ((l * (l + 1)) / 2 < n) l++;
  return Math.max(2, Math.min(l, 40));
}

/** Distribute `n` bodies over `levels`, biggest level first. */
export function levelsOf(n: number, levels: number): number[] {
  const out: number[] = [];
  const total = (levels * (levels + 1)) / 2;
  for (let i = 0; i < levels; i++) {
    out.push(Math.max(1, Math.round((n * (levels - i)) / total)));
  }
  return out;
}
