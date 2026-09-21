// HTTP 路由层：鉴权使用 X-Worker-Id 头；所有响应为 JSON。
import { createServer } from "node:http";
import { ServiceError } from "./service.js";

const MAX_BODY_BYTES = 64 * 1024;

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ServiceError(413, "BODY_TOO_LARGE", "请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ServiceError(400, "INVALID_JSON", "请求体不是合法 JSON"));
      }
    });
    request.on("error", reject);
  });
}

export function buildApp(service) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const auth = request.headers["x-worker-id"]?.toString();

    const body = request.method === "POST" || request.method === "PUT" ? await readBody(request).catch((error) => error) : {};
    if (body instanceof Error) {
      send(response, body.status ?? 400, { error: body.code, message: body.message });
      return;
    }

    const call = async (handler) => {
      try {
        const result = await handler();
        send(response, 200, result);
      } catch (error) {
        if (error instanceof ServiceError) {
          send(response, error.status, { error: error.code, message: error.message, details: error.details });
        } else {
          send(response, 500, { error: "INTERNAL_ERROR", message: error.message });
        }
      }
    };

    // 路由
    if (request.method === "GET" && path === "/health") {
      send(response, 200, { service: "shelter-capacity", status: "ok" });
      return;
    }

    if (request.method === "POST" && path === "/admin/bootstrap") {
      return call(() => service.bootstrapCommander(body));
    }

    if (request.method === "POST" && path === "/admin/workers") {
      return call(() => service.registerWorker(auth, body));
    }

    if (request.method === "POST" && path === "/shelters") {
      return call(() => service.createShelter(auth, body));
    }

    if (request.method === "GET" && path === "/shelters") {
      return call(async () => ({ shelters: await service.listShelters(auth) }));
    }

    const shelterMatch = path.match(/^\/shelters\/([^/]+)$/);
    if (request.method === "GET" && shelterMatch) {
      return call(() => service.queryShelter(auth, decodeURIComponent(shelterMatch[1])));
    }

    const applyMatch = path.match(/^\/shelters\/([^/]+)\/applications$/);
    if (request.method === "POST" && applyMatch) {
      return call(() =>
        service.apply({ ...body, workerId: auth, shelterId: decodeURIComponent(applyMatch[1]) }),
      );
    }

    const auditMatch = path.match(/^\/shelters\/([^/]+)\/beds$/);
    if (request.method === "GET" && auditMatch) {
      return call(() =>
        service.bedAudit(
          auth,
          decodeURIComponent(auditMatch[1]),
          url.searchParams.get("bedId"),
        ),
      );
    }

    const householdMatch = path.match(/^\/households\/([^/]+)$/);
    if (request.method === "GET" && householdMatch) {
      return call(() => service.getHousehold(auth, decodeURIComponent(householdMatch[1])));
    }

    const reassignMatch = path.match(/^\/reservations\/([^/]+)\/reassign$/);
    if (request.method === "POST" && reassignMatch) {
      return call(() =>
        service.reassign({ ...body, workerId: auth, reservationId: decodeURIComponent(reassignMatch[1]) }),
      );
    }

    const cancelMatch = path.match(/^\/reservations\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelMatch) {
      return call(() =>
        service.cancelReservation({ ...body, workerId: auth, reservationId: decodeURIComponent(cancelMatch[1]) }),
      );
    }

    const checkInMatch = path.match(/^\/reservations\/([^/]+)\/check-in$/);
    if (request.method === "POST" && checkInMatch) {
      return call(() =>
        service.checkIn({ ...body, workerId: auth, reservationId: decodeURIComponent(checkInMatch[1]) }),
      );
    }

    const cancelWaitMatch = path.match(/^\/waitlist\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelWaitMatch) {
      return call(() =>
        service.cancelWaitlist({ ...body, workerId: auth, entryId: decodeURIComponent(cancelWaitMatch[1]) }),
      );
    }

    send(response, 404, { error: "NOT_FOUND", message: "接口不存在" });
  });
}
