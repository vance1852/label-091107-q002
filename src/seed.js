/**
 * 首次启动时写入演示数据：两个辖区、多处站点和工作人员，便于独立运行验证。
 * 事件日志已存在数据时不会重复写入；可用 SEED_DEMO=0 关闭。
 * 返回新建工作人员（含令牌），供启动时打印一次。
 */
export async function seedIfEmpty(service) {
  if (process.env.SEED_DEMO === "0" || process.env.SEED_DEMO === "false") return [];
  const state = service._state();
  if (state.sites.size > 0) return [];

  const day = 24 * 60 * 60 * 1000;
  const windows = [{ from: Date.now() - day, to: Date.now() + 3650 * day }];

  await service.registerSite({
    id: "S-NORTH",
    name: "北城体育馆避难所",
    district: "北城区",
    openWindows: windows,
    zones: [
      { id: "A", name: "A 区（普通家庭）", capacity: 20, accessibleBeds: 4 },
      { id: "B", name: "B 区（无障碍）", capacity: 10, accessibleBeds: 10 },
    ],
  });
  await service.registerSite({
    id: "S-SOUTH",
    name: "南河小学避难所",
    district: "南河区",
    openWindows: windows,
    zones: [{ id: "C", name: "C 区（综合）", capacity: 8, accessibleBeds: 2 }],
  });

  const created = [];
  created.push(await service.registerStaff({ id: "W-N1", name: "周敏", district: "北城区", role: "worker" }));
  created.push(await service.registerStaff({ id: "W-S1", name: "李强", district: "南河区", role: "worker" }));
  created.push(await service.registerStaff({ id: "W-COORD", name: "指挥员王磊", district: "北城区", role: "coordinator" }));
  return created;
}
