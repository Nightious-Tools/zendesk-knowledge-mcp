export class ZdError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = "ZdError";
  }
}
export class DomainNotAllowedError extends ZdError {
  constructor(url: string) { super(`Refusing to fetch non-official URL: ${url}`, "DOMAIN_NOT_ALLOWED", { url }); }
}
export class HttpError extends ZdError {
  constructor(public status: number, url: string, public retryAfterMs?: number, public bodySnippet?: string) {
    super(`HTTP ${status} from ${url}${bodySnippet ? `: ${bodySnippet}` : ""}`, "HTTP_ERROR", { status, url, retryAfterMs, body: bodySnippet });
  }
}
export class TimeoutError extends ZdError {
  constructor(url: string, ms: number) { super(`Timed out after ${ms}ms fetching ${url}`, "TIMEOUT", { url, ms }); }
}
export class NotFoundError extends ZdError {
  constructor(what: string) { super(`${what} not found`, "NOT_FOUND"); }
}
