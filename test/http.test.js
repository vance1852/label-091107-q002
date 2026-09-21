import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { makeService } from "./helpers.js";

function start(service) {
  const server = buildApp(service);
  return new Promise((resolve) =>
    server.listen(0, () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        close: () => new Promise((done) => server.close(done)),
      });
    }),
  );
}

async function api(http, method, path, { worker, body } = {}) {
  const response = await fetch(`${http.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(worker ? { "x-worker-id": worker } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("HTTP 全流程：自举、建站点、登记、候补、查询、取消、递补、审计", async () => {
  const { store, service } = makeService();
  const http = await start(service);
  try {
    // 未自举时的鉴权错误
    let res = await api(http, "GET", "/shelters", { worker: "nobody" });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, "UNAUTHENTICATED");

    // 自举指挥员
    res = await api(http, "POST", "/admin/bootstrap", { body: { workerId: "cmd", name: "指挥员" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.role, "COMMANDER");
    // 再次自举被拒
    res = await api(http, "POST", "/admin/bootstrap", { body: { workerId: "cmd2", name: "另一人" } });
    assert.equal(res.status, 409);

    // 登记社工
    res = await api(http, "POST", "/admin/workers", { worker: "cmd", body: { workerId: "w1", name: "社工", role: "STAFF", districts: ["NORTH"] } });
    assert.equal(res.status, 200);

    // 建站点：A 区 2 床（含 1 无障碍）
    res = await api(http, "POST", "/shelters", {
      worker: "cmd",
      body: {
        id: "s1",
        name: "一号避难所",
        district: "NORTH",
        openHours: { opens: "00:00", closes: "23:59" },
        zones: [{ code: "A", capacity: 2, accessibleCapacity: 1 }],
      },
    });
    assert.equal(res.status, 200);

    // 非法容量被拒
    res = await api(http, "POST", "/shelters", {
      worker: "cmd",
      body: { id: "bad", name: "x", district: "NORTH", openHours: { opens: "08:00", closes: "20:00" }, zones: [{ code: "A", capacity: -1 }] },
    });
    assert.equal(res.status, 400);

    // 两户登记，第二户进入候补
    res = await api(http, "POST", "/shelters/s1/applications", {
      worker: "w1",
      body: { householdId: "h1", size: 2, accessibleNeed: 1, reason: "现场登记", idempotencyKey: "k1" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, "RESERVED");
    const reservationId = res.json.reservationId;
    const bedId = res.json.bedIds[0];

    // 幂等重放
    res = await api(http, "POST", "/shelters/s1/applications", {
      worker: "w1",
      body: { householdId: "h1", size: 2, accessibleNeed: 1, reason: "现场登记", idempotencyKey: "k1" },
    });
    assert.equal(res.json.reservationId, reservationId);
    assert.equal(res.json.idempotent, true);

    res = await api(http, "POST", "/shelters/s1/applications", {
      worker: "w1",
      body: { householdId: "h2", size: 1, reason: "满员等待" },
    });
    assert.equal(res.json.outcome, "WAITING");

    // 指挥员查站点：可用量、占用量、排队家庭与状态
    res = await api(http, "GET", "/shelters/s1", { worker: "cmd" });
    assert.equal(res.status, 200);
    assert.equal(res.json.totals.occupied, 2);
    assert.equal(res.json.totals.available, 0);
    assert.equal(res.json.queue.length, 1);
    assert.equal(res.json.queue[0].householdId, "h2");
    assert.equal(res.json.queue[0].status, "WAITING");

    // 到场核销
    res = await api(http, "POST", `/reservations/${reservationId}/check-in`, {
      worker: "w1",
      body: { reason: "证件核验，全家到场" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.outcome, "CHECKED_IN");

    // 已核销后取消被拒
    res = await api(http, "POST", `/reservations/${reservationId}/cancel`, {
      worker: "w1",
      body: { reason: "想取消" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "ALREADY_CHECKED_IN");

    // 床位审计
    res = await api(http, "GET", `/shelters/s1/beds?bedId=${encodeURIComponent(bedId)}`, { worker: "w1" });
    assert.equal(res.status, 200);
    assert.equal(res.json.timeline[0].action, "LOCKED");
    assert.equal(res.json.timeline[0].workerId, "w1");
    assert.equal(res.json.timeline[0].reason, "现场登记");

    // 错误请求：缺原因
    res = await api(http, "POST", "/shelters/s1/applications", { worker: "w1", body: { householdId: "hx", size: 1 } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "INVALID_REQUEST");

    // 路由不存在 / 非法 JSON
    res = await api(http, "GET", "/nope");
    assert.equal(res.status, 404);
  } finally {
    await http.close();
    store.close();
  }
});

test("HTTP 拒绝非法 JSON 与跨辖区访问", async () => {
  const { store, service } = makeService();
  const http = await start(service);
  try {
    await service.bootstrapCommander({ workerId: "cmd", name: "指挥员" });
    await service.registerWorker("cmd", { workerId: "w1", name: "北", role: "STAFF", districts: ["NORTH"] });
    await service.createShelter("cmd", {
      id: "s1",
      name: "x",
      district: "SOUTH",
      openHours: { opens: "00:00", closes: "23:59" },
      zones: [{ code: "A", capacity: 1, accessibleCapacity: 0 }],
    });

    const response = await fetch(`${http.base}/shelters/s1/applications`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-id": "w1" },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "INVALID_JSON");

    const res2 = await api(http, "GET", "/shelters/s1", { worker: "w1" });
    assert.equal(res2.status, 403);
    assert.equal(res2.json.error, "OUTSIDE_JURISDICTION");
  } finally {
    await http.close();
    store.close();
  }
});
