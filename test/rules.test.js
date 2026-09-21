import assert from "node:assert/strict";
import test from "node:test";
import { makeService, seedNorth } from "./helpers.js";

test("相同幂等键的重复登记不重复占床，直接返回首次结果", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const payload = { workerId: "north", householdId: "dup", shelterId: "s1", size: 2, accessibleNeed: 1, reason: "现场登记", idempotencyKey: "req-42" };
  const first = await service.apply(payload);
  const second = await service.apply(payload);
  assert.equal(first.reservationId, second.reservationId);
  assert.equal(second.idempotent, true);
  assert.equal(service.getShelterView("s1").totals.occupied, 2);
  store.close();
});

test("候补请求重放同样幂等，不产生第二条排队", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const payload = { workerId: "north", householdId: "dup", shelterId: "s1", size: 9, reason: "大户", idempotencyKey: "req-99" };
  const first = await service.apply(payload);
  const second = await service.apply(payload);
  assert.equal(first.outcome, "WAITING");
  assert.equal(first.entryId, second.entryId);
  assert.equal(service.getShelterView("s1").queue.length, 1);
  store.close();
});

test("同一幂等键但请求体不同时拒绝", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 1, reason: "x", idempotencyKey: "k" });
  await assert.rejects(
    service.apply({ workerId: "north", householdId: "h2", shelterId: "s1", size: 1, reason: "x", idempotencyKey: "k" }),
    (e) => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT",
  );
  store.close();
});

test("无幂等键时同一家庭的重复登记被拒绝", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 1, reason: "x" });
  await assert.rejects(
    service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 1, reason: "再次登记" }),
    (e) => e.status === 409 && e.code === "HOUSEHOLD_ALREADY_ACTIVE",
  );
  store.close();
});

test("工作人员只能处理所属辖区", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await assert.rejects(
    service.apply({ workerId: "south", householdId: "h1", shelterId: "s1", size: 1, reason: "越区登记" }),
    (e) => e.status === 403 && e.code === "OUTSIDE_JURISDICTION",
  );
  await assert.rejects(() => service.queryShelter("south", "s1"), (e) => e.code === "OUTSIDE_JURISDICTION");
  // 南区社工只能看到南区站点
  const visible = (await service.listShelters("south")).map((s) => s.id);
  assert.deepEqual(visible, ["s2"]);
  store.close();
});

test("跨辖区改派：普通社工无授权被拒，指挥员或持授权可执行", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const r = await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, reason: "x" });

  await assert.rejects(
    service.reassign({ workerId: "north", reservationId: r.reservationId, targetShelterId: "s2", reason: "疏散转移" }),
    (e) => e.status === 403 && e.code === "CROSS_DISTRICT_UNAUTHORIZED",
  );

  const moved = await service.reassign({
    workerId: "north",
    reservationId: r.reservationId,
    targetShelterId: "s2",
    reason: "建筑安全隐患，指挥员授权转移",
    authorization: "CMD-AUTH-2026-07",
  });
  assert.equal(moved.outcome, "REASSIGNED");
  assert.equal(moved.toShelterId, "s2");

  // 旧预约释放、新预约占用，没有重复计数
  const s1 = service.getShelterView("s1");
  const s2 = service.getShelterView("s2");
  assert.equal(s1.totals.occupied, 0);
  assert.equal(s2.totals.occupied, 2);

  const household = await service.getHousehold("cmd", "h1");
  assert.equal(household.reservation.shelterId, "s2");
  assert.equal(household.reservation.reassignedFrom, r.reservationId);
  store.close();
});

test("跨区分区改派（同站点内）普通社工即可，且释放原分区床位触发递补", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const r = await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, preferredZoneCode: "B", reason: "x" });
  // B 满，等待者
  const w = await service.apply({ workerId: "north", householdId: "w", shelterId: "s1", size: 1, preferredZoneCode: "B", reason: "等B" });
  assert.equal(w.outcome, "WAITING");

  const moved = await service.reassign({ workerId: "north", reservationId: r.reservationId, targetShelterId: "s1", targetZoneCode: "A", reason: "家庭需要靠近出口" });
  assert.equal(moved.toZoneCode, "A");
  assert.equal(moved.promotions[0].householdId, "w");
  store.close();
});

test("改派目标容量不足时整单失败，原床位保持锁定", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const keep = await service.apply({ workerId: "south", householdId: "k", shelterId: "s2", size: 3, accessibleNeed: 1, reason: "占满南区" });
  assert.equal(keep.zoneCode, "H");
  const r = await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, reason: "x" });

  await assert.rejects(
    service.reassign({ workerId: "north", reservationId: r.reservationId, targetShelterId: "s2", reason: "想转移", authorization: "CMD-1" }),
    (e) => e.status === 409 && e.code === "INSUFFICIENT_CAPACITY",
  );
  // 原预约完好
  const view = service.getShelterView("s1");
  assert.equal(view.totals.occupied, 2);
  const household = await service.getHousehold("north", "h1");
  assert.equal(household.reservation.reservationId, r.reservationId);
  assert.equal(household.reservation.status, "RESERVED");
  store.close();
});

test("到场核销必须在开放时段内，并记录身份与原因", async () => {
  const fixed = new Date("2026-09-21T12:00:00");
  const { store, service } = makeService(fixed);
  await seedNorth(service);

  const r = await service.apply({ workerId: "south", householdId: "h1", shelterId: "s2", size: 1, reason: "x" });
  const done = await service.checkIn({ workerId: "south", reservationId: r.reservationId, reason: "全家到场，证件核验通过" });
  assert.equal(done.outcome, "CHECKED_IN");

  // 闭馆时间不能核销
  const { service: closedService, store: closedStore } = makeService(new Date("2026-09-21T20:00:00"));
  await seedNorth(closedService);
  const r2 = await closedService.apply({ workerId: "south", householdId: "h2", shelterId: "s2", size: 1, reason: "x" });
  await assert.rejects(
    closedService.checkIn({ workerId: "south", reservationId: r2.reservationId, reason: "迟到" }),
    (e) => e.status === 409 && e.code === "SHELTER_CLOSED",
  );
  closedStore.close();

  // 已核销不能改派或重复核销
  await assert.rejects(
    service.reassign({ workerId: "south", reservationId: r.reservationId, targetShelterId: "s1", reason: "想转移", authorization: "CMD-1" }),
    (e) => e.code === "ALREADY_CHECKED_IN",
  );
  await assert.rejects(
    service.checkIn({ workerId: "south", reservationId: r.reservationId, reason: "再来一次" }),
    (e) => e.code === "ALREADY_CHECKED_IN",
  );
  store.close();
});

test("取消候补会让出排队位置，后续家庭前移", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await service.apply({ workerId: "north", householdId: "w1", shelterId: "s1", size: 9, reason: "q" });
  await service.apply({ workerId: "north", householdId: "w2", shelterId: "s1", size: 9, reason: "q" });
  const entry1 = (await service.getHousehold("north", "w1")).entry;
  await service.cancelWaitlist({ workerId: "north", entryId: entry1.entryId, reason: "家庭自行解决住宿" });

  const queue = service.getShelterView("s1").queue;
  assert.deepEqual(queue.map((q) => q.householdId), ["w2"]);
  assert.equal(queue[0].position, 1);
  await assert.rejects(() => service.getHousehold("north", "w1"), (e) => e.code === "HOUSEHOLD_NOT_FOUND");
  store.close();
});

test("变更必须提供原因；床位审计能解释锁定与释放", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const r = await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, accessibleNeed: 1, reason: "开放日登记" });
  await service.cancelReservation({ workerId: "north", reservationId: r.reservationId, reason: "家庭投奔亲友" });

  await assert.rejects(
    service.apply({ workerId: "north", householdId: "h9", shelterId: "s1", size: 1, reason: "   " }),
    (e) => e.code === "INVALID_REQUEST",
  );

  const bedId = r.bedIds[0];
  const audit = await service.bedAudit("north", "s1", bedId);
  assert.deepEqual(
    audit.timeline.map((t) => ({ action: t.action, via: t.via, reason: t.reason, workerId: t.workerId })),
    [
      { action: "LOCKED", via: "登记", reason: "开放日登记", workerId: "north" },
      { action: "RELEASED", via: "取消", reason: "家庭投奔亲友", workerId: "north" },
    ],
  );

  // 无床号时返回该站点全部床位变更
  const full = await service.bedAudit("north", "s1");
  assert.equal(full.timeline.length, 2);
  store.close();
});
