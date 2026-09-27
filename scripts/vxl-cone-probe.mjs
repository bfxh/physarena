// BSHSQ-Solver 圆锥落体直测：读回位姿后把 hull 顶点转到世界系，量最低点相对地面的高度
// （判定「深穿透 = 引擎接触缺陷」还是「侧躺 = 合法姿态」）。
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => !!window.__bshsq, null, { timeout: 60000 });

const out = await page.evaluate(async () => {
  const res = await fetch('/vendor/vxl/vxl_phys_wasm.wasm');
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  const ex = instance.exports;

  // 与 BSHSQ 的 cone→凸包 降级链一致：coneHullPoints(0.4, 0.5)。
  const pts = [0, 0.5, 0];
  const seg = 16;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(Math.cos(a) * 0.4, -0.5, Math.sin(a) * 0.4);
  }

  ex.vxl_world_create(0, -9.81, 0, 0, 4);
  ex.vxl_add_box(30, 1, 30, 0, -1, 0, 1000, 1);         // 地面：顶面 y=0
  ex.vxl_hull_begin();
  for (let i = 0; i + 2 < pts.length; i += 3) ex.vxl_hull_push(pts[i], pts[i + 1], pts[i + 2]);
  const idx = ex.vxl_hull_commit(0, 5, 0, 1000);
  ex.vxl_body_material(idx, 0.7, 0.05);

  const yHist = [];
  for (let step = 0; step < 180; step++) {
    ex.vxl_step(1 / 60);
    const buf = ex.memory.buffer;
    const poses = new Float32Array(buf, ex.vxl_read_poses(), 2 * 7);
    yHist.push(poses[7 + 1]);
  }
  const buf = ex.memory.buffer;
  const poses = new Float32Array(buf, ex.vxl_read_poses(), 2 * 7);
  const [rho_x, rho_y, rho_z, qx, qy, qz, qw] = [poses[7], poses[8], poses[9], poses[10], poses[11], poses[12], poses[13]];

  // 四元数旋转每个局部点到世界系，取最低 y。
  const rot = (x, y, z) => {
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    return [
      x + qw * tx + (qy * tz - qz * ty),
      y + qw * ty + (qz * tx - qx * tz),
      z + qw * tz + (qx * ty - qy * tx),
    ];
  };
  let minY = Infinity;
  for (let i = 0; i + 2 < pts.length; i += 3) {
    const [wx, wy, wz] = rot(pts[i], pts[i + 1], pts[i + 2]);
    minY = Math.min(minY, wy + rho_y);
  }
  return {
    restY: Number(rho_y.toFixed(4)),
    quat: [qx, qy, qz, qw].map((v) => Number(v.toFixed(3))),
    lowestHullVertexY: Number(minY.toFixed(4)),
    penetration: Number((-minY).toFixed(4)),
    yAtStep30: Number(yHist[30].toFixed(3)),
    yAtStep90: Number(yHist[90].toFixed(3)),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
