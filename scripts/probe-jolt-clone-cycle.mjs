/**
 * Regression probe: does cloning BodyIDs survive repeated world rebuilds?
 *
 * The adapter destroys only the JoltInterface because releasing embind objects
 * by hand corrupted the class table on the next world. Cloning introduces one
 * small embind object per body, so this checks two things across 24 rebuilds:
 *
 *   1. no class-table corruption (a rebuild would throw)
 *   2. no wasm heap growth (a leak would show as a rising HEAPU8 length)
 *
 * Run: node probe-jolt-clone-cycle.mjs
 */
const mod = await import('jolt-physics');
const JoltInit = mod.default ?? mod;
const J = await JoltInit();

const heap = () => J.HEAPU8.byteLength;

function buildOnce(bodies) {
  const settings = new J.JoltSettings();
  settings.mMaxBodies = Math.max(1024, bodies * 4 + 512);
  settings.mMaxBodyPairs = Math.max(1024, bodies * 8 + 1024);
  settings.mMaxContactConstraints = Math.max(1024, bodies * 8 + 1024);
  settings.mMaxWorkerThreads = 0;
  const bpLayers = new J.BroadPhaseLayerInterfaceTable(2, 2);
  bpLayers.MapObjectToBroadPhaseLayer(0, 0);
  bpLayers.MapObjectToBroadPhaseLayer(1, 1);
  const pairFilter = new J.ObjectLayerPairFilterTable(2);
  pairFilter.EnableCollision(0, 0);
  pairFilter.EnableCollision(0, 1);
  const vsFilter = new J.ObjectVsBroadPhaseLayerFilterTable(bpLayers, 2, pairFilter, 2);
  settings.mBroadPhaseLayerInterface = bpLayers;
  settings.mObjectLayerPairFilter = pairFilter;
  settings.mObjectVsBroadPhaseLayerFilter = vsFilter;

  const jolt = new J.JoltInterface(settings);
  const ps = jolt.GetPhysicsSystem();
  const bi = ps.GetBodyInterface();
  ps.SetGravity(new J.Vec3(0, -9.81, 0));

  const gs = new J.BoxShapeSettings(new J.Vec3(60, 0.5, 60), 0.02);
  const gShape = gs.Create().Get();
  bi.CreateAndAddBody(
    new J.BodyCreationSettings(gShape, new J.RVec3(0, -0.5, 0), new J.Quat(0, 0, 0, 1), J.EMotionType_Static, 1),
    J.EActivation_DontActivate,
  );

  const bs = new J.BoxShapeSettings(new J.Vec3(0.5, 0.5, 0.5), 0.02);
  const bShape = bs.Create().Get();
  const ids = [];
  for (let i = 0; i < bodies; i++) {
    const bcs = new J.BodyCreationSettings(
      bShape,
      new J.RVec3((i % 10) - 5, 1 + Math.floor(i / 10), 0),
      new J.Quat(0, 0, 0, 1),
      J.EMotionType_Dynamic,
      0,
    );
    const id = bi.CreateAndAddBody(bcs, J.EActivation_Activate);
    ids.push(id.Clone()); // the fix
  }

  for (let s = 0; s < 120; s++) jolt.Step(1 / 60, 1);

  const poses = [];
  const p = new J.RVec3(0, 0, 0);
  const r = new J.Quat(0, 0, 0, 1);
  for (const id of ids) {
    bi.GetPositionAndRotation(id, p, r);
    poses.push([p.GetX(), p.GetY()]);
  }

  const xSpread = Math.max(...poses.map((q) => q[0])) - Math.min(...poses.map((q) => q[0]));
  const ySpread = Math.max(...poses.map((q) => q[1])) - Math.min(...poses.map((q) => q[1]));

  J.destroy(jolt);
  return { xSpread, ySpread, first: poses[0], last: poses[poses.length - 1] };
}

const BODIES = 40;
console.log(`--- ${24} consecutive worlds, ${BODIES} bodies each, ids cloned ---`);
const heaps = [];
for (let w = 0; w < 24; w++) {
  let res;
  try {
    res = buildOnce(BODIES);
  } catch (e) {
    console.log(`  world ${w}: THREW ${e.message}`);
    break;
  }
  heaps.push(heap());
  if (w < 3 || w === 23) {
    console.log(
      `  world ${String(w).padStart(2)}: heap=${(heaps[w] / 1048576).toFixed(1)}MB ` +
        `xSpread=${res.xSpread.toFixed(2)} ySpread=${res.ySpread.toFixed(2)} ` +
        `first=(${res.first[0].toFixed(2)},${res.first[1].toFixed(2)}) ` +
        `last=(${res.last[0].toFixed(2)},${res.last[1].toFixed(2)})`,
    );
  }
}

const min = Math.min(...heaps);
const max = Math.max(...heaps);
console.log(`--- heap: ${(min / 1048576).toFixed(1)}MB -> ${(max / 1048576).toFixed(1)}MB ---`);
console.log(`--- verdict: ${max - min < 2 * 1048576 ? 'STABLE (no leak)' : 'GREW by ' + ((max - min) / 1048576).toFixed(1) + 'MB'} ---`);
console.log('--- poses distinct? ' + (heaps.length ? 'see spreads above (want > 0)' : 'n/a') + ' ---');
