import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { makeService } from "./helpers.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("健康检查返回服务状态", async () => {
  const { store, service } = makeService();
  const server = buildApp(service);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { service: "shelter-capacity", status: "ok" });
  } finally {
    await close(server);
    store.close();
  }
});
