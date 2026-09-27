//! **桥的原生驱动**（诊断）：把 BSHSQ 走的桥路径在本机跑一遍，用来二分
//! "引擎物理 vs 桥/适配层"——见 `TECH-SURVEY.md` A9 的缺口记录。
//!
//! 复刻浏览器自检 `shape-capsule` 的场景与调用序（`ground(60,1,0)` +
//! 一个 capsule 从 y=5 落下 + 材质 + 180 步 @1/60）。
//!
//! 用法：`cargo run --release --example capsule_probe`
//!   ⇒ 打印每 15 步的 y/速度。判定：末态应 ≈ 0.695（= half_height + radius）。

use vxl_phys_wasm::*;

fn pose_y(poses: &[f32], i: usize) -> f32 {
    poses[i * 7 + 1]
}

fn main() {
    let dt = 1.0f32 / 60.0;
    println!("[bridge-probe] ABI={}", vxl_abi());
    vxl_world_create(0.0, -9.81, 0.0, 0.0, 4);

    // 地板：与 arena `ground(60, 1, 0)` 同几何（半 30×1×30，中心 (0,-1,0) ⇒ 顶面 y=0）——
    // 静态体经 `vxl_add_box(..., is_static=1)`（与适配层的 `case 'box'` 同路径）。
    let g = vxl_add_box(30.0, 1.0, 30.0, 0.0, -1.0, 0.0, 1000.0, 1);
    // 探针体：capsule（radius 0.3、halfHeight 0.4）从 y=5 落下，动态。
    let c = vxl_add_capsule(0.4, 0.3, 0.0, 5.0, 0.0, 1000.0, 0);
    println!("[bridge-probe] ground idx={g} capsule idx={c} bodies={}", vxl_body_count());

    // 适配层对每个体都调材质（摩擦 0.7 / 恢复 0.05，探针场景的口径）。
    // **MU / E 可用环境变量覆盖**（NO_MATERIAL=1 完全不设）：用来二分是哪一个参数触发穿地。
    if std::env::var("NO_MATERIAL").is_err() {
        let mu: f32 = std::env::var("MU").ok().and_then(|s| s.parse().ok()).unwrap_or(0.7);
        let e: f32 = std::env::var("E").ok().and_then(|s| s.parse().ok()).unwrap_or(0.05);
        println!("[bridge-probe] 材质 μ={mu} e={e}");
        vxl_body_material(g, mu, e);
        vxl_body_material(c, mu, e);
    } else {
        println!("[bridge-probe] ⚠️ 未设置材质（NO_MATERIAL=1）");
    }

    let mut last = 5.0f32;
    for t in 1..=180 {
        let rc = vxl_step(dt);
        if rc != 0 {
            println!("[bridge-probe] ⚠️ vxl_step 返回 {rc}（dt 不匹配？）");
            break;
        }
        if t % 15 == 0 {
            // SAFETY: 桥保证指针在下次世界变更前有效（4 体 × 7 f32）。
            let poses = unsafe { std::slice::from_raw_parts(vxl_read_poses(), 4 * 7) };
            let vels = unsafe { std::slice::from_raw_parts(vxl_read_velocities(), 4 * 3) };
            let y = pose_y(poses, c as usize);
            let v = (vels[c as usize * 3].powi(2)
                + vels[c as usize * 3 + 1].powi(2)
                + vels[c as usize * 3 + 2].powi(2))
            .sqrt();
            println!("t={t:3} y={y:8.3} |v|={v:7.3} sleeping={}", vxl_sleeping(c));
            last = y;
        }
    }
    println!("[bridge-probe] 末态 y={last:.3}（期望 ≈0.695 = half_height+radius）");
}
