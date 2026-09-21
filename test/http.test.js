import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { createService } from "../src/service.js";
import { createApp } from "../src/http.js";

const T0 = 1_700_000_000_000;

async function startServer({ dataDir, now } = {}) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), "shelter-http-")));
  const store = new Store({ dataDir: dir, now: now ?? (() => T0) });
  await store.init();
  const service = createService(store);
  const server = createApp(service, { adminToken: "admin-secret" });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    dir,
    base,
    service,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function setupWorld() {
  const harness = await startServer();
  const { base } = harness;
  const admin = { Authorization: "Bearer admin-secret" };

  const siteRes = await fetch(`${base}/admin/sites`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({
      id: "S1",
      name: "一号站",
      district: "东城",
      zones: [{ id: "A", name: "A区", capacity: 4, accessibleBeds: 1 }],
    }),
  });
  assert.equal(siteRes.status, 201);

  const staffRes = await fetch(`${base}/admin/staff`, {
    method: "POST",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ id: "w1", name: "东员", district: "东城", role: "worker" }),
  });
  const staff = await staffRes.json();
  const auth = { "X-Staff-Id": "w1", "X-Staff-Token": staff.token };
  return { ...harness, auth, admin };
}

test("端到端：登记→等待→取消递补→查询与审计", async () => {
  const h = await setupWorld();
  try {
    const post = (path, body, headers = h.auth) =>
      fetch(`${h.base}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const r1 = await (await post("/reservations", { siteId: "S1", household: { id: "f1", name: "张家", members: 3, accessibleNeeded: 1 } })).json();
    assert.equal(r1.status, "confirmed");

    const r2 = await (await post("/reservations", { siteId: "S1", household: { id: "f2", name: "李家", members: 2 } })).json();
    assert.equal(r2.status, "waiting");
    assert.equal(r2.queuePosition, 1);

    // 指挥员视图
    const viewRes = await fetch(`${h.base}/sites/S1`, { headers: h.auth });
    assert.equal(viewRes.status, 200);
    const view = await viewRes.json();
    assert.equal(view.totals.available, 1);
    assert.equal(view.totals.occupiedAccessible, 1);
    assert.equal(view.waiting[0].household.name, "李家");

    // 取消后自动递补
    const cancelRes = await post(`/reservations/${r1.reservation.id}/cancel`, { reason: "投亲靠友" });
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.promotions, 1);

    // 审计
    const historyRes = await fetch(`${h.base}/reservations/${r1.reservation.id}/history`, { headers: h.auth });
    const history = await historyRes.json();
    assert.deepEqual(history.timeline.map((event) => event.type), ["RESERVATION_CONFIRMED", "CANCELLED"]);
    assert.equal(history.timeline[1].actor.name, "东员");
  } finally {
    await h.close();
    await h.cleanup();
  }
});

test("鉴权：无凭证 401、错误令牌 401、跨辖区 403", async () => {
  const h = await setupWorld();
  try {
    const noAuth = await fetch(`${h.base}/sites/S1`);
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch(`${h.base}/sites/S1`, {
      headers: { "X-Staff-Id": "w1", "X-Staff-Token": "wrong" },
    });
    assert.equal(badAuth.status, 401);

    // 管理接口需要 Bearer
    const noAdmin = await fetch(`${h.base}/admin/staff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", district: "y" }),
    });
    assert.equal(noAdmin.status, 401);

    // 建一个西城工作人员
    const created = await fetch(`${h.base}/admin/staff`, {
      method: "POST",
      headers: { ...h.admin, "content-type": "application/json" },
      body: JSON.stringify({ id: "w2", name: "西员", district: "西城", role: "worker" }),
    });
    const w2 = await created.json();
    const forbidden = await fetch(`${h.base}/sites/S1`, {
      headers: { "X-Staff-Id": "w2", "X-Staff-Token": w2.token },
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await h.close();
    await h.cleanup();
  }
});

test("HTTP 幂等：重复送达相同请求只占一次床位", async () => {
  const h = await setupWorld();
  try {
    const send = () =>
      fetch(`${h.base}/reservations`, {
        method: "POST",
        headers: {
          ...h.auth,
          "content-type": "application/json",
          "Idempotency-Key": "ticket-777",
        },
        body: JSON.stringify({ siteId: "S1", household: { id: "f9", name: "重复户", members: 2 } }),
      });
    const [a, b] = await Promise.all([send(), send()]);
    const bodyA = await a.json();
    const bodyB = await b.json();
    // 串行化后两次都会返回 201/200，且指向同一预约，其中一次标记 replayed。
    assert.equal(bodyA.reservation.id, bodyB.reservation.id);
    assert.ok(bodyA.replayed || bodyB.replayed);
    assert.equal(bodyA.replayed && bodyB.replayed, false);
    const view = await (await fetch(`${h.base}/sites/S1`, { headers: h.auth })).json();
    assert.equal(view.totals.occupied, 2);
  } finally {
    await h.close();
    await h.cleanup();
  }
});

test("日志末尾存在崩溃半截行时，重启自动截断且不丢已提交事务", async () => {
  const h = await setupWorld();
  try {
    const created = await fetch(`${h.base}/reservations`, {
      method: "POST",
      headers: { ...h.auth, "content-type": "application/json" },
      body: JSON.stringify({ siteId: "S1", household: { id: "f1", name: "张家", members: 2 } }),
    });
    const r1 = await created.json();
    await h.close();

    // 模拟在写下一个批次时进程被杀：追加一条残缺的、没有 COMMIT 的半截 JSON 行。
    await appendFile(join(h.dir, "events.log"), '{"v":1,"kind":"EVENT","batchId":"ghost","seq":999,"type":"WAITLISTED","dat');

    const store2 = new Store({ dataDir: h.dir, now: () => T0 });
    await store2.init();
    const service2 = createService(store2);
    const staffRecord = service2._state().staff.get("w1");
    const viewAuth = service2.getSite({ staffId: "w1", value: staffRecord.token }, "S1");
    assert.equal(viewAuth.totals.occupied, 2);
    assert.equal(viewAuth.waiting.length, 0);
    assert.ok(service2._state().reservations.has(r1.reservation.id));
    await store2.close();
  } finally {
    await h.cleanup();
  }
});

test("并发登记不会超卖：超出容量的请求全部排队", async () => {
  const h = await setupWorld();
  try {
    const requests = Array.from({ length: 8 }, (_, index) =>
      fetch(`${h.base}/reservations`, {
        method: "POST",
        headers: { ...h.auth, "content-type": "application/json" },
        body: JSON.stringify({ siteId: "S1", household: { id: `c${index}`, name: `家庭${index}`, members: 1 } }),
      }).then((response) => response.json()),
    );
    const results = await Promise.all(requests);
    const confirmed = results.filter((result) => result.status === "confirmed");
    const waiting = results.filter((result) => result.status === "waiting");
    // 站点 4 张床中 1 张为无障碍床，普通家庭只能使用 3 张普通床，其余 5 户排队。
    assert.equal(confirmed.length, 3);
    assert.equal(waiting.length, 5);
    const view = await (await fetch(`${h.base}/sites/S1`, { headers: h.auth })).json();
    assert.equal(view.totals.occupied, 3);
    assert.equal(view.waiting.length, 5);
  } finally {
    await h.close();
    await h.cleanup();
  }
});
