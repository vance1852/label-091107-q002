import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server.js";

test("健康检查返回服务状态", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "shelter-health-"));
  const { app, store } = await buildApp({ dataDir, seed: false });
  await new Promise((resolve) => app.listen(0, resolve));
  const { port } = app.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await response.json(), { service: "shelter-capacity", status: "ok" });
  } finally {
    await new Promise((resolve) => app.close(resolve));
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
