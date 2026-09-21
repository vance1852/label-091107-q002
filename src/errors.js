/** 可直接映射为 HTTP 响应的业务错误。 */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, "VALIDATION", message);
export const unauthorized = (message = "缺少或无效的身份凭证") =>
  new HttpError(401, "UNAUTHENTICATED", message);
export const forbidden = (message) => new HttpError(403, "FORBIDDEN", message);
export const notFound = (message) => new HttpError(404, "NOT_FOUND", message);
export const conflict = (code, message) => new HttpError(409, code, message);
