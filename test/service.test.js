import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createService } from "../src/service.js";
import { HttpError } from "../src/errors.js";

const T0 = 1_700_000_000_000;

async function makeHarness() {
  const dir = await mkdtemp(join(tmpdir(), "shelter-"));
  let clock = T0;
  const store = new Store({ dataDir: dir, now: () => clock });
  await store.init();
  const service = createService(store);
  return {
    dir,
    service,
    store,
    advance: (ms) => {
      clock += ms;
    },
    async close() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function standardWorld() {
  const h = await makeHarness();
  await h.service.registerSite({
    id: "S1",
    name: "一号站",
    district: "东城",
    openWindows: [{ from: T0 - 1000, to: T0 + 10_000_000 }],
    zones: [{ id: "A", name: "A区", capacity: 5, accessibleBeds: 1 }],
  });
  await h.service.registerSite({
    id: "S2",
    name: "二号站",
    district: "西城",
    openWindows: [{ from: T0 - 1000, to: T0 + 10_000_000 }],
    zones: [{ id: "B", name: "B区", capacity: 2, accessibleBeds: 0 }],
  });
  const w1 = await h.service.registerStaff({ id: "w1", name: "东员", district: "东城", role: "worker" });
  const w2 = await h.service.registerStaff({ id: "w2", name: "西员", district: "西城", role: "worker" });
  const coord = await h.service.registerStaff({ id: "c1", name: "指挥员", district: "东城", role: "coordinator" });
  h.tokens = { w1: { staffId: "w1", value: w1.token }, w2: { staffId: "w2", value: w2.token }, coord: { staffId: "c1", value: coord.token } };
  return h;
}

const household = (id, name, members, accessibleNeeded = 0) => ({
  household: { id, name, members, accessibleNeeded },
});

test("容量用尽时整户进入等待，绝不超卖", async () => {
  const h = await standardWorld();
  try {
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3) });
    assert.equal(r1.status, "confirmed");
    assert.equal(r1.reservation.zoneId, "A");

    const r2 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 2) });
    assert.equal(r2.status, "waiting");
    assert.equal(r2.queuePosition, 1);

    const view = h.service.getSite(h.tokens.w1, "S1");
    assert.equal(view.totals.occupied, 3);
    assert.equal(view.totals.available, 2);
    assert.equal(view.waiting.length, 1);
  } finally {
    await h.close();
  }
});

test("无障碍床位独立核算，不能被普通需求占用", async () => {
  const h = await standardWorld();
  try {
    // 1 张无障碍床 + 3 张普通床的家庭，恰好占满。
    const r1 = await h.service.reserve(
      h.tokens.w1,
      { siteId: "S1", ...household("h1", "张家", 4, 1) },
    );
    assert.equal(r1.status, "confirmed");
    // 再来一个需要无障碍床的家庭：必须等待，即使总占用按人数看有结构差异。
    const r2 = await h.service.reserve(
      h.tokens.w1,
      { siteId: "S1", ...household("h2", "李家", 1, 1) },
    );
    assert.equal(r2.status, "waiting");
    const view = h.service.getSite(h.tokens.w1, "S1");
    assert.equal(view.zones[0].occupied.accessible, 1);
    assert.equal(view.zones[0].available.accessible, 0);
  } finally {
    await h.close();
  }
});

test("取消后按 FIFO 递补，且递补结果计入占用", async () => {
  const h = await standardWorld();
  try {
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3) });
    const q1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 2) });
    const q2 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h3", "王家", 1) });
    assert.deepEqual([q1.queuePosition, q2.queuePosition], [1, 2]);

    const result = await h.service.cancel(h.tokens.w1, r1.reservation.id, "居民自行投亲");
    assert.equal(result.promotions, 2);
    // 队首是 2 人家庭，空出 3 张床可容纳；其后 1 人家庭也应递补。
    const after = h.service.getSite(h.tokens.w1, "S1");
    assert.equal(after.totals.occupied, 3);
    assert.equal(after.waiting.length, 0);
    assert.equal(h.service.getReservation(h.tokens.w1, q1.reservation.id).status, "confirmed");
    assert.equal(h.service.getReservation(h.tokens.w1, q2.reservation.id).status, "confirmed");
    // 自动递补事件同样留下操作者身份，便于沿记录解释床位为何被锁定。
    const promotedHistory = h.service.reservationHistory(h.tokens.w1, q1.reservation.id);
    const promotedEvent = promotedHistory.timeline.find((event) => event.type === "PROMOTED");
    assert.ok(promotedEvent);
    assert.equal(promotedEvent.actor.staffId, "w1");
    assert.equal(promotedEvent.reason, "容量释放后按等待次序自动递补");
  } finally {
    await h.close();
  }
});

test("队首放不下时阻塞队列，后面的家庭不能越位", async () => {
  const h = await standardWorld();
  try {
    // 占 2 张，空 2 张。
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 2) });
    // 队首要 3 张（放不下），队尾要 1 张（放得下）。
    const big = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 3) });
    const small = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h3", "王家", 1) });
    assert.equal(big.queuePosition, 1);
    assert.equal(small.queuePosition, 2);

    // 再释放 2 张，共空 4 张：队首 3 人先递补，随后 1 人也递补。
    const result = await h.service.cancel(h.tokens.w1, r1.reservation.id, "测试释放");
    assert.equal(result.promotions, 2);
  } finally {
    await h.close();
  }
});

test("已有排队家庭时，新登记直接排队不占床", async () => {
  const h = await standardWorld();
  try {
    // 4 张普通床被两户占满。
    await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h0", "陈家", 1) });
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3) });
    // 队首需要 5 张床（含 1 张无障碍床），即使稍后释放 3 张仍放不下。
    const big = await h.service.reserve(
      h.tokens.w1,
      { siteId: "S1", ...household("h2", "李家", 5, 1) },
    );
    assert.equal(big.status, "waiting");
    // 释放 3 张后：4 普通 + 1 无障碍中空出 3 张普通床，队首仍放不下（需 4 普通）。
    await h.service.cancel(h.tokens.w1, r1.reservation.id, "先取消");
    const view1 = h.service.getSite(h.tokens.w1, "S1");
    assert.equal(view1.totals.available, 4);
    assert.equal(view1.waiting.length, 1);

    // 此时来一个 1 人家庭，明明放得下，也必须排到队尾。
    const late = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h3", "王家", 1) });
    assert.equal(late.status, "waiting");
    assert.equal(late.queuePosition, 2);
    assert.equal(h.service.getSite(h.tokens.w1, "S1").totals.occupied, 1);
  } finally {
    await h.close();
  }
});

test("幂等键重放不重复占床，负载变化则拒绝", async () => {
  const h = await standardWorld();
  try {
    const body = { siteId: "S1", ...household("h9", "赵家", 2), contact: "电话110" };
    const first = await h.service.reserve(h.tokens.w1, body, "key-001");
    const replay = await h.service.reserve(h.tokens.w1, body, "key-001");
    assert.equal(replay.replayed, true);
    assert.equal(replay.reservation.id, first.reservation.id);
    const view = h.service.getSite(h.tokens.w1, "S1");
    assert.equal(view.totals.occupied, 2);

    await assert.rejects(
      () => h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h9", "赵家", 3) }, "key-001"),
      (error) => error instanceof HttpError && error.code === "IDEMPOTENCY_KEY_REUSED",
    );
  } finally {
    await h.close();
  }
});

test("同户重复登记被拒绝", async () => {
  const h = await standardWorld();
  try {
    await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h10", "孙家", 1) });
    await assert.rejects(
      () => h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h10", "孙家", 1) }),
      (error) => error instanceof HttpError && error.code === "DUPLICATE_ACTIVE_RESERVATION",
    );
  } finally {
    await h.close();
  }
});

test("辖区隔离：跨区操作与跨区改派被拒，指挥员可授权", async () => {
  const h = await standardWorld();
  try {
    await assert.rejects(
      () => h.service.reserve(h.tokens.w2, { siteId: "S1", ...household("h1", "张家", 1) }),
      (error) => error instanceof HttpError && error.status === 403,
    );
    const r = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 1) });
    await assert.rejects(
      () => h.service.reassign(h.tokens.w2, r.reservation.id, { toSiteId: "S2", reason: "想调走" }),
      (error) => error instanceof HttpError && error.status === 403,
    );
    // 本辖区工作人员不能跨区改派。
    await assert.rejects(
      () => h.service.reassign(h.tokens.w1, r.reservation.id, { toSiteId: "S2", reason: "想调走" }),
      (error) => error instanceof HttpError && error.status === 403,
    );
    // 指挥员可以。
    const moved = await h.service.reassign(h.tokens.coord, r.reservation.id, { toSiteId: "S2", reason: "东城站点检修，统一转移" });
    assert.equal(moved.reservation.siteId, "S2");
  } finally {
    await h.close();
  }
});

test("改派到容量不足的目标站点被拒，且不产生任何变更", async () => {
  const h = await standardWorld();
  try {
    await h.service.reserve(h.tokens.w2, { siteId: "S2", ...household("x1", "西关张家", 2) });
    const r = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 2) });
    await assert.rejects(
      () => h.service.reassign(h.tokens.coord, r.reservation.id, { toSiteId: "S2", reason: "满员也要去" }),
      (error) => error instanceof HttpError && error.code === "TARGET_AT_CAPACITY",
    );
    const unchanged = h.service.getReservation(h.tokens.w1, r.reservation.id);
    assert.equal(unchanged.reservation.siteId, "S1");
    assert.equal(unchanged.status, "confirmed");
  } finally {
    await h.close();
  }
});

test("等待中家庭改派到有空床的站点直接确认，释放后源站点递补", async () => {
  const h = await standardWorld();
  try {
    // S1：占 4 普通床，再来一户进入排队。
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 4) });
    const waiter = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 1) });
    assert.equal(waiter.status, "waiting");
    // S2 空着（2 张普通床）；指挥员把排队家庭改派过去 -> 直接确认。
    const moved = await h.service.reassign(h.tokens.coord, waiter.reservation.id, {
      toSiteId: "S2",
      reason: "该户愿意就近前往南城",
    });
    assert.equal(moved.status, "confirmed");
    assert.equal(moved.reservation.siteId, "S2");
    assert.equal(h.service.getSite(h.tokens.w1, "S1").waiting.length, 0);

    // 反向验证：S2 现在有 1 张空床，若 S2 先有排队者，则已确认家庭不能改派进去插队。
    await h.service.reserve(h.tokens.coord, { siteId: "S2", ...household("h3", "南城排队户", 2) });
    await assert.rejects(
      () => h.service.reassign(h.tokens.coord, r1.reservation.id, { toSiteId: "S2", reason: "想插队" }),
      (error) => error instanceof HttpError && error.code === "TARGET_HAS_QUEUE",
    );
  } finally {
    await h.close();
  }
});

test("到场核销与失约释放：核销保持占用，失约触发递补", async () => {
  const h = await standardWorld();
  try {
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3) });
    const q1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 2) });
    await h.service.checkIn(h.tokens.w1, r1.reservation.id, "全员到场");
    assert.equal(h.service.getReservation(h.tokens.w1, r1.reservation.id).status, "checked_in");
    // 已核销不能再核销
    await assert.rejects(
      () => h.service.checkIn(h.tokens.w1, r1.reservation.id, "重复核销"),
      (error) => error instanceof HttpError && error.code === "NOT_CONFIRMED",
    );
    // 取消已核销家庭（退宿）后同样递补。
    const result = await h.service.cancel(h.tokens.w1, r1.reservation.id, "转投亲友");
    assert.equal(result.promotions, 1);
    assert.equal(h.service.getReservation(h.tokens.w1, q1.reservation.id).status, "confirmed");

    // 失约流程
    await h.service.markNoShow(h.tokens.w1, q1.reservation.id, "开放日结束未到场");
    assert.equal(h.service.getReservation(h.tokens.w1, q1.reservation.id).status, "no_show");
  } finally {
    await h.close();
  }
});

test("审计时间线能解释每张床的锁定与释放", async () => {
  const h = await standardWorld();
  try {
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3, 1) });
    await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 2) });
    await h.service.cancel(h.tokens.w1, r1.reservation.id, "临时取消");
    const history = h.service.reservationHistory(h.tokens.w1, r1.reservation.id);
    const types = history.timeline.map((event) => event.type);
    assert.deepEqual(types, ["RESERVATION_CONFIRMED", "CANCELLED"]);
    assert.equal(history.timeline[0].actor.staffId, "w1");
    assert.equal(history.timeline[1].reason, "临时取消");
    assert.deepEqual(history.timeline[1].beds.released, { general: 2, accessible: 1 });
  } finally {
    await h.close();
  }
});

test("关闭并重新打开后，预约与排队次序完整恢复，幂等键仍有效", async () => {
  const h = await standardWorld();
  const dir = h.dir;
  let r1Id;
  let q1Id;
  let q2Id;
  try {
    const r1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h1", "张家", 3) });
    const q1 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h2", "李家", 2) }, "idem-q1");
    const q2 = await h.service.reserve(h.tokens.w1, { siteId: "S1", ...household("h3", "王家", 1) });
    r1Id = r1.reservation.id;
    q1Id = q1.reservation.id;
    q2Id = q2.reservation.id;
    await h.store.close();
  } finally {
    // 不清理目录，下面复用
  }

  let clock = T0;
  const reopened = new Store({ dataDir: dir, now: () => clock });
  await reopened.init();
  const service = createService(reopened);
  try {
    const view = service.getSite({ staffId: "w1", value: h.tokens.w1.value }, "S1");
    assert.equal(view.totals.occupied, 3);
    assert.deepEqual(view.waiting.map((entry) => entry.reservationId), [q1Id, q2Id]);
    assert.equal(view.waiting[0].position, 1);

    // 幂等重放
    const replay = await service.reserve(
      { staffId: "w1", value: h.tokens.w1.value },
      { siteId: "S1", ...household("h2", "李家", 2) },
      "idem-q1",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.reservation.id, q1Id);
    assert.equal(service.getSite({ staffId: "w1", value: h.tokens.w1.value }, "S1").waiting.length, 2);

    // 恢复后取消，FIFO 递补照常工作。
    await service.cancel({ staffId: "w1", value: h.tokens.w1.value }, r1Id, "恢复后取消");
    const after = service.getSite({ staffId: "w1", value: h.tokens.w1.value }, "S1");
    assert.equal(after.totals.occupied, 3);
    assert.equal(after.waiting.length, 0);
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("非开放时段拒绝登记与核销", async () => {
  const h = await makeHarness();
  try {
    await h.service.registerSite({
      id: "SX",
      name: "限时站",
      district: "东城",
      openWindows: [{ from: T0 + 10_000, to: T0 + 20_000 }],
      zones: [{ id: "A", name: "A区", capacity: 5, accessibleBeds: 0 }],
    });
    const w = await h.service.registerStaff({ id: "w", name: "员", district: "东城", role: "worker" });
    const token = { staffId: "w", value: w.token };
    await assert.rejects(
      () => h.service.reserve(token, { siteId: "SX", ...household("h1", "张家", 1) }),
      (error) => error instanceof HttpError && error.code === "SITE_CLOSED",
    );
    h.advance(15_000);
    const r = await h.service.reserve(token, { siteId: "SX", ...household("h1", "张家", 1) });
    assert.equal(r.status, "confirmed");
  } finally {
    await h.close();
  }
});
