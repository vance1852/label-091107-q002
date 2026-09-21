import { pathToFileURL } from "node:url";
import { Store } from "./store.js";
import { createService } from "./service.js";
import { createApp } from "./http.js";
import { seedIfEmpty } from "./seed.js";

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const store = new Store({ dataDir: process.env.DATA_DIR });
  await store.init();
  const service = createService(store);
  const seeded = await seedIfEmpty(service);

  const app = createApp(service);
  await new Promise((resolve) => app.listen(port, resolve));
  console.log(`避难所容量服务已启动：http://127.0.0.1:${port}（数据目录 ${process.env.DATA_DIR ?? "data"}）`);
  if (seeded.length > 0) {
    console.log("已写入演示数据，工作人员令牌（仅本次显示，请妥善保存）：");
    for (const staff of seeded) {
      console.log(`  ${staff.id}（${staff.name}/${staff.role}）: ${staff.token}`);
    }
  }

  const shutdown = async (signal) => {
    console.log(`收到 ${signal}，停止接入新请求并落盘关闭…`);
    await new Promise((resolve) => app.close(resolve));
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export async function buildApp({ dataDir, now, seed = true } = {}) {
  const store = new Store({ dataDir, now });
  await store.init();
  const service = createService(store);
  if (seed) await seedIfEmpty(service);
  return { app: createApp(service), store, service };
}
