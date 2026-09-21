import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { EventStore } from "../src/store.js";
import { CapacityService } from "../src/service.js";
import { makeService, seedNorth } from "./helpers.js";

test("服务器重启后恢复预约、占用量、幂等结果与等待次序", async () => {
  const { dir, store, service } = makeService();
  await seedNorth(service);

  const payload = { workerId: "north", householdId: "h1", shelterId: "s1", size: 3, accessibleNeed: 1, reason: "开放日", idempotencyKey: "stable-key" };
  const first = await service.apply(payload);
  await service.apply({ workerId: "north", householdId: "w1", shelterId: "s1", size: 5, reason: "排第一" });
  await service.apply({ workerId: "north", householdId: "w2", shelterId: "s1", size: 5, reason: "排第二" });
  store.close();

  // 用同一个日志文件重建服务，模拟进程恢复
  const store2 = new EventStore(join(dir, "events.log"));
  const service2 = new CapacityService(store2);

  const view = service2.getShelterView("s1");
  assert.equal(view.totals.occupied, 3);
  assert.equal(view.totals.available, 3);
  assert.deepEqual(view.queue.map((q) => q.householdId), ["w1", "w2"]);
  assert.deepEqual(view.queue.map((q) => q.position), [1, 2]);

  // 原预约仍锁定相同床位
  const household = await service2.getHousehold("north", "h1");
  assert.equal(household.reservation.reservationId, first.reservationId);
  assert.deepEqual(household.reservation.bedIds, first.bedIds);

  // 重放幂等请求不会多占床位
  const replay = await service2.apply(payload);
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(replay.idempotent, true);
  assert.equal(service2.getShelterView("s1").totals.occupied, 3);

  // 事件序号连续，审计轨迹完整
  assert.equal(store2.state.events.at(-1).seq, store2.state.events.length);
  store2.close();
});

test("恢复后释放床位仍能按原次序递补", async () => {
  const { dir, store, service } = makeService();
  await seedNorth(service);
  await service.createShelter("cmd", {
    id: "s3",
    name: "大礼堂",
    district: "NORTH",
    openHours: { opens: "00:00", closes: "23:59" },
    zones: [{ code: "Z", capacity: 6, accessibleCapacity: 1 }],
  });

  const full = await service.apply({ workerId: "north", householdId: "occ", shelterId: "s3", size: 6, accessibleNeed: 1, reason: "占满" });
  assert.equal(full.outcome, "RESERVED");
  await service.apply({ workerId: "north", householdId: "w1", shelterId: "s3", size: 2, reason: "等" });
  store.close();

  const store2 = new EventStore(join(dir, "events.log"));
  const service2 = new CapacityService(store2);
  const result = await service2.cancelReservation({ workerId: "north", reservationId: full.reservationId, reason: "重启后取消" });
  assert.equal(result.promotions.length, 1);
  assert.equal(result.promotions[0].householdId, "w1");
  assert.equal(service2.getShelterView("s3").queue.length, 0);
  store2.close();
});
