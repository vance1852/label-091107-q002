import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const app = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ service: "shelter-capacity", status: "ok" }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "接口不存在" }));
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(Number(process.env.PORT ?? 3000));
}
