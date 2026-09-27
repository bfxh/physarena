// PhysX 圆柱落体隔离探针：几何类型 + 180 步后的静止高度。
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
  const tlf = P.PxTopLevelFunctions;
  const T = tlf && typeof tlf.CreateFoundation === 'function' ? tlf : P;
  const foundation = T.CreateFoundation(T.PHYSICS_VERSION, new P.PxDefaultAllocator(), new P.PxDefaultErrorCallback());
  const tol = new P.PxTolerancesScale();
  const physics = T.CreatePhysics(T.PHYSICS_VERSION, foundation, tol);

  const run = (geomKind) => {
    const sd = new P.PxSceneDesc(tol);
    sd.setToDefault(tol);
    sd.gravity = new P.PxVec3(0, -9.81, 0);
    sd.cpuDispatcher = T.DefaultCpuDispatcherCreate(0);
    sd.filterShader = T.DefaultFilterShader();
    const scene = physics.createScene(sd);
    const mat = physics.createMaterial(0.7, 0.05, 0.05);
    const fd = new P.PxFilterData(1, 0xffffffff, 0, 0);
    const mk = (pos, geom, dynamic) => {
      const tr = new P.PxTransform(new P.PxVec3(...pos), new P.PxQuat(0, 0, 0, 1));
      const a = dynamic ? physics.createRigidDynamic(tr) : physics.createRigidStatic(tr);
      const s = physics.createShape(geom, mat, true);
      s.setSimulationFilterData(fd);
      a.attachShape(s);
      scene.addActor(a);
      return { a, s };
    };
    mk([0, -1, 0], new P.PxBoxGeometry(30, 1, 30), false);
    const geom = geomKind === 'cylinder'
      ? new P.PxCylinderGeometry(0.4, 0.4)
      : new P.PxBoxGeometry(0.4, 0.4, 0.4);
    const { a, s } = mk([0, 5, 0], geom, true);
    const type = s.getGeometryType();
    for (let i = 0; i < 180; i++) {
      scene.simulate(1 / 60, null, 0, 0, true);
      scene.fetchResults(true);
    }
    const pose = a.getGlobalPose();
    const quat = pose.q;
    const res = {
      y: Number(pose.p.y.toFixed(3)),
      x: Number(pose.p.x.toFixed(3)),
      z: Number(pose.p.z.toFixed(3)),
      quat: [Number(quat.x.toFixed(3)), Number(quat.y.toFixed(3)), Number(quat.z.toFixed(3)), Number(quat.w.toFixed(3))],
      geomType: type,
    };
    scene.release();
    return res;
  };

  return {
    cylinder: run('cylinder'),
    box: run('box'),
    // enum sanity: what does eGEOMETRY_CYLINDER resolve to?
    cylinderEnum: P.PxGeometryTypeEnum?.eGEOMETRY_CYLINDER,
    boxEnum: P.PxGeometryTypeEnum?.eGEOMETRY_BOX,
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
