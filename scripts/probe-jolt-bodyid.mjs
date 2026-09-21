/**
 * Isolated regression probe for Jolt's BodyID read path.
 *
 * `BodyInterface.CreateAndAddBody` returns the SAME JS wrapper on every call,
 * so `ids.push(bi.CreateAndAddBody(...))` stores N aliases of the last body.
 * Every pose read then reports that one body, the whole scene collapses onto a
 * point, and the pane shows only the ground plane - which reads on screen as
 * "the engine drew one giant degenerate surface".
 *
 * Run: node scripts/probe-jolt-bodyid.mjs
 * Exits non-zero if any assertion fails.
 */
const mod = await import('jolt-physics');
const JoltInit = mod.default ?? mod;
const J = await JoltInit();

function makeWorld() {
  const settings = new J.JoltSettings();
  settings.mMaxBodies = 1024;
  settings.mMaxBodyPairs = 1024;
  settings.mMaxContactConstraints = 1024;
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
  return { jolt, bi };
}

function addBox(bi, x) {
  const s = new J.BoxShapeSettings(new J.Vec3(0.5, 0.5, 0.5), 0.02);
  const shape = s.Create().Get();
  const bcs = new J.BodyCreationSettings(
    shape,
    new J.RVec3(x, 2, 0),
    new J.Quat(0, 0, 0, 1),
    J.EMotionType_Dynamic,
    0,
  );
  return bi.CreateAndAddBody(bcs, J.EActivation_Activate);
}

const XS = [-4.2, -3, -1.8, -0.6, 0.6, 1.8, 3, 4.2];
const failures = [];
const check = (ok, label, detail) => {
  if (!ok) failures.push(`${label}: ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label} - ${detail}`);
};

const { jolt, bi } = makeWorld();

// ---------------------------------------------------------------- the bug
const bare = [];
for (const x of XS) bare.push(addBox(bi, x));

check(
  bare[0] === bare[1],
  'aliasing is real',
  `bare[0]===bare[1] is ${bare[0] === bare[1]} (the binding reuses one wrapper)`,
);

const readX = (ids) =>
  ids.map((id) => {
    const p = new J.RVec3(0, 0, 0);
    const r = new J.Quat(0, 0, 0, 1);
    bi.GetPositionAndRotation(id, p, r);
    return Number(p.GetX().toFixed(2));
  });

const bareX = readX(bare);
check(
  new Set(bareX).size === 1,
  'bare results collapse',
  `x = [${bareX}] - all the same body`,
);

/**
 * The compatibility matrix asserts that spaced-out bodies settle at distinct x.
 * Proving this predicate discriminates keeps that probe honest: an alias read
 * must fail it, a correct read must pass it.
 */
const spreadVerdict = (xs) => {
  const distinct = new Set(xs.map((v) => Math.round(v * 10) / 10)).size;
  const spread = Math.max(...xs) - Math.min(...xs);
  return distinct >= 8 && spread >= 7;
};

// ------------------------------------------------------- the wrong "fixes"
const copiedX = readX(bare.map((id) => new J.BodyID(id)));
check(
  new Set(copiedX).size === 1,
  'new BodyID(id) is not a usable snapshot',
  `x = [${copiedX}] - the copy ctor writes garbage`,
);

// ------------------------------------------------------------- the fix
const cloned = [];
{
  const w = makeWorld();
  for (const x of XS) cloned.push(addBox(w.bi, x).Clone());
  // Read through this world's own interface - `readX` closes over the first
  // one, and ids are only meaningful to the interface that created them.
  const clonedX = cloned.map((id) => {
    const p = new J.RVec3(0, 0, 0);
    const r = new J.Quat(0, 0, 0, 1);
    w.bi.GetPositionAndRotation(id, p, r);
    return Number(p.GetX().toFixed(2));
  });
  check(
    new Set(clonedX).size === XS.length &&
      clonedX.every((v, i) => Math.abs(v - XS[i]) < 0.01),
    'Clone() gives a real snapshot',
    `x = [${clonedX}] (want [${XS}])`,
  );
  check(
    cloned[0] !== cloned[1],
    'clones are distinct objects',
    'cloned[0] !== cloned[1]',
  );

  check(
    !spreadVerdict(bareX) && spreadVerdict(clonedX),
    'spread assertion discriminates',
    `alias read -> ${new Set(bareX).size} distinct x (verdict ${spreadVerdict(bareX)}), ` +
      `clone read -> ${new Set(clonedX).size} distinct x (verdict ${spreadVerdict(clonedX)})`,
  );
  J.destroy(w.jolt);
}

J.destroy(jolt);

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length})`);
  process.exit(1);
}
console.log('all assertions passed');
