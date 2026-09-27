//! # BSHSQ-Solver ↔ PhysArena wasm 桥
//!
//! **零 unsafe** 的批量 ABI：
//! - 写路径（JS → 引擎）：逐体调用（`vxl_add_box` / `vxl_add_sphere` /
//!   `vxl_hull_push`…），只在场景构建期发生，不进热路径；
//! - 读路径（引擎 → JS）：批量打包进本 crate 自持的读缓冲（`Vec<f32>`），导出其
//!   **数据指针**；JS 侧 `new Float32Array(memory.buffer, ptr, n*7)` 建视图一次拷出。
//!   缓冲容量在世界创建时按体数预留、读数期间不重分配 ⇒ 指针稳定；全程无 unsafe。
//!
//! 固定步契约：`vxl_step(dt)` 校验 `dt == config.dt`（1/60），不等即返回错误码，
//! 绝不偷偷改变步长——「每引擎收到同一 dt 序列」由宿主保证，本桥只做校验。
//!
//! 关于 lint：本 crate 放开 `unsafe_code` **仅为 `#[unsafe(no_mangle)]` 这一
//! 属性包裹**（Rust 2024 起导出符号必须如此写），crate 内没有任何 `unsafe` 块、
//! `unsafe fn`、裸指针解引用（读路径用「Rust 侧缓冲 + 导出数据指针」实现）。
//! 引擎侧 crates 仍然 `#![forbid(unsafe_code)]`；构建脚本附带一次
//! 「零 unsafe 块」源码检查。独立的理由：这是**工具桥**（不在引擎工作区内，
//! 不进引擎纪律扫描口径）。

#![allow(unsafe_code)]

use std::cell::RefCell;

use vxl_phys::{CompoundChild, World};
use vxl_phys_core::{FrictionModel, Material, PhysConfig, Quat, Shape, Vec3};

/// ABI 版本（不兼容变更必须递增）。
const ABI_VERSION: u32 = 1;

/// 桥的全部可变状态（单线程 wasm；一处 RefCell 避免借用嵌套）。
struct Bridge {
    world: Option<World>,
    /// 位姿读缓冲（7 × n：x,y,z,qx,qy,qz,qw）。
    poses: Vec<f32>,
    /// 速度读缓冲（6 × n：vx,vy,vz,wx,wy,wz）。
    vels: Vec<f32>,
    /// 凸包点云暂存（`vxl_hull_begin/push/commit`）。
    hull: Vec<Vec3>,
    /// 复合体子形状暂存（`vxl_compound_begin/push_*/commit`）。
    cmp: Vec<CompoundChild>,
    /// 三角网暂存（`vxl_mesh_begin/push_vertex/push_tri/commit`）。
    mesh_v: Vec<Vec3>,
    mesh_t: Vec<[u32; 3]>,
}

thread_local! {
    static B: RefCell<Bridge> = const {
        RefCell::new(Bridge {
            world: None,
            poses: Vec::new(),
            vels: Vec::new(),
            hull: Vec::new(),
            cmp: Vec::new(),
            mesh_v: Vec::new(),
            mesh_t: Vec::new(),
        })
    };
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_abi() -> u32 {
    ABI_VERSION
}

/// 建世界（替换旧世界）。`ccd_threshold` ≤ 0 表示关闭 CCD。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_world_create(
    gx: f32,
    gy: f32,
    gz: f32,
    ccd_threshold: f32,
    reserve_bodies: u32,
) -> u32 {
    let mut cfg = PhysConfig::default();
    cfg.gravity = Vec3::new(gx, gy, gz);
    if ccd_threshold > 0.0 {
        cfg.ccd_speed_threshold = ccd_threshold;
    }
    B.with(|b| {
        let mut b = b.borrow_mut();
        b.world = Some(World::new(cfg));
        let cap = (reserve_bodies as usize).saturating_mul(8);
        b.poses.clear();
        b.poses.reserve(cap);
        b.vels.clear();
        b.vels.reserve(cap);
        b.hull.clear();
    });
    0
}

/// 释放世界（PhysArena 的 disposeWorld 会调用；下一次 `vxl_world_create` 亦可替换）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_world_drop() -> u32 {
    B.with(|b| {
        b.borrow_mut().world = None;
    });
    0
}

/// 体内索引 = 加入顺序（与 IR 的 bodies 序一一对应）。
fn add_body(shape: Shape, p: [f32; 3], density: f32, is_static: bool) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return u32::MAX;
        };
        let pos = Vec3::new(p[0], p[1], p[2]);
        if is_static {
            w.add_static(shape, pos, Quat::IDENTITY);
        } else {
            w.add_dynamic(shape, pos, Quat::IDENTITY, density);
        }
        (w.bodies.len() - 1) as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_add_box(
    hx: f32,
    hy: f32,
    hz: f32,
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    add_body(
        Shape::Box {
            half: Vec3::new(hx, hy, hz),
        },
        [px, py, pz],
        density,
        is_static != 0,
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_add_sphere(
    radius: f32,
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    add_body(Shape::Sphere { radius }, [px, py, pz], density, is_static != 0)
}

/// 胶囊体（局部 +Y 线段 ±half_height ⊕ 半径球）。适配层**已接线**（能力表已加 `capsule`，
/// 自检 15/4/0 → 16/3/0）；窄相走**解析最近点** `capsule_axis_reach`，见 BSHSQ-Solver
/// `EXPERIMENTS.md` R.2/R.3。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_add_capsule(
    half_height: f32,
    radius: f32,
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    add_body(
        Shape::Capsule {
            half_height,
            radius,
        },
        [px, py, pz],
        density,
        is_static != 0,
    )
}

/// 圆柱（局部 +Y：半高 `half_height`、半径 `radius`）。引擎侧与盒同族走**多面体路径**
/// （表面为多面化近似，与胶囊的解析支撑不同，见 `TECH-SURVEY.md` A9）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_add_cylinder(
    half_height: f32,
    radius: f32,
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    add_body(
        Shape::Cylinder {
            half_height,
            radius,
        },
        [px, py, pz],
        density,
        is_static != 0,
    )
}

/// 圆锥（局部 +Y：底面半径 `radius` 在 `−half_height`、顶点在 `+half_height`）。引擎侧
/// 走**多面化**路径（16 面棱锥近似，与圆柱同族）；锥侧面是光滑面，不走 EPA（见 A9 记录）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_add_cone(
    half_height: f32,
    radius: f32,
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    add_body(
        Shape::Cone {
            half_height,
            radius,
        },
        [px, py, pz],
        density,
        is_static != 0,
    )
}

// ---- 复合体（子形状 = 球/盒 + 局部偏移；探针所需，要更多类型再扩）----------------

#[unsafe(no_mangle)]
pub extern "C" fn vxl_compound_begin() -> u32 {
    B.with(|b| b.borrow_mut().cmp.clear());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_compound_push_sphere(radius: f32, ox: f32, oy: f32, oz: f32) -> u32 {
    B.with(|b| {
        b.borrow_mut().cmp.push(CompoundChild {
            shape: Shape::Sphere { radius },
            offset: Vec3::new(ox, oy, oz),
            rot: Quat::IDENTITY,
        })
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_compound_push_box(hx: f32, hy: f32, hz: f32, ox: f32, oy: f32, oz: f32) -> u32 {
    B.with(|b| {
        b.borrow_mut().cmp.push(CompoundChild {
            shape: Shape::Box {
                half: Vec3::new(hx, hy, hz),
            },
            offset: Vec3::new(ox, oy, oz),
            rot: Quat::IDENTITY,
        })
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_compound_commit(
    px: f32,
    py: f32,
    pz: f32,
    density: f32,
    is_static: u32,
) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let kids = std::mem::take(&mut b.cmp);
        let Some(w) = b.world.as_mut() else {
            return u32::MAX;
        };
        if kids.is_empty() {
            return u32::MAX;
        }
        let cid = w.add_compound(kids);
        let pos = Vec3::new(px, py, pz);
        if is_static != 0 {
            w.add_compound_static(cid, pos, Quat::IDENTITY);
        } else {
            w.spawn_compound_body(cid, pos, Quat::IDENTITY, density);
        }
        (w.bodies.len() - 1) as u32
    })
}

/// 每体材质（摩擦/恢复），体创建后立刻调用。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_body_material(index: u32, friction: f32, restitution: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        let i = index as usize;
        if i >= w.bodies.len() {
            return 1;
        }
        let m = w.add_material(Material {
            friction: FrictionModel::Coulomb { mu: friction },
            restitution,
        });
        w.bodies.set_material(i, m);
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_set_rotation(index: u32, x: f32, y: f32, z: f32, wq: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        let i = index as usize;
        if i >= w.bodies.len() {
            return 1;
        }
        w.bodies.set_rot(i, Quat { x, y, z, w: wq });
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_set_linvel(index: u32, x: f32, y: f32, z: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        let i = index as usize;
        if i >= w.bodies.len() {
            return 1;
        }
        w.bodies.set_linvel(i, Vec3::new(x, y, z));
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_set_angvel(index: u32, x: f32, y: f32, z: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        let i = index as usize;
        if i >= w.bodies.len() {
            return 1;
        }
        w.bodies.set_angvel(i, Vec3::new(x, y, z));
        0
    })
}

// ---- 凸包（点云分块传入，避免任何指针入参）-------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn vxl_hull_begin() -> u32 {
    B.with(|b| b.borrow_mut().hull.clear());
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_hull_push(x: f32, y: f32, z: f32) -> u32 {
    B.with(|b| b.borrow_mut().hull.push(Vec3::new(x, y, z)));
    0
}

/// 用已压入的点云建一个**动态**凸包体；返回体内索引（`u32::MAX` = 失败）。
/// 静态凸包请由适配器降级为盒（本引擎的壳路径是动态体）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_hull_commit(px: f32, py: f32, pz: f32, density: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        // Length check BEFORE taking: a failed commit must leave the pushed
        // points in place (the adapter may retry or the caller may inspect).
        if b.hull.len() < 4 {
            return u32::MAX;
        }
        let pts = std::mem::take(&mut b.hull);
        let Some(w) = b.world.as_mut() else {
            return u32::MAX;
        };
        let hull = w.add_hull(pts);
        w.spawn_hull_body(hull, Vec3::new(px, py, pz), Quat::IDENTITY, density);
        (w.bodies.len() - 1) as u32
    })
}

// ---- 三角网（顶点/索引分块传入，零指针）-----------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn vxl_mesh_begin() -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        b.mesh_v.clear();
        b.mesh_t.clear();
    });
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_mesh_push_vertex(x: f32, y: f32, z: f32) -> u32 {
    B.with(|b| b.borrow_mut().mesh_v.push(Vec3::new(x, y, z)));
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_mesh_push_tri(a: u32, b: u32, c: u32) -> u32 {
    B.with(|br| br.borrow_mut().mesh_t.push([a, b, c]));
    0
}

/// 用已压入的顶点/三角形建一张**静态三角网**提供者（`vxl-phys-terrain::TriMesh`
/// 薄壳语义 + 均匀网格加速）。返回 0 = 成功，1 = 数据不足/失败。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_mesh_commit() -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        if b.mesh_v.len() < 3 || b.mesh_t.is_empty() {
            return 1;
        }
        let verts = std::mem::take(&mut b.mesh_v);
        let tris = std::mem::take(&mut b.mesh_t);
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        let mesh = vxl_phys_terrain::mesh::TriMesh::new(verts, tris);
        w.add_mesh(mesh);
        0
    })
}

// ---- 关节（§2.5 约束族） --------------------------------------------------

/// 关节类型码（桥↔适配器约定）：0 球 / 1 转动 / 2 固定 / 3 棱柱 / 4 距离。
///
/// 锚点与轴均为**体局部量**（与 PhysArena 的 `JointDesc` 同口径）：
/// 局部轴按各自体的姿态进世界系 ⇒ yaw 旋转过的刚体（如布娃娃的四肢）也能
/// 拿到正确的折弯轴，不需要调用方预先把轴转好。
/// 返回 0 = 成功，1 = 无世界，2 = 体索引越界。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_joint_add(
    kind: u32,
    a: u32,
    b: u32,
    ahx: f32,
    ahy: f32,
    ahz: f32,
    bhx: f32,
    bhy: f32,
    bhz: f32,
    ax: f32,
    ay: f32,
    az: f32,
    rest: f32,
) -> u32 {
    // 走门面再导出（桥不直接依赖 solver crate：依赖面越小越好）。
    use vxl_phys::{Joint, JointKind};
    let k = match kind {
        0 => JointKind::Spherical,
        1 => JointKind::Revolute,
        2 => JointKind::Fixed,
        3 => JointKind::Prismatic,
        4 => JointKind::Distance,
        _ => return 3,
    };
    B.with(|br| {
        let mut br = br.borrow_mut();
        let Some(w) = br.world.as_mut() else {
            return 1;
        };
        let n = w.bodies.len() as u32;
        if a >= n || b >= n {
            return 2;
        }
        let mut j = Joint::new(
            k,
            a,
            b,
            Vec3::new(ahx, ahy, ahz),
            Vec3::new(bhx, bhy, bhz),
        );
        // 零轴/退化轴不交给 perp_basis（归一化会产生 NaN）——退回局部 X 轴。
        let axis = Vec3::new(ax, ay, az);
        if axis.length() > 1e-6 {
            j = j.with_axis(axis.normalize());
        }
        if k == JointKind::Distance {
            j = j.with_rest(rest);
        }
        w.add_joint(j);
        0
    })
}

/// 给已创建的关节装**马达**（转动：目标角速度 rad/s；棱柱：目标线速度 m/s；
/// `max_force <= 0` = 关闭）。关节索引 = `vxl_joint_add` 的调用序号（0 起，
/// 与适配器的添加顺序一致）。返回 0 = 成功，1 = 无世界，2 = 关节索引越界。
///
/// 独立导出而非加 `vxl_joint_add` 的参数：**不动既有 ABI arity** ⇒ 老调用方
/// （只建关节不装马达）不需要改。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_joint_motor(joint: u32, target: f32, max_force: f32) -> u32 {
    B.with(|br| {
        let mut br = br.borrow_mut();
        let Some(w) = br.world.as_mut() else {
            return 1;
        };
        let Some(j) = w.joints.joints.get_mut(joint as usize) else {
            return 2;
        };
        j.motor_target = target;
        j.motor_max_force = max_force;
        0
    })
}

/// 给已创建的关节装**限位**：转动 = 绕自由轴的相对转角（rad）；棱柱 = 沿轴的
/// 行程（m）；`lower >= upper` 视为未设。关节索引 = `vxl_joint_add` 的调用序号。
/// 返回 0 = 成功，1 = 无世界，2 = 关节索引越界。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_joint_limit(joint: u32, lower: f32, upper: f32) -> u32 {
    B.with(|br| {
        let mut br = br.borrow_mut();
        let Some(w) = br.world.as_mut() else {
            return 1;
        };
        let Some(j) = w.joints.joints.get_mut(joint as usize) else {
            return 2;
        };
        j.limit_lower = lower;
        j.limit_upper = upper;
        0
    })
}

// ---- 推进与读取 -----------------------------------------------------------

/// 推进一个 tick；`dt` 必须等于引擎固定步（1/60），否则返回 1。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_step(dt: f32) -> u32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Some(w) = b.world.as_mut() else {
            return 1;
        };
        if (w.config.dt - dt).abs() > 1e-6 {
            return 1;
        }
        w.step();
        0
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_body_count() -> u32 {
    B.with(|b| b.borrow().world.as_ref().map(|w| w.bodies.len() as u32).unwrap_or(0))
}

/// 位姿块指针（7 × n）；缓冲不足会扩容（仅在世界重建后发生）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_read_poses() -> *const f32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        // Destructure so the read buffer and the world are borrowed independently.
        let Bridge { world, poses, .. } = &mut *b;
        let n = world.as_ref().map(|w| w.bodies.len()).unwrap_or(0);
        if poses.len() < n * 7 {
            poses.resize(n * 7, 0.0);
        }
        if let Some(w) = world.as_ref() {
            for i in 0..n {
                let (p, q) = w.bodies.pose(i);
                let o = i * 7;
                poses[o] = p.x;
                poses[o + 1] = p.y;
                poses[o + 2] = p.z;
                poses[o + 3] = q.x;
                poses[o + 4] = q.y;
                poses[o + 5] = q.z;
                poses[o + 6] = q.w;
            }
        }
        poses.as_ptr()
    })
}

/// 速度块指针（6 × n），约定同 `vxl_read_poses`。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_read_velocities() -> *const f32 {
    B.with(|b| {
        let mut b = b.borrow_mut();
        let Bridge { world, vels, .. } = &mut *b;
        let n = world.as_ref().map(|w| w.bodies.len()).unwrap_or(0);
        if vels.len() < n * 6 {
            vels.resize(n * 6, 0.0);
        }
        if let Some(w) = world.as_ref() {
            for i in 0..n {
                let v = w.bodies.linvel[i];
                let a = w.bodies.linvel.ang(i);
                let o = i * 6;
                vels[o] = v.x;
                vels[o + 1] = v.y;
                vels[o + 2] = v.z;
                vels[o + 3] = a.x;
                vels[o + 4] = a.y;
                vels[o + 5] = a.z;
            }
        }
        vels.as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn vxl_is_dynamic(index: u32) -> u32 {
    B.with(|b| {
        b.borrow()
            .world
            .as_ref()
            .map(|w| u32::from(w.bodies.is_dynamic(index as usize)))
            .unwrap_or(0)
    })
}

/// 1 = 休眠（仅动态体有意义；静态/越界一律 0）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_sleeping(index: u32) -> u32 {
    B.with(|b| {
        let b = b.borrow();
        let Some(w) = b.world.as_ref() else {
            return 0;
        };
        let i = index as usize;
        if i >= w.bodies.len() || !w.bodies.is_dynamic(i) {
            return 0;
        }
        u32::from(!w.bodies.awake[i])
    })
}

/// 已推进 tick 数（诊断）。
#[unsafe(no_mangle)]
pub extern "C" fn vxl_tick() -> u32 {
    B.with(|b| b.borrow().world.as_ref().map(|w| w.tick as u32).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_version_exposed() {
        assert_eq!(vxl_abi(), ABI_VERSION);
    }

    #[test]
    fn world_build_step_read_circle() {
        // 1 静态地 + 1 动态盒：建立 → 推进一步 → 读回位姿。
        vxl_world_create(0.0, -9.81, 0.0, 0.0, 4);
        let ground = vxl_add_box(5.0, 1.0, 5.0, 0.0, -1.0, 0.0, 1000.0, 1);
        let body = vxl_add_box(0.5, 0.5, 0.5, 0.0, 3.0, 0.0, 500.0, 0);
        assert_eq!(ground, 0);
        assert_eq!(body, 1);
        assert_eq!(vxl_body_count(), 2);
        assert_eq!(vxl_step(1.0 / 60.0), 0);
        assert_eq!(vxl_step(1.0 / 30.0), 1, "步长不等于固定步必须报错");

        // 读路径：指针 + 长度约定（JS 侧同构）。
        let n = vxl_body_count() as usize;
        let ptr = vxl_read_poses();
        assert!(!ptr.is_null());
        let reads = B.with(|b| {
            let b = b.borrow();
            (b.poses.len(), b.poses[7 + 1])
        });
        assert_eq!(reads.0, n * 7, "位姿块长度 = 7 × 体数");
        assert!(reads.1 < 3.0, "自由落体应开始下落：y={}", reads.1);
    }

    #[test]
    fn hull_commit_needs_four_points() {
        vxl_world_create(0.0, -9.81, 0.0, 0.0, 1);
        vxl_hull_begin();
        vxl_hull_push(0.0, 0.0, 0.0);
        assert_eq!(vxl_hull_commit(0.0, 1.0, 0.0, 500.0), u32::MAX);
        vxl_hull_push(1.0, 0.0, 0.0);
        vxl_hull_push(0.0, 1.0, 0.0);
        vxl_hull_push(0.0, 0.0, 1.0);
        assert_ne!(vxl_hull_commit(0.0, 1.0, 0.0, 500.0), u32::MAX);
    }
}
