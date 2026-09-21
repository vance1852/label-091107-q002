import assert from "node:assert/strict";
import test from "node:test";
import { ServiceError } from "../src/service.js";
import { makeService, seedNorth } from "./helpers.js";

async function errorOf(fn, status, code) {
  await assert.rejects(
    fn,
    (error) => {
      assert.ok(error instanceof ServiceError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    },
  );
}

test("整户登记成功时锁定分区内床位并满足无障碍需求", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const result = await service.apply({
    workerId: "north",
    householdId: "h1",
    shelterId: "s1",
    size: 4,
    accessibleNeed: 2,
    reason: "现场登记",
  });
  assert.equal(result.outcome, "RESERVED");
  assert.equal(result.zoneCode, "A");
  assert.equal(result.bedIds.length, 4);

  const view = service.getShelterView("s1");
  const zoneA = view.zones.find((z) => z.code === "A");
  assert.deepEqual(
    { capacity: zoneA.capacity, occupied: zoneA.occupied, available: zoneA.available, occupiedAccessible: zoneA.occupiedAccessible },
    { capacity: 4, occupied: 4, available: 0, occupiedAccessible: 2 },
  );
  assert.equal(view.totals.available, 2);
  store.close();
});

test("家庭不能被拆散：任一单分区放不下即等待，即使总量足够", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const result = await service.apply({
    workerId: "north",
    householdId: "big",
    shelterId: "s1",
    size: 5,
    accessibleNeed: 0,
    reason: "全家五口",
  });
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.position, 1);
  assert.equal(service.getShelterView("s1").queue[0].householdId, "big");
  store.close();
});

test("无障碍床位不被普通需求挪用", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, accessibleNeed: 2, reason: "两位轮椅成员" });
  // A 区仍有 2 张普通床空闲，但无障碍床已耗尽
  const result = await service.apply({ workerId: "north", householdId: "h2", shelterId: "s1", size: 1, accessibleNeed: 1, reason: "一位轮椅成员" });
  assert.equal(result.outcome, "WAITING");

  const view = service.getShelterView("s1");
  assert.equal(view.totals.occupied, 2);
  assert.equal(view.queue.length, 1);
  store.close();
});

test("指定分区满员时进入该站点候补，而不是占用其他分区", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  await service.apply({ workerId: "north", householdId: "h1", shelterId: "s1", size: 2, reason: "x", preferredZoneCode: "B" });
  const result = await service.apply({ workerId: "north", householdId: "h2", shelterId: "s1", size: 1, reason: "x", preferredZoneCode: "B" });
  assert.equal(result.outcome, "WAITING");
  assert.equal(result.requestedZoneCode, "B");
  // A 区仍全空
  assert.equal(service.getShelterView("s1").zones.find((z) => z.code === "A").occupied, 0);
  store.close();
});

test("并发登记不会超卖，每张床至多属于一个预约", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  const requests = Array.from({ length: 10 }, (_, i) =>
    service.apply({ workerId: "north", householdId: `c${i}`, shelterId: "s1", size: 1, reason: "并发登记" }),
  );
  const results = await Promise.all(requests);
  const reserved = results.filter((r) => r.outcome === "RESERVED");
  const waiting = results.filter((r) => r.outcome === "WAITING");
  // 普通需求只能使用普通床（A 区 2 + B 区 2），2 张无障碍床保留
  assert.equal(reserved.length, 4);
  assert.equal(waiting.length, 6);

  const allBeds = reserved.flatMap((r) => r.bedIds);
  assert.equal(new Set(allBeds).size, allBeds.length);
  const view = service.getShelterView("s1");
  assert.equal(view.totals.occupied, 4);
  assert.equal(view.totals.availableAccessible, 2);
  assert.deepEqual(waiting.map((r) => r.position), [1, 2, 3, 4, 5, 6]);
  store.close();
});

test("取消后按 FIFO 递补；放不下的家庭跳过且保留原位", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  // 占满 A 区（2 无障碍 + 2 普通）
  const a1 = await service.apply({ workerId: "north", householdId: "a1", shelterId: "s1", size: 2, accessibleNeed: 2, reason: "x" });
  const a2 = await service.apply({ workerId: "north", householdId: "a2", shelterId: "s1", size: 2, reason: "x" });
  // 占满 B 区
  const b1 = await service.apply({ workerId: "north", householdId: "b1", shelterId: "s1", size: 2, reason: "x" });
  assert.equal(a1.zoneCode, "A");
  assert.equal(a2.zoneCode, "A");
  assert.equal(b1.zoneCode, "B");

  await service.apply({ workerId: "north", householdId: "big", shelterId: "s1", size: 3, reason: "排队大户" });
  await service.apply({ workerId: "north", householdId: "small", shelterId: "s1", size: 1, reason: "排队小户" });

  // 释放 B 区 2 床：大户放不下被跳过，小户递补
  const cancel = await service.cancelReservation({ workerId: "north", reservationId: b1.reservationId, reason: "临时取消" });
  assert.equal(cancel.promotions.length, 1);
  assert.equal(cancel.promotions[0].householdId, "small");

  const view = service.getShelterView("s1");
  assert.equal(view.queue.length, 1);
  assert.equal(view.queue[0].householdId, "big");
  assert.equal(view.queue[0].status, "WAITING");

  const small = await service.getHousehold("north", "small");
  assert.equal(small.kind, "reservation");
  assert.equal(small.reservation.status, "RESERVED");

  // 再释放 A 区 2 张普通床仍不够大户（需 3 张），大户继续等待
  await service.cancelReservation({ workerId: "north", reservationId: a2.reservationId, reason: "临时取消" });
  assert.equal(service.getShelterView("s1").queue[0].householdId, "big");
  store.close();
});

test("递补时同样校验无障碍床位", async () => {
  const { store, service } = makeService();
  await seedNorth(service);

  // 占满全部无障碍床与全部容量
  await service.apply({ workerId: "north", householdId: "x1", shelterId: "s1", size: 2, accessibleNeed: 2, reason: "x" });
  await service.apply({ workerId: "north", householdId: "x2", shelterId: "s1", size: 2, reason: "x" });
  await service.apply({ workerId: "north", householdId: "x3", shelterId: "s1", size: 2, reason: "x" });
  await service.apply({ workerId: "north", householdId: "w", shelterId: "s1", size: 1, accessibleNeed: 1, reason: "需要无障碍" });
  assert.equal((await service.getHousehold("north", "w")).kind, "waitlist");

  // 取消一户普通家庭（释放 2 张普通床），候补仍不能递补
  const cancel = await service.cancelReservation({ workerId: "north", reservationId: (await service.getHousehold("north", "x2")).reservation.reservationId, reason: "取消" });
  assert.equal(cancel.promotions.length, 0);
  assert.equal((await service.getHousehold("north", "w")).kind, "waitlist");
  store.close();
});
