import { DYNAMICS_SCENARIOS } from './dynamics';
import { HAVOC_SCENARIOS } from './havoc';
import { JOINT_SCENARIOS } from './joints';
import { SHAPE_SCENARIOS } from './shapes';
import { STACKING_SCENARIOS } from './stacking';
import { STRESS_SCENARIOS } from './stress';
import { PBF_SCENARIOS } from '../fluid/scenarios';
import type { Scenario, ScenarioGroup } from './types';

export * from './types';
export { SceneBuilder, rng, heightfieldMesh, icosaPoints, rockPoints } from './kit';

export const SCENARIOS: Scenario[] = [
  ...STACKING_SCENARIOS,
  ...DYNAMICS_SCENARIOS,
  ...JOINT_SCENARIOS,
  ...STRESS_SCENARIOS,
  ...HAVOC_SCENARIOS,
  ...PBF_SCENARIOS,
  ...SHAPE_SCENARIOS,
];

export function scenariosByGroup(): Map<ScenarioGroup, Scenario[]> {
  const m = new Map<ScenarioGroup, Scenario[]>();
  for (const s of SCENARIOS) {
    const list = m.get(s.group) ?? [];
    list.push(s);
    m.set(s.group, list);
  }
  return m;
}

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario: ${id}`);
  return s;
}
