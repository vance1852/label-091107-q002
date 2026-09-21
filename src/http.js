import { createServer } from "node:http";
import { HttpError } from "./errors.js";

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

const readBody = async (request) => {
  if (request.method === "GET" || request.headers["content-length"] === "0") return {};
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
    }
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "VALIDATION", "请求体不是合法 JSON");
  }
};

/** 工作人员身份通过请求头传递：X-Staff-Id + X-Staff-Token。 */
const staffToken = (request) => {
  const staffId = request.headers["x-staff-id"];
  const value = request.headers["x-staff-token"];
  if (!staffId && !value) return null;
  return { staffId, value };
};

export function createApp(service, { adminToken } = {}) {
  const routes = [];
  const route = (method, pattern, handler, options = {}) => {
    const names = [];
    const regex = new RegExp(
      "^" +
        pattern.replace(/:[^/]+/g, (name) => {
          names.push(name.slice(1));
          return "([^/]+)";
        }) +
        "$",
    );
    routes.push({ method, regex, names, handler, ...options });
  };

  const requireAdmin = (request) => {
    const expected = adminToken ?? process.env.ADMIN_TOKEN ?? "setup-token";
    const given = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!given || given !== expected) {
      throw new HttpError(401, "UNAUTHENTICATED", "管理接口需要有效的 Bearer 令牌");
    }
  };

  // ---- 引导/管理 ----
  route("POST", "/admin/sites", async (req) => {
    requireAdmin(req.request);
    return { status: 201, body: await service.registerSite(req.body) };
  });
  route("POST", "/admin/staff", async (req) => {
    requireAdmin(req.request);
    return { status: 201, body: await service.registerStaff(req.body) };
  });

  // ---- 登记 ----
  route("POST", "/reservations", async (req) => {
    const result = await service.reserve(
      staffToken(req.request),
      req.body,
      req.request.headers["idempotency-key"],
    );
    return { status: 201, body: result };
  });

  // ---- 状态变更 ----
  route("POST", "/reservations/:id/cancel", async (req, { id }) => ({
    status: 200,
    body: await service.cancel(staffToken(req.request), id, req.body.reason),
  }));
  route("POST", "/reservations/:id/check-in", async (req, { id }) => ({
    status: 200,
    body: await service.checkIn(staffToken(req.request), id, req.body.reason),
  }));
  route("POST", "/reservations/:id/no-show", async (req, { id }) => ({
    status: 200,
    body: await service.markNoShow(staffToken(req.request), id, req.body.reason),
  }));
  route("POST", "/reservations/:id/reassign", async (req, { id }) => ({
    status: 200,
    body: await service.reassign(staffToken(req.request), id, req.body),
  }));

  // ---- 查询 ----
  route("GET", "/sites/:id", async (req, { id }) => ({
    status: 200,
    body: await service.getSite(staffToken(req.request), id),
  }));
  route("GET", "/reservations/:id", async (req, { id }) => ({
    status: 200,
    body: service.getReservation(staffToken(req.request), id),
  }));
  route("GET", "/reservations/:id/history", async (req, { id }) => ({
    status: 200,
    body: service.reservationHistory(staffToken(req.request), id),
  }));
  route("GET", "/sites/:id/history", async (req, { id }) => ({
    status: 200,
    body: service.siteHistory(staffToken(req.request), id),
  }));

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { service: "shelter-capacity", status: "ok" });
      return;
    }
    const url = new URL(request.url, "http://localhost");
    const match = routes.find((r) => r.method === request.method && r.regex.test(url.pathname));
    if (!match) {
      json(response, 404, { error: "接口不存在" });
      return;
    }
    try {
      const body = await readBody(request);
      const params = Object.fromEntries(
        match.names.map((name, i) => [name, url.pathname.match(match.regex)[i + 1]]),
      );
      const { status = 200, body: payload } = await match.handler(
        { request, body, query: url.searchParams },
        params,
      );
      // 204 等无正文情况
      if (payload === undefined) {
        response.writeHead(status);
        response.end();
      } else {
        json(response, status, payload);
      }
    } catch (error) {
      if (error instanceof HttpError) {
        json(response, error.status, { error: error.code, message: error.message });
        return;
      }
      console.error(error);
      json(response, 500, { error: "INTERNAL", message: "服务器内部错误" });
    }
  });
}
