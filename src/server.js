import { pathToFileURL } from "node:url";
import { EventStore } from "./store.js";
import { CapacityService } from "./service.js";
import { buildApp } from "./app.js";
import { seedIfEmpty } from "./seed.js";

export function createContext({ dataFile = process.env.DATA_FILE ?? "data/events.log", now } = {}) {
  const store = new EventStore(dataFile);
  const service = new CapacityService(store, now ? { now } : {});
  return { store, service };
}

export { buildApp as app };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const { store, service } = createContext();
  await seedIfEmpty(service);
  const server = buildApp(service).listen(port, () => {
    console.log(`避难所容量服务已启动：http://127.0.0.1:${port}（事件日志 ${store.filePath}）`);
  });

  const shutdown = (signal) => {
    console.log(`收到 ${signal}，关闭服务…`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
