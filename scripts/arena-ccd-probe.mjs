// PhysX CCD 隔离探针：在页面里用手工最小场景验证 CCD 是否生效，
// 并测试各开关（场景标志 / body 标志 / scratch / ccdMaxPasses）的必要性。
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__bshsq, null, { timeout: 60000 });
await page.evaluate(() => window.__bshsq.selectEngine('physx5'));
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const url = performance
    .getEntriesByType('resource')
    .map((e) => e.name)
    .find((n) => n.includes('physx-js-webidl'));
  const mod = await import(url);
  const P = await (mod.default ?? mod)({ locateFile: () => '/vendor/physx/physx-js-webidl.wasm' });

  const run = ({ sceneCcd, bodyCcd, scratch, passes, speed = 240, speculative = false }) => {
    const tlf = P.PxTopLevelFunctions;
    const T = tlf && typeof tlf.CreateFoundation === 'function' ? tlf : P;
    const foundation = T.CreateFoundation(
      T.PHYSICS_VERSION,
      new P.PxDefaultAllocator(),
      new P.PxDefaultErrorCallback(),
    );
    const tol = new P.PxTolerancesScale();
    const physics = T.CreatePhysics(T.PHYSICS_VERSION, foundation, tol);
    const sd = new P.PxSceneDesc(tol);
    sd.setToDefault(tol);
    sd.gravity = new P.PxVec3(0, -9.81, 0);
    sd.cpuDispatcher = T.DefaultCpuDispatcherCreate(0);
    sd.filterShader = T.DefaultFilterShader();
    if (sceneCcd) {
      sd.flags.raise(P.PxSceneFlagEnum.eENABLE_CCD);
      sd.flags.raise(P.PxSceneFlagEnum.eENABLE_ACTIVE_ACTORS);
      sd.ccdMaxPasses = passes;
    }
    const scene = physics.createScene(sd);
    const mat = physics.createMaterial(0.5, 0.5, 0.05);
    const identity = new P.PxTransform(new P.PxVec3(0, 0, 0), new P.PxQuat(0, 0, 0, 1));
    const filterData = new P.PxFilterData(1, 0xffffffff, 0, 0);

    const addBody = (pos, half, dynamic) => {
      const tr = new P.PxTransform(new P.PxVec3(...pos), new P.PxQuat(0, 0, 0, 1));
      const actor = dynamic ? physics.createRigidDynamic(tr) : physics.createRigidStatic(tr);
      const shape = physics.createShape(
        new P.PxBoxGeometry(half[0], half[1], half[2]),
        mat,
        true,
      );
      shape.setSimulationFilterData(filterData);
      actor.attachShape(shape);
      scene.addActor(actor);
      return actor;
    };
    addBody([0, -1, 0], [60, 1, 60], false);        // ground
    addBody([0, 2, 0], [0.05, 2, 4], false);        // thin wall

    const proj = addBody([-14, 2, 0], [0.3, 0.3, 0.3], true); // box projectile, easy to read
    proj.setLinearVelocity(new P.PxVec3(speed, 0, 0), true);
    if (bodyCcd) proj.setRigidBodyFlag(P.PxRigidBodyFlagEnum.eENABLE_CCD, true);
    if (speculative) proj.setRigidBodyFlag(P.PxRigidBodyFlagEnum.eENABLE_SPECULATIVE_CCD, true);

    const scratchPtr = scratch ? P._malloc(4 * 1024 * 1024) : 0;
    for (let i = 0; i < 120; i++) {
      scene.simulate(1 / 60, null, scratchPtr, scratch ? 4 * 1024 * 1024 : 0, true);
      scene.fetchResults(true);
    }
    const pose = proj.getGlobalPose();
    const x = pose.p.x;
    const flags = proj.getRigidBodyFlags().isSet(P.PxRigidBodyFlagEnum.eENABLE_CCD);
    // cleanup
    scene.release();
    physics.release();
    foundation.release();
    return { x: Number(x.toFixed(2)), bodyFlag: flags };
  };

  return {
    all: run({ sceneCcd: true, bodyCcd: true, scratch: true, passes: 4 }),
    noScratch: run({ sceneCcd: true, bodyCcd: true, scratch: false, passes: 4 }),
    noBodyFlag: run({ sceneCcd: true, bodyCcd: false, scratch: true, passes: 4 }),
    noSceneFlag: run({ sceneCcd: false, bodyCcd: true, scratch: true, passes: 4 }),
    // Control: does the probe scene collide AT ALL? A 15 m/s box (0.25 m/step)
    // must stop at the wall.
    slowNoCcd: run({ sceneCcd: false, bodyCcd: false, scratch: false, passes: 1, speed: 15 }),
    speculative: run({ sceneCcd: true, bodyCcd: true, scratch: true, passes: 4, speculative: true }),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
