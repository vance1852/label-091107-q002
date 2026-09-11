import assert from "node:assert/strict";
import test from "node:test";
import { app } from "../src/server.js";

test("健康检查返回服务状态", async () => {
  app.listen(0);
  const { port } = app.address();
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.deepEqual(await response.json(), { service: "shelter-capacity", status: "ok" });
  await new Promise((resolve) => app.close(resolve));
});
