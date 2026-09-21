// 首次启动的演示数据：全部为合成标识，不含真实居民信息。

export async function seedIfEmpty(service) {
  if (service.store.state.events.length > 0) return false;

  await service.bootstrapCommander({ workerId: "cmd-demo", name: "演示指挥员" });

  await service.registerWorker("cmd-demo", {
    workerId: "staff-north",
    name: "北区社工小王",
    role: "STAFF",
    districts: ["D-NORTH"],
  });
  await service.registerWorker("cmd-demo", {
    workerId: "staff-south",
    name: "南区社工小李",
    role: "STAFF",
    districts: ["D-SOUTH"],
  });

  await service.createShelter("cmd-demo", {
    id: "sh-north",
    name: "县第一中学避难所",
    district: "D-NORTH",
    openHours: { opens: "00:00", closes: "23:59" },
    zones: [
      { code: "A", capacity: 8, accessibleCapacity: 3 },
      { code: "B", capacity: 4, accessibleCapacity: 1 },
    ],
  });
  await service.createShelter("cmd-demo", {
    id: "sh-south",
    name: "城南体育馆避难所",
    district: "D-SOUTH",
    openHours: { opens: "06:00", closes: "22:00" },
    zones: [{ code: "HALL", capacity: 6, accessibleCapacity: 2 }],
  });

  await service.apply({
    workerId: "staff-north",
    householdId: "demo-household-1",
    shelterId: "sh-north",
    size: 3,
    accessibleNeed: 1,
    preferredZoneCode: "A",
    reason: "开放日现场登记",
    idempotencyKey: "seed-1",
  });
  await service.apply({
    workerId: "staff-north",
    householdId: "demo-household-2",
    shelterId: "sh-north",
    size: 3,
    accessibleNeed: 1,
    preferredZoneCode: "B",
    reason: "开放日现场登记",
    idempotencyKey: "seed-2",
  });
  // B 区满员后该家庭进入候补，用于演示有序等待与自动递补。
  await service.apply({
    workerId: "staff-north",
    householdId: "demo-household-3",
    shelterId: "sh-north",
    size: 2,
    accessibleNeed: 1,
    preferredZoneCode: "B",
    reason: "开放日现场登记",
    idempotencyKey: "seed-3",
  });

  return true;
}
